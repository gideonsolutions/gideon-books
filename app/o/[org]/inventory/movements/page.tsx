import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listMovements, listStockMoves, MOVEMENT_LABELS } from "@/lib/inventory/movements";
import { can } from "@/lib/context";
import { formatQuantity } from "@/lib/money/format";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Card, DateText, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, Table, Td, Th, inputClass } from "@/components/ui";
import { MoveSourceLink } from "@/components/inventory/move-source";
import { itemOptions, locationOptions } from "@/lib/web/options";

export const metadata = { title: "Adjustments & transfers" };

export default async function Movements({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const base = `/o/${org}`;
  const records = await listMovements(db, ctx.orgId, { pageSize: 10 });
  const page = intParam(sp.page, 1);
  const ledger = await listStockMoves(db, ctx.orgId, { itemId: sp.item || undefined, locationId: sp.location || undefined, from: dateParam(sp.from), to: dateParam(sp.to), page });
  const allItems = (await itemOptions(db, ctx.orgId)).filter((i) => i.kind === "stock");
  const locs = await locationOptions(db, ctx.orgId);
  const manage = can(ctx, "inventory.manage");
  return (
    <>
      <PageHeader
        title="Adjustments & transfers"
        description="Stock changes made by hand, and the full stock ledger: every movement from bills, invoices, receipts, returns, counts and transfers."
        actions={
          manage && (
            <>
              <LinkButton variant="secondary" href={`${base}/inventory/movements/new?kind=opening`}>
                Opening stock
              </LinkButton>
              <LinkButton variant="secondary" href={`${base}/inventory/movements/new?kind=transfer`}>
                Transfer
              </LinkButton>
              <LinkButton variant="secondary" href={`${base}/inventory/movements/new?kind=revaluation`}>
                Revalue
              </LinkButton>
              <LinkButton href={`${base}/inventory/movements/new?kind=adjustment`}>Adjust quantity</LinkButton>
            </>
          )
        }
      />
      <Card title="Recent adjustments and transfers" padded={false} className="mb-8">
        {records.rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">None yet.</p>
        ) : (
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Date</Th>
                <Th>Kind</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {records.rows.map((m) => (
                <tr key={m.id}>
                  <Td>
                    <Link className="font-medium text-brand-700 hover:underline" href={`${base}/inventory/movements/${m.id}`}>
                      {m.number}
                    </Link>
                  </Td>
                  <Td>
                    <DateText date={m.movementDate} />
                  </Td>
                  <Td>{MOVEMENT_LABELS[m.kind]}</Td>
                  <Td className="max-w-md truncate text-slate-600">{m.reason}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Stock ledger</h2>
      <FilterBar>
        <FilterField label="Item">
          <select name="item" defaultValue={sp.item ?? ""} className={inputClass}>
            <option value="">All</option>
            {allItems.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
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
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
      </FilterBar>
      {ledger.rows.length === 0 ? (
        <EmptyState title="No stock movements">Stock moves are recorded as stock items are received, sold, returned, counted and transferred.</EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Item</Th>
                <Th>Movement</Th>
                <Th className="hidden md:table-cell">Location</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Value</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ledger.rows.map(({ move: m, itemName, locationName }) => (
                <tr key={m.id}>
                  <Td>
                    <DateText date={m.moveDate} />
                  </Td>
                  <Td>
                    <Link className="hover:text-brand-700" href={`${base}/inventory/items/${m.itemId}`}>
                      {itemName}
                    </Link>
                  </Td>
                  <Td>
                    <MoveSourceLink base={base} move={m} />
                  </Td>
                  <Td className="hidden md:table-cell">{locationName}</Td>
                  <Td align="right" className="num">
                    {formatQuantity(m.quantity)}
                  </Td>
                  <Td align="right">
                    <Money amount={m.value} currency={ctx.org.baseCurrency} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={ledger.pageSize} total={ledger.total} params={sp} />
        </>
      )}
    </>
  );
}
