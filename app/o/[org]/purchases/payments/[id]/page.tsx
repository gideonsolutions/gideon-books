import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, contacts } from "@/lib/db/schema/ledger";
import { documents, payments } from "@/lib/db/schema/commerce";
import { getPayment, PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import { openItemsForContact, paymentNature } from "@/lib/commerce/open-items";
import { KIND_LABELS } from "@/lib/commerce/states";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { orgCtx } from "@/lib/web/session";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, inputClass } from "@/components/ui";
import { ActionForm, ConfirmButton, SubmitButton } from "@/components/client/forms";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { applyCreditsAction, unapplyAction, voidPaymentAction } from "../../actions";

export const metadata = { title: "Payment" };

export default async function PaymentPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  let data;
  try {
    data = await getPayment(db, ctx.orgId, id);
  } catch {
    notFound();
  }
  const { payment: p, settlements, unapplied } = data;
  if (!["vendor_payment", "vendor_prepayment", "vendor_refund"].includes(p.kind)) notFound();
  const base = `/o/${org}`;
  const today = todayIn(ctx.org.timezone);
  const [vendor] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, p.contactId)));
  const [account] = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, p.accountId)));
  const otherIds = settlements.map((s) => (s.debitItemId === id ? s.creditItemId : s.debitItemId));
  const docs = otherIds.length ? await db.select({ id: documents.id, kind: documents.kind, number: documents.number, reference: documents.reference }).from(documents).where(and(eq(documents.orgId, ctx.orgId), inArray(documents.id, otherIds))) : [];
  const pays = otherIds.length ? await db.select({ id: payments.id, kind: payments.kind, number: payments.number }).from(payments).where(and(eq(payments.orgId, ctx.orgId), inArray(payments.id, otherIds))) : [];
  const nature = paymentNature(p.kind).nature;
  const open = Decimal.from(unapplied);
  const candidates =
    p.status === "posted" && open.isPositive()
      ? (await openItemsForContact(db, ctx.orgId, "payables", p.contactId)).filter((o) => o.currency === p.currency && o.id !== id && o.nature !== nature)
      : [];
  const files = await listAttachments(db, ctx.orgId, "payment", id);
  const history = await listAudit(db, ctx.orgId, { entityType: "payment", entityId: id });
  const label = (otherId: string) => {
    const d = docs.find((x) => x.id === otherId);
    if (d) return { text: `${KIND_LABELS[d.kind]} ${d.number ?? ""}${d.reference ? ` (${d.reference})` : ""}`, href: `${base}/documents/${d.id}` };
    const q = pays.find((x) => x.id === otherId);
    if (q) return { text: `${PAYMENT_KIND_LABELS[q.kind]} ${q.number ?? ""}`, href: `${base}/payments/${q.id}` };
    return { text: "—", href: "#" };
  };
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {PAYMENT_KIND_LABELS[p.kind]} {p.number}
            <Badge tone={p.status === "void" ? "red" : "green"}>{p.status}</Badge>
          </span>
        }
        back={{ href: `${base}/purchases/payments`, label: "Payments made" }}
        actions={
          p.status === "posted" &&
          can(ctx, "payments.void") && (
            <ConfirmButton
              action={voidPaymentAction.bind(null, org, id)}
              label="Void payment"
              variant="danger"
              title={`Void ${p.number}?`}
              body="Its applications are removed (the bills are open again) and its entry is reversed on the date you choose."
              dateLabel="Void date"
              defaultDate={today < p.paymentDate ? p.paymentDate : today}
              reasonLabel="Why is it being voided?"
              confirmLabel="Void it"
            />
          )
        }
      />
      {p.status === "void" && (
        <div className="mb-4">
          <Alert tone="warning">Voided: {p.voidReason}</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card>
            <DescriptionList
              items={[
                { label: "Vendor", value: vendor ? <Link className="text-brand-700 hover:underline" href={`${base}/purchases/vendors/${vendor.id}`}>{vendor.displayName}</Link> : "—" },
                { label: "Date", value: <DateText date={p.paymentDate} /> },
                { label: "Amount", value: <Money amount={p.amount} currency={p.currency} /> },
                { label: p.kind === "vendor_refund" ? "Deposited to" : "Paid from", value: account ? `${account.code} ${account.name}` : "—" },
                { label: "Method", value: p.method },
                { label: "Reference", value: p.reference },
                ...(p.currency !== ctx.org.baseCurrency ? [{ label: "In base currency", value: <Money amount={p.baseAmount} currency={ctx.org.baseCurrency} /> }] : []),
                { label: "Unapplied", value: <Money amount={unapplied} currency={p.currency} /> },
                ...(p.memo ? [{ label: "Memo", value: p.memo }] : []),
                ...(p.journalEntryId ? [{ label: "Ledger", value: <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${p.journalEntryId}`}>View entry</Link> }] : []),
              ]}
            />
          </Card>
          <Card title="Applied to">
            {settlements.length === 0 ? (
              <p className="text-sm text-slate-500">{p.kind === "vendor_prepayment" ? "Not applied to a bill yet." : "Nothing applied."}</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {settlements.map((s) => {
                  const other = label(s.debitItemId === id ? s.creditItemId : s.debitItemId);
                  return (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span className={s.status === "reversed" ? "line-through opacity-60" : ""}>
                        <DateText date={s.settlementDate} /> ·{" "}
                        <Link className="text-brand-700 hover:underline" href={other.href}>
                          {other.text}
                        </Link>{" "}
                        · <Money amount={s.amount} currency={s.currency} />
                      </span>
                      {s.status === "active" && can(ctx, "payments.void") && (
                        <ConfirmButton
                          action={unapplyAction.bind(null, org, s.id)}
                          label="Remove"
                          size="sm"
                          title="Remove this application?"
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
              <ActionForm action={applyCreditsAction.bind(null, org, { type: "payment", id, nature })} className="mt-4 space-y-3 border-t border-slate-100 pt-4">
                <p className="text-sm font-medium text-slate-800">Apply the unapplied {p.currency} {open.toString()}</p>
                {candidates.map((c) => (
                  <label key={c.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span>
                      {c.type === "document" ? KIND_LABELS[c.kind as keyof typeof KIND_LABELS] : c.kind.replace(/_/g, " ")} {c.number} · open <Money amount={c.openTxn} currency={c.currency} />
                    </span>
                    <input name={`apply.${c.type}.${c.id}`} inputMode="decimal" placeholder="0.00" className={`${inputClass} num w-32 text-right`} aria-label={`Amount to apply to ${c.number}`} />
                  </label>
                ))}
                <div className="flex items-end justify-between gap-3">
                  <label className="text-xs font-medium text-slate-600">
                    Date
                    <input type="date" name="date" defaultValue={today < p.paymentDate ? p.paymentDate : today} className={`${inputClass} mt-1`} />
                  </label>
                  <SubmitButton variant="secondary">Apply</SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Attachments org={org} entityType="payment" entityId={id} files={files} canUpload={can(ctx, "payments.record")} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
