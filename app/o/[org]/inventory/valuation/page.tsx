import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { valuationAsOf } from "@/lib/inventory/queries";
import { inventoryReconciliation } from "@/lib/inventory/valuation";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { formatQuantity } from "@/lib/money/format";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Alert, Card, FilterBar, FilterField, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";

export const metadata = { title: "Inventory valuation" };

export default async function Valuation({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const asOf = dateParam(sp.asOf) ?? todayIn(ctx.org.timezone);
  const rows = (await valuationAsOf(db, ctx.orgId, asOf)).filter((r) => !Decimal.from(r.qty).isZero() || !Decimal.from(r.value).isZero());
  const rec = await inventoryReconciliation(db, ctx.orgId, asOf);
  const total = Decimal.sum(rows.map((r) => r.value));
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const balanced = Decimal.from(rec.difference).isZero();
  return (
    <>
      <PageHeader
        title="Inventory valuation"
        back={{ href: `${base}/inventory/stock`, label: "Stock on hand" }}
        description="The value of stock on hand from the stock ledger (moving weighted average cost), and its reconciliation to the inventory accounts in the general ledger."
      />
      <FilterBar>
        <FilterField label="As of">
          <input type="date" name="asOf" defaultValue={asOf} className={inputClass} />
        </FilterField>
      </FilterBar>
      <div className="mb-6">
        {balanced ? (
          <Alert tone="success">The stock ledger and the inventory accounts agree as of {asOf}.</Alert>
        ) : (
          <Alert tone="danger" title="The stock ledger and the inventory accounts disagree">
            A difference of <Money amount={rec.difference} currency={cur} /> as of {asOf}. Something posted to an inventory account without moving stock; the period cannot close until it is found. Use the general ledger links below.
          </Alert>
        )}
      </div>
      <Card title="Reconciliation to the ledger" padded={false} className="mb-6">
        <Table className="rounded-none border-0 shadow-none">
          <thead>
            <tr>
              <Th>Inventory account</Th>
              <Th align="right">Stock ledger</Th>
              <Th align="right">General ledger</Th>
              <Th align="right">Difference</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rec.rows.map((r) => (
              <tr key={r.accountId}>
                <Td>
                  <span className="font-mono text-xs text-slate-500">{r.accountCode}</span> {r.accountName}
                </Td>
                <Td align="right">
                  <Money amount={r.stockValue} currency={cur} />
                </Td>
                <Td align="right">
                  <Link className="hover:underline" href={`${base}/reports/general-ledger?account=${r.accountId}&to=${asOf}`}>
                    <Money amount={r.ledgerValue} currency={cur} />
                  </Link>
                </Td>
                <Td align="right">
                  <Money amount={r.difference} currency={cur} showZero={false} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <Table>
        <thead>
          <tr>
            <Th>Item</Th>
            <Th align="right">Quantity</Th>
            <Th align="right">Average cost</Th>
            <Th align="right">Value</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.item_id}>
              <Td>
                <Link className="text-brand-700 hover:underline" href={`${base}/inventory/items/${r.item_id}`}>
                  {r.name}
                </Link>
                {r.sku && <span className="ml-2 font-mono text-xs text-slate-500">{r.sku}</span>}
              </Td>
              <Td align="right" className="num">
                {formatQuantity(r.qty)} {r.unit}
              </Td>
              <Td align="right">{r.avgCost ? <Money amount={r.avgCost} currency={cur} /> : "—"}</Td>
              <Td align="right">
                <Link className="hover:underline" href={`${base}/inventory/movements?item=${r.item_id}&to=${asOf}`}>
                  <Money amount={r.value} currency={cur} />
                </Link>
              </Td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-50 font-semibold">
          <tr>
            <Td>Total</Td>
            <Td />
            <Td />
            <Td align="right">
              <Money amount={total.toString()} currency={cur} />
            </Td>
          </tr>
        </tfoot>
      </Table>
    </>
  );
}
