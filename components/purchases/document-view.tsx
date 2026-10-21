import Link from "next/link";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, contacts, items, taxJurisdictions } from "@/lib/db/schema/ledger";
import { documents, payments } from "@/lib/db/schema/commerce";
import { poClosures } from "@/lib/db/schema/purchasing";
import { getDocument } from "@/lib/commerce/documents";
import { itemBalance, loadOpenItem, openAmount, openItemsForContact } from "@/lib/commerce/open-items";
import { settlementsForItem } from "@/lib/commerce/settlements";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { matchForLinkedAttachment } from "@/lib/purchases/receipts";
import { matchesForBill, receiptsForOrder } from "@/lib/purchases/receiving";
import { displayStatus, KIND_LABELS } from "@/lib/commerce/states";
import { can, type Ctx } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { formatRatePercent } from "@/lib/money/format";
import { Alert, Card, DateText, DescriptionList, LinkButton, Money, PageHeader, StatusBadge, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, SubmitButton } from "@/components/client/forms";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { applyCreditsAction, billFromOrderAction, closeOrderAction, creditFromBillAction, duplicateAction, reopenOrderAction, reverseReceiptAction, unapplyAction, unmatchReceiptAction, voidAction } from "@/app/o/[org]/purchases/actions";
import { PURCHASE_KINDS, type PurchaseKind } from "./kinds";

