/**
 * Period-end revaluation of foreign-currency balances (unrealized exchange
 * gain or loss), and the automatic reversal of revaluations and accruals.
 *
 * On a revaluation date, every open foreign-currency receivable, payable,
 * deposit and prepayment, and every foreign-currency money account, is
 * restated at that date's rate: the difference between the restated base
 * value and the carried base value is posted against unrealized exchange
 * gain/loss. The entries reverse on the next day, so settlements always
 * relieve the historical rate and the realized gain or loss is measured from
 * it. Base amounts are rounded half-up per item.
 *
 * Open items and money accounts post as two entries: the open-item entry is
 * excluded from cash-basis reports (receivables and payables do not exist on
 * the cash basis); the money-account entry is kept.
 */
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { journalEntries } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { ConflictError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, assertIsoDate, todayIn } from "@/lib/dates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { systemAccountId } from "@/lib/ledger/accounts";
import { isDateOpen } from "@/lib/ledger/periods";
import { requireRate } from "./rates";

export interface RevaluationRow {
  kind: "open_item" | "money_account";
  accountId: string;
  accountCode: string;
  accountName: string;
  openItemType: "document" | "payment" | null;
  openItemId: string | null;
  contactId: string | null;
  reference: string | null;
  currency: string;
  txnBalance: string;
  carriedBase: string;
  rate: string;
  rateDate: string;
  exchangeRateId: string | null;
  revaluedBase: string;
  adjustment: string;
}

export async function previewRevaluation(db: DbOrTx, ctx: Ctx, date: string): Promise<RevaluationRow[]> {
  assertIsoDate(date, "revaluation date");
  const base = ctx.org.baseCurrency;
  const baseMu = minorUnits(base);
  const res = await db.execute<{
    account_id: string;
    code: string;
    name: string;
    control: string | null;
    open_item_type: "document" | "payment" | null;
    open_item_id: string | null;
    contact_id: string | null;
    currency: string;
    txn: string;
    base: string;
  }>(sql`
    select l.account_id, a.code, a.name, a.control, l.open_item_type, l.open_item_id,
           min(l.contact_id::text) as contact_id, l.currency,
           sum(l.txn_amount)::text as txn, sum(l.base_amount)::text as base
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${ctx.orgId} and e.status = 'posted' and e.entry_date <= ${date}
      and l.currency <> ${base}
      and (
        (a.control in ('receivables','payables','customer_deposits','vendor_prepayments') and l.open_item_id is not null)
        or (a.currency is not null and a.currency <> ${base})
      )
    group by l.account_id, a.code, a.name, a.control, l.open_item_type, l.open_item_id, l.currency
    having sum(l.txn_amount) <> 0
  `);
  const refs = new Map<string, string>();
  const ids = res.rows.map((r) => r.open_item_id).filter(Boolean) as string[];
  if (ids.length) {
    const named = await db.execute<{ id: string; ref: string | null }>(sql`
      select id, coalesce(number, reference) as ref from documents where org_id = ${ctx.orgId} and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      union all
      select id, number as ref from payments where org_id = ${ctx.orgId} and id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    `);
    for (const n of named.rows) refs.set(n.id, n.ref ?? "");
  }
  const out: RevaluationRow[] = [];
  const rateCache = new Map<string, Awaited<ReturnType<typeof requireRate>>>();
  for (const r of res.rows) {
    let rate = rateCache.get(r.currency);
    if (!rate) {
      rate = await requireRate(db, ctx.orgId, r.currency, base, date);
      rateCache.set(r.currency, rate);
    }
    // Money accounts aggregate across open items (they have none).
    const revalued = Decimal.from(r.txn).mul(rate.rate).round(baseMu, "half_up");
    const adj = revalued.sub(r.base);
    out.push({
      kind: r.open_item_id ? "open_item" : "money_account",
      accountId: r.account_id,
      accountCode: r.code,
      accountName: r.name,
      openItemType: r.open_item_type,
      openItemId: r.open_item_id,
      contactId: r.contact_id,
      reference: r.open_item_id ? (refs.get(r.open_item_id) ?? null) : null,
      currency: r.currency,
      txnBalance: r.txn,
      carriedBase: r.base,
      rate: rate.rate.toString(),
      rateDate: rate.rateDate,
      exchangeRateId: rate.exchangeRateId,
      revaluedBase: revalued.toString(),
      adjustment: adj.toString(),
    });
  }
  return out;
}

