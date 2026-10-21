/**
 * Reviewing bank transactions: suggestions, matching to what the books
 * already hold, categorizing (with splits and fees), transfers, recording a
 * payment from a transaction, excluding, and undoing any of these.
 *
 * Nothing here posts on its own: every posting follows a person's action
 * (or a rule they allowed to post, in rules.ts).
 */
import { and, asc, desc, eq, gte, ilike, inArray, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { getDb, pgErrorCode, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { bankMatchGroups, bankMatchItems, bankRuleApplications, bankRules, bankTransactions, reconciliationLines, reconciliations } from "@/lib/db/schema/banking";
import { accounts, contacts, journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, daysBetween, todayIn } from "@/lib/dates";
import { resolveRate } from "@/lib/fx/rates";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { recordPayment, type AllocationInput } from "@/lib/commerce/payments";
import type { PaymentKind } from "@/lib/db/schema/commerce";
import { lineAccountAmount, loadMoneyAccount, reviewCondition, textSimilarity, type MoneyAccount } from "./common";
import { firstMatchingRule, type BankRule, type ComputedSplit } from "./rules-engine";

export type BankTxn = typeof bankTransactions.$inferSelect;

// ── Listing ─────────────────────────────────────────────────────────────────

export interface TxnFilters {
  accountId?: string;
  /** "review": unreviewed, plus auto-categorized ones not yet confirmed. */
  status?: "review" | "unreviewed" | "matched" | "categorized" | "excluded" | "all";
  from?: string;
  to?: string;
  q?: string;
  page?: number;
  pageSize?: number;
  sort?: "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
}

export { reviewCondition };

export async function listBankTransactions(db: DbOrTx, orgId: string, f: TxnFilters = {}) {
  const conds: SQL[] = [eq(bankTransactions.orgId, orgId), ne(bankTransactions.status, "removed")];
  if (f.accountId) conds.push(eq(bankTransactions.accountId, f.accountId));
  const status = f.status ?? "review";
  if (status === "review") conds.push(reviewCondition());
  else if (status !== "all") conds.push(eq(bankTransactions.status, status));
  if (f.from) conds.push(gte(bankTransactions.postedDate, f.from));
  if (f.to) conds.push(lte(bankTransactions.postedDate, f.to));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(bankTransactions.description, like), ilike(bankTransactions.payee, like), ilike(bankTransactions.reference, like))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order =
    f.sort === "date_asc"
      ? [asc(bankTransactions.postedDate), asc(bankTransactions.createdAt)]
      : f.sort === "amount_desc"
        ? [desc(bankTransactions.amount)]
        : f.sort === "amount_asc"
          ? [asc(bankTransactions.amount)]
          : [desc(bankTransactions.postedDate), desc(bankTransactions.createdAt)];
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db
      .select({ txn: bankTransactions, accountName: accounts.name, accountCode: accounts.code })
      .from(bankTransactions)
      .innerJoin(accounts, and(eq(accounts.orgId, bankTransactions.orgId), eq(accounts.id, bankTransactions.accountId)))
      .where(where)
      .orderBy(...order)
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(bankTransactions).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

export async function getBankTransaction(db: DbOrTx, orgId: string, id: string) {
  const [txn] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.id, id)));
  if (!txn) throw new NotFoundError("The bank transaction");
  let group: typeof bankMatchGroups.$inferSelect | null = null;
  let items: { item: typeof bankMatchItems.$inferSelect; line: typeof journalLines.$inferSelect | null; entry: typeof journalEntries.$inferSelect | null; txn: BankTxn | null }[] = [];
  if (txn.matchGroupId) {
    group = (await db.select().from(bankMatchGroups).where(and(eq(bankMatchGroups.orgId, orgId), eq(bankMatchGroups.id, txn.matchGroupId))))[0] ?? null;
    const rows = await db.select().from(bankMatchItems).where(and(eq(bankMatchItems.orgId, orgId), eq(bankMatchItems.groupId, txn.matchGroupId)));
    for (const item of rows) {
      let line = null;
      let entry = null;
      let other = null;
      if (item.journalLineId) {
        [line] = await db.select().from(journalLines).where(and(eq(journalLines.orgId, orgId), eq(journalLines.id, item.journalLineId)));
        if (line) [entry] = await db.select().from(journalEntries).where(and(eq(journalEntries.orgId, orgId), eq(journalEntries.id, line.entryId)));
      }
      if (item.bankTransactionId) [other] = await db.select().from(bankTransactions).where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.id, item.bankTransactionId)));
      items.push({ item, line: line ?? null, entry: entry ?? null, txn: other ?? null });
    }
    items = items.filter((i) => i.item.active || group?.status === "undone");
  }
  const rule = txn.ruleId ? ((await db.select().from(bankRules).where(and(eq(bankRules.orgId, orgId), eq(bankRules.id, txn.ruleId))))[0] ?? null) : null;
  return { txn, group: group ?? null, items, rule };
}

// ── Candidates and suggestions ──────────────────────────────────────────────

export interface CandidateLine {
  lineId: string;
  entryId: string;
  entryNumber: number | null;
  entryDate: string;
  kind: string;
  description: string;
  sourceRef: string | null;
  sourceType: string | null;
  sourceId: string | null;
  contactName: string | null;
  /** Signed, in the account's currency. */
  amount: string;
}

