/**
 * Projects: who they are for, how they bill, their budget, and their
 * profitability (income and costs from ledger lines tagged with the project,
 * accrual basis).
 */
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { contacts, projects } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";

export type Project = typeof projects.$inferSelect;

export interface ProjectInput {
  name: string;
  code?: string | null;
  customerId?: string | null;
  status?: Project["status"];
  billingMethod: Project["billingMethod"];
  hourlyRate?: string | null;
  fixedFee?: string | null;
  budgetAmount?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  description?: string | null;
}

function dec(v: string | null | undefined, field: string, fields: Record<string, string>, places: number): string | null {
  if (v === null || v === undefined || v.trim() === "") return null;
  const d = Decimal.tryFrom(v.replace(/[,\s$]/g, ""));
  if (!d || d.isNegative()) {
    fields[field] = "Enter a positive amount.";
    return null;
  }
  if (d.decimalPlaces > places) {
    fields[field] = `Use at most ${places} decimal places.`;
    return null;
  }
  return d.toString();
}

async function normalize(db: DbOrTx, ctx: Ctx, input: ProjectInput) {
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the project.";
  if (!["time_and_materials", "fixed_fee", "non_billable"].includes(input.billingMethod)) fields.billingMethod = "Choose how it bills.";
  const mu = minorUnits(ctx.org.baseCurrency);
  const hourlyRate = dec(input.hourlyRate, "hourlyRate", fields, 8);
  const fixedFee = dec(input.fixedFee, "fixedFee", fields, mu);
  const budgetAmount = dec(input.budgetAmount, "budgetAmount", fields, mu);
  if (input.startDate && !isIsoDate(input.startDate)) fields.startDate = "Enter a date.";
  if (input.endDate && !isIsoDate(input.endDate)) fields.endDate = "Enter a date.";
  if (input.startDate && input.endDate && input.endDate < input.startDate) fields.endDate = "Ends before it starts.";
  if (input.billingMethod !== "non_billable" && !input.customerId) fields.customerId = "A billable project needs a customer.";
  if (input.billingMethod === "fixed_fee" && !fixedFee) fields.fixedFee = "Enter the fixed fee.";
  if (input.customerId) {
    const [c] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.customerId)));
    if (!c || !c.isCustomer) fields.customerId = "Choose a customer.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the project.", fields);
  return {
    name: input.name.trim(),
    code: input.code?.trim() || null,
    customerId: input.customerId || null,
    status: input.status ?? "active",
    billingMethod: input.billingMethod,
    hourlyRate,
    fixedFee,
    budgetAmount,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    description: input.description?.trim() || null,
  };
}

export async function createProject(ctx: Ctx, input: ProjectInput): Promise<Project> {
  requirePermission(ctx, "projects.manage");
  return withTransaction(async (tx) => {
    const values = await normalize(tx, ctx, input);
    const [clash] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.name, values.name)));
    if (clash) throw new ConflictError("A project with that name exists.", "duplicate_project");
    const [row] = await tx.insert(projects).values({ orgId: ctx.orgId, ...values }).returning();
    await audit(tx, ctx, { action: "project.created", entityType: "project", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateProject(ctx: Ctx, id: string, input: ProjectInput): Promise<Project> {
  requirePermission(ctx, "projects.manage");
  return withTransaction(async (tx) => {
    const [before] = await tx.select().from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, id))).for("update");
    if (!before) throw new NotFoundError("The project");
    const values = await normalize(tx, ctx, input);
    const [clash] = await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, ctx.orgId), eq(projects.name, values.name)));
    if (clash && clash.id !== id) throw new ConflictError("A project with that name exists.", "duplicate_project");
    const [row] = await tx.update(projects).set(values).where(eq(projects.id, id)).returning();
    await audit(tx, ctx, { action: "project.updated", entityType: "project", entityId: id, before, after: row });
    return row!;
  });
}

export async function getProject(db: DbOrTx, orgId: string, id: string) {
  const [row] = await db
    .select({ project: projects, customerName: contacts.displayName, customerCurrency: contacts.currency })
    .from(projects)
    .leftJoin(contacts, and(eq(contacts.orgId, projects.orgId), eq(contacts.id, projects.customerId)))
    .where(and(eq(projects.orgId, orgId), eq(projects.id, id)));
  if (!row) throw new NotFoundError("The project");
  return row;
}

