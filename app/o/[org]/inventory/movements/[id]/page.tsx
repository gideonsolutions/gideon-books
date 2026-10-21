import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { getMovement, MOVEMENT_LABELS } from "@/lib/inventory/movements";
import { listAudit } from "@/lib/audit";
import { formatQuantity } from "@/lib/money/format";
import { orgCtx } from "@/lib/web/session";
import { Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { AuditTrail } from "@/components/audit-trail";
import { MoveSourceLink } from "@/components/inventory/move-source";

export const metadata = { title: "Stock movement" };

export default async function MovementPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  let data;
  try {
    data = await getMovement(db, ctx.orgId, id);
  } catch {
    notFound();
  }
  const { movement: m, moves } = data;
  const base = `/o/${org}`;
  const history = await listAudit(db, ctx.orgId, { entityType: "inventory_movement", entityId: id });
  return (
    <>
      <PageHeader title={`${MOVEMENT_LABELS[m.kind]} ${m.number}`} back={{ href: `${base}/inventory/movements`, label: "Adjustments & transfers" }} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <DescriptionList
              items={[
                { label: "Date", value: <DateText date={m.movementDate} /> },
                { label: "Reason", value: m.reason },
                {
                  label: "Ledger",
                  value: m.journalEntryId ? (
                    <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${m.journalEntryId}`}>
                      View entry
                    </Link>
                  ) : (
                    "No ledger effect (a transfer keeps value with the item)"
                  ),
                },
              ]}
            />
          </Card>
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>Movement</Th>
                <Th>Location</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Value</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {moves.map(({ move, itemName, itemUnit, locationName }) => (
                <tr key={move.id}>
                  <Td>
                    <Link className="hover:text-brand-700" href={`${base}/inventory/items/${move.itemId}`}>
                      {itemName}
                    </Link>
                  </Td>
                  <Td>
                    <MoveSourceLink base={base} move={{ ...move, reason: null }} />
                  </Td>
                  <Td>{locationName}</Td>
                  <Td align="right" className="num">
                    {formatQuantity(move.quantity)} {itemUnit}
                  </Td>
                  <Td align="right">
                    <Money amount={move.value} currency={ctx.org.baseCurrency} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
        <AuditTrail events={history} />
      </div>
    </>
  );
}
