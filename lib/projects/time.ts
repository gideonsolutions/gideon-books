/**
 * Time entries: hours on a project by a member or an employee, billable or
 * not. A billed entry (on an invoice that is not void) can no longer be
 * edited or deleted.
 */
import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { contacts, projects } from "@/lib/db/schema/ledger";
import { memberships, users } from "@/lib/db/schema/core";
import { timeEntries } from "@/lib/db/schema/projects";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { addDays, isIsoDate, parts, toDayNumber, fromDayNumber } from "@/lib/dates";

export type TimeEntry = typeof timeEntries.$inferSelect;

export interface TimeEntryInput {
  projectId: string;
  workDate: string;
  /** A member (user id) or an employee contact; one of them. */
  userId?: string | null;
  contactId?: string | null;
  hours: string;
  rate?: string | null;
  billable?: boolean;
  description?: string | null;
}

/** SQL: whether a time entry is billed on an invoice that is not void (qualified names: drizzle leaves single-table columns unqualified). */
export const billedExpr = sql<boolean>`exists (
  select 1 from project_billing_links b join documents d on d.org_id = b.org_id and d.id = b.invoice_id
  where b.org_id = time_entries.org_id and b.source_type = 'time_entry' and b.source_id = time_entries.id and b.status = 'active' and d.status <> 'void')`;

async function normalize(db: DbOrTx, ctx: Ctx, input: TimeEntryInput) {
  const fields: Record<string, string> = {};
  if (!input.projectId) fields.projectId = "Choose a project.";
  if (!isIsoDate(input.workDate)) fields.workDate = "Enter the date worked.";
  const hours = Decimal.tryFrom(input.hours?.replace(/[,\s]/g, ""));
  if (!hours || !hours.isPositive() || hours.gt(24)) fields.hours = "Enter hours between 0 and 24.";
  else if (hours.decimalPlaces > 2) fields.hours = "Use at most two decimal places (0.25 = 15 minutes).";
  let rate: string | null = null;
  if (input.rate && input.rate.trim()) {
    const r = Decimal.tryFrom(input.rate.replace(/[,\s$]/g, ""));
    if (!r || r.isNegative() || r.decimalPlaces > 8) fields.rate = "Enter an hourly rate.";
    else rate = r.toString();
  }
  if (!input.userId && !input.contactId) fields.person = "Choose who did the work.";
  if (Object.keys(fields).length) throw new ValidationError("Check the time entry.", fields);
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, input.projectId)));
  if (!project) throw new ValidationError("That project does not exist.", { projectId: "Not found." });
  if (project.status === "completed" || project.status === "cancelled") throw new ValidationError(`${project.name} is ${project.status}; reopen it to record time.`, { projectId: "Not active." });
  let personLabel: string;
  if (input.userId) {
    const [m] = await db
      .select({ name: users.name, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.orgId, ctx.orgId), eq(memberships.userId, input.userId)));
    if (!m) throw new ValidationError("That person is not a member of this organization.", { person: "Not a member." });
    personLabel = m.name || m.email;
  } else {
    const [c] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.contactId!)));
    if (!c || !c.isEmployee) throw new ValidationError("Choose an employee.", { person: "Not an employee." });
    personLabel = c.displayName;
  }
  return {
    projectId: input.projectId,
    workDate: input.workDate,
    userId: input.userId || null,
    contactId: input.userId ? null : input.contactId || null,
    personLabel,
    hours: hours!.toString(),
    rate,
    billable: project.billingMethod === "non_billable" ? false : (input.billable ?? true),
    description: input.description?.trim() ?? "",
  };
}

export async function createTimeEntry(ctx: Ctx, input: TimeEntryInput): Promise<TimeEntry> {
  requirePermission(ctx, "time.record");
  return withTransaction(async (tx) => {
    const values = await normalize(tx, ctx, input);
    const [row] = await tx.insert(timeEntries).values({ orgId: ctx.orgId, ...values, createdBy: ctx.actor.userId }).returning();
    await audit(tx, ctx, { action: "time.recorded", entityType: "time_entry", entityId: row!.id, after: row });
    return row!;
  });
}

async function lockUnbilled(tx: DbOrTx, ctx: Ctx, id: string) {
  const [row] = await tx.select({ entry: timeEntries, billed: billedExpr }).from(timeEntries).where(and(eq(timeEntries.orgId, ctx.orgId), eq(timeEntries.id, id)));
  if (!row) throw new NotFoundError("The time entry");
  if (row.billed) throw new ConflictError("This time is billed on an invoice. Remove it from the invoice (or void the invoice) first.", "time_billed");
  if (row.entry.createdBy !== ctx.actor.userId && ctx.role === "staff") throw new ConflictError("Staff can change only their own time entries.", "not_own_entry");
  return row.entry;
}

