/**
 * Recurring bills: a template (a bill as a draft payload) and a schedule.
 * Each occurrence produces exactly one bill, however many times or however
 * concurrently the job runs: occurrences of a template are produced under a
 * Postgres advisory lock, a document already produced for an occurrence
 * (found by template and date) is linked rather than duplicated, and
 * recurring_runs is unique per (template, occurrence date).
 */
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { getDb, getPool, withTransaction, type DbOrTx } from "@/lib/db/client";
import { documents, recurringRuns, recurringTemplates } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { organizations } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, addMonths, isIsoDate, todayIn } from "@/lib/dates";
import { issueDocument, saveDraft, type DocumentInput } from "@/lib/commerce/documents";
import { log } from "@/lib/log";

export type RecurringTemplate = typeof recurringTemplates.$inferSelect;

export function nextOccurrence(date: string, frequency: RecurringTemplate["frequency"], interval: number): string {
  switch (frequency) {
    case "weekly":
      return addDays(date, 7 * interval);
    case "monthly":
      return addMonths(date, interval);
    case "quarterly":
      return addMonths(date, 3 * interval);
    case "yearly":
      return addMonths(date, 12 * interval);
  }
}

/** The n-th occurrence counted from the start (keeps month-end dates from drifting: Jan 31, Feb 28, Mar 31). */
export function occurrenceDate(start: string, frequency: RecurringTemplate["frequency"], interval: number, n: number): string {
  switch (frequency) {
    case "weekly":
      return addDays(start, 7 * interval * n);
    case "monthly":
      return addMonths(start, interval * n);
    case "quarterly":
      return addMonths(start, 3 * interval * n);
    case "yearly":
      return addMonths(start, 12 * interval * n);
  }
}

export interface RecurringBillInput {
  name: string;
  frequency: RecurringTemplate["frequency"];
  interval: number;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  autoIssue: boolean;
  /** The bill; its issue date is replaced by each occurrence's date. */
  bill: DocumentInput;
}

function validate(input: RecurringBillInput) {
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the schedule.";
  if (!["weekly", "monthly", "quarterly", "yearly"].includes(input.frequency)) fields.frequency = "Choose how often.";
  if (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 52) fields.interval = "Every 1–52.";
  if (!isIsoDate(input.startDate)) fields.startDate = "Enter the first date.";
  if (input.endDate && (!isIsoDate(input.endDate) || input.endDate < input.startDate)) fields.endDate = "Must be after the start.";
  if (input.maxOccurrences != null && (!Number.isInteger(input.maxOccurrences) || input.maxOccurrences < 1)) fields.maxOccurrences = "At least 1.";
  if (!input.bill.contactId) fields.contactId = "Choose the vendor.";
  if (!input.bill.lines.length) fields.lines = "Add at least one line.";
  if (Object.keys(fields).length) throw new ValidationError("Check the schedule.", fields);
}

