/**
 * Sales-tax liability for a period, by jurisdiction: what was sold taxable
 * and exempt and the tax charged (from the tax computed and kept on each
 * issued document, by document date), and what the ledger shows for the
 * jurisdiction's liability — tax collected, remittances recorded,
 * adjustments, and the balance owed.
 *
 * Gideon Books records remittances; it does not prepare or file sales-tax
 * returns. Rates are the ones the organization entered for each date.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import type { Org } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { formatDate } from "@/lib/money/format";
import { addDays } from "@/lib/dates";
import type { ReportRow, ReportTable } from "./table";
import { glHref } from "./table";

export interface SalesTaxRow {
  jurisdictionId: string;
  name: string;
  liabilityAccountId: string;
  taxableSales: Decimal;
  exemptSales: Decimal;
  taxCharged: Decimal;
  recoverablePurchaseTax: Decimal;
  opening: Decimal;
  collected: Decimal;
  remitted: Decimal;
  adjustments: Decimal;
  closing: Decimal;
}

export async function salesTaxLiability(db: DbOrTx, org: Org, opts: { from: string; to: string }): Promise<{ rows: SalesTaxRow[]; table: ReportTable }> {
  const mu = minorUnits(org.baseCurrency);
  const docs = await db.execute<{ jurisdiction_id: string; side: string; is_exempt: boolean; is_recoverable: boolean; taxable: string; tax: string }>(sql`
    select t.jurisdiction_id, d.side, t.is_exempt, t.is_recoverable,
      sum(round(t.taxable_amount * d.fx_rate, ${mu}) * case when d.kind in ('credit_note','vendor_credit') then -1 else 1 end)::text as taxable,
      sum(round(t.tax_amount * d.fx_rate, ${mu}) * case when d.kind in ('credit_note','vendor_credit') then -1 else 1 end)::text as tax
    from document_line_taxes t
    join documents d on d.org_id = t.org_id and d.id = t.document_id
    where t.org_id = ${org.id} and d.status not in ('draft','void')
      and d.kind in ('invoice','sales_receipt','credit_note','bill','expense','vendor_credit')
      and d.issue_date >= ${opts.from} and d.issue_date <= ${opts.to}
    group by t.jurisdiction_id, d.side, t.is_exempt, t.is_recoverable
  `);
  const ledger = await db.execute<{ jurisdiction_id: string; bucket: string; before: string; during: string }>(sql`
    with jl as (
      select coalesce(r.jurisdiction_id, case when e.source_type in ('sales_tax_remittance','sales_tax_adjustment') then e.source_id end) as jurisdiction_id,
             case when e.source_type = 'sales_tax_remittance' then 'remitted'
                  when e.source_type = 'sales_tax_adjustment' then 'adjustments'
                  else 'collected' end as bucket,
             e.entry_date, l.base_amount, l.account_id
      from journal_lines l
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
      left join tax_rates r on r.org_id = l.org_id and r.id = l.tax_rate_id
      where l.org_id = ${org.id} and e.status = 'posted' and e.entry_date <= ${opts.to}
        and l.account_id in (select liability_account_id from tax_jurisdictions where org_id = ${org.id})
    )
    select jl.jurisdiction_id::text, jl.bucket,
      coalesce(sum(jl.base_amount) filter (where jl.entry_date < ${opts.from}), 0)::text as before,
      coalesce(sum(jl.base_amount) filter (where jl.entry_date >= ${opts.from}), 0)::text as during
    from jl
    join tax_jurisdictions j on j.org_id = ${org.id} and j.id = jl.jurisdiction_id and j.liability_account_id = jl.account_id
    group by jl.jurisdiction_id, jl.bucket
  `);
  const juris = await db.execute<{ id: string; name: string; liability_account_id: string }>(sql`
    select id, name, liability_account_id from tax_jurisdictions where org_id = ${org.id} order by name`);
  const rows: SalesTaxRow[] = juris.rows.map((j) => ({
    jurisdictionId: j.id,
    name: j.name,
    liabilityAccountId: j.liability_account_id,
    taxableSales: Decimal.ZERO,
    exemptSales: Decimal.ZERO,
    taxCharged: Decimal.ZERO,
    recoverablePurchaseTax: Decimal.ZERO,
    opening: Decimal.ZERO,
    collected: Decimal.ZERO,
    remitted: Decimal.ZERO,
    adjustments: Decimal.ZERO,
    closing: Decimal.ZERO,
  }));
  const byId = new Map(rows.map((r) => [r.jurisdictionId, r]));
  for (const d of docs.rows) {
    const r = byId.get(d.jurisdiction_id);
    if (!r) continue;
    if (d.side === "sales") {
      if (d.is_exempt) r.exemptSales = r.exemptSales.add(d.taxable);
      else {
        r.taxableSales = r.taxableSales.add(d.taxable);
        r.taxCharged = r.taxCharged.add(d.tax);
      }
    } else if (d.is_recoverable) {
      r.recoverablePurchaseTax = r.recoverablePurchaseTax.add(d.tax);
    }
  }
  for (const l of ledger.rows) {
    const r = byId.get(l.jurisdiction_id);
    if (!r) continue;
    // Liabilities are credits: show owed amounts as positive.
    r.opening = r.opening.add(Decimal.from(l.before).neg());
    const during = Decimal.from(l.during).neg();
    if (l.bucket === "collected") r.collected = r.collected.add(during);
    else if (l.bucket === "remitted") r.remitted = r.remitted.add(during.neg());
    else r.adjustments = r.adjustments.add(during);
  }
  for (const r of rows) r.closing = r.opening.add(r.collected).sub(r.remitted).add(r.adjustments);
  const shown = rows.filter((r) => [r.taxableSales, r.exemptSales, r.taxCharged, r.recoverablePurchaseTax, r.opening, r.collected, r.remitted, r.adjustments, r.closing].some((v) => !v.isZero()));
  const tableRows: ReportRow[] = shown.map((r) => ({
    kind: "detail",
    cells: [
      { value: r.name },
      { value: r.taxableSales.toString() },
      { value: r.exemptSales.toString() },
      { value: r.taxCharged.toString() },
      { value: r.recoverablePurchaseTax.toString() },
      { value: r.opening.toString(), href: glHref({ account: r.liabilityAccountId, to: addDays(opts.from, -1) }) },
      { value: r.collected.toString(), href: glHref({ account: r.liabilityAccountId, from: opts.from, to: opts.to }) },
      { value: r.remitted.toString(), href: glHref({ account: r.liabilityAccountId, from: opts.from, to: opts.to }) },
      { value: r.adjustments.toString(), href: glHref({ account: r.liabilityAccountId, from: opts.from, to: opts.to }) },
      { value: r.closing.toString(), href: glHref({ account: r.liabilityAccountId, to: opts.to }) },
    ],
  }));
  const sum = (k: keyof SalesTaxRow) => Decimal.sum(shown.map((r) => r[k] as Decimal)).toString();
  tableRows.push({
    kind: "total",
    cells: [
      { value: "Total" },
      { value: sum("taxableSales") },
      { value: sum("exemptSales") },
      { value: sum("taxCharged") },
      { value: sum("recoverablePurchaseTax") },
      { value: sum("opening") },
      { value: sum("collected") },
      { value: sum("remitted") },
      { value: sum("adjustments") },
      { value: sum("closing") },
    ],
  });
  return {
    rows: shown,
    table: {
      key: "sales-tax",
      title: "Sales tax liability",
      subtitle: `${formatDate(opts.from)} – ${formatDate(opts.to)}`,
      currency: org.baseCurrency,
      columns: [
        { key: "jurisdiction", label: "Jurisdiction", kind: "text" },
        { key: "taxable", label: "Taxable sales", kind: "money", align: "right" },
        { key: "exempt", label: "Exempt sales", kind: "money", align: "right" },
        { key: "charged", label: "Tax charged", kind: "money", align: "right" },
        { key: "recoverable", label: "Recoverable purchase tax", kind: "money", align: "right" },
        { key: "opening", label: "Owed at start", kind: "money", align: "right" },
        { key: "collected", label: "Collected (ledger)", kind: "money", align: "right" },
        { key: "remitted", label: "Remitted", kind: "money", align: "right" },
        { key: "adjustments", label: "Adjustments", kind: "money", align: "right" },
        { key: "closing", label: "Owed at end", kind: "money", align: "right" },
      ],
      rows: tableRows,
      notes: [
        "Sales figures come from the tax computed and kept on each issued document, by document date, converted at each document's rate; credit notes reduce them. The ledger columns come from the jurisdiction's liability account by posting date.",
        "Gideon Books records remittances and adjustments; it does not prepare or file sales-tax returns, and it does not determine what is taxable in a jurisdiction. Check the figures against the jurisdiction's own rules before filing.",
      ],
    },
  };
}
