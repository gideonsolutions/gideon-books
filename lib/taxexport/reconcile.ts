/**
 * The book-to-tax reconciliation for a tax year: each category's book amount
 * (from the mapped accounts' ledger balances, on the chosen basis), its
 * adjustments, and its tax amount; accounts with a balance but no mapping
 * (which block an export from being complete); and the review status.
 *
 * Signs: income-kind and nontaxable categories are credit-positive (income
 * is positive; a returns-and-allowances account shows negative); cost of
 * goods sold, deductions and nondeductible categories are debit-positive.
 */
import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { taxReviews, type TaxReturnType } from "@/lib/db/schema/taxexport";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx, type Org } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { label, loadChart } from "@/lib/reports/accounts";
import { ledgerRows } from "@/lib/reports/ledger";
import type { Basis } from "@/lib/reports/scope";
import type { CategoryKind, TaxCategory } from "./catalogs";
import { allCategories, findSet, currentVersion, getVersion, mappingsOf, type Mapping, type MappingVersion } from "./mappings";
import { listAdjustments, type TaxAdjustment } from "./adjustments";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Which way a category reads: credit-positive (income) or debit-positive (deductions). */
export function creditPositive(kind: CategoryKind): boolean {
  return kind === "income" || kind === "nontaxable";
}

export interface AccountSource {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  dimensionKey: string;
  /** Debit-positive ledger amount for the year. */
  ledgerAmount: string;
  categoryCode: string | null;
  confirmed: boolean;
}

export interface CategoryRow {
  category: TaxCategory;
  bookAmount: Decimal;
  adjustments: Decimal;
  taxAmount: Decimal;
  accounts: string[];
}

export interface Reconciliation {
  returnType: TaxReturnType;
  basis: Basis;
  taxYearStart: string;
  taxYearEnd: string;
  version: MappingVersion | null;
  categories: CategoryRow[];
  sources: AccountSource[];
  unmapped: AccountSource[];
  unconfirmed: number;
  adjustments: TaxAdjustment[];
  bookNetIncome: Decimal;
  taxableBeforeSpecialItems: Decimal;
  entryCount: number;
  lastEntryNumber: number | null;
  dataHash: string;
  review: (typeof taxReviews.$inferSelect) | null;
  reviewCurrent: boolean;
}

/** Find the mapping for a ledger amount: a dimension-specific mapping first, then the account's. */
function resolveMapping(mappings: Mapping[], accountId: string, dims: Record<string, string | null>): Mapping | null {
  const forAccount = mappings.filter((m) => m.accountId === accountId);
  for (const m of forAccount) {
    if (m.dimensionKind && m.dimensionValueId && dims[m.dimensionKind] === m.dimensionValueId) return m;
  }
  return forAccount.find((m) => !m.dimensionKey) ?? null;
}