/** Post the revaluation for `date` (one per date; it reverses the next day). */
export async function postRevaluation(ctx: Ctx, date: string): Promise<{ entryIds: string[]; rows: RevaluationRow[] }> {
  requirePermission(ctx, "fx.manage");
  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.orgId, ctx.orgId),
          eq(journalEntries.kind, "fx_revaluation"),
          eq(journalEntries.entryDate, date),
          sql`${journalEntries.reversesEntryId} is null`,
          sql`not exists (select 1 from journal_entries r where r.org_id = ${journalEntries.orgId} and r.reverses_entry_id = ${journalEntries.id})`,
        ),
      )
      .limit(1);
    if (existing) throw new ConflictError(`Balances were already revalued on ${date}. Reverse that revaluation first to run it again.`, "already_revalued");
    const rows = (await previewRevaluation(tx, ctx, date)).filter((r) => !Decimal.from(r.adjustment).isZero());
    const unrealized = await systemAccountId(tx, ctx.orgId, "unrealized_fx");
    const entryIds: string[] = [];
    for (const kind of ["open_item", "money_account"] as const) {
      const group = rows.filter((r) => r.kind === kind);
      if (!group.length) continue;
      const lines: LineInput[] = group.map((r) => ({
        accountId: r.accountId,
        amount: "0",
        currency: r.currency,
        fxRate: r.rate,
        exchangeRateId: r.exchangeRateId,
        baseAmount: r.adjustment,
        contactId: r.contactId,
        openItem: r.openItemType && r.openItemId ? { type: r.openItemType, id: r.openItemId } : null,
        description: `Revalue ${r.reference ?? r.accountName} ${r.txnBalance} ${r.currency} at ${r.rate}`,
      }));
      const total = Decimal.sum(group.map((r) => r.adjustment));
      lines.push({ accountId: unrealized, amount: total.neg().toString(), description: total.isPositive() ? "Unrealized exchange gain" : "Unrealized exchange loss" });
      const posted = await postEntry(tx, ctx, {
        kind: "fx_revaluation",
        entryDate: date,
        description: `Foreign-currency revaluation at ${date} (${kind === "open_item" ? "receivables and payables" : "money accounts"})`,
        sourceType: "fx_revaluation",
        idempotencyKey: `fxreval:${date}:${kind}`,
        cashBasis: kind === "open_item" ? "deferred" : "as_is",
        autoReverseOn: addDays(date, 1),
        isAdjusting: true,
        allowControlAccounts: true,
        lines,
      });
      entryIds.push(posted.entry.id);
    }
    await audit(tx, ctx, { action: "fx.revalued", entityType: "fx_revaluation", entityId: null, metadata: { date, entries: entryIds, items: rows.length } });
    return { entryIds, rows };
  });
}

/**
 * Reverse every posted entry whose auto-reverse date has come (revaluations
 * and accruals). Idempotent: an entry is reversed once. If the reversal date
 * falls in a closed period, the entry is left for a person (the close
 * checklist shows it).
 */
export async function runAutoReversals(orgId: string, today?: string): Promise<{ reversed: number; skipped: number }> {
  const db = getDb();
  const ctx = await systemCtx(orgId, "job: auto-reversals");
  const asOf = today ?? todayIn(ctx.org.timezone);
  const due = await db
    .select()
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.orgId, orgId),
        eq(journalEntries.status, "posted"),
        isNotNull(journalEntries.autoReverseOn),
        lte(journalEntries.autoReverseOn, asOf),
        sql`not exists (select 1 from journal_entries r where r.org_id = ${journalEntries.orgId} and r.reverses_entry_id = ${journalEntries.id})`,
      ),
    );
  let reversed = 0;
  let skipped = 0;
  for (const e of due) {
    if (!(await isDateOpen(db, ctx.org, e.autoReverseOn!))) {
      skipped++;
      continue;
    }
    await withTransaction(async (tx) => {
      await reverseEntryInternal(tx, ctx, e.id, {
        date: e.autoReverseOn!,
        reason: e.kind === "fx_revaluation" ? "Automatic reversal of period-end revaluation" : "Automatic reversal of accrual",
        idempotencyKey: `autoreverse:${e.id}`,
      });
    });
    reversed++;
  }
  return { reversed, skipped };
}
