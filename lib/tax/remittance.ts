/**
 * Recording sales-tax remittances and adjustments. Recording a remittance
 * records that it was paid; Gideon Books does not file returns or move
 * money. Filing is the jurisdiction's own process (or Gideon Tax's, where it
 * supports the return).
 */
import { and, eq } from "drizzle-orm";
import { withTransaction } from "@/lib/db/client";
import { accounts, taxJurisdictions } from "@/lib/db/schema/ledger";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isIsoDate } from "@/lib/dates";
import { postEntry } from "@/lib/ledger/posting";

export async function recordTaxRemittance(
  ctx: Ctx,
  input: { jurisdictionId: string; date: string; amount: string; paidFromAccountId: string; periodStart?: string | null; periodEnd?: string | null; reference?: string | null },
) {
  requirePermission(ctx, "sales_tax.manage");
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.date)) fields.date = "Enter the payment date.";
  const amount = Decimal.tryFrom(input.amount?.replace(/,/g, ""));
  if (!amount || !amount.isPositive()) fields.amount = "Enter the amount paid.";
  if (!input.paidFromAccountId) fields.paidFromAccountId = "Choose the account it was paid from.";
  if (Object.keys(fields).length) throw new ValidationError("Check the remittance.", fields);
  return withTransaction(async (tx) => {
    const [j] = await tx.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, ctx.orgId), eq(taxJurisdictions.id, input.jurisdictionId)));
    if (!j) throw new NotFoundError("The jurisdiction");
    const [bank] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.paidFromAccountId)));
    if (!bank || !["bank", "cash", "credit_card", "clearing"].includes(bank.subtype)) throw new ValidationError("Pay from a bank, cash or credit-card account.", { paidFromAccountId: "Not a money account." });
    const period = input.periodStart && input.periodEnd ? ` for ${input.periodStart} to ${input.periodEnd}` : "";
    return postEntry(tx, ctx, {
      kind: "sales_tax",
      entryDate: input.date,
      description: `${j.name} sales tax remittance${period}`,
      sourceType: "sales_tax_remittance",
      sourceId: j.id,
      sourceRef: input.reference || null,
      lines: [
        { accountId: j.liabilityAccountId, amount: amount!.toString(), description: `Remitted to ${j.name}${period}`, contactId: j.authorityContactId },
        { accountId: bank.id, amount: amount!.neg().toString(), description: `${j.name} sales tax`, contactId: j.authorityContactId },
      ],
    });
  });
}

/**
 * An adjustment to tax owed (a vendor discount for filing on time, a
 * correction, a penalty). Positive amounts increase what is owed.
 */
export async function recordTaxAdjustment(ctx: Ctx, input: { jurisdictionId: string; date: string; amount: string; offsetAccountId: string; reason: string }) {
  requirePermission(ctx, "sales_tax.manage");
  const amount = Decimal.tryFrom(input.amount?.replace(/,/g, ""));
  if (!isIsoDate(input.date) || !amount || amount.isZero() || !input.offsetAccountId || !input.reason?.trim()) {
    throw new ValidationError("Enter a date, a non-zero amount, the offsetting account and a reason.", {
      ...(!isIsoDate(input.date) ? { date: "Required." } : {}),
      ...(!amount || amount.isZero() ? { amount: "Non-zero." } : {}),
      ...(!input.offsetAccountId ? { offsetAccountId: "Required." } : {}),
      ...(!input.reason?.trim() ? { reason: "Required." } : {}),
    });
  }
  return withTransaction(async (tx) => {
    const [j] = await tx.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, ctx.orgId), eq(taxJurisdictions.id, input.jurisdictionId)));
    if (!j) throw new NotFoundError("The jurisdiction");
    return postEntry(tx, ctx, {
      kind: "sales_tax",
      entryDate: input.date,
      description: `${j.name} sales tax adjustment: ${input.reason.trim()}`,
      sourceType: "sales_tax_adjustment",
      sourceId: j.id,
      lines: [
        { accountId: j.liabilityAccountId, amount: amount!.neg().toString(), description: input.reason.trim() },
        { accountId: input.offsetAccountId, amount: amount!.toString(), description: input.reason.trim() },
      ],
    });
  });
}