export async function saveRecurringBill(ctx: Ctx, input: RecurringBillInput, id?: string | null): Promise<RecurringTemplate> {
  requirePermission(ctx, "purchases.manage");
  validate(input);
  return withTransaction(async (tx) => {
    const [vendor] = await tx.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.bill.contactId)));
    if (!vendor || (!vendor.isVendor && !vendor.isEmployee)) throw new ValidationError("Choose a vendor.", { contactId: "Not a vendor." });
    const template = { ...input.bill, kind: "bill" as const };
    if (id) {
      const [before] = await tx.select().from(recurringTemplates).where(and(eq(recurringTemplates.orgId, ctx.orgId), eq(recurringTemplates.id, id))).for("update");
      if (!before || before.kind !== "bill") throw new NotFoundError("The recurring bill");
      // Changing the start re-anchors the schedule only if nothing has been produced yet.
      const nextRunDate = before.occurrences === 0 ? input.startDate : before.nextRunDate;
      const [row] = await tx
        .update(recurringTemplates)
        .set({
          name: input.name.trim(),
          frequency: input.frequency,
          interval: input.interval,
          startDate: before.occurrences === 0 ? input.startDate : before.startDate,
          endDate: input.endDate || null,
          maxOccurrences: input.maxOccurrences ?? null,
          autoIssue: input.autoIssue,
          template,
          nextRunDate,
          updatedAt: new Date(),
        })
        .where(eq(recurringTemplates.id, id))
        .returning();
      await audit(tx, ctx, { action: "recurring_bill.updated", entityType: "recurring_template", entityId: id, before, after: row });
      return row!;
    }
    const [row] = await tx
      .insert(recurringTemplates)
      .values({
        orgId: ctx.orgId,
        kind: "bill",
        name: input.name.trim(),
        frequency: input.frequency,
        interval: input.interval,
        startDate: input.startDate,
        endDate: input.endDate || null,
        maxOccurrences: input.maxOccurrences ?? null,
        autoIssue: input.autoIssue,
        template,
        nextRunDate: input.startDate,
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "recurring_bill.created", entityType: "recurring_template", entityId: row!.id, after: row });
    return row!;
  });
}

export async function setRecurringStatus(ctx: Ctx, id: string, status: "active" | "paused" | "ended") {
  requirePermission(ctx, "purchases.manage");
  await withTransaction(async (tx) => {
    const [t] = await tx.select().from(recurringTemplates).where(and(eq(recurringTemplates.orgId, ctx.orgId), eq(recurringTemplates.id, id)));
    if (!t || t.kind !== "bill") throw new NotFoundError("The recurring bill");
    await tx.update(recurringTemplates).set({ status, updatedAt: new Date() }).where(eq(recurringTemplates.id, id));
    await audit(tx, ctx, { action: `recurring_bill.${status}`, entityType: "recurring_template", entityId: id });
  });
}

/** Run a callback holding a database-wide advisory lock for `key`. */
async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      return await fn();
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
    }
  } finally {
    client.release();
  }
}

/**
 * Produce every due occurrence of one template (up to `today`). Returns the
 * documents produced or linked. Safe to call any number of times.
 */
export async function runTemplate(templateId: string, today?: string): Promise<{ created: number; failed: number }> {
  return withAdvisoryLock(`recurring:${templateId}`, async () => {
    const db = getDb();
    const [t] = await db.select().from(recurringTemplates).where(eq(recurringTemplates.id, templateId));
    if (!t || t.status !== "active" || !t.nextRunDate) return { created: 0, failed: 0 };
    const ctx = await systemCtx(t.orgId, `job: recurring bill “${t.name}”`);
    const asOf = today ?? todayIn(ctx.org.timezone);
    let created = 0;
    let failed = 0;
    let n = t.occurrences;
    let date = t.nextRunDate;
    // At most a year of catch-up per run; the next run continues.
    for (let guard = 0; guard < 60; guard++) {
      if (date > asOf) break;
      if (t.endDate && date > t.endDate) break;
      if (t.maxOccurrences && n >= t.maxOccurrences) break;
      const [run] = await db.select().from(recurringRuns).where(and(eq(recurringRuns.templateId, t.id), eq(recurringRuns.occurrenceDate, date)));
      if (!run || run.status === "failed") {
        try {
          // A bill produced before a crash, but not yet recorded as a run, is found and linked.
          let [doc] = await db
            .select()
            .from(documents)
            .where(and(eq(documents.orgId, t.orgId), eq(documents.recurringTemplateId, t.id), eq(documents.issueDate, date)));
          if (!doc) {
            const input = t.template as DocumentInput;
            doc = await saveDraft(ctx, { ...input, kind: "bill", issueDate: date, postingDate: null, dueDate: null, recurringTemplateId: t.id });
          }
          if (t.autoIssue && doc.status === "draft") doc = await issueDocument(ctx, doc.id, { idempotencyKey: `recurring:${t.id}:${date}` });
          if (run) {
            await db.update(recurringRuns).set({ status: "created", documentId: doc.id, error: null }).where(eq(recurringRuns.id, run.id));
          } else {
            await db.insert(recurringRuns).values({ orgId: t.orgId, templateId: t.id, occurrenceDate: date, status: "created", documentId: doc.id }).onConflictDoNothing();
          }
          created++;
        } catch (err) {
          failed++;
          const message = (err as Error).message.slice(0, 1000);
          log.warn("recurring bill occurrence failed", { templateId: t.id, date, error: message });
          if (run) await db.update(recurringRuns).set({ error: message }).where(eq(recurringRuns.id, run.id));
          else await db.insert(recurringRuns).values({ orgId: t.orgId, templateId: t.id, occurrenceDate: date, status: "failed", error: message }).onConflictDoNothing();
          // Stop here: later occurrences wait until this one succeeds, so they stay in order.
          break;
        }
      }
      n++;
      date = occurrenceDate(t.startDate, t.frequency, t.interval, n);
      await db
        .update(recurringTemplates)
        .set({
          occurrences: n,
          nextRunDate: date,
          lastRunAt: new Date(),
          status: (t.maxOccurrences && n >= t.maxOccurrences) || (t.endDate && date > t.endDate) ? "ended" : t.status,
        })
        .where(eq(recurringTemplates.id, t.id));
    }
    return { created, failed };
  });
}

