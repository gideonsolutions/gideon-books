/** Helpers shared across the banking module. */
import { createHash } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { bankTransactions } from "@/lib/db/schema/banking";
import type { DbOrTx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import type { Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { normalizeDescription } from "./csv";

export const MONEY_SUBTYPES = ["bank", "cash", "clearing", "credit_card"] as const;

export type MoneyAccount = typeof accounts.$inferSelect & { currencyResolved: string };

/** A bank, cash, clearing or credit-card account of the organization. */
export async function loadMoneyAccount(db: DbOrTx, ctx: Ctx, accountId: string): Promise<MoneyAccount> {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, accountId)));
  if (!a) throw new NotFoundError("The account");
  if (!(MONEY_SUBTYPES as readonly string[]).includes(a.subtype)) {
    throw new ValidationError(`${a.code} ${a.name} is not a bank, cash, clearing or credit-card account.`, { accountId: "Not a money account." });
  }
  return { ...a, currencyResolved: a.currency ?? ctx.org.baseCurrency };
}

/**
 * A journal line's amount in its account's currency: the transaction amount
 * on a foreign-currency account, the base amount otherwise (so a line in any
 * currency posted to a base-currency bank account counts at what it moved).
 */
export const lineAccountAmountSql = sql`case when a.currency is not null then l.txn_amount else l.base_amount end`;

export function lineAccountAmount(line: { baseAmount: string; txnAmount: string }, accountCurrency: string | null): Decimal {
  return Decimal.from(accountCurrency ? line.txnAmount : line.baseAmount);
}

/**
 * The duplicate-detection fingerprint: account, date, amount, normalized
 * description and the occurrence of that combination within its file, so
 * two identical coffees on one day in one file are two transactions, and the
 * same file imported twice yields the same fingerprints.
 */
export function fingerprint(accountId: string, date: string, amount: Decimal, description: string, occurrence: number): string {
  return createHash("sha256")
    .update(`${accountId}|${date}|${amount.normalize().toString()}|${normalizeDescription(description)}|${occurrence}`)
    .digest("hex")
    .slice(0, 40);
}

/** Similarity of two short texts by shared words (0–1). */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const wa = new Set(normalizeDescription(a ?? "").split(" ").filter((w) => w.length >= 3));
  const wb = new Set(normalizeDescription(b ?? "").split(" ").filter((w) => w.length >= 3));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

/** Waiting for a person: unreviewed, or auto-categorized by a rule and not yet confirmed. */
export function reviewCondition() {
  return or(eq(bankTransactions.status, "unreviewed"), and(eq(bankTransactions.autoCategorized, true), isNull(bankTransactions.reviewedAt)))!;
}