/** Posted lines on a money account that are not yet matched to bank transactions. */
export async function unmatchedLines(db: DbOrTx, ctx: Ctx, accountId: string, opts: { from?: string; to?: string; q?: string; limit?: number } = {}): Promise<CandidateLine[]> {
  const res = await db.execute<{
    line_id: string;
    entry_id: string;
    entry_number: number | null;
    entry_date: string;
    kind: string;
    description: string;
    source_ref: string | null;
    source_type: string | null;
    source_id: string | null;
    contact_name: string | null;
    amount: string;
  }>(sql`
    select l.id as line_id, e.id as entry_id, e.entry_number, e.entry_date, e.kind,
           coalesce(nullif(l.description, ''), e.description) as description, e.source_ref, e.source_type, e.source_id::text,
           c.display_name as contact_name,
           (case when a.currency is not null then l.txn_amount else l.base_amount end)::text as amount
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    left join contacts c on c.org_id = l.org_id and c.id = l.contact_id
    where l.org_id = ${ctx.orgId} and l.account_id = ${accountId} and e.status = 'posted'
      and not exists (select 1 from bank_match_items mi where mi.org_id = l.org_id and mi.journal_line_id = l.id and mi.active)
      ${opts.from ? sql`and e.entry_date >= ${opts.from}` : sql``}
      ${opts.to ? sql`and e.entry_date <= ${opts.to}` : sql``}
      ${opts.q ? sql`and (e.description ilike ${`%${opts.q}%`} or e.source_ref ilike ${`%${opts.q}%`} or c.display_name ilike ${`%${opts.q}%`} or (case when a.currency is not null then l.txn_amount else l.base_amount end)::text like ${`${opts.q.replace(/[^0-9.\-]/g, "")}%`})` : sql``}
    order by e.entry_date desc, e.entry_number desc
    limit ${opts.limit ?? 200}
  `);
  return res.rows.map((r) => ({
    lineId: r.line_id,
    entryId: r.entry_id,
    entryNumber: r.entry_number,
    entryDate: r.entry_date,
    kind: r.kind,
    description: r.description,
    sourceRef: r.source_ref,
    sourceType: r.source_type,
    sourceId: r.source_id,
    contactName: r.contact_name,
    amount: r.amount,
  }));
}

export type Suggestion =
  | { type: "match"; score: number; line: CandidateLine }
  | { type: "transfer"; score: number; counterpart: BankTxn; accountName: string }
  | { type: "invoice" | "bill"; score: number; documentId: string; number: string | null; contactId: string; contactName: string; openAmount: string; currency: string }
  | { type: "rule"; score: number; rule: BankRule; splits: ComputedSplit[] };

function dateScore(a: string, b: string, window: number) {
  const d = Math.abs(daysBetween(a, b));
  return d > window ? -1 : 1 - d / (window + 1);
}

/** Suggestions for several transactions at once (one query per kind, not per transaction). */
export async function suggestionsForMany(db: DbOrTx, ctx: Ctx, txns: BankTxn[]): Promise<Map<string, Suggestion[]>> {
  const out = new Map<string, Suggestion[]>();
  if (!txns.length) return out;
  const dates = txns.map((t) => t.postedDate).sort();
  const from = addDays(dates[0]!, -30);
  const to = addDays(dates[dates.length - 1]!, 30);
  const byAccount = new Map<string, CandidateLine[]>();
  for (const accountId of new Set(txns.map((t) => t.accountId))) {
    byAccount.set(accountId, await unmatchedLines(db, ctx, accountId, { from, to, limit: 2000 }));
  }
  const others = await db
    .select({ txn: bankTransactions, accountName: accounts.name })
    .from(bankTransactions)
    .innerJoin(accounts, and(eq(accounts.orgId, bankTransactions.orgId), eq(accounts.id, bankTransactions.accountId)))
    .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.status, "unreviewed"), gte(bankTransactions.postedDate, addDays(dates[0]!, -7)), lte(bankTransactions.postedDate, addDays(dates[dates.length - 1]!, 7))));
  const openDocs = await db.execute<{ id: string; kind: string; number: string | null; reference: string | null; contact_id: string; contact_name: string; currency: string; open: string }>(sql`
    select d.id, d.kind, d.number, d.reference, d.contact_id, c.display_name as contact_name, d.currency,
           abs(sum(l.txn_amount))::text as open
    from documents d
    join contacts c on c.org_id = d.org_id and c.id = d.contact_id
    join journal_lines l on l.org_id = d.org_id and l.open_item_id = d.id
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status = 'posted'
    where d.org_id = ${ctx.orgId} and d.kind in ('invoice', 'bill') and d.status in ('issued', 'partially_paid')
    group by d.id, c.display_name
    having sum(l.txn_amount) <> 0
  `);
  const rules = await db.select().from(bankRules).where(and(eq(bankRules.orgId, ctx.orgId), eq(bankRules.isActive, true)));

  for (const t of txns) {
    const s: Suggestion[] = [];
    const amount = Decimal.from(t.amount);
    for (const line of byAccount.get(t.accountId) ?? []) {
      if (!Decimal.from(line.amount).eq(amount)) continue;
      const ds = dateScore(t.postedDate, line.entryDate, 7);
      if (ds < 0) continue;
      let score = 60 + 30 * ds + 10 * Math.max(textSimilarity(`${t.description} ${t.payee ?? ""}`, `${line.description} ${line.contactName ?? ""}`), 0);
      if (t.reference && line.sourceRef && t.reference.trim() === line.sourceRef.trim()) score += 20;
      s.push({ type: "match", score, line });
    }
    for (const o of others) {
      if (o.txn.id === t.id || o.txn.accountId === t.accountId || o.txn.currency !== t.currency) continue;
      if (!Decimal.from(o.txn.amount).eq(amount.neg())) continue;
      const ds = dateScore(t.postedDate, o.txn.postedDate, 5);
      if (ds < 0) continue;
      s.push({ type: "transfer", score: 50 + 30 * ds, counterpart: o.txn, accountName: o.accountName });
    }
    for (const d of openDocs.rows) {
      const isInvoice = d.kind === "invoice";
      if ((isInvoice && !amount.isPositive()) || (!isInvoice && !amount.isNegative())) continue;
      if (d.currency !== t.currency || !Decimal.from(d.open).eq(amount.abs())) continue;
      const sim = Math.max(textSimilarity(`${t.description} ${t.payee ?? ""}`, d.contact_name), textSimilarity(t.reference, d.number ?? d.reference));
      s.push({
        type: isInvoice ? "invoice" : "bill",
        score: 40 + 40 * sim,
        documentId: d.id,
        number: d.number ?? d.reference,
        contactId: d.contact_id,
        contactName: d.contact_name,
        openAmount: d.open,
        currency: d.currency,
      });
    }
    const r = firstMatchingRule(rules, { accountId: t.accountId, amount: t.amount, description: t.description, payee: t.payee, currency: t.currency });
    if (r) s.push({ type: "rule", score: 75, rule: r.rule, splits: r.splits });
    s.sort((a, b) => b.score - a.score);
    out.set(t.id, s.slice(0, 6));
  }
  return out;
}