/** Every due recurring bill, across organizations (the daily job), or one organization's. */
export async function runDueRecurringBills(today?: string, orgId?: string) {
  const db = getDb();
  const due = await db
    .select({ id: recurringTemplates.id, orgId: recurringTemplates.orgId, tz: organizations.timezone })
    .from(recurringTemplates)
    .innerJoin(organizations, eq(organizations.id, recurringTemplates.orgId))
    .where(
      and(
        eq(recurringTemplates.kind, "bill"),
        eq(recurringTemplates.status, "active"),
        lte(recurringTemplates.nextRunDate, today ?? todayIn("Pacific/Kiritimati")),
        orgId ? eq(recurringTemplates.orgId, orgId) : sql`true`,
      ),
    );
  let created = 0;
  let failed = 0;
  for (const d of due) {
    const r = await runTemplate(d.id, today ?? todayIn(d.tz));
    created += r.created;
    failed += r.failed;
  }
  return { templates: due.length, created, failed };
}

export async function listRecurringBills(db: DbOrTx, orgId: string) {
  return db
    .select({ t: recurringTemplates, vendor: contacts.displayName })
    .from(recurringTemplates)
    .leftJoin(contacts, and(eq(contacts.orgId, recurringTemplates.orgId), sql`${contacts.id}::text = ${recurringTemplates.template}->>'contactId'`))
    .where(and(eq(recurringTemplates.orgId, orgId), eq(recurringTemplates.kind, "bill")))
    .orderBy(asc(recurringTemplates.status), asc(recurringTemplates.nextRunDate));
}

export async function getRecurringBill(db: DbOrTx, orgId: string, id: string) {
  const [t] = await db.select().from(recurringTemplates).where(and(eq(recurringTemplates.orgId, orgId), eq(recurringTemplates.id, id)));
  if (!t || t.kind !== "bill") throw new NotFoundError("The recurring bill");
  const runs = await db
    .select({ run: recurringRuns, number: documents.number, status: documents.status, total: documents.total, currency: documents.currency })
    .from(recurringRuns)
    .leftJoin(documents, and(eq(documents.orgId, recurringRuns.orgId), eq(documents.id, recurringRuns.documentId)))
    .where(and(eq(recurringRuns.orgId, orgId), eq(recurringRuns.templateId, id)))
    .orderBy(desc(recurringRuns.occurrenceDate))
    .limit(100);
  return { template: t, runs };
}