/** The read-only view of an issued purchase document, with what can be done to it. */
export async function PurchaseDocumentView({ org, ctx, id, kind }: { org: string; ctx: Ctx; id: string; kind: PurchaseKind }) {
  const db = getDb();
  const base = `/o/${org}`;
  const cfg = PURCHASE_KINDS[kind];
  const { doc, lines, taxes } = await getDocument(db, ctx.orgId, id);
  const today = todayIn(ctx.org.timezone);
  const accIds = [...new Set(lines.map((l) => l.accountId).filter(Boolean))] as string[];
  const accRows = accIds.length ? await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, accIds))) : [];
  const accMap = new Map(accRows.map((a) => [a.id, a]));
  const itemIds = [...new Set(lines.map((l) => l.itemId).filter(Boolean))] as string[];
  const itemRows = itemIds.length ? await db.select().from(items).where(and(eq(items.orgId, ctx.orgId), inArray(items.id, itemIds))) : [];
  const itemMap = new Map(itemRows.map((i) => [i.id, i]));
  const [contact] = doc.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, doc.contactId))) : [];
  const jurIds = [...new Set(taxes.map((t) => t.jurisdictionId))];
  const jurs = jurIds.length ? await db.select().from(taxJurisdictions).where(and(eq(taxJurisdictions.orgId, ctx.orgId), inArray(taxJurisdictions.id, jurIds))) : [];
  const isOpenItem = kind === "bill" || kind === "vendor_credit";
  const info = isOpenItem && doc.status !== "void" ? await loadOpenItem(db, ctx.orgId, { type: "document", id }) : null;
  const open = info ? openAmount(info, await itemBalance(db, ctx.orgId, id)) : Decimal.ZERO;
  const apps = isOpenItem ? await settlementsForItem(db, ctx.orgId, id) : [];
  const appDocIds = apps.flatMap((s) => [s.debitItemId, s.creditItemId]).filter((x) => x !== id);
  const counterparties = new Map<string, { label: string; href: string }>();
  if (appDocIds.length) {
    const ds = await db.select({ id: documents.id, kind: documents.kind, number: documents.number }).from(documents).where(and(eq(documents.orgId, ctx.orgId), inArray(documents.id, appDocIds)));
    for (const d of ds) counterparties.set(d.id, { label: `${KIND_LABELS[d.kind]} ${d.number ?? ""}`, href: `${base}/documents/${d.id}` });
    const ps = await db.select({ id: payments.id, number: payments.number, kind: payments.kind }).from(payments).where(and(eq(payments.orgId, ctx.orgId), inArray(payments.id, appDocIds)));
    for (const p of ps) counterparties.set(p.id, { label: `${p.kind.replace(/_/g, " ")} ${p.number ?? ""}`, href: `${base}/payments/${p.id}` });
  }
  // Credits that could be applied (to a bill), or bills a credit could go to.
  const candidates =
    info && open.isPositive() && doc.contactId
      ? (await openItemsForContact(db, ctx.orgId, "payables", doc.contactId)).filter((o) => o.currency === doc.currency && o.id !== id && o.nature !== info.nature)
      : [];
  const files = await listAttachments(db, ctx.orgId, "purchase_document", id);
  const receiptMatches = await matchForLinkedAttachment(db, ctx.orgId, id);
  const history = await listAudit(db, ctx.orgId, { entityType: "document", entityId: id });
  const poMatches = kind === "bill" ? await matchesForBill(db, ctx.orgId, id) : [];
  const [sourceDoc] = doc.sourceDocumentId ? await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, doc.sourceDocumentId))) : [];
  const canManage = can(ctx, "purchases.manage");
  const isPo = kind === "purchase_order";
  const receipts = isPo ? await receiptsForOrder(db, ctx.orgId, id) : [];
  const poOpen = isPo && ["issued", "partially_received", "received"].includes(doc.status);
  const poUsed = lines.some((l) => Decimal.from(l.receivedQuantity).isPositive() || Decimal.from(l.billedQuantity).isPositive());
  const poUnbilled = lines.some((l) => Decimal.from(l.quantity).gt(l.billedQuantity));
  const [manualClose] = isPo && doc.status === "closed" ? await db.select().from(poClosures).where(and(eq(poClosures.orgId, ctx.orgId), eq(poClosures.purchaseOrderId, id))) : [];
  const status = displayStatus(doc, today);
  const foreign = doc.currency !== ctx.org.baseCurrency;

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {cfg.label} {doc.number}
            <StatusBadge status={status} />
          </span>
        }
        back={{ href: `${base}${cfg.path}`, label: cfg.plural }}
        actions={
          <>
            {kind === "bill" && open.isPositive() && can(ctx, "payments.record") && (
              <LinkButton href={`${base}/purchases/payments/new?vendor=${doc.contactId}&apply=${id}`}>Pay bill</LinkButton>
            )}
            {kind === "vendor_credit" && open.isPositive() && can(ctx, "payments.record") && (
              <LinkButton variant="secondary" href={`${base}/purchases/payments/new?kind=vendor_refund&vendor=${doc.contactId}&apply=${id}`}>
                Record refund
              </LinkButton>
            )}
            {kind === "bill" && doc.status !== "void" && canManage && (
              <ActionButton action={creditFromBillAction.bind(null, org, id)}>Vendor credit</ActionButton>
            )}
            {kind === "bill" && canManage && (
              <LinkButton variant="secondary" href={`${base}/purchases/recurring/new?from=${id}`}>
                Make recurring
              </LinkButton>
            )}
            {isPo && poOpen && canManage && <LinkButton href={`${base}/purchases/orders/${id}/receive`}>Receive goods</LinkButton>}
            {isPo && poOpen && poUnbilled && canManage && <ActionButton action={billFromOrderAction.bind(null, org, id)}>Create bill</ActionButton>}
            {isPo && doc.status !== "draft" && (
              <a className="inline-flex items-center rounded-md px-3.5 py-2 text-sm font-medium text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50" href={`${base}/purchases/orders/${id}/pdf`}>
                PDF
              </a>
            )}
            {isPo && poOpen && canManage && (
              <ConfirmButton
                action={closeOrderAction.bind(null, org, id)}
                label="Close order"
                title={`Close purchase order ${doc.number}?`}
                body="Nothing more will be received or billed against it. You can reopen it later."
                reasonLabel="Why is it being closed?"
                confirmLabel="Close it"
              />
            )}
            {isPo && manualClose && !manualClose.reopenedAt && canManage && <ActionButton action={reopenOrderAction.bind(null, org, id)}>Reopen</ActionButton>}
            {isPo && doc.status === "issued" && !poUsed && can(ctx, "purchases.void") && (
              <ConfirmButton action={voidAction.bind(null, org, id)} label="Cancel order" variant="danger" title={`Cancel purchase order ${doc.number}?`} reasonLabel="Why is it being cancelled?" confirmLabel="Cancel the order" />
            )}
            {canManage && <ActionButton action={duplicateAction.bind(null, org, kind, id)}>Duplicate</ActionButton>}
            {!isPo && doc.status !== "void" && can(ctx, "purchases.void") && (
              <ConfirmButton
                action={voidAction.bind(null, org, id)}
                label="Void"
                variant="danger"
                title={`Void ${cfg.label.toLowerCase()} ${doc.number}?`}
                body={
                  <>
                    Everything it posted is reversed on the void date, and any stock it brought in goes back out. Payments or credits applied to it must be removed first.
                    {poMatches.length > 0 && " The purchase-order quantities it billed become open again."}
                  </>
                }
                dateLabel="Void date"
                defaultDate={today < (doc.postingDate ?? doc.issueDate) ? (doc.postingDate ?? doc.issueDate) : today}
                reasonLabel="Why is it being voided?"
                confirmLabel="Void it"
              />
            )}
          </>
        }
      />
      {doc.status === "void" && (
        <div className="mb-4">
          <Alert tone="warning" title="Void">
            Voided {doc.voidedAt ? `on ${doc.voidedAt.toISOString().slice(0, 10)}` : ""}: {doc.voidReason}.{" "}
            {doc.voidEntryId && (
              <Link className="underline" href={`${base}/accounting/journal/${doc.voidEntryId}`}>
                Reversing entry
              </Link>
            )}
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card>
            <DescriptionList
              items={[
                { label: kind === "expense" ? "Paid to" : "Vendor", value: contact ? <Link className="text-brand-700 hover:underline" href={`${base}/purchases/vendors/${contact.id}`}>{contact.displayName}</Link> : "—" },
                { label: "Date", value: <DateText date={doc.issueDate} /> },
                ...(doc.postingDate && doc.postingDate !== doc.issueDate ? [{ label: "Posting date", value: <DateText date={doc.postingDate} /> }] : []),
                ...(kind === "bill" ? [{ label: "Due", value: <DateText date={doc.dueDate} /> }] : []),
                ...(kind === "purchase_order" ? [{ label: "Expected", value: <DateText date={doc.expiryDate} /> }] : []),
                { label: cfg.show.reference || "Reference", value: doc.reference },
                ...(foreign ? [{ label: "Currency", value: `${doc.currency} at ${Decimal.from(doc.fxRate).normalize().toString()} ${ctx.org.baseCurrency}` }] : []),
                ...(doc.isReimbursement ? [{ label: "Reimbursement", value: "Employee's out-of-pocket expense" }] : []),
                ...(sourceDoc ? [{ label: "From", value: <Link className="text-brand-700 hover:underline" href={`${base}/documents/${sourceDoc.id}`}>{KIND_LABELS[sourceDoc.kind]} {sourceDoc.number}</Link> }] : []),
                ...(doc.memo ? [{ label: "Memo", value: doc.memo }] : []),
                ...(doc.journalEntryId ? [{ label: "Ledger", value: <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${doc.journalEntryId}`}>View entry</Link> }] : []),
              ]}
            />
          </Card>
          <Table>
            <thead>
              <tr>
                <Th>Item / description</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Price</Th>
                <Th className="hidden md:table-cell">Account</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l) => {
                const it = l.itemId ? itemMap.get(l.itemId) : null;
                const acc = l.accountId ? accMap.get(l.accountId) : null;
                return (
                  <tr key={l.id}>
                    <Td>
                      {it && (
                        <Link className="font-medium text-slate-900 hover:text-brand-700" href={`${base}/inventory/items/${it.id}`}>
                          {it.name}
                        </Link>
                      )}
                      <div className="text-slate-600">{l.lineType === "shipping" ? `Shipping${l.description && l.description !== "Shipping" ? `: ${l.description}` : ""}` : l.description}</div>
                      {kind === "purchase_order" && (
                        <div className="text-xs text-slate-500">
                          Received {Decimal.from(l.receivedQuantity).normalize().toString()} · billed {Decimal.from(l.billedQuantity).normalize().toString()}
                        </div>
                      )}
                      {l.discountRate && <div className="text-xs text-slate-500">Discount {formatRatePercent(l.discountRate)}</div>}
                    </Td>
                    <Td align="right" className="num">
                      {Decimal.from(l.quantity).normalize().toString()}
                    </Td>
                    <Td align="right">
                      <Money amount={Decimal.from(l.unitPrice).normalize().toString()} currency={doc.currency} />
                    </Td>
                    <Td className="hidden text-slate-600 md:table-cell">{acc ? `${acc.code} ${acc.name}` : ""}</Td>
                    <Td align="right">
                      <Money amount={l.netAmount} currency={doc.currency} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 text-sm">
              <tr>
                <Td colSpan={4} className="hidden text-right md:table-cell">
                  Subtotal
                </Td>
                <Td colSpan={3} className="text-right md:hidden">
                  Subtotal
                </Td>
                <Td align="right">
                  <Money amount={Decimal.from(doc.subtotal).sub(doc.discountTotal).toString()} currency={doc.currency} />
                </Td>
              </tr>
              <tr>
                <Td colSpan={4} className="hidden text-right md:table-cell">
                  {doc.taxInclusive ? "Tax (included)" : "Tax"}
                </Td>
                <Td colSpan={3} className="text-right md:hidden">
                  Tax
                </Td>
                <Td align="right">
                  <Money amount={doc.taxTotal} currency={doc.currency} />
                </Td>
              </tr>
              <tr className="font-semibold">
                <Td colSpan={4} className="hidden text-right md:table-cell">
                  Total
                </Td>
                <Td colSpan={3} className="text-right md:hidden">
                  Total
                </Td>
                <Td align="right">
                  <Money amount={doc.total} currency={doc.currency} />
                </Td>
              </tr>
              {isOpenItem && doc.status !== "void" && (
                <tr className="font-semibold">
                  <Td colSpan={4} className="hidden text-right md:table-cell">
                    {kind === "bill" ? "Still owed" : "Unused credit"}
                  </Td>
                  <Td colSpan={3} className="text-right md:hidden">
                    Open
                  </Td>
                  <Td align="right">
                    <Money amount={open.toString()} currency={doc.currency} />
                  </Td>
                </tr>
              )}
            </tfoot>
          </Table>
          {taxes.length > 0 && (
            <Card title="Tax detail" padded={false}>
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Jurisdiction</Th>
                    <Th align="right">Rate</Th>
                    <Th align="right">Taxable</Th>
                    <Th align="right">Tax</Th>
                    <Th>Treatment</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {taxes.map((t) => (
                    <tr key={t.id}>
                      <Td>{jurs.find((j) => j.id === t.jurisdictionId)?.name}</Td>
                      <Td align="right">{formatRatePercent(t.rate)}</Td>
                      <Td align="right">
                        <Money amount={t.taxableAmount} currency={doc.currency} />
                      </Td>
                      <Td align="right">
                        <Money amount={t.taxAmount} currency={doc.currency} />
                      </Td>
                      <Td className="text-slate-600">{t.isExempt ? "Exempt" : t.isRecoverable ? "Recoverable" : "Part of cost"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
          {isPo && (
            <Card title="Goods received">
              {receipts.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing received yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {receipts.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className={r.status === "reversed" ? "line-through opacity-60" : ""}>
                        {r.number} · <DateText date={r.receiptDate} /> ·{" "}
                        {r.lines.map((l) => `${Decimal.from(l.quantity).normalize().toString()} × ${lines.find((x) => x.id === l.poLineId)?.description ?? ""}`).join(", ")}
                        {r.journalEntryId && (
                          <>
                            {" "}
                            ·{" "}
                            <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${r.journalEntryId}`}>
                              entry
                            </Link>
                          </>
                        )}
                        {r.status === "reversed" && <span className="ml-1 text-xs">(reversed: {r.reversalReason})</span>}
                      </span>
                      {r.status === "posted" && canManage && (
                        <ConfirmButton
                          action={reverseReceiptAction.bind(null, org, r.id)}
                          label="Reverse"
                          size="sm"
                          title={`Reverse receipt ${r.number}?`}
                          body="The goods go back out of stock at the value they came in at and the order's received quantities fall. Not possible once any of it is billed."
                          dateLabel="Date"
                          defaultDate={today}
                          reasonLabel="Why?"
                          confirmLabel="Reverse receipt"
                          variant="danger"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {manualClose && !manualClose.reopenedAt && <p className="mt-3 text-sm text-slate-600">Closed by hand: {manualClose.reason}</p>}
            </Card>
          )}
          {poMatches.length > 0 && (
            <Card title="Matched to the purchase order">
              <ul className="space-y-1 text-sm text-slate-700">
                {poMatches.map((m) => (
                  <li key={m.id} className={m.status === "reversed" ? "line-through opacity-60" : ""}>
                    {Decimal.from(m.billedQuantity).normalize().toString()} billed: {Decimal.from(m.matchedQuantity).normalize().toString()} against goods already received (
                    <Money amount={m.grniValue} currency={ctx.org.baseCurrency} /> from goods received not invoiced
                    {!Decimal.from(m.varianceValue).isZero() && (
                      <>
                        , <Money amount={m.varianceValue} currency={ctx.org.baseCurrency} /> price variance
                      </>
                    )}
                    ){Decimal.from(m.receivedWithBill).isPositive() && `, ${Decimal.from(m.receivedWithBill).normalize().toString()} received with the bill`}.
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {isOpenItem && (
            <Card title={kind === "bill" ? "Payments and credits applied" : "Applied to"}>
              {apps.length === 0 ? (
                <p className="text-sm text-slate-500">Nothing applied yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {apps.map((s) => {
                    const otherId = s.debitItemId === id ? s.creditItemId : s.debitItemId;
                    const cp = counterparties.get(otherId);
                    return (
                      <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                        <span className={s.status === "reversed" ? "line-through opacity-60" : ""}>
                          <DateText date={s.settlementDate} /> ·{" "}
                          {cp ? (
                            <Link className="text-brand-700 hover:underline" href={cp.href}>
                              {cp.label}
                            </Link>
                          ) : (
                            "—"
                          )}{" "}
                          · <Money amount={s.amount} currency={s.currency} />
                          {!Decimal.from(s.fxDifferenceBase).isZero() && (
                            <span className="text-xs text-slate-500">
                              {" "}
                              (exchange difference <Money amount={s.fxDifferenceBase} currency={ctx.org.baseCurrency} />)
                            </span>
                          )}
                        </span>
                        {s.status === "active" && can(ctx, "payments.void") && (
                          <ConfirmButton
                            action={unapplyAction.bind(null, org, s.id)}
                            label="Remove"
                            size="sm"
                            title="Remove this application?"
                            body="Both items become open again. The application stays in the history with your reason."
                            dateLabel="Date"
                            defaultDate={today < s.settlementDate ? s.settlementDate : today}
                            reasonLabel="Why?"
                            confirmLabel="Remove"
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {candidates.length > 0 && can(ctx, "payments.record") && (
                <ActionForm action={applyCreditsAction.bind(null, org, { type: "document", id, nature: info!.nature })} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                  <p className="text-sm font-medium text-slate-800">{kind === "bill" ? "Apply available credits" : "Apply to open bills"}</p>
                  {candidates.map((c) => (
                    <label key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span>
                        {c.kind.replace(/_/g, " ")} {c.number} · <DateText date={c.date} /> · available <Money amount={c.openTxn} currency={c.currency} />
                      </span>
                      <input name={`apply.${c.type}.${c.id}`} inputMode="decimal" placeholder="0.00" className={`${inputClass} num w-32 text-right`} aria-label={`Amount to apply from ${c.number}`} />
                    </label>
                  ))}
                  <div className="flex items-end justify-between gap-3">
                    <label className="text-xs font-medium text-slate-600">
                      Date
                      <input type="date" name="date" defaultValue={today} className={`${inputClass} mt-1`} />
                    </label>
                    <SubmitButton variant="secondary">Apply</SubmitButton>
                  </div>
                </ActionForm>
              )}
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Attachments org={org} entityType="purchase_document" entityId={id} files={files} canUpload={canManage} />
          {receiptMatches.length > 0 && (
            <Card title="From the receipt inbox">
              <ul className="space-y-2 text-sm">
                {receiptMatches.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span className="text-slate-600">Matched {m.matchedAt.toISOString().slice(0, 10)}</span>
                    {canManage && <ActionButton size="sm" action={unmatchReceiptAction.bind(null, org, m.id)}>Unmatch</ActionButton>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
