/**
 * Billing a project: unbilled billable time and billable expenses (purchase
 * lines marked billable to the project's customer) become a draft invoice.
 * Each time entry and expense line is linked to the invoice so it is billed
 * once; deleting the draft (or voiding the invoice) releases them.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTransaction, pgErrorCode, type DbOrTx } from "@/lib/db/client";
import { contacts, projects } from "@/lib/db/schema/ledger";
import { documentLines, documents } from "@/lib/db/schema/commerce";
import { projectBillingLinks, timeEntries } from "@/lib/db/schema/projects";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { deleteDraft, saveDraft, type Document, type DocumentLineInput } from "@/lib/commerce/documents";
import { systemAccountId } from "@/lib/ledger/accounts";
import { billedExpr } from "./time";

/** SQL: whether a purchase line is billed on an invoice that is not void. */
const lineBilledExpr = sql<boolean>`exists (
  select 1 from project_billing_links b join documents d on d.org_id = b.org_id and d.id = b.invoice_id
  where b.org_id = document_lines.org_id and b.source_type = 'expense_line' and b.source_id = document_lines.id and b.status = 'active' and d.status <> 'void')`;

export interface UnbilledExpense {
  lineId: string;
  documentId: string;
  documentKind: string;
  documentNumber: string | null;
  date: string;
  vendorName: string | null;
  description: string;
  currency: string;
  /** Net amount of the line in the document's currency (the cost re-billed). */
  amount: string;
  billableCustomerId: string;
}

export async function unbilledForProject(db: DbOrTx, orgId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.id, projectId)));
  if (!project) throw new NotFoundError("The project");
  const time = await db
    .select({ entry: timeEntries })
    .from(timeEntries)
    .where(and(eq(timeEntries.orgId, orgId), eq(timeEntries.projectId, projectId), eq(timeEntries.billable, true), sql`not ${billedExpr}`))
    .orderBy(asc(timeEntries.workDate));
  const expenseRows = await db
    .select({ line: documentLines, doc: documents, vendorName: contacts.displayName })
    .from(documentLines)
    .innerJoin(documents, and(eq(documents.orgId, documentLines.orgId), eq(documents.id, documentLines.documentId)))
    .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
    .where(
      and(
        eq(documentLines.orgId, orgId),
        eq(documentLines.projectId, projectId),
        sql`${documentLines.billableCustomerId} is not null`,
        inArray(documents.kind, ["bill", "expense"]),
        inArray(documents.status, ["issued", "partially_paid", "paid"]),
        sql`not ${lineBilledExpr}`,
      ),
    )
    .orderBy(asc(documents.issueDate));
  const rate = project.hourlyRate;
  return {
    project,
    time: time.map(({ entry }) => {
      const r = entry.rate ?? rate;
      return { ...entry, effectiveRate: r, amount: r ? Decimal.from(entry.hours).mul(r) : null };
    }),
    expenses: expenseRows.map(
      (r): UnbilledExpense => ({
        lineId: r.line.id,
        documentId: r.doc.id,
        documentKind: r.doc.kind,
        documentNumber: r.doc.number ?? r.doc.reference,
        date: r.doc.issueDate,
        vendorName: r.vendorName,
        description: r.line.description,
        currency: r.doc.currency,
        amount: r.line.netAmount,
        billableCustomerId: r.line.billableCustomerId!,
      }),
    ),
  };
}

export interface BillProjectInput {
  timeEntryIds: string[];
  expenseLineIds: string[];
  /** Percent added to re-billed expenses, e.g. "10". */
  markupPercent?: string | null;
  incomeAccountId?: string | null;
  issueDate: string;
  /** A fixed-fee or milestone amount to bill as its own line. */
  extra?: { description: string; amount: string } | null;
}

/**
 * Create a draft invoice for the project's customer from the selected time,
 * expenses and (optionally) a fixed amount, and link everything billed.
 */