// ── Shared steps ────────────────────────────────────────────────────────────

async function lockTxns(tx: Tx, ctx: Ctx, ids: string[]): Promise<BankTxn[]> {
  if (!ids.length) return [];
  const rows = await tx
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, ids)))
    .orderBy(asc(bankTransactions.id))
    .for("update");
  if (rows.length !== new Set(ids).size) throw new NotFoundError("A bank transaction");
  return rows;
}

function assertReviewable(t: BankTxn) {
  if (t.status !== "unreviewed") {
    throw new ConflictError(`The bank transaction “${t.description}” on ${t.postedDate} is already ${t.status}. Undo that first.`, "not_unreviewed", { id: t.id, status: t.status });
  }
}

async function postingRate(tx: Tx, ctx: Ctx, account: MoneyAccount, date: string) {
  if (account.currencyResolved === ctx.org.baseCurrency) return {};
  const r = await resolveRate(tx, ctx, account.currencyResolved, date);
  return { fxRate: r.rate.toString(), exchangeRateId: r.exchangeRateId };
}

async function createGroup(
  tx: Tx,
  ctx: Ctx,
  input: { accountId: string; kind: "match" | "categorized" | "transfer" | "payment"; entryId?: string | null; ruleId?: string | null; txns: BankTxn[]; lines: { id: string; amount: Decimal }[] },
) {
  const [g] = await tx
    .insert(bankMatchGroups)
    .values({ orgId: ctx.orgId, accountId: input.accountId, kind: input.kind, entryId: input.entryId ?? null, ruleId: input.ruleId ?? null, createdBy: ctx.actor.userId })
    .returning();
  const items = [
    ...input.txns.map((t) => ({ orgId: ctx.orgId, groupId: g!.id, bankTransactionId: t.id, journalLineId: null, amount: t.amount })),
    ...input.lines.map((l) => ({ orgId: ctx.orgId, groupId: g!.id, bankTransactionId: null, journalLineId: l.id, amount: l.amount.toString() })),
  ];
  if (items.length) await tx.insert(bankMatchItems).values(items);
  return g!;
}

// ── Match ───────────────────────────────────────────────────────────────────

/**
 * Match bank transactions to journal lines already in the books — one to
 * one, several bank transactions to one deposit, or one bank transaction to
 * several lines. The two sides must add up exactly.
 */
export async function matchTransactions(ctx: Ctx, input: { bankTransactionIds: string[]; journalLineIds: string[] }) {
  requirePermission(ctx, "banking.categorize");
  if (!input.bankTransactionIds.length || !input.journalLineIds.length) throw new ValidationError("Choose at least one bank transaction and one entry to match.");
  return withTransaction(async (tx) => {
    return matchInTx(tx, ctx, input);
  }).catch((e) => {
    if (pgErrorCode(e) === "23505") throw new ConflictError("Another match took one of these first. Refresh and try again.", "already_matched");
    throw e;
  });
}

