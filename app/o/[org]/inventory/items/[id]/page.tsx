import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getItem } from "@/lib/items/items";
import { itemStockDetail } from "@/lib/inventory/queries";
import { listStockMoves } from "@/lib/inventory/movements";
import { itemDefaults, itemFormOptions } from "@/lib/inventory/item-options";
import { listAudit } from "@/lib/audit";
import { can } from "@/lib/context";
import { formatQuantity } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Badge, Card, DateText, LinkButton, Money, PageHeader, Pagination, Stat, Table, Td, Th } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { ItemForm } from "@/components/inventory/item-form";
import { AuditTrail } from "@/components/audit-trail";
import { MoveSourceLink } from "@/components/inventory/move-source";
import { archiveItemAction, updateItemAction } from "../../actions";

export const metadata = { title: "Item" };

export default async function ItemPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org, id } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  let item;
  try {
    item = await getItem(db, ctx.orgId, id);
  } catch {
    notFound();
  }
  const stock = await itemStockDetail(db, ctx.orgId, id);
  const page = intParam(sp.page, 1);
  const moves = item.kind === "stock" ? await listStockMoves(db, ctx.orgId, { itemId: id, page, pageSize: 25 }) : null;
  const hasMoves = (moves?.total ?? 0) > 0;
  const history = await listAudit(db, ctx.orgId, { entityType: "item", entityId: id });
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const manage = can(ctx, "items.manage");
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {item.name}
            {item.sku && <span className="font-mono text-base text-slate-500">{item.sku}</span>}
            {item.isArchived && <Badge tone="amber">archived</Badge>}
          </span>
        }
        back={{ href: `${base}/inventory/items`, label: "Products & services" }}
        actions={
          <>
            {item.kind === "stock" && can(ctx, "inventory.manage") && (
              <LinkButton variant="secondary" href={`${base}/inventory/movements/new?kind=adjustment&item=${id}`}>
                Adjust stock
              </LinkButton>
            )}
            {manage && <ActionButton action={archiveItemAction.bind(null, org, id, !item.isArchived)}>{item.isArchived ? "Restore" : "Archive"}</ActionButton>}
          </>
        }
      />
      {item.kind === "stock" && (
        <div className="mb-6 grid gap-4 sm:grid-cols-3">
          <Stat label="On hand" value={`${formatQuantity(stock.qtyOnHand)} ${item.unit}`} hint={item.reorderLevel ? `Reorder at ${formatQuantity(item.reorderLevel)}` : undefined} tone={item.reorderLevel && Decimal.from(stock.qtyOnHand).lte(item.reorderLevel) ? "warning" : "default"} />
          <Stat label="Value" value={<Money amount={stock.totalValue} currency={cur} />} hint="At moving average cost" />
          <Stat label="Average cost" value={stock.avgCost ? <Money amount={stock.avgCost} currency={cur} /> : "—"} hint={stock.lastMoveDate ? `Last movement ${stock.lastMoveDate}` : "No movements yet"} />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          {manage && (
            <Card title="Details">
              <ItemForm action={updateItemAction.bind(null, org, id)} defaults={itemDefaults(item)} {...await itemFormOptions(db, ctx.orgId)} kindLocked={hasMoves} submitLabel="Save changes" />
            </Card>
          )}
          {moves && (
            <Card title="Stock movements" padded={false}>
              {moves.rows.length === 0 ? (
                <p className="p-4 text-sm text-slate-500">No movements yet. Receive it on a bill or purchase order, or enter opening stock.</p>
              ) : (
                <>
                  <Table className="rounded-none border-0 shadow-none">
                    <thead>
                      <tr>
                        <Th>Date</Th>
                        <Th>Movement</Th>
                        <Th className="hidden md:table-cell">Location</Th>
                        <Th align="right">Qty</Th>
                        <Th align="right">Value</Th>
                        <Th align="right">On hand after</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {moves.rows.map(({ move: m, locationName }) => (
                        <tr key={m.id}>
                          <Td>
                            <DateText date={m.moveDate} />
                          </Td>
                          <Td>
                            <MoveSourceLink base={base} move={m} />
                          </Td>
                          <Td className="hidden md:table-cell">{locationName}</Td>
                          <Td align="right" className="num">
                            {formatQuantity(m.quantity)}
                          </Td>
                          <Td align="right">
                            <Money amount={m.value} currency={cur} />
                          </Td>
                          <Td align="right" className="num">
                            {formatQuantity(m.qtyOnHandAfter)}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  <div className="px-4 pb-3">
                    <Pagination page={page} pageSize={moves.pageSize} total={moves.total} params={sp} />
                  </div>
                </>
              )}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          {item.kind === "stock" && (
            <Card title="By location">
              {stock.byLocation.length === 0 ? (
                <p className="text-sm text-slate-500">None on hand.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {stock.byLocation.map((l) => (
                    <li key={l.locationId} className="flex justify-between py-1.5">
                      <span>{l.name}</span>
                      <span className="num">
                        {formatQuantity(l.qty)} {item.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Link className="mt-3 inline-block text-sm text-brand-700 hover:underline" href={`${base}/inventory/movements/new?kind=transfer&item=${id}`}>
                Transfer between locations
              </Link>
            </Card>
          )}
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