export async function billProject(ctx: Ctx, projectId: string, input: BillProjectInput): Promise<Document> {
  requirePermission(ctx, "projects.manage", "sales.manage");
  if (!isIsoDate(input.issueDate)) throw new ValidationError("Enter the invoice date.", { issueDate: "Required." });
  const db = getDb();
  const { project, time, expenses } = await unbilledForProject(db, ctx.orgId, projectId);
  if (!project.customerId) throw new ValidationError("This project has no customer to bill.", { customerId: "Set the customer first." });
  if (project.billingMethod === "non_billable") throw new ValidationError("This project is not billable.");
  const [customer] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, project.customerId)));
  const currency = customer?.currency ?? ctx.org.baseCurrency;
  const mu = minorUnits(currency);

  const selectedTime = time.filter((t) => input.timeEntryIds.includes(t.id));
  const selectedExp = expenses.filter((e) => input.expenseLineIds.includes(e.lineId));
  if (selectedTime.length !== input.timeEntryIds.length || selectedExp.length !== input.expenseLineIds.length) {
    throw new ConflictError("Some of the selected items are already billed or no longer billable. Refresh and select again.", "already_billed");
  }
  const extraAmount = input.extra?.amount ? Decimal.tryFrom(input.extra.amount.replace(/[,\s$]/g, "")) : null;
  if (input.extra?.amount && (!extraAmount || !extraAmount.isPositive())) throw new ValidationError("Enter a positive amount.", { extraAmount: "Must be positive." });
  if (!selectedTime.length && !selectedExp.length && !extraAmount) throw new ValidationError("Select time or expenses to bill.");
  for (const t of selectedTime) {
    if (!t.effectiveRate) throw new ValidationError(`The time on ${t.workDate} has no rate and the project has no hourly rate. Set one first.`, { rate: "Rate required." });
  }
  for (const e of selectedExp) {
    if (e.currency !== currency) throw new ValidationError(`The expense on ${e.documentNumber ?? e.date} is in ${e.currency}; the customer is billed in ${currency}. Bill it by hand.`);
    if (e.billableCustomerId !== project.customerId) throw new ValidationError(`The expense on ${e.documentNumber ?? e.date} is billable to a different customer.`);
  }
  let markup = Decimal.ZERO;
  if (input.markupPercent && input.markupPercent.trim()) {
    const m = Decimal.tryFrom(input.markupPercent.replace(/[%\s]/g, ""));
    if (!m || m.isNegative() || m.gt(1000)) throw new ValidationError("Enter a markup percentage.", { markupPercent: "0 or more." });
    markup = m;
  }
  const incomeAccountId = input.incomeAccountId || (await withTransaction((tx) => systemAccountId(tx, ctx.orgId, "service_income")));

  const lines: DocumentLineInput[] = [];
  const links: { sourceType: "time_entry" | "expense_line"; sourceId: string; amount: Decimal }[] = [];
  for (const t of selectedTime) {
    const amount = Decimal.from(t.hours).mul(t.effectiveRate!).round(mu, "half_up");
    lines.push({
      description: `${t.workDate} — ${t.personLabel}${t.description ? `: ${t.description}` : ""}`,
      quantity: Decimal.from(t.hours).normalize().toString(),
      unitPrice: Decimal.from(t.effectiveRate!).normalize().toString(),
      accountId: incomeAccountId,
      projectId,
      serviceDate: t.workDate,
    });
    links.push({ sourceType: "time_entry", sourceId: t.id, amount });
  }
  for (const e of selectedExp) {
    const amount = Decimal.from(e.amount).mul(Decimal.ONE.add(markup.div(100, 8, "half_up"))).round(mu, "half_up");
    lines.push({
      description: `Reimbursable: ${e.description || "expense"} (${e.vendorName ?? "vendor"} ${e.documentNumber ?? ""})`.trim(),
      quantity: "1",
      unitPrice: amount.toString(),
      accountId: incomeAccountId,
      projectId,
      serviceDate: e.date,
    });
    links.push({ sourceType: "expense_line", sourceId: e.lineId, amount });
  }
  if (extraAmount) {
    lines.push({ description: input.extra!.description?.trim() || `${project.name} — fixed fee`, quantity: "1", unitPrice: extraAmount.toString(), accountId: incomeAccountId, projectId });
  }

  const invoice = await saveDraft(ctx, {
    kind: "invoice",
    contactId: project.customerId,
    issueDate: input.issueDate,
    currency,
    memo: `Billed from project ${project.name}`,
    lines,
  });
  try {
    await withTransaction(async (tx) => {
      // Release links on void invoices so the work can be billed again.
      const ids = links.map((l) => l.sourceId);
      if (ids.length) {
        await tx.execute(sql`
          update project_billing_links b set status = 'released'
          from documents d
          where b.org_id = ${ctx.orgId} and d.org_id = b.org_id and d.id = b.invoice_id and d.status = 'void' and b.status = 'active'
            and b.source_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
        `);
        await tx.insert(projectBillingLinks).values(links.map((l) => ({ orgId: ctx.orgId, invoiceId: invoice.id, projectId, sourceType: l.sourceType, sourceId: l.sourceId, amount: l.amount.toString() })));
      }
      await audit(tx, ctx, {
        action: "project.billed",
        entityType: "project",
        entityId: projectId,
        metadata: { invoiceId: invoice.id, timeEntries: selectedTime.length, expenseLines: selectedExp.length, extra: extraAmount?.toString() ?? null },
      });
    });
  } catch (e) {
    // Someone billed the same work at the same moment: take back this draft.
    await deleteDraft(ctx, invoice.id).catch(() => {});
    if (pgErrorCode(e) === "23505") throw new ConflictError("Some of this work was just billed on another invoice. Refresh and select again.", "already_billed");
    throw e;
  }
  return invoice;
}

/** What is billed on an invoice from projects (for its page and for releasing). */
export async function billingLinksForInvoice(db: DbOrTx, orgId: string, invoiceId: string) {
  return db.select().from(projectBillingLinks).where(and(eq(projectBillingLinks.orgId, orgId), eq(projectBillingLinks.invoiceId, invoiceId)));
}

