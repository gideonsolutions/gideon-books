/**
 * Opening balances: the balances carried in from the previous system, as of
 * the day before the books start. Ordinary accounts are entered here and
 * balanced against Opening Balance Equity. Receivables and payables come in
 * as opening invoices and bills (so each customer's and vendor's items are
 * known), stock as opening stock, and fixed assets through the register —
 * which is why control accounts are refused here.
 */
import { and, eq } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { accounts, journalEntries } from "@/lib/db/schema/ledger";
import { organizations } from "@/lib/db/schema/core";
import { requirePermission, type Ctx } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, isIsoDate } from "@/lib/dates";
import { postEntry, type LineInput } from "./posting";
import { systemAccountId } from "./accounts";
import { resolveRate } from "@/lib/fx/rates";

export async function postOpeningBalances(ctx: Ctx, input: { asOf: string; lines: { accountId: string; debit: string | null; credit: string | null }[] }) {
  requirePermission(ctx, "opening_balances.manage");
  if (!isIsoDate(input.asOf)) throw new ValidationError("Enter the date the balances are as of.", { asOf: "Required." });
  return withTransaction(async (tx) => {
    const obe = await systemAccountId(tx, ctx.orgId, "opening_balance_equity");
    const lines: LineInput[] = [];
    let net = Decimal.ZERO;
    const fields: Record<string, string> = {};
    for (const l of input.lines) {
      const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, l.accountId)));
      if (!acc) continue;
      const d = l.debit ? Decimal.tryFrom(l.debit.replace(/,/g, "")) : null;
      const c = l.credit ? Decimal.tryFrom(l.credit.replace(/,/g, "")) : null;
      if ((l.debit && !d) || (l.credit && !c)) {
        fields[`bal.${acc.id}`] = `${acc.code}: not a number.`;
        continue;
      }
      const amount = (d ?? Decimal.ZERO).sub(c ?? Decimal.ZERO);
      if (amount.isZero()) continue;
      if (acc.control) {
        fields[`bal.${acc.id}`] = `${acc.code} ${acc.name} is kept by its subledger: enter opening ${acc.control === "receivables" ? "invoices" : acc.control === "payables" ? "bills" : acc.control === "inventory" ? "stock" : "assets"} instead.`;
        continue;
      }
      if (acc.id === obe) continue;
      const line: LineInput = { accountId: acc.id, amount: amount.toString(), description: "Opening balance" };
      if (acc.currency && acc.currency !== ctx.org.baseCurrency) {
        const r = await resolveRate(tx, ctx, acc.currency, input.asOf);
        line.currency = acc.currency;
        line.fxRate = r.rate.toString();
        line.exchangeRateId = r.exchangeRateId;
        net = net.add(amount.mul(r.rate).round(minorUnits(ctx.org.baseCurrency), "half_up"));
      } else {
        net = net.add(amount);
      }
      lines.push(line);
    }
    if (Object.keys(fields).length) throw new ValidationError("Some balances cannot be entered here.", fields);
    if (!lines.length) throw new ValidationError("Enter at least one balance.");
    if (!net.isZero()) lines.push({ accountId: obe, amount: net.neg().toString(), description: "Balancing opening balance equity" });
    const posted = await postEntry(tx, ctx, {
      kind: "opening_balance",
      entryDate: input.asOf,
      description: `Opening balances as of ${input.asOf}`,
      sourceType: "opening_balances",
      lines,
    });
    if (!ctx.org.booksStartDate) {
      await tx.update(organizations).set({ booksStartDate: addDays(input.asOf, 1) }).where(eq(organizations.id, ctx.orgId));
    }
    return posted;
  });
}

export async function openingBalanceEntries(orgId: string) {
  return getDb()
    .select()
    .from(journalEntries)
    .where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.kind, "opening_balance")));
}

/**
 * An opening receivable or payable: an invoice or bill carried over from the
 * previous system, posted against Opening Balance Equity so the customer's or
 * vendor's open items are known and can be paid.
 */
export async function createOpeningDocument(
  ctx: Ctx,
  input: { kind: "invoice" | "bill"; contactId: string; reference: string | null; issueDate: string; dueDate: string | null; amount: string; currency: string | null; fxRate: string | null },
) {
  requirePermission(ctx, "opening_balances.manage");
  const { saveDraft, issueDocument } = await import("@/lib/commerce/documents");
  const amount = Decimal.tryFrom(input.amount?.replace(/,/g, ""));
  if (!amount || !amount.isPositive()) throw new ValidationError("Enter the amount still open.", { amount: "Must be positive." });
  const draft = await saveDraft(ctx, {
    kind: input.kind,
    contactId: input.contactId,
    issueDate: input.issueDate,
    dueDate: input.dueDate,
    currency: input.currency,
    fxRate: input.fxRate,
    reference: input.reference,
    memo: "Opening balance",
    isOpeningBalance: true,
    lines: [{ description: `Opening balance${input.reference ? ` — ${input.reference}` : ""}`, quantity: "1", unitPrice: amount.toString() }],
  });
  return issueDocument(ctx, draft.id);
}
