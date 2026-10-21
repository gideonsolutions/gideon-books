import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { stockOnHand } from "@/lib/inventory/queries";
import { can } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { formatQuantity } from "@/lib/money/format";
import { locationOptions } from "@/lib/web/options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Badge, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";

export const metadata = { title: "Stock on hand" };

export default async function Stock({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const locs = await locationOptions(db, ctx.orgId);
  const rows = await stockOnHand(db, ctx.orgId, { q: sp.q, locationId: sp.location || undefined, belowReorderOnly: sp.reorder === "1" });
  const totalValue = Decimal.sum(rows.map((r) => r.totalValue));
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Stock on hand"
        description="Quantities by item and location, valued at moving average cost. Value is for the item across all locations."
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/inventory/valuation`}>
              Valuation & reconciliation
            </LinkButton>
            {can(ctx, "inventory.manage") && <LinkButton href={`${base}/inventory/movements/new?kind=adjustment`}>Adjust stock</LinkButton>}
          </>
        }
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Name or SKU" className={inputClass} />
        </FilterField>
        {locs.length > 1 && (
          <FilterField label="Location">
            <select name="location" defaultValue={sp.location ?? ""} className={inputClass}>
              <option value="">All</option>
              {locs.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </FilterField>
        )}
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="reorder" value="1" defaultChecked={sp.reorder === "1"} /> At or below reorder level
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={sp.reorder === "1" ? "Nothing needs reordering" : "No stock"} action={<LinkButton href={`${base}/inventory/items/new`}>New stock item</LinkButton>}>
          {sp.reorder === "1" ? "Every stock item is above its reorder level." : "Stock items appear here once they are received or given opening stock."}
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Item</Th>
              <Th className="hidden md:table-cell">By location</Th>
              <Th align="right">On hand</Th>
              <Th align="right">Reorder at</Th>
              <Th align="right" className="hidden sm:table-cell">
                Avg cost
              </Th>
              <Th align="right">Value</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.itemId}>
                <Td>
                  <Link className="font-medium text-brand-700 hover:underline" href={`${base}/inventory/items/${r.itemId}`}>
                    {r.name}
                  </Link>
                  {r.sku && <span className="ml-2 font-mono text-xs text-slate-500">{r.sku}</span>}
                  {r.belowReorder && (
                    <span className="ml-2">
                      <Badge tone="red">reorder{r.reorderQuantity ? ` ${formatQuantity(r.reorderQuantity)}` : ""}</Badge>
                    </span>
                  )}
                </Td>
                <Td className="hidden text-xs text-slate-600 md:table-cell">{r.byLocation.map((l) => `${l.locationName}: ${formatQuantity(l.qty)}`).join(" · ")}</Td>
                <Td align="right" className="num">
                  {formatQuantity(r.qtyOnHand)} {r.unit}
                </Td>
                <Td align="right" className="num">
                  {r.reorderLevel ? formatQuantity(r.reorderLevel) : "—"}
                </Td>
                <Td align="right" className="hidden sm:table-cell">
                  {r.avgCost ? <Money amount={r.avgCost} currency={cur} /> : "—"}
                </Td>
                <Td align="right">
                  <Money amount={r.totalValue} currency={cur} />
                </Td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 font-semibold">
            <tr>
              <Td>Total value</Td>
              <Td className="hidden md:table-cell" />
              <Td />
              <Td />
              <Td className="hidden sm:table-cell" />
              <Td align="right">
                <Money amount={totalValue.toString()} currency={cur} />
              </Td>
            </tr>
          </tfoot>
        </Table>
      )}
    </>
  );
}