async function matchInTx(tx: Tx, ctx: Ctx, input: { bankTransactionIds: string[]; journalLineIds: string[] }) {
  const txns = await lockTxns(tx, ctx, input.bankTransactionIds);
  txns.forEach(assertReviewable);
  const accountId = txns[0]!.accountId;
  if (txns.some((t) => t.accountId !== accountId)) throw new ValidationError("Matched bank transactions must all be on the same account.");
  const account = await loadMoneyAccount(tx, ctx, accountId);
  const lines = await tx
    .select({ line: journalLines, entry: journalEntries })
    .from(journalLines)
    .innerJoin(journalEntries, and(eq(journalEntries.orgId, journalLines.orgId), eq(journalEntries.id, journalLines.entryId)))
    .where(and(eq(journalLines.orgId, ctx.orgId), inArray(journalLines.id, input.journalLineIds)));
  if (lines.length !== new Set(input.journalLineIds).size) throw new NotFoundError("A journal line");
  for (const { line, entry } of lines) {
    if (line.accountId !== accountId) throw new ValidationError("Every entry line must be on the same account as the bank transactions.");
    if (entry.status !== "posted") throw new ValidationError("Only posted entries can be matched.");
  }
  const taken = await tx
    .select({ id: bankMatchItems.journalLineId })
    .from(bankMatchItems)
    .where(and(eq(bankMatchItems.orgId, ctx.orgId), inArray(bankMatchItems.journalLineId, input.journalLineIds), eq(bankMatchItems.active, true)));
  if (taken.length) throw new ConflictError("One of those entries is already matched to another bank transaction.", "line_already_matched");
  const bankSum = Decimal.sum(txns.map((t) => t.amount));
  const lineAmounts = lines.map(({ line }) => ({ id: line.id, amount: lineAccountAmount(line, account.currency) }));
  const lineSum = Decimal.sum(lineAmounts.map((l) => l.amount));
  if (!bankSum.eq(lineSum)) {
    throw new ValidationError(
      `The bank side totals ${bankSum.toString()} and the books side ${lineSum.toString()} ${account.currencyResolved}; a match must add up exactly (difference ${bankSum.sub(lineSum).toString()}).`,
      { amount: "Totals differ." },
      { bank: bankSum.toString(), books: lineSum.toString() },
    );
  }
  const g = await createGroup(tx, ctx, { accountId, kind: "match", txns, lines: lineAmounts });
  await tx
    .update(bankTransactions)
    .set({ status: "matched", matchGroupId: g.id, reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, txns.map((t) => t.id))));
  await audit(tx, ctx, { action: "banking.matched", entityType: "bank_match_group", entityId: g.id, metadata: { transactions: txns.map((t) => t.id), lines: input.journalLineIds, amount: bankSum.toString() } });
  return g;
}

// ── Categorize ──────────────────────────────────────────────────────────────

export interface SplitInput {
  accountId: string;
  /** Positive amount in the account's currency. */
  amount: string;
  description?: string | null;
  contactId?: string | null;
  projectId?: string | null;
  classId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  fundId?: string | null;
}

/**
 * Post a bank transaction as a new entry: the bank account against one or
 * more category lines (a split; a fee is one more line). Runs inside the
 * caller's transaction (rules auto-categorize through this too).
 */