export async function reconcile(
  db: DbOrTx,
  org: Org,
  opts: { returnType: TaxReturnType; taxYearStart: string; taxYearEnd: string; basis: Basis; versionId?: string | null },
): Promise<Reconciliation> {
  const set = await findSet(db, org.id, opts.returnType);
  const version = opts.versionId ? await getVersion(db, org.id, opts.versionId) : set ? await currentVersion(db, org.id, set.id) : null;
  const mappings = version ? await mappingsOf(db, org.id, version.id) : [];
  const categories = await allCategories(db, org.id, opts.returnType);
  const catMap = new Map(categories.map((c) => [c.code, c]));
  const chart = await loadChart(db, org.id);
  const res = await db.execute<{ account_id: string; project_id: string | null; class_id: string | null; department_id: string | null; location_id: string | null; fund_id: string | null; base: string }>(sql`
    select lr.account_id, lr.project_id::text, lr.class_id::text, lr.department_id::text, lr.location_id::text, lr.fund_id::text, sum(lr.base_amount)::text as base
    from (${ledgerRows(org.id, opts.basis)}) lr
    join accounts a on a.org_id = ${org.id} and a.id = lr.account_id
    where a.type in ('income', 'expense') and lr.entry_date >= ${opts.taxYearStart} and lr.entry_date <= ${opts.taxYearEnd}
    group by lr.account_id, lr.project_id, lr.class_id, lr.department_id, lr.location_id, lr.fund_id
  `);
  const stats = await db.execute<{ n: number; last: number | null }>(sql`
    select count(distinct lr.entry_id)::int as n, max(lr.entry_number)::int as last
    from (${ledgerRows(org.id, opts.basis)}) lr
    where lr.entry_date >= ${opts.taxYearStart} and lr.entry_date <= ${opts.taxYearEnd}
  `);
  // Aggregate to account × mapping used.
  const agg = new Map<string, AccountSource>();
  for (const r of res.rows) {
    const acc = chart.byId.get(r.account_id);
    if (!acc) continue;
    const m = resolveMapping(mappings, r.account_id, { project: r.project_id, class: r.class_id, department: r.department_id, location: r.location_id, fund: r.fund_id });
    const key = `${r.account_id}|${m?.dimensionKey ?? ""}`;
    const cur = agg.get(key) ?? {
      accountId: acc.id,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      subtype: acc.subtype,
      dimensionKey: m?.dimensionKey ?? "",
      ledgerAmount: "0",
      categoryCode: m?.categoryCode ?? null,
      confirmed: m?.confirmed ?? false,
    };
    cur.ledgerAmount = Decimal.from(cur.ledgerAmount).add(r.base).toString();
    agg.set(key, cur);
  }
  const sources = [...agg.values()].filter((s) => !Decimal.from(s.ledgerAmount).isZero()).sort((a, b) => a.code.localeCompare(b.code) || a.dimensionKey.localeCompare(b.dimensionKey));
  const unmapped = sources.filter((s) => !s.categoryCode || !catMap.has(s.categoryCode));
  const adjustments = await listAdjustments(db, org.id, opts.returnType, opts.taxYearStart, opts.taxYearEnd);
  const rows = new Map<string, CategoryRow>();
  for (const c of categories) rows.set(c.code, { category: c, bookAmount: Decimal.ZERO, adjustments: Decimal.ZERO, taxAmount: Decimal.ZERO, accounts: [] });
  for (const s of sources) {
    if (!s.categoryCode) continue;
    const row = rows.get(s.categoryCode);
    if (!row) continue;
    const amt = Decimal.from(s.ledgerAmount);
    row.bookAmount = row.bookAmount.add(creditPositive(row.category.kind) ? amt.neg() : amt);
    row.accounts.push(`${s.code} ${s.name}`);
  }
  for (const a of adjustments) {
    const row = rows.get(a.categoryCode);
    if (row) row.adjustments = row.adjustments.add(a.amount);
  }
  for (const r of rows.values()) r.taxAmount = r.bookAmount.add(r.adjustments);
  const catRows = [...rows.values()].filter((r) => !r.bookAmount.isZero() || !r.adjustments.isZero() || r.accounts.length > 0);
  const bookNetIncome = Decimal.sum(sources.map((s) => s.ledgerAmount)).neg();
  const sumKind = (k: CategoryKind) => Decimal.sum(catRows.filter((r) => r.category.kind === k).map((r) => r.taxAmount));
  const taxableBeforeSpecialItems = sumKind("income").sub(sumKind("cogs")).sub(sumKind("deduction"));
  const dataHash = sha256(
    canonicalJson({
      returnType: opts.returnType,
      basis: opts.basis,
      period: [opts.taxYearStart, opts.taxYearEnd],
      version: version ? [version.id, version.version] : null,
      sources: sources.map((s) => [s.accountId, s.dimensionKey, Decimal.from(s.ledgerAmount).normalize().toString(), s.categoryCode, s.confirmed]),
      adjustments: adjustments.map((a) => [a.id, a.categoryCode, Decimal.from(a.amount).normalize().toString(), a.kind]),
    }),
  );
  const [review] = version
    ? await db
        .select()
        .from(taxReviews)
        .where(and(eq(taxReviews.orgId, org.id), eq(taxReviews.returnType, opts.returnType), eq(taxReviews.taxYearStart, opts.taxYearStart), eq(taxReviews.taxYearEnd, opts.taxYearEnd), eq(taxReviews.basis, opts.basis)))
        .orderBy(desc(taxReviews.createdAt))
        .limit(1)
    : [];
  return {
    returnType: opts.returnType,
    basis: opts.basis,
    taxYearStart: opts.taxYearStart,
    taxYearEnd: opts.taxYearEnd,
    version,
    categories: catRows,
    sources,
    unmapped,
    unconfirmed: sources.filter((s) => s.categoryCode && !s.confirmed).length,
    adjustments,
    bookNetIncome,
    taxableBeforeSpecialItems,
    entryCount: stats.rows[0]?.n ?? 0,
    lastEntryNumber: stats.rows[0]?.last ?? null,
    dataHash,
    review: review ?? null,
    reviewCurrent: !!review && review.dataHash === dataHash,
  };
}

/** Record that a person reviewed (or approved) the reconciliation as it stands. */
export async function recordReview(
  ctx: Ctx,
  opts: { returnType: TaxReturnType; taxYearStart: string; taxYearEnd: string; basis: Basis; status: "reviewed" | "approved"; note?: string | null },
) {
  requirePermission(ctx, "tax_export.manage");
  const rec = await reconcile(getDb(), ctx.org, opts);
  if (!rec.version) throw new ValidationError("Map the accounts before reviewing.");
  if (opts.status === "approved" && rec.unmapped.length) throw new ValidationError(`${rec.unmapped.length} account${rec.unmapped.length === 1 ? " has" : "s have"} a balance and no tax category. Map them before approving.`);
  if (opts.status === "approved" && rec.unconfirmed) throw new ValidationError(`${rec.unconfirmed} suggested mapping${rec.unconfirmed === 1 ? " is" : "s are"} not confirmed yet.`);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(taxReviews)
      .values({
        orgId: ctx.orgId,
        returnType: opts.returnType,
        versionId: rec.version!.id,
        taxYearStart: opts.taxYearStart,
        taxYearEnd: opts.taxYearEnd,
        basis: opts.basis,
        status: opts.status,
        dataHash: rec.dataHash,
        note: opts.note ?? null,
        reviewedBy: ctx.actor.userId,
        reviewedByLabel: ctx.actor.label,
      })
      .returning();
    await audit(tx, ctx, { action: `tax_export.reconciliation_${opts.status}`, entityType: "tax_review", entityId: row!.id, metadata: { returnType: opts.returnType, year: [opts.taxYearStart, opts.taxYearEnd], basis: opts.basis, dataHash: rec.dataHash } });
    return row!;
  });
}

export function sourceLabel(s: AccountSource): string {
  return label({ code: s.code, name: s.name }) + (s.dimensionKey ? ` [${s.dimensionKey}]` : "");
}