export async function listProjects(db: DbOrTx, orgId: string, f: { q?: string; status?: Project["status"]; customerId?: string; page?: number; pageSize?: number; sort?: "name_asc" | "name_desc" | "start_desc" } = {}) {
  const conds: SQL[] = [eq(projects.orgId, orgId)];
  if (f.status) conds.push(eq(projects.status, f.status));
  if (f.customerId) conds.push(eq(projects.customerId, f.customerId));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(projects.name, like), ilike(projects.code, like), ilike(contacts.displayName, like))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const order = f.sort === "name_desc" ? desc(projects.name) : f.sort === "start_desc" ? desc(projects.startDate) : asc(projects.name);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        project: projects,
        customerName: contacts.displayName,
        hours: sql<string>`(select coalesce(sum(t.hours), 0)::text from time_entries t where t.org_id = ${projects.orgId} and t.project_id = ${projects.id})`,
        income: sql<string>`(select coalesce(-sum(l.base_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id join accounts a on a.org_id = l.org_id and a.id = l.account_id where l.org_id = ${projects.orgId} and l.project_id = ${projects.id} and e.status = 'posted' and a.type = 'income')`,
        costs: sql<string>`(select coalesce(sum(l.base_amount), 0)::text from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id join accounts a on a.org_id = l.org_id and a.id = l.account_id where l.org_id = ${projects.orgId} and l.project_id = ${projects.id} and e.status = 'posted' and a.type = 'expense')`,
      })
      .from(projects)
      .leftJoin(contacts, and(eq(contacts.orgId, projects.orgId), eq(contacts.id, projects.customerId)))
      .where(where)
      .orderBy(order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(projects)
      .leftJoin(contacts, and(eq(contacts.orgId, projects.orgId), eq(contacts.id, projects.customerId)))
      .where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

export interface Profitability {
  income: Decimal;
  costOfGoods: Decimal;
  expenses: Decimal;
  costs: Decimal;
  profit: Decimal;
  /** Profit ÷ income, as a percentage to one place; null without income. */
  marginPercent: string | null;
  budget: Decimal | null;
  budgetRemaining: Decimal | null;
  hours: Decimal;
  billableHours: Decimal;
  byAccount: { accountId: string; code: string; name: string; type: string; amount: Decimal }[];
}

/** Income and costs from ledger lines tagged with the project (accrual), with hours and budget. */
export async function projectProfitability(db: DbOrTx, orgId: string, projectId: string, opts: { from?: string; to?: string } = {}): Promise<Profitability> {
  const { project } = await getProject(db, orgId, projectId);
  const res = await db.execute<{ account_id: string; code: string; name: string; type: string; subtype: string; amount: string }>(sql`
    select a.id as account_id, a.code, a.name, a.type, a.subtype, sum(l.base_amount)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId} and l.project_id = ${projectId} and e.status = 'posted' and a.type in ('income','expense')
      ${opts.from ? sql`and e.entry_date >= ${opts.from}` : sql``}
      ${opts.to ? sql`and e.entry_date <= ${opts.to}` : sql``}
    group by a.id, a.code, a.name, a.type, a.subtype
    order by a.code
  `);
  let income = Decimal.ZERO;
  let cogs = Decimal.ZERO;
  let expenses = Decimal.ZERO;
  for (const r of res.rows) {
    if (r.type === "income") income = income.add(Decimal.from(r.amount).neg());
    else if (r.subtype === "cost_of_goods_sold") cogs = cogs.add(r.amount);
    else expenses = expenses.add(r.amount);
  }
  const costs = cogs.add(expenses);
  const profit = income.sub(costs);
  const hoursRes = await db.execute<{ hours: string; billable: string }>(sql`
    select coalesce(sum(hours), 0)::text as hours, coalesce(sum(hours) filter (where billable), 0)::text as billable
    from time_entries where org_id = ${orgId} and project_id = ${projectId}
      ${opts.from ? sql`and work_date >= ${opts.from}` : sql``}
      ${opts.to ? sql`and work_date <= ${opts.to}` : sql``}
  `);
  const budget = project.budgetAmount ? Decimal.from(project.budgetAmount) : null;
  return {
    income,
    costOfGoods: cogs,
    expenses,
    costs,
    profit,
    marginPercent: income.isZero() ? null : profit.mul(100).div(income, 1, "half_up").toString(),
    budget,
    budgetRemaining: budget ? budget.sub(costs) : null,
    hours: Decimal.from(hoursRes.rows[0]?.hours ?? "0"),
    billableHours: Decimal.from(hoursRes.rows[0]?.billable ?? "0"),
    byAccount: res.rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, type: r.type, amount: r.type === "income" ? Decimal.from(r.amount).neg() : Decimal.from(r.amount) })),
  };
}