export async function categorizeInTx(
  tx: Tx,
  ctx: Ctx,
  txn: BankTxn,
  input: { splits: SplitInput[]; memo?: string | null; contactId?: string | null; postingDate?: string | null; ruleId?: string | null; auto?: boolean },
) {
  assertReviewable(txn);
  const account = await loadMoneyAccount(tx, ctx, txn.accountId);
  const mu = minorUnits(account.currencyResolved);
  const amount = Decimal.from(txn.amount);
  if (!input.splits.length) throw new ValidationError("Choose at least one category.", { splits: "Required." });
  const fields: Record<string, string> = {};
  const splits = input.splits.map((s, i) => {
    const a = Decimal.tryFrom(String(s.amount).replace(/[,\s$]/g, ""));
    if (!s.accountId) fields[`splits.${i}.accountId`] = "Choose an account.";
    if (s.accountId === account.id) fields[`splits.${i}.accountId`] = "Choose an account other than this bank account (use a transfer between money accounts).";
    if (!a || !a.isPositive()) fields[`splits.${i}.amount`] = "Enter a positive amount.";
    else if (a.decimalPlaces > mu) fields[`splits.${i}.amount`] = `At most ${mu} decimal places.`;
    return { ...s, value: a ?? Decimal.ZERO };
  });
  if (Object.keys(fields).length) throw new ValidationError("Check the categories.", fields);
  const total = Decimal.sum(splits.map((s) => s.value));
  if (!total.eq(amount.abs())) {
    throw new ValidationError(`The categories add up to ${total.toString()}; the transaction is ${amount.abs().toString()} ${account.currencyResolved}.`, { splits: "Must add up to the transaction." });
  }
  const date = input.postingDate || txn.postedDate;
  const fx = await postingRate(tx, ctx, account, date);
  const sign = amount.isPositive() ? 1 : -1;
  const contactId = input.contactId ?? (new Set(splits.map((s) => s.contactId ?? null)).size === 1 ? (splits[0]!.contactId ?? null) : null);
  const lines: LineInput[] = [
    { accountId: account.id, amount: amount.toString(), currency: account.currencyResolved, ...fx, description: txn.description, contactId },
    ...splits.map((s) => ({
      accountId: s.accountId,
      amount: s.value.mul(-sign).toString(),
      currency: account.currencyResolved,
      ...fx,
      description: s.description?.trim() || input.memo?.trim() || txn.description,
      contactId: s.contactId ?? contactId,
      projectId: s.projectId ?? null,
      classId: s.classId ?? null,
      departmentId: s.departmentId ?? null,
      locationId: s.locationId ?? null,
      fundId: s.fundId ?? null,
    })),
  ];
  const [g] = await tx
    .insert(bankMatchGroups)
    .values({ orgId: ctx.orgId, accountId: account.id, kind: "categorized", ruleId: input.ruleId ?? null, createdBy: ctx.actor.userId })
    .returning();
  const posted = await postEntry(tx, ctx, {
    kind: "bank",
    entryDate: date,
    documentDate: txn.postedDate,
    description: (input.memo?.trim() || txn.description || "Bank transaction").slice(0, 500),
    sourceType: "bank_transaction",
    sourceId: txn.id,
    sourceRef: txn.reference,
    idempotencyKey: `bank:${g!.id}`,
    lines,
  });
  const bankLine = posted.lines.find((l) => l.accountId === account.id && l.lineNo === 1)!;
  await tx.update(bankMatchGroups).set({ entryId: posted.entry.id }).where(eq(bankMatchGroups.id, g!.id));
  await tx.insert(bankMatchItems).values([
    { orgId: ctx.orgId, groupId: g!.id, bankTransactionId: txn.id, journalLineId: null, amount: txn.amount },
    { orgId: ctx.orgId, groupId: g!.id, bankTransactionId: null, journalLineId: bankLine.id, amount: lineAccountAmount(bankLine, account.currency).toString() },
  ]);
  await tx
    .update(bankTransactions)
    .set({
      status: "categorized",
      matchGroupId: g!.id,
      ruleId: input.ruleId ?? txn.ruleId,
      autoCategorized: !!input.auto,
      reviewedBy: input.auto ? null : ctx.actor.userId,
      reviewedAt: input.auto ? null : new Date(),
      updatedAt: new Date(),
    })
    .where(eq(bankTransactions.id, txn.id));
  await audit(tx, ctx, {
    action: input.auto ? "banking.auto_categorized" : "banking.categorized",
    entityType: "bank_transaction",
    entityId: txn.id,
    metadata: { entryId: posted.entry.id, ruleId: input.ruleId ?? null, splits: splits.map((s) => ({ accountId: s.accountId, amount: s.value.toString() })) },
  });
  return { group: { ...g!, entryId: posted.entry.id }, entry: posted.entry };
}

export async function categorizeTransaction(ctx: Ctx, txnId: string, input: { splits: SplitInput[]; memo?: string | null; contactId?: string | null; postingDate?: string | null; ruleId?: string | null }) {
  requirePermission(ctx, "banking.categorize");
  return withTransaction(async (tx) => {
    const [txn] = await lockTxns(tx, ctx, [txnId]);
    const r = await categorizeInTx(tx, ctx, txn!, input);
    if (input.ruleId) await tx.insert(bankRuleApplications).values({ orgId: ctx.orgId, ruleId: input.ruleId, bankTransactionId: txnId, outcome: "accepted", entryId: r.entry.id, actorUserId: ctx.actor.userId });
    return r;
  });
}

// ── Transfer ────────────────────────────────────────────────────────────────

/**
 * Money moved between two of the organization's own money accounts. The
 * other account's bank transaction, if already imported, is matched too.
 */