export async function updateTimeEntry(ctx: Ctx, id: string, input: TimeEntryInput): Promise<TimeEntry> {
  requirePermission(ctx, "time.record");
  return withTransaction(async (tx) => {
    const before = await lockUnbilled(tx, ctx, id);
    const values = await normalize(tx, ctx, input);
    const [row] = await tx.update(timeEntries).set({ ...values, updatedAt: new Date() }).where(eq(timeEntries.id, id)).returning();
    await audit(tx, ctx, { action: "time.updated", entityType: "time_entry", entityId: id, before, after: row });
    return row!;
  });
}

export async function deleteTimeEntry(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, "time.record");
  await withTransaction(async (tx) => {
    const before = await lockUnbilled(tx, ctx, id);
    await tx.delete(timeEntries).where(eq(timeEntries.id, id));
    await audit(tx, ctx, { action: "time.deleted", entityType: "time_entry", entityId: id, before });
  });
}

export interface TimeFilters {
  projectId?: string;
  person?: string;
  from?: string;
  to?: string;
  state?: "unbilled" | "billed" | "non_billable";
  page?: number;
  pageSize?: number;
}

export async function listTimeEntries(db: DbOrTx, orgId: string, f: TimeFilters = {}) {
  const conds: SQL[] = [eq(timeEntries.orgId, orgId)];
  if (f.projectId) conds.push(eq(timeEntries.projectId, f.projectId));
  if (f.person) conds.push(sql`(${timeEntries.userId}::text = ${f.person} or ${timeEntries.contactId}::text = ${f.person})`);
  if (f.from) conds.push(gte(timeEntries.workDate, f.from));
  if (f.to) conds.push(lte(timeEntries.workDate, f.to));
  if (f.state === "non_billable") conds.push(eq(timeEntries.billable, false));
  if (f.state === "billed") conds.push(sql`${timeEntries.billable} and ${billedExpr}`);
  if (f.state === "unbilled") conds.push(sql`${timeEntries.billable} and not ${billedExpr}`);
  const pageSize = Math.min(Math.max(f.pageSize ?? 100, 1), 1000);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const [rows, [agg]] = await Promise.all([
    db
      .select({ entry: timeEntries, projectName: projects.name, projectRate: projects.hourlyRate, billed: billedExpr })
      .from(timeEntries)
      .innerJoin(projects, and(eq(projects.orgId, timeEntries.orgId), eq(projects.id, timeEntries.projectId)))
      .where(where)
      .orderBy(desc(timeEntries.workDate), asc(timeEntries.personLabel))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int`, hours: sql<string>`coalesce(sum(${timeEntries.hours}), 0)::text` }).from(timeEntries).where(where),
  ]);
  return { rows, total: agg?.n ?? 0, totalHours: agg?.hours ?? "0", page, pageSize };
}

/** Monday of the week containing `date`. */
export function weekStart(date: string): string {
  const n = toDayNumber(date);
  // 1970-01-01 was a Thursday: day 0 → Thursday; Monday-based index = (n + 3) mod 7.
  return fromDayNumber(n - ((((n + 3) % 7) + 7) % 7));
}

/** A week of time (Monday to Sunday) by project and day, with totals. */
export async function weeklyTimesheet(db: DbOrTx, orgId: string, anyDate: string, person?: string) {
  const start = weekStart(anyDate);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const { rows } = await listTimeEntries(db, orgId, { from: days[0], to: days[6], ...(person ? { person } : {}), pageSize: 1000 });
  const byProject = new Map<string, { projectId: string; projectName: string; days: Decimal[]; total: Decimal }>();
  for (const r of rows) {
    const p = byProject.get(r.entry.projectId) ?? { projectId: r.entry.projectId, projectName: r.projectName, days: days.map(() => Decimal.ZERO), total: Decimal.ZERO };
    const i = days.indexOf(r.entry.workDate);
    if (i >= 0) p.days[i] = p.days[i]!.add(r.entry.hours);
    p.total = p.total.add(r.entry.hours);
    byProject.set(r.entry.projectId, p);
  }
  const lines = [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName));
  const dayTotals = days.map((_, i) => Decimal.sum(lines.map((l) => l.days[i]!)));
  return { start, days, lines, dayTotals, total: Decimal.sum(dayTotals), entries: rows };
}

export function weekLabel(start: string): string {
  const [y, m, d] = parts(start);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
