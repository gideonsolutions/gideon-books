/** Payments received from customers: the list, the receive form, and a payment's page. */
import Link from "next/link";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, contacts } from "@/lib/db/schema/ledger";
import { orgCtx } from "@/lib/web/session";
import { getPayment, listPayments, PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { KIND_LABELS } from "@/lib/commerce/states";
import { documentDetail } from "@/lib/sales/documents";
import { accountOptions, contactOptions, moneyAccountOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { can, requirePermission } from "@/lib/context";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Decimal } from "@/lib/money/decimal";
import { todayIn } from "@/lib/dates";
import type { PaymentKind } from "@/lib/db/schema/commerce";
import { Alert, Badge, Card, DateText, DescriptionList, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, StatusBadge, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { ReceivePaymentForm, type OpenRow } from "./receive-payment-form";
import { applyToInvoiceAction, receivePaymentAction, refundCreditAction, simulateRefundAction, unapplyAction, voidPaymentAction } from "@/app/o/[org]/sales/actions";

const CUSTOMER_KINDS: PaymentKind[] = ["customer_payment", "customer_deposit", "customer_refund"];

export async function PaymentListPage({ slug, searchParams }: { slug: string; searchParams: SearchParams }) {
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(slug);
  const page = intParam(sp.page, 1);
  const db = getDb();
  const kind = CUSTOMER_KINDS.includes(sp.kind as PaymentKind) ? (sp.kind as PaymentKind) : undefined;
  const { rows, total, pageSize } = await listPayments(db, ctx.orgId, {
    side: "customer",
    kind,
    contactId: sp.customer,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    q: sp.q,
    unapplied: sp.unapplied === "1",
    status: sp.status === "void" || sp.status === "posted" ? sp.status : undefined,
    page,
    sort: (sp.sort as never) ?? "date_desc",
  });
  const customers = await contactOptions(db, ctx.orgId, "customer");
  const base = `/o/${slug}`;
  return (
    <>
      <PageHeader
        title="Payments received"
        description="Money from customers, deposits taken before invoicing, and refunds paid back. Unapplied amounts are credits that can be applied or refunded."
        actions={can(ctx, "payments.record") && <LinkButton href={`${base}/sales/payments/new`}>Receive payment</LinkButton>}
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, reference, customer" className={inputClass} />
        </FilterField>
        <FilterField label="Kind">
          <select name="kind" defaultValue={sp.kind ?? ""} className={inputClass}>
            <option value="">All</option>
            {CUSTOMER_KINDS.map((k) => (
              <option key={k} value={k}>
                {PAYMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Customer">
          <select name="customer" defaultValue={sp.customer ?? ""} className={inputClass}>
            <option value="">All</option>
            {customers.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="unapplied" value="1" defaultChecked={sp.unapplied === "1"} /> Unapplied only
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No payments here" action={can(ctx, "payments.record") && <LinkButton href={`${base}/sales/payments/new`}>Receive payment</LinkButton>}>
          Record money as it arrives and apply it to invoices; part-payments and payments covering several invoices are fine.
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Number</Th>
                <SortTh label="Date" sortKey="date" current={sp.sort ?? "date_desc"} params={sp} />
                <Th>Customer</Th>
                <Th className="hidden md:table-cell">Kind</Th>
                <Th className="hidden md:table-cell">Account</Th>
                <SortTh label="Amount" sortKey="amount" current={sp.sort} params={sp} align="right" />
                <Th align="right">Unapplied</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ payment: p, contactName, accountName, unapplied }) => (
                <tr key={p.id} className={p.status === "void" ? "opacity-60" : "hover:bg-slate-50"}>
                  <Td>
                    <Link href={`${base}/sales/payments/${p.id}`} className="font-medium text-brand-700 hover:underline">
                      {p.number}
                    </Link>
                    {p.status === "void" && <Badge tone="red">void</Badge>}
                    {p.provider && <div className="text-xs text-slate-500">via {p.provider}</div>}
                  </Td>
                  <Td>
                    <DateText date={p.paymentDate} />
                  </Td>
                  <Td>{contactName}</Td>
                  <Td className="hidden md:table-cell">{PAYMENT_KIND_LABELS[p.kind]}</Td>
                  <Td className="hidden md:table-cell">{accountName}</Td>
                  <Td align="right">
                    <Money amount={p.amount} currency={p.currency} />
                  </Td>
                  <Td align="right">{p.status === "void" ? "—" : <Money amount={unapplied} currency={p.currency} showZero={false} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={total} params={sp} />
        </>
      )}
    </>
  );
}

export async function PaymentNewPage({ slug, searchParams }: { slug: string; searchParams: SearchParams }) {
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "payments.record");
  const db = getDb();
  const customerId = sp.customer ?? "";
  let currency = ctx.org.baseCurrency;
  let invoices: OpenRow[] = [];
  let credits: OpenRow[] = [];
  if (customerId) {
    const [c] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, customerId)));
    if (c) {
      currency = c.currency ?? ctx.org.baseCurrency;
      const open = (await openItemsForContact(db, ctx.orgId, "receivables", customerId)).filter((o) => o.currency === currency);
      invoices = open
        .filter((o) => o.nature === "debit" && o.type === "document")
        .map((o) => ({ type: o.type, id: o.id, label: `Invoice ${o.number ?? ""}`, date: o.date, dueDate: o.dueDate, open: o.openTxn }));
      credits = open
        .filter((o) => o.nature === "credit" && o.kind !== "customer_deposit")
        .map((o) => ({ type: o.type, id: o.id, label: `${o.type === "document" ? KIND_LABELS[o.kind as keyof typeof KIND_LABELS] : PAYMENT_KIND_LABELS[o.kind as PaymentKind]} ${o.number ?? ""}`, date: o.date, dueDate: null, open: o.openTxn }));
    }
  }
  const kind = (CUSTOMER_KINDS.includes(sp.kind as PaymentKind) ? sp.kind : "customer_payment") as "customer_payment" | "customer_deposit" | "customer_refund";
  const [undeposited] = await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.systemKey, "undeposited_funds")));
  return (
    <>
      <PageHeader title="Receive payment" back={{ href: `/o/${slug}/sales/payments`, label: "Payments received" }} />
      <Card>
        <ReceivePaymentForm
          key={`${customerId}:${kind}`}
          action={receivePaymentAction.bind(null, slug)}
          slug={slug}
          customers={await contactOptions(db, ctx.orgId, "customer")}
          customerId={customerId}
          currency={currency}
          baseCurrency={ctx.org.baseCurrency}
          invoices={invoices}
          credits={credits}
          accounts={await moneyAccountOptions(db, ctx.orgId)}
          feeAccounts={await accountOptions(db, ctx.orgId, { types: ["expense"] })}
          defaults={{ kind, date: todayIn(ctx.org.timezone), preselect: sp.invoice ?? null, accountId: undeposited?.id ?? null }}
          idempotencyKey={randomUUID()}
        />
      </Card>
    </>
  );
}

