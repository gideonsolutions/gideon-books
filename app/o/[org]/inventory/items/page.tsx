import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listItems } from "@/lib/items/items";
import { stockOnHand } from "@/lib/inventory/queries";
import { can } from "@/lib/context";
import { formatQuantity } from "@/lib/money/format";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Badge, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, Table, Td, Th, inputClass } from "@/components/ui";

export const metadata = { title: "Products & services" };

const KIND_LABELS = { service: "Service", non_stock: "Non-stock", stock: "Stock" } as const;

export default async function Items({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const page = intParam(sp.page, 1);
  const kind = sp.kind === "service" || sp.kind === "non_stock" || sp.kind === "stock" ? sp.kind : undefined;
  const { rows, total, pageSize } = await listItems(db, ctx.orgId, { q: sp.q, kind, includeArchived: sp.archived === "1", page, sort: (sp.sort as never) ?? "name_asc" });
  const stock = new Map((await stockOnHand(db, ctx.orgId, { includeArchived: true })).map((s) => [s.itemId, s]));
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Products & services"
        description="What you sell and buy. Stock products are counted by location and costed at moving average; the stock pages show quantities and value."
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/inventory/stock`}>
              Stock on hand
            </LinkButton>
            {can(ctx, "items.manage") && <LinkButton href={`${base}/inventory/items/new`}>New item</LinkButton>}
          </>
        }
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Name, SKU, description" className={inputClass} />
        </FilterField>
        <FilterField label="Kind">
          <select name="kind" defaultValue={kind ?? ""} className={inputClass}>
            <option value="">All</option>
            <option value="stock">Stock</option>
            <option value="non_stock">Non-stock</option>
            <option value="service">Service</option>
          </select>
        </FilterField>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === "1"} /> Show archived
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={sp.q || kind ? "No items match" : "No products or services yet"} action={can(ctx, "items.manage") && <LinkButton href={`${base}/inventory/items/new`}>New item</LinkButton>}>
          Items fill in descriptions, prices, accounts and tax on invoices and bills.
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="Name" sortKey="name" current={sp.sort ?? "name_asc"} params={sp} />
                <SortTh label="SKU" sortKey="sku" current={sp.sort} params={sp} />
                <Th>Kind</Th>
                <Th align="right">Sale price</Th>
                <Th align="right">On hand</Th>
                <Th align="right" className="hidden md:table-cell">
                  Avg cost
                </Th>
                <Th align="right" className="hidden md:table-cell">
                  Value
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((i) => {
                const s = stock.get(i.id);
                return (
                  <tr key={i.id} className={i.isArchived ? "opacity-60" : "hover:bg-slate-50"}>
                    <Td>
                      <Link className="font-medium text-brand-700 hover:underline" href={`${base}/inventory/items/${i.id}`}>
                        {i.name}
                      </Link>
                      {i.isArchived && (
                        <span className="ml-2">
                          <Badge tone="amber">archived</Badge>
                        </span>
                      )}
                      {s?.belowReorder && (
                        <span className="ml-2">
                          <Badge tone="red">reorder</Badge>
                        </span>
                      )}
                    </Td>
                    <Td className="font-mono text-xs text-slate-600">{i.sku}</Td>
                    <Td className="text-slate-600">{KIND_LABELS[i.kind]}</Td>
                    <Td align="right">{i.salePrice ? <Money amount={i.salePrice} currency={cur} /> : <span className="text-slate-400">—</span>}</Td>
                    <Td align="right" className="num">
                      {i.kind === "stock" ? `${formatQuantity(s?.qtyOnHand ?? "0")} ${i.unit}` : <span className="text-slate-400">—</span>}
                    </Td>
                    <Td align="right" className="hidden md:table-cell">
                      {s?.avgCost ? <Money amount={s.avgCost} currency={cur} /> : <span className="text-slate-400">—</span>}
                    </Td>
                    <Td align="right" className="hidden md:table-cell">
                      {i.kind === "stock" ? <Money amount={s?.totalValue ?? "0"} currency={cur} /> : <span className="text-slate-400">—</span>}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={total} params={sp} />
        </>
      )}
    </>
  );
}