export async function transferTransaction(ctx: Ctx, txnId: string, input: { toAccountId: string; counterpartId?: string | null; memo?: string | null }) {
  requirePermission(ctx, "banking.categorize");
  return withTransaction(async (tx) => {
    const ids = [txnId, ...(input.counterpartId ? [input.counterpartId] : [])];
    const locked = await lockTxns(tx, ctx, ids);
    const txn = locked.find((t) => t.id === txnId)!;
    assertReviewable(txn);
    const from = await loadMoneyAccount(tx, ctx, txn.accountId);
    const to = await loadMoneyAccount(tx, ctx, input.toAccountId);
    if (from.id === to.id) throw new ValidationError("Choose a different account to transfer to.", { toAccountId: "Same account." });
    if (from.currencyResolved !== to.currencyResolved) {
      throw new ValidationError(`${from.name} is in ${from.currencyResolved} and ${to.name} in ${to.currencyResolved}. Record a currency exchange with a journal entry, then match it.`, { toAccountId: "Different currency." });
    }
    const counterpart = input.counterpartId ? locked.find((t) => t.id === input.counterpartId)! : null;
    if (counterpart) {
      assertReviewable(counterpart);
      if (counterpart.accountId !== to.id) throw new ValidationError("The other transaction is not on the account being transferred to.");
      if (!Decimal.from(counterpart.amount).eq(Decimal.from(txn.amount).neg())) throw new ValidationError("The other side of a transfer must be the same amount in the opposite direction.");
    }
    const fx = await postingRate(tx, ctx, from, txn.postedDate);
    const amount = Decimal.from(txn.amount);
    const description = input.memo?.trim() || `Transfer ${amount.isNegative() ? "to" : "from"} ${to.name}`;
    const [g] = await tx.insert(bankMatchGroups).values({ orgId: ctx.orgId, accountId: from.id, kind: "transfer", createdBy: ctx.actor.userId }).returning();
    const posted = await postEntry(tx, ctx, {
      kind: "transfer",
      entryDate: txn.postedDate,
      description,
      sourceType: "bank_transaction",
      sourceId: txn.id,
      sourceRef: txn.reference,
      idempotencyKey: `bank:${g!.id}`,
      lines: [
        { accountId: from.id, amount: amount.toString(), currency: from.currencyResolved, ...fx, description },
        { accountId: to.id, amount: amount.neg().toString(), currency: to.currencyResolved, ...fx, description },
      ],
    });
    const fromLine = posted.lines.find((l) => l.accountId === from.id)!;
    const toLine = posted.lines.find((l) => l.accountId === to.id)!;
    await tx.update(bankMatchGroups).set({ entryId: posted.entry.id }).where(eq(bankMatchGroups.id, g!.id));
    await tx.insert(bankMatchItems).values([
      { orgId: ctx.orgId, groupId: g!.id, bankTransactionId: txn.id, journalLineId: null, amount: txn.amount },
      { orgId: ctx.orgId, groupId: g!.id, bankTransactionId: null, journalLineId: fromLine.id, amount: lineAccountAmount(fromLine, from.currency).toString() },
    ]);
    await tx.update(bankTransactions).set({ status: "categorized", matchGroupId: g!.id, reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(bankTransactions.id, txn.id));
    if (counterpart) {
      const g2 = await createGroup(tx, ctx, { accountId: to.id, kind: "transfer", entryId: posted.entry.id, txns: [counterpart], lines: [{ id: toLine.id, amount: lineAccountAmount(toLine, to.currency) }] });
      await tx.update(bankTransactions).set({ status: "categorized", matchGroupId: g2.id, reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(bankTransactions.id, counterpart.id));
    }
    await audit(tx, ctx, { action: "banking.transferred", entityType: "bank_transaction", entityId: txn.id, metadata: { entryId: posted.entry.id, toAccountId: to.id, counterpartId: counterpart?.id ?? null } });
    return { entry: posted.entry };
  });
}

// ── Payment from a transaction ──────────────────────────────────────────────

const INFLOW_KINDS: PaymentKind[] = ["customer_payment", "customer_deposit", "vendor_refund"];
const OUTFLOW_KINDS: PaymentKind[] = ["vendor_payment", "vendor_prepayment", "customer_refund"];

/**
 * Record a customer or vendor payment (or refund, deposit, prepayment) from
 * a bank transaction and match it. The payment is applied to the documents
 * chosen; anything not applied stays as an open credit.
 */
export async function recordPaymentFromTransaction(
  ctx: Ctx,
  txnId: string,
  input: { kind: PaymentKind; contactId: string; allocations?: AllocationInput[]; feeAmount?: string | null; feeAccountId?: string | null; currency?: string | null; memo?: string | null },
) {
  requirePermission(ctx, "banking.categorize", "payments.record");
  return withTransaction(async (tx) => {
    const [txn] = await lockTxns(tx, ctx, [txnId]);
    assertReviewable(txn!);
    const amount = Decimal.from(txn!.amount);
    if (amount.isPositive() && !INFLOW_KINDS.includes(input.kind)) throw new ValidationError("Money came in: record a customer payment, a deposit or a vendor refund.");
    if (amount.isNegative() && !OUTFLOW_KINDS.includes(input.kind)) throw new ValidationError("Money went out: record a vendor payment, a prepayment or a customer refund.");
    const account = await loadMoneyAccount(tx, ctx, txn!.accountId);
    const fee = input.feeAmount ? Decimal.tryFrom(input.feeAmount.replace(/[,\s$]/g, "")) : null;
    const currency = input.currency || account.currencyResolved;
    const cross = currency !== account.currencyResolved;
    if (cross && fee && !fee.isZero()) throw new ValidationError("A fee can be recorded only when the payment is in the account's currency.", { feeAmount: "Not with a conversion." });
    if (cross && !input.allocations?.length) throw new ValidationError("A foreign-currency payment into this account needs the documents it pays (to know the amount in their currency).");
    const gross = fee && !fee.isZero() ? amount.abs().add(fee) : amount.abs();
    const docAmount = cross ? Decimal.sum((input.allocations ?? []).map((a) => Decimal.from(a.amount))) : gross;
    const payment = await recordPayment(
      ctx,
      {
        kind: input.kind,
        contactId: input.contactId,
        paymentDate: txn!.postedDate,
        accountId: account.id,
        currency,
        amount: docAmount.toString(),
        ...(cross ? { accountAmount: amount.abs().toString() } : {}),
        ...(fee && !fee.isZero() ? { feeAmount: fee.toString(), feeAccountId: input.feeAccountId ?? null } : {}),
        method: "ach",
        reference: txn!.reference ?? null,
        memo: input.memo?.trim() || txn!.description,
        allocations: input.allocations ?? [],
      },
      { tx },
    );
    const [line] = await tx
      .select()
      .from(journalLines)
      .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.entryId, payment.journalEntryId!), eq(journalLines.accountId, account.id)));
    if (!line) throw new Error("payment posted without a bank line");
    const lineAmt = lineAccountAmount(line, account.currency);
    if (!lineAmt.eq(amount)) {
      throw new ValidationError(`The payment moved ${lineAmt.toString()} through the account but the bank shows ${amount.toString()}. Check the fee and amounts.`);
    }
    const g = await createGroup(tx, ctx, { accountId: account.id, kind: "payment", txns: [txn!], lines: [{ id: line.id, amount: lineAmt }] });
    await tx.update(bankTransactions).set({ status: "matched", matchGroupId: g.id, reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(bankTransactions.id, txnId));
    await audit(tx, ctx, { action: "banking.payment_recorded", entityType: "bank_transaction", entityId: txnId, metadata: { paymentId: payment.id, kind: input.kind } });
    return payment;
  });
}