export async function PaymentDetailPage({ slug, id }: { slug: string; id: string }) {
  const ctx = await orgCtx(slug);
  const db = getDb();
  const found = await getPayment(db, ctx.orgId, id).catch(() => null);
  if (!found || !CUSTOMER_KINDS.includes(found.payment.kind)) notFound();
  const { payment: p, settlements, unapplied } = found;
  const [contact] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, p.contactId)));
  const [account] = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, p.accountId)));
  const base = `/o/${slug}`;
  const today = todayIn(ctx.org.timezone);
  const open = Decimal.from(unapplied);
  const canPay = can(ctx, "payments.record");
  // What each application touched, via the documents' own detail.
  const others = await Promise.all(
    settlements.map(async (s) => {
      const otherId = s.debitItemId === id ? s.creditItemId : s.debitItemId;
      const otherType = s.debitItemId === id ? s.creditItemType : s.debitItemType;
      if (otherType === "document") {
        const d = await documentDetail(db, ctx.orgId, otherId).catch(() => null);
        return { s, href: `${base}/documents/${otherId}`, label: d ? `${KIND_LABELS[d.doc.kind]} ${d.doc.number ?? ""}` : "Document" };
      }
      const op = await getPayment(db, ctx.orgId, otherId).catch(() => null);
      return { s, href: `${base}/payments/${otherId}`, label: op ? `${PAYMENT_KIND_LABELS[op.payment.kind]} ${op.payment.number}` : "Payment" };
    }),
  );
  const isCredit = p.kind === "customer_payment" || p.kind === "customer_deposit";
  const openInvoices =
    isCredit && open.isPositive() && p.status === "posted"
      ? (await openItemsForContact(db, ctx.orgId, "receivables", p.contactId)).filter((o) => o.kind === "invoice" && o.currency === p.currency)
      : [];
  const files = await listAttachments(db, ctx.orgId, "payment", id);
  const history = await listAudit(db, ctx.orgId, { entityType: "payment", entityId: id, limit: 20 });
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {PAYMENT_KIND_LABELS[p.kind]} {p.number} <StatusBadge status={p.status === "void" ? "void" : open.isZero() ? "applied" : "unapplied credit"} />
          </span>
        }
        description={contact && <Link className="text-brand-700 hover:underline" href={`${base}/sales/customers/${contact.id}`}>{contact.displayName}</Link>}
        back={{ href: `${base}/sales/payments`, label: "Payments received" }}
        actions={
          p.status === "posted" &&
          can(ctx, "payments.void") && (
            <ConfirmButton
              action={voidPaymentAction.bind(null, slug, id)}
              label="Void"
              variant="danger"
              title={`Void ${p.number}?`}
              body="Its applications are removed (the invoices reopen) and its entry is reversed on the date you choose. Use this for a bounced check or a payment recorded by mistake."
              dateLabel="Void date"
              defaultDate={today < p.paymentDate ? p.paymentDate : today}
              reasonLabel="Why?"
              confirmLabel="Void payment"
            />
          )
        }
      />
      {p.status === "void" && (
        <div className="mb-4">
          <Alert tone="danger" title="Void">
            {p.voidReason}
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <DescriptionList
              items={[
                { label: "Date", value: <DateText date={p.paymentDate} /> },
                { label: "Amount", value: <Money amount={p.amount} currency={p.currency} /> },
                { label: p.kind === "customer_refund" ? "Paid from" : "Deposited to", value: account && <Link className="text-brand-700 hover:underline" href={`${base}/accounting/accounts/${account.id}`}>{account.code} {account.name}</Link> },
                { label: "Method", value: p.method },
                { label: "Reference", value: p.reference },
                ...(Decimal.from(p.feeAmount).isZero() ? [] : [{ label: "Processing fee", value: <Money amount={p.feeAmount} currency={p.currency} /> }]),
                ...(p.currency !== ctx.org.baseCurrency ? [{ label: `In ${ctx.org.baseCurrency}`, value: <><Money amount={p.baseAmount} currency={ctx.org.baseCurrency} /> at {Decimal.from(p.fxRate).normalize().toString()}</> }] : []),
                ...(p.provider ? [{ label: "Provider", value: `${p.provider} · ${p.providerRef}` }] : []),
                { label: "Ledger", value: p.journalEntryId && <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${p.journalEntryId}`}>View entry</Link> },
                ...(p.memo ? [{ label: "Memo", value: p.memo }] : []),
              ]}
            />
          </Card>
          <Card title="Applications" padded={false}>
            {others.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Not applied to anything.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Applied to</Th>
                    <Th align="right">Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {others.map(({ s, href, label }) => (
                    <tr key={s.id} className={s.status === "reversed" ? "text-slate-400 line-through" : ""}>
                      <Td><DateText date={s.settlementDate} /></Td>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={href}>{label}</Link>
                      </Td>
                      <Td align="right"><Money amount={s.amount} currency={s.currency} /></Td>
                      <Td align="right">
                        {s.status === "active" && can(ctx, "payments.void") && (
                          <ConfirmButton
                            action={unapplyAction.bind(null, slug, s.id)}
                            label="Remove"
                            size="sm"
                            title="Remove this application?"
                            body="The amount becomes unapplied credit again and the document reopens."
                            dateLabel="Date"
                            defaultDate={today < s.settlementDate ? s.settlementDate : today}
                            reasonLabel="Why?"
                            confirmLabel="Remove"
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title={isCredit ? "Unapplied credit" : "Not yet matched to a credit"}>
            <div className="num text-2xl font-semibold">
              <Money amount={unapplied} currency={p.currency} />
            </div>
          </Card>
          {isCredit && open.isPositive() && p.status === "posted" && canPay && (
            <Card title="Use the credit">
              {openInvoices.length > 0 ? (
                <ActionForm action={applyToInvoiceAction.bind(null, slug, { type: "payment", id })} className="space-y-3">
                  <SelectField label="Apply to invoice" name="invoiceId" required options={openInvoices.map((o) => ({ value: o.id, label: `${o.number} — ${Decimal.from(o.openTxn).toFixed(2)} open` }))} />
                  <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={Decimal.min(open, Decimal.from(openInvoices[0]!.openTxn)).toFixed(2)} />
                  <TextField label="Date" name="date" type="date" required defaultValue={today} />
                  <SubmitButton>Apply</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">No open invoices for this customer in {p.currency}.</p>
              )}
              {p.kind === "customer_payment" && (
                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-medium text-brand-700">Refund it</summary>
                  <ActionForm action={refundCreditAction.bind(null, slug, { type: "payment", id }, p.contactId, p.currency)} className="mt-3 space-y-3">
                    <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={open.toFixed(2)} />
                    <TextField label="Date" name="date" type="date" required defaultValue={today} />
                    <SelectField label="Paid from" name="accountId" required placeholder="Choose…" options={await moneyAccountOptions(db, ctx.orgId)} defaultValue={p.accountId} />
                    <TextField label="Reference" name="reference" />
                    <p className="text-xs text-slate-500">Recording a refund does not send money.</p>
                    <SubmitButton>Record refund</SubmitButton>
                  </ActionForm>
                </details>
              )}
            </Card>
          )}
          {p.provider === "sandbox" && p.kind === "customer_payment" && p.status === "posted" && canPay && (
            <Card title="Sandbox">
              <p className="mb-3 text-sm text-slate-600">Simulate the sandbox provider refunding this payment. It arrives as a signed webhook, like a real one. No money moves.</p>
              <ActionForm action={simulateRefundAction.bind(null, slug, id)} className="space-y-3">
                <TextField label="Refund amount" name="amount" inputMode="decimal" required defaultValue={Decimal.from(p.amount).toFixed(2)} />
                <SubmitButton variant="secondary">Simulate provider refund</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Attachments org={slug} entityType="payment" entityId={id} files={files} canUpload={canPay} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
