import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { items } from "@/lib/db/schema/ledger";
import { getDocument } from "@/lib/commerce/documents";
import { requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { locationOptions } from "@/lib/web/options";
import { orgCtx } from "@/lib/web/session";
import { Alert, Card, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { receiveAction } from "../../../actions";

export const metadata = { title: "Receive goods" };

export default async function Receive({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "purchases.manage");
  const db = getDb();
  let found;
  try {
    found = await getDocument(db, ctx.orgId, id);
  } catch {
    notFound();
  }
  const { doc, lines } = found;
  if (doc.kind !== "purchase_order") notFound();
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))] as string[];
  const itemRows = itemIds.length ? await db.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
  const open = ["issued", "partially_received", "received"].includes(doc.status);
  const locs = await locationOptions(db, ctx.orgId);
  return (
    <>
      <PageHeader
        title={`Receive against ${doc.number}`}
        back={{ href: `/o/${org}/purchases/orders/${id}`, label: `Purchase order ${doc.number}` }}
        description="Record what arrived. Stock items come into stock at the order's price and are carried in goods received not invoiced until the vendor's bill arrives; other lines just record the quantity."
      />
      {!open ? (
        <Alert tone="warning">This order is {doc.status}; nothing can be received against it.</Alert>
      ) : (
        <Card>
          <ActionForm action={receiveAction.bind(null, org, id)} className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Date received" name="date" type="date" required defaultValue={todayIn(ctx.org.timezone)} />
              {locs.length > 1 && <SelectField label="Into location" name="locationId" options={locs} defaultValue={doc.inventoryLocationId ?? locs[0]?.value} />}
              <TextField label="Delivery note / memo" name="memo" />
            </div>
            <Table>
              <thead>
                <tr>
                  <Th>Line</Th>
                  <Th align="right">Ordered</Th>
                  <Th align="right">Received so far</Th>
                  <Th align="right">Receiving now</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((l) => {
                  const it = itemRows.find((i) => i.id === l.itemId);
                  const remaining = Decimal.from(l.quantity).sub(l.receivedQuantity);
                  return (
                    <tr key={l.id}>
                      <Td>
                        <div className="font-medium text-slate-900">{it?.name ?? l.description}</div>
                        <div className="text-xs text-slate-500">{it ? (it.kind === "stock" ? "Stock item — into stock" : "Not stocked — quantity only") : l.description}</div>
                      </Td>
                      <Td align="right" className="num">
                        {Decimal.from(l.quantity).normalize().toString()}
                      </Td>
                      <Td align="right" className="num">
                        {Decimal.from(l.receivedQuantity).normalize().toString()}
                      </Td>
                      <Td align="right">
                        {remaining.isPositive() ? (
                          <input
                            name={`receive.${l.id}`}
                            defaultValue={remaining.normalize().toString()}
                            inputMode="decimal"
                            className={`${inputClass} num ml-auto w-28 text-right`}
                            aria-label={`Quantity of ${it?.name ?? l.description} received`}
                          />
                        ) : (
                          <span className="text-sm text-slate-500">All received</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
            <div className="flex justify-end">
              <SubmitButton pendingText="Recording…">Record receipt</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