// ── Exclude, confirm, undo ──────────────────────────────────────────────────

export async function excludeTransactions(ctx: Ctx, txnIds: string[], reason: string) {
  requirePermission(ctx, "banking.categorize");
  if (!reason?.trim()) throw new ValidationError("Say why (a duplicate, a personal charge, …).", { reason: "Required." });
  await withTransaction(async (tx) => {
    const txns = await lockTxns(tx, ctx, txnIds);
    txns.forEach(assertReviewable);
    await tx
      .update(bankTransactions)
      .set({ status: "excluded", statusReason: reason.trim(), reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, txnIds)));
    for (const t of txns) await audit(tx, ctx, { action: "banking.excluded", entityType: "bank_transaction", entityId: t.id, reason: reason.trim() });
  });
}

export async function restoreTransaction(ctx: Ctx, txnId: string) {
  requirePermission(ctx, "banking.categorize");
  await withTransaction(async (tx) => {
    const [t] = await lockTxns(tx, ctx, [txnId]);
    if (t!.status !== "excluded") throw new ConflictError("Only an excluded transaction can be restored.", "not_excluded");
    await tx.update(bankTransactions).set({ status: "unreviewed", statusReason: null, reviewedBy: null, reviewedAt: null, updatedAt: new Date() }).where(eq(bankTransactions.id, txnId));
    await audit(tx, ctx, { action: "banking.restored", entityType: "bank_transaction", entityId: txnId });
  });
}

/** Confirm auto-categorized transactions after looking at them. */
export async function confirmReviewed(ctx: Ctx, txnIds: string[]) {
  requirePermission(ctx, "banking.categorize");
  await withTransaction(async (tx) => {
    const txns = await lockTxns(tx, ctx, txnIds);
    for (const t of txns) {
      if (!t.autoCategorized || t.reviewedAt) continue;
      await tx.update(bankTransactions).set({ reviewedBy: ctx.actor.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(bankTransactions.id, t.id));
      await audit(tx, ctx, { action: "banking.auto_categorization_confirmed", entityType: "bank_transaction", entityId: t.id });
    }
  });
}

/** Whether any of these journal lines is cleared by a completed reconciliation or checked in one in progress. */
async function reconciledLines(tx: Tx, orgId: string, lineIds: string[]) {
  if (!lineIds.length) return [];
  return tx
    .select({ lineId: reconciliationLines.journalLineId, status: reconciliations.status, statementDate: reconciliations.statementDate })
    .from(reconciliationLines)
    .innerJoin(reconciliations, and(eq(reconciliations.orgId, reconciliationLines.orgId), eq(reconciliations.id, reconciliationLines.reconciliationId)))
    .where(and(eq(reconciliationLines.orgId, orgId), inArray(reconciliationLines.journalLineId, lineIds), eq(reconciliationLines.active, true)));
}

/**
 * Undo a match, categorization, transfer or payment match. A categorization
 * or transfer entry is reversed (with the reason); a payment stays recorded
 * (void it from its own page) and is only unmatched.
 */
export async function undoMatch(ctx: Ctx, groupId: string, reason: string) {
  requirePermission(ctx, "banking.categorize");
  if (!reason?.trim()) throw new ValidationError("Say why it is being undone.", { reason: "Required." });
  return withTransaction(async (tx) => {
    const [g] = await tx.select().from(bankMatchGroups).where(and(eq(bankMatchGroups.orgId, ctx.orgId), eq(bankMatchGroups.id, groupId))).for("update");
    if (!g) throw new NotFoundError("The match");
    if (g.status !== "active") throw new ConflictError("This was already undone.", "already_undone");
    // A transfer posted one entry matched on two accounts: undo both sides together.
    const groups = g.entryId && g.kind === "transfer"
      ? await tx.select().from(bankMatchGroups).where(and(eq(bankMatchGroups.orgId, ctx.orgId), eq(bankMatchGroups.entryId, g.entryId), eq(bankMatchGroups.status, "active"))).for("update")
      : [g];
    const groupIds = groups.map((x) => x.id);
    const items = await tx.select().from(bankMatchItems).where(and(eq(bankMatchItems.orgId, ctx.orgId), inArray(bankMatchItems.groupId, groupIds), eq(bankMatchItems.active, true)));
    const lineIds = items.map((i) => i.journalLineId).filter(Boolean) as string[];
    if (g.entryId) {
      const entryLines = await tx.select({ id: journalLines.id }).from(journalLines).where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.entryId, g.entryId)));
      lineIds.push(...entryLines.map((l) => l.id));
    }
    const cleared = await reconciledLines(tx, ctx.orgId, [...new Set(lineIds)]);
    if (cleared.some((c) => c.status === "completed")) {
      throw new ConflictError(`The entry is cleared in the reconciliation to ${cleared.find((c) => c.status === "completed")!.statementDate}. Undo that reconciliation first.`, "reconciled");
    }
    if (cleared.some((c) => c.status === "in_progress")) {
      throw new ConflictError("The entry is checked off in a reconciliation in progress. Uncheck it there first.", "in_reconciliation");
    }
    let reversalId: string | null = null;
    if (g.entryId && (g.kind === "categorized" || g.kind === "transfer")) {
      const [entry] = await tx.select().from(journalEntries).where(and(eq(journalEntries.orgId, ctx.orgId), eq(journalEntries.id, g.entryId)));
      const today = todayIn(ctx.org.timezone);
      const date = entry && today < entry.entryDate ? entry.entryDate : today;
      const rev = await reverseEntryInternal(tx, ctx, g.entryId, { date, reason: `Bank ${g.kind === "transfer" ? "transfer" : "categorization"} undone: ${reason.trim()}` });
      reversalId = rev.entry.id;
    }
    await tx.update(bankMatchItems).set({ active: false }).where(and(eq(bankMatchItems.orgId, ctx.orgId), inArray(bankMatchItems.groupId, groupIds)));
    await tx
      .update(bankMatchGroups)
      .set({ status: "undone", undoneAt: new Date(), undoneBy: ctx.actor.userId, undoReason: reason.trim() })
      .where(and(eq(bankMatchGroups.orgId, ctx.orgId), inArray(bankMatchGroups.id, groupIds)));
    const txnIds = items.map((i) => i.bankTransactionId).filter(Boolean) as string[];
    if (txnIds.length) {
      await tx
        .update(bankTransactions)
        .set({ status: "unreviewed", matchGroupId: null, autoCategorized: false, reviewedBy: null, reviewedAt: null, updatedAt: new Date() })
        .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, txnIds)));
    }
    if (g.ruleId) {
      for (const id of txnIds) await tx.insert(bankRuleApplications).values({ orgId: ctx.orgId, ruleId: g.ruleId, bankTransactionId: id, outcome: "undone", entryId: reversalId, actorUserId: ctx.actor.userId });
    }
    await audit(tx, ctx, { action: "banking.match_undone", entityType: "bank_match_group", entityId: g.id, reason: reason.trim(), metadata: { kind: g.kind, transactions: txnIds, reversalEntryId: reversalId } });
    return { reversalId };
  });
}

/**
 * Accept the best suggestion for each selected transaction where it is
 * unambiguous: a single exact match, or a rule. Others are left for a
 * person. Each is its own transaction.
 */
export async function acceptSuggestions(ctx: Ctx, txnIds: string[]): Promise<{ accepted: number; skipped: { id: string; reason: string }[] }> {
  requirePermission(ctx, "banking.categorize");
  const db = getDb();
  const txns = await db.select().from(bankTransactions).where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, txnIds)));
  const suggestions = await suggestionsForMany(db, ctx, txns.filter((t) => t.status === "unreviewed"));
  let accepted = 0;
  const skipped: { id: string; reason: string }[] = [];
  for (const t of txns) {
    if (t.status !== "unreviewed") {
      skipped.push({ id: t.id, reason: `already ${t.status}` });
      continue;
    }
    const s = suggestions.get(t.id) ?? [];
    const matches = s.filter((x) => x.type === "match");
    const top = s[0];
    try {
      if (top?.type === "rule") {
        await categorizeTransaction(ctx, t.id, { splits: top.splits.map((sp) => ({ accountId: sp.accountId, amount: sp.amount.toString(), description: sp.description, contactId: top.rule.actions.contactId ?? null, projectId: top.rule.actions.projectId ?? null, classId: top.rule.actions.classId ?? null, departmentId: top.rule.actions.departmentId ?? null, locationId: top.rule.actions.locationId ?? null, fundId: top.rule.actions.fundId ?? null })), memo: top.rule.actions.memo ?? null, ruleId: top.rule.id });
        accepted++;
      } else if (top?.type === "match" && matches.length === 1) {
        await matchTransactions(ctx, { bankTransactionIds: [t.id], journalLineIds: [top.line.lineId] });
        accepted++;
      } else {
        skipped.push({ id: t.id, reason: matches.length > 1 ? "several possible matches" : "no single clear suggestion" });
      }
    } catch (e) {
      skipped.push({ id: t.id, reason: (e as Error).message });
    }
  }
  return { accepted, skipped };
}

/** Contacts for the payment form, with names. */
export async function contactName(db: DbOrTx, orgId: string, id: string) {
  const [c] = await db.select({ name: contacts.displayName }).from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)));
  return c?.name ?? null;
}

