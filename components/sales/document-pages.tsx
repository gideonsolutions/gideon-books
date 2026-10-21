/**
 * The pages for sales documents — invoices, estimates, credit notes and
 * sales receipts — share one implementation; each kind sets its labels,
 * fields and actions here.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { getDocument, listDocuments } from "@/lib/commerce/documents";
import { displayStatus, STATUS_LABELS } from "@/lib/commerce/states";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { documentDetail, emailDefaults, openCreditsFor } from "@/lib/sales/documents";
import { activePaymentConnection } from "@/lib/integrations/payments/connections";
import { documentFormOptions, draftFromDocument, emptyDraft } from "@/lib/web/document-form";
import { moneyAccountOptions, contactOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { can, requirePermission } from "@/lib/context";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { documentPath } from "@/lib/web/routes";
import { Decimal } from "@/lib/money/decimal";
import { formatDateTime } from "@/lib/money/format";
import { todayIn } from "@/lib/dates";
import type { DocumentKind } from "@/lib/db/schema/commerce";
import {
  Alert,
  Badge,
  Card,
  DateText,
  DescriptionList,
  EmptyState,
  FilterBar,
  FilterField,
  LinkButton,
  Money,
  PageHeader,
  Pagination,
  SortTh,
  StatusBadge,
  Table,
  Td,
  Th,
  buttonClass,
  inputClass,
} from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/client/forms";
import { DocumentForm } from "@/components/commerce/document-form";
import { blankLine } from "@/lib/commerce/draft";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import {
  applyCreditAction,
  applyToInvoiceAction,
  convertEstimateAction,
  createPaymentLinkAction,
  deleteDocumentAction,
  duplicateDocumentAction,
  emailDocumentAction,
  estimateStatusAction,
  issueDocumentAction,
  makeRecurringAction,
  refundCreditAction,
  saveDocumentAction,
  unapplyAction,
  voidDocumentAction,
  writeOffAction,
} from "@/app/o/[org]/sales/actions";

export type SalesKind = Extract<DocumentKind, "invoice" | "estimate" | "credit_note" | "sales_receipt">;

interface KindConfig {
  path: string;
  label: string;
  plural: string;
  description: string;
  show: { dueDate?: boolean; expiryDate?: boolean; terms?: boolean; cashAccount?: boolean; reference?: string | false; notes?: boolean; shipping?: boolean; postingDate?: boolean };
  issueLabel: string;
  statuses: { value: string; label: string }[];
  empty: string;
}

export const SALES_KINDS: Record<SalesKind, KindConfig> = {
  invoice: {
    path: "/sales/invoices",
    label: "Invoice",
    plural: "Invoices",
    description: "What customers owe. Issuing posts the invoice; overdue is worked out from the due date.",
    show: { dueDate: true, terms: true, reference: "Customer's PO number", notes: true, shipping: true, postingDate: true },
    issueLabel: "Save and issue",
    statuses: [
      { value: "open", label: "Open (issued or partly paid)" },
      { value: "overdue", label: "Overdue" },
      { value: "draft", label: "Draft" },
      { value: "paid", label: "Paid" },
      { value: "void", label: "Void" },
    ],
    empty: "Create an invoice, or turn an accepted estimate into one.",
  },
  estimate: {
    path: "/sales/estimates",
    label: "Estimate",
    plural: "Estimates",
    description: "Quotes. They post nothing; an accepted estimate converts to an invoice.",
    show: { expiryDate: true, reference: "Reference", notes: true, shipping: true },
    issueLabel: "Save and mark sent",
    statuses: [
      { value: "draft", label: "Draft" },
      { value: "sent", label: "Sent" },
      { value: "accepted", label: "Accepted" },
      { value: "declined", label: "Declined" },
      { value: "expired", label: "Expired" },
      { value: "converted", label: "Converted" },
    ],
    empty: "Send a customer an estimate; when they accept, convert it to an invoice in one step.",
  },
  credit_note: {
    path: "/sales/credit-notes",
    label: "Credit note",
    plural: "Credit notes",
    description: "Credits to customers for returns, corrections and allowances. Apply them to invoices or refund them. Write-offs of bad debt are listed here too.",
    show: { reference: "Reason or reference", notes: true, postingDate: true },
    issueLabel: "Save and issue",
    statuses: [
      { value: "issued", label: "Open" },
      { value: "closed", label: "Fully applied" },
      { value: "draft", label: "Draft" },
      { value: "void", label: "Void" },
    ],
    empty: "Issue a credit note to correct an invoice or record a return.",
  },
  sales_receipt: {
    path: "/sales/receipts",
    label: "Sales receipt",
    plural: "Sales receipts",
    description: "Sales paid on the spot: no invoice, no receivable — the money goes straight to the account you choose.",
    show: { cashAccount: true, reference: "Reference", notes: true, shipping: true, postingDate: true },
    issueLabel: "Save and record",
    statuses: [
      { value: "paid", label: "Recorded" },
      { value: "draft", label: "Draft" },
      { value: "void", label: "Void" },
    ],
    empty: "Record a cash sale with a sales receipt.",
  },
};

// ── List ────────────────────────────────────────────────────────────────────

export async function SalesDocumentListPage({ slug, kind, searchParams }: { slug: string; kind: SalesKind; searchParams: SearchParams }) {
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(slug);
  const cfg = SALES_KINDS[kind];
  const page = intParam(sp.page, 1);
  const today = todayIn(ctx.org.timezone);
  const db = getDb();
  const kinds: DocumentKind[] = kind === "credit_note" ? ["credit_note", "write_off"] : [kind];
  const { rows, total, pageSize } = await listDocuments(db, ctx.orgId, {
    kind: kinds,
    status: sp.status === "overdue" ? undefined : sp.status,
    overdue: sp.status === "overdue",
    today,
    contactId: sp.customer,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    q: sp.q,
    page,
    sort: (sp.sort as never) ?? "date_desc",
  });
  const customers = await contactOptions(db, ctx.orgId, "customer");
  const base = `/o/${slug}`;
  const filtered = !!(sp.q || sp.status || sp.customer || sp.from || sp.to);
  return (
    <>
      <PageHeader title={cfg.plural} description={cfg.description} actions={can(ctx, "sales.manage") && <LinkButton href={`${base}${cfg.path}/new`}>New {cfg.label.toLowerCase()}</LinkButton>} />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, customer, reference" className={inputClass} />
        </FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            {cfg.statuses.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
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
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={filtered ? "Nothing matches these filters" : `No ${cfg.plural.toLowerCase()} yet`} action={!filtered && can(ctx, "sales.manage") && <LinkButton href={`${base}${cfg.path}/new`}>New {cfg.label.toLowerCase()}</LinkButton>}>
          {filtered ? "Clear a filter to see more." : cfg.empty}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="Number" sortKey="number" current={sp.sort} params={sp} />
                <SortTh label="Date" sortKey="date" current={sp.sort ?? "date_desc"} params={sp} />
                <Th>Customer</Th>
                {kind === "invoice" && <SortTh label="Due" sortKey="due" current={sp.sort} params={sp} />}
                <Th>Status</Th>
                <SortTh label="Total" sortKey="total" current={sp.sort} params={sp} align="right" />
                {(kind === "invoice" || kind === "credit_note") && <Th align="right">Open</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ doc, contactName, openAmount }) => (
                <tr key={doc.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={documentPath(base, doc.kind, doc.id)} className="font-medium text-brand-700 hover:underline">
                      {doc.number ?? "Draft"}
                    </Link>
                    {doc.kind === "write_off" && <div className="text-xs text-slate-500">write-off</div>}
                  </Td>
                  <Td>
                    <DateText date={doc.issueDate} />
                  </Td>
                  <Td className="max-w-[14rem] truncate">{contactName}</Td>
                  {kind === "invoice" && (
                    <Td>
                      <DateText date={doc.dueDate} />
                    </Td>
                  )}
                  <Td>
                    <StatusBadge status={displayStatus(doc, today)} />
                  </Td>
                  <Td align="right">
                    <Money amount={doc.total} currency={doc.currency} />
                  </Td>
                  {(kind === "invoice" || kind === "credit_note") && (
                    <Td align="right">{doc.status === "draft" || doc.status === "void" ? <span className="text-slate-400">—</span> : <Money amount={openAmount} currency={doc.currency} showZero={false} />}</Td>
                  )}
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

// ── Create / edit ───────────────────────────────────────────────────────────

export async function SalesDocumentNewPage({ slug, kind, searchParams }: { slug: string; kind: SalesKind; searchParams: SearchParams }) {
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "sales.manage");
  const cfg = SALES_KINDS[kind];
  const today = todayIn(ctx.org.timezone);
  const db = getDb();
  const draft = emptyDraft(today);
  if (sp.customer) draft.contactId = sp.customer;
  let fromNote: string | null = null;
  if (kind === "credit_note" && sp.from) {
    // A credit note from an invoice: its lines, each linked to the line it credits (returns come back at their original cost).
    const src = await getDocument(db, ctx.orgId, sp.from).catch(() => null);
    if (src && src.doc.kind === "invoice") {
      const d = draftFromDocument(src.doc, src.lines, ctx.org.baseCurrency);
      draft.contactId = d.contactId;
      draft.currency = d.currency;
      draft.taxInclusive = d.taxInclusive;
      draft.reference = `Credit for ${src.doc.number}`;
      draft.lines = d.lines.map((l, i) => ({ ...l, sourceLineId: "", returnOfLineId: src.lines[i]!.id }));
      fromNote = src.doc.number;
    }
  }
  return (
    <>
      <PageHeader title={`New ${cfg.label.toLowerCase()}`} back={{ href: `/o/${slug}${cfg.path}`, label: cfg.plural }} description={fromNote ? `Crediting invoice ${fromNote}. Remove the lines that are not being credited and adjust quantities.` : undefined} />
      <Card>
        <DocumentForm
          action={saveDocumentAction.bind(null, slug, kind, null)}
          side="sales"
          kindLabel={cfg.label}
          contactLabel="Customer"
          show={cfg.show}
          defaults={draft.lines.length ? draft : { ...draft, lines: [blankLine()] }}
          issueLabel={can(ctx, "sales.issue") ? cfg.issueLabel : false}
          {...await documentFormOptions(db, ctx, "sales", today)}
        />
      </Card>
    </>
  );
}

export async function SalesDocumentEditPage({ slug, kind, id }: { slug: string; kind: SalesKind; id: string }) {
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "sales.manage");
  const cfg = SALES_KINDS[kind];
  const db = getDb();
  const found = await getDocument(db, ctx.orgId, id).catch(() => null);
  if (!found || found.doc.kind !== kind) notFound();
  const { doc, lines } = found;
  const editable = doc.status === "draft" || (kind === "estimate" && ["sent", "expired", "declined"].includes(doc.status));
  const back = documentPath(`/o/${slug}`, kind, id);
  if (!editable) {
    return (
      <>
        <PageHeader title={`${cfg.label} ${doc.number}`} back={{ href: back, label: "Back" }} />
        <Alert tone="warning" title="This document can no longer be edited">
          It is {STATUS_LABELS[doc.status].toLowerCase()}. Posted documents stay as they were posted: void it, or issue a credit note, and make a new one.
        </Alert>
      </>
    );
  }
  return (
    <>
      <PageHeader title={doc.number ? `Edit ${cfg.label.toLowerCase()} ${doc.number}` : `Edit draft ${cfg.label.toLowerCase()}`} back={{ href: back, label: doc.number ?? "Draft" }} />
      <Card>
        <DocumentForm
          action={saveDocumentAction.bind(null, slug, kind, id)}
          side="sales"
          kindLabel={cfg.label}
          contactLabel="Customer"
          show={cfg.show}
          defaults={draftFromDocument(doc, lines, ctx.org.baseCurrency)}
          issueLabel={doc.status === "draft" && can(ctx, "sales.issue") ? cfg.issueLabel : false}
          draftLabel={doc.status === "draft" ? "Save draft" : "Save changes"}
          {...await documentFormOptions(db, ctx, "sales", doc.issueDate)}
        />
      </Card>
    </>
  );
}

// ── Detail ──────────────────────────────────────────────────────────────────

export async function SalesDocumentDetailPage({ slug, kind, id }: { slug: string; kind: SalesKind; id: string }) {
  const ctx = await orgCtx(slug);
  const db = getDb();
  const detail = await documentDetail(db, ctx.orgId, id).catch(() => null);
  if (!detail) notFound();
  const { doc, lines, taxSummary, contact, applications, open, emails, files, openLink } = detail;
  const isWriteOff = doc.kind === "write_off";
  if (doc.kind !== kind && !(kind === "credit_note" && isWriteOff)) notFound();
  const cfg = SALES_KINDS[kind];
  const label = isWriteOff ? "Write-off" : cfg.label;
  const base = `/o/${slug}`;
  const today = todayIn(ctx.org.timezone);
  const statusLabel = displayStatus(doc, today);
  const openAmt = open ? Decimal.from(open) : null;
  const isOpen = (doc.status === "issued" || doc.status === "partially_paid") && !!openAmt?.isPositive();
  const canManage = can(ctx, "sales.manage");
  const canIssue = can(ctx, "sales.issue");
  const canVoid = can(ctx, "sales.void");
  const canPay = can(ctx, "payments.record");
  const history = await listAudit(db, ctx.orgId, { entityType: "document", entityId: id, limit: 30 });
  const credits = kind === "invoice" && isOpen && doc.contactId ? await openCreditsFor(db, ctx, doc.contactId, doc.currency) : [];
  const openInvoices =
    kind === "credit_note" && !isWriteOff && isOpen && doc.contactId
      ? (await openItemsForContact(db, ctx.orgId, "receivables", doc.contactId)).filter((o) => o.kind === "invoice" && o.currency === doc.currency)
      : [];
  const conn = kind === "invoice" && isOpen ? await activePaymentConnection(db, ctx.orgId) : null;
  const mail = doc.status !== "draft" && doc.status !== "void" && canManage ? await emailDefaults(ctx, id) : null;
  const moneyAccounts = kind === "credit_note" && isOpen && canPay ? await moneyAccountOptions(db, ctx.orgId) : [];
  const editable = canManage && (doc.status === "draft" || (kind === "estimate" && ["sent", "expired", "declined"].includes(doc.status)));

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {label} {doc.number ?? "(draft)"} <StatusBadge status={statusLabel} />
          </span>
        }
        description={contact ? <Link href={`${base}/sales/customers/${contact.id}`} className="text-brand-700 hover:underline">{contact.displayName}</Link> : undefined}
        back={{ href: `${base}${cfg.path}`, label: cfg.plural }}
        actions={
          <>
            {doc.status === "draft" && canIssue && <ActionButton variant="primary" action={issueDocumentAction.bind(null, slug, id)}>{kind === "estimate" ? "Mark sent" : kind === "sales_receipt" ? "Record" : "Issue"}</ActionButton>}
            {editable && <LinkButton variant="secondary" href={`${documentPath(base, kind, id)}/edit`}>Edit</LinkButton>}
            {kind === "invoice" && isOpen && canPay && <LinkButton href={`${base}/sales/payments/new?customer=${doc.contactId}&invoice=${id}`}>Record payment</LinkButton>}
            {kind === "estimate" && ["draft", "sent", "accepted"].includes(doc.status) && canManage && <ActionButton variant="primary" action={convertEstimateAction.bind(null, slug, id)}>Convert to invoice</ActionButton>}
            {kind === "estimate" && doc.status === "sent" && canManage && (
              <>
                <ActionButton action={estimateStatusAction.bind(null, slug, id, "accepted")}>Mark accepted</ActionButton>
                <ActionButton action={estimateStatusAction.bind(null, slug, id, "declined")}>Mark declined</ActionButton>
                <ActionButton action={estimateStatusAction.bind(null, slug, id, "expired")}>Mark expired</ActionButton>
              </>
            )}
            {kind === "invoice" && doc.status !== "draft" && doc.status !== "void" && canManage && (
              <LinkButton variant="secondary" href={`${base}/sales/credit-notes/new?from=${id}`}>
                Credit note
              </LinkButton>
            )}
            {doc.status !== "draft" && (
              <a className={buttonClass("secondary")} href={`${documentPath(base, kind, id)}/pdf`} target="_blank" rel="noopener">
                PDF
              </a>
            )}
            {canManage && !isWriteOff && <ActionButton action={duplicateDocumentAction.bind(null, slug, id)}>Duplicate</ActionButton>}
            {kind === "invoice" && canManage && doc.status !== "void" && <ActionButton action={makeRecurringAction.bind(null, slug, id)}>Make recurring</ActionButton>}
            {doc.status === "draft" && canManage && (
              <ConfirmButton action={deleteDocumentAction.bind(null, slug, id, cfg.path)} label="Delete draft" variant="danger" title="Delete this draft?" body="A draft was never posted; deleting it leaves no trace in the books." confirmLabel="Delete" />
            )}
            {kind === "estimate" && doc.status !== "draft" && doc.status !== "converted" && doc.status !== "declined" && canVoid && (
              <ConfirmButton action={voidDocumentAction.bind(null, slug, id)} label="Withdraw" title="Withdraw this estimate?" body="It is marked declined and can no longer be converted." reasonLabel="Why?" confirmLabel="Withdraw" />
            )}
            {kind !== "estimate" && doc.status !== "draft" && doc.status !== "void" && canVoid && !isWriteOff && (
              <ConfirmButton
                action={voidDocumentAction.bind(null, slug, id)}
                label="Void"
                variant="danger"
                title={`Void ${label.toLowerCase()} ${doc.number}?`}
                body={
                  applications.some((a) => a.settlement.status === "active")
                    ? "Payments or credits are applied to it. Voiding will be refused until they are removed below — or issue a credit note instead, which keeps the original and corrects it."
                    : "Everything it posted (and any stock it moved) is reversed on the void date. The document stays, marked void."
                }
                dateLabel="Void date"
                defaultDate={today}
                reasonLabel="Why is it being voided?"
                confirmLabel="Void"
              />
            )}
          </>
        }
      />
      {doc.status === "void" && (
        <div className="mb-4">
          <Alert tone="danger" title="Void">
            {doc.voidReason}
            {doc.voidEntryId && (
              <>
                {" "}
                · <Link className="underline" href={`${base}/accounting/journal/${doc.voidEntryId}`}>reversing entry</Link>
              </>
            )}
          </Alert>
        </div>
      )}
      {doc.status === "draft" && (
        <div className="mb-4">
          <Alert tone="info">This is a draft: nothing is posted until it is {kind === "estimate" ? "sent" : "issued"}. Taxes and the exchange rate are recalculated for its date when it is.</Alert>
        </div>
      )}
      {statusLabel.startsWith("Overdue") && (
        <div className="mb-4">
          <Alert tone="warning">Due <DateText date={doc.dueDate} />; <Money amount={openAmt?.toString() ?? "0"} currency={doc.currency} /> is still open.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card>
            <DescriptionList
              items={[
                { label: "Customer", value: contact?.displayName },
                { label: `${label} date`, value: <DateText date={doc.issueDate} /> },
                ...(doc.postingDate && doc.postingDate !== doc.issueDate ? [{ label: "Posting date", value: <DateText date={doc.postingDate} /> }] : []),
                ...(kind === "invoice" ? [{ label: "Due", value: <DateText date={doc.dueDate} /> }] : []),
                ...(kind === "estimate" ? [{ label: "Valid until", value: <DateText date={doc.expiryDate} /> }] : []),
                { label: "Currency", value: doc.currency === ctx.org.baseCurrency ? doc.currency : `${doc.currency} at ${Decimal.from(doc.fxRate).normalize().toString()} ${ctx.org.baseCurrency}` },
                ...(doc.reference ? [{ label: "Reference", value: doc.reference }] : []),
                ...(doc.journalEntryId ? [{ label: "Ledger", value: <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${doc.journalEntryId}`}>View entry</Link> }] : []),
                ...(doc.sentAt ? [{ label: "Last sent", value: formatDateTime(doc.sentAt, ctx.org.timezone) }] : []),
                ...(doc.memo ? [{ label: "Memo", value: doc.memo }] : []),
              ]}
            />
          </Card>
          <Table>
            <thead>
              <tr>
                <Th>Description</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Price</Th>
                <Th align="right" className="hidden sm:table-cell">Tax</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l) => (
                <tr key={l.id}>
                  <Td>
                    {l.lineType === "shipping" && <span className="mr-1 text-xs uppercase text-slate-500">Shipping</span>}
                    {l.description}
                    {l.discountRate && !Decimal.from(l.discountRate).isZero() && <span className="ml-2 text-xs text-slate-500">−{Decimal.from(l.discountRate).mul(100).normalize().toString()}%</span>}
                    {l.serviceDate && <div className="text-xs text-slate-500">Service date <DateText date={l.serviceDate} /></div>}
                  </Td>
                  <Td align="right" className="num">{Decimal.from(l.quantity).normalize().toString()}</Td>
                  <Td align="right"><Money amount={Decimal.from(l.unitPrice).normalize().toString()} currency={doc.currency} /></Td>
                  <Td align="right" className="hidden sm:table-cell"><Money amount={l.taxAmount} currency={doc.currency} showZero={false} /></Td>
                  <Td align="right"><Money amount={Decimal.from(doc.taxInclusive ? l.grossAmount : l.netAmount).add(l.documentDiscount).toString()} currency={doc.currency} /></Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="ml-auto w-full max-w-sm space-y-1.5 rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <Row label="Subtotal" value={<Money amount={doc.subtotal} currency={doc.currency} />} />
            {!Decimal.from(doc.discountTotal).isZero() && <Row label="Discount" value={<Money amount={Decimal.from(doc.discountTotal).neg().toString()} currency={doc.currency} />} />}
            {taxSummary.map((t, i) => (
              <Row
                key={i}
                label={t.exempt ? `${t.name} (exempt sale of ${Decimal.from(t.taxable).toFixed(2)})` : `${t.name} ${Decimal.from(t.rate).mul(100).normalize().toString()}%${doc.taxInclusive ? " included" : ""}`}
                value={<Money amount={t.amount.toString()} currency={doc.currency} />}
              />
            ))}
            <div className="border-t border-slate-200 pt-1.5">
              <Row label="Total" value={<Money amount={doc.total} currency={doc.currency} />} strong />
            </div>
            {open !== null && doc.status !== "void" && <Row label={kind === "invoice" ? "Still open" : "Available to apply"} value={<Money amount={open} currency={doc.currency} />} strong />}
            {doc.currency !== ctx.org.baseCurrency && <Row label={`Total in ${ctx.org.baseCurrency}`} value={<Money amount={doc.baseTotal} currency={ctx.org.baseCurrency} />} />}
          </div>
          {doc.notes && (
            <Card title="Notes on the document">
              <p className="whitespace-pre-wrap text-sm text-slate-700">{doc.notes}</p>
            </Card>
          )}
          {applications.length > 0 && (
            <Card title={kind === "invoice" ? "Payments and credits applied" : "Applied to"} padded={false}>
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>{kind === "invoice" ? "From" : "To"}</Th>
                    <Th align="right">Amount</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {applications.map(({ settlement: s, other }) => (
                    <tr key={s.id} className={s.status === "reversed" ? "text-slate-400 line-through" : ""}>
                      <Td><DateText date={s.settlementDate} /></Td>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={`${base}/${other.type === "document" ? "documents" : "payments"}/${other.id}`}>{other.label}</Link>
                        {!Decimal.from(s.fxDifferenceBase).isZero() && <div className="text-xs text-slate-500">exchange difference <Money amount={s.fxDifferenceBase} currency={ctx.org.baseCurrency} /></div>}
                      </Td>
                      <Td align="right"><Money amount={s.amount} currency={s.currency} /></Td>
                      <Td align="right">
                        {s.status === "active" && can(ctx, "payments.void") ? (
                          <ConfirmButton
                            action={unapplyAction.bind(null, slug, s.id)}
                            label="Remove"
                            size="sm"
                            title="Remove this application?"
                            body="The amount goes back to being open on both items. The application stays in the history, reversed on the date you choose."
                            dateLabel="Date"
                            defaultDate={today < s.settlementDate ? s.settlementDate : today}
                            reasonLabel="Why?"
                            confirmLabel="Remove"
                          />
                        ) : s.status === "reversed" ? (
                          <span className="text-xs no-underline">removed</span>
                        ) : null}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          )}
        </div>
        <div className="space-y-6">
          {kind === "invoice" && isOpen && canPay && credits.length > 0 && (
            <Card title="Apply a credit">
              <p className="mb-3 text-sm text-slate-600">This customer has unapplied payments, deposits or credit notes.</p>
              <ActionForm action={applyCreditAction.bind(null, slug, { type: "document", id })} className="space-y-3">
                <SelectField
                  label="Credit"
                  name="credit"
                  required
                  options={credits.map((c) => ({ value: `${c.type}:${c.id}`, label: `${c.kind.replace(/_/g, " ")} ${c.number ?? ""} — ${Decimal.from(c.openTxn).toFixed(2)} ${c.currency}` }))}
                />
                <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={Decimal.min(openAmt!, Decimal.from(credits[0]!.openTxn)).toFixed(2)} />
                <TextField label="Date" name="date" type="date" required defaultValue={today} />
                <SubmitButton>Apply</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {kind === "credit_note" && !isWriteOff && isOpen && canPay && (
            <Card title="Use this credit">
              {openInvoices.length > 0 ? (
                <ActionForm action={applyToInvoiceAction.bind(null, slug, { type: "document", id })} className="space-y-3">
                  <SelectField label="Apply to invoice" name="invoiceId" required options={openInvoices.map((o) => ({ value: o.id, label: `${o.number} — ${Decimal.from(o.openTxn).toFixed(2)} open` }))} />
                  <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={Decimal.min(openAmt!, Decimal.from(openInvoices[0]!.openTxn)).toFixed(2)} />
                  <TextField label="Date" name="date" type="date" required defaultValue={today} />
                  <SubmitButton>Apply</SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">The customer has no open invoices in {doc.currency}.</p>
              )}
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-medium text-brand-700">Refund it instead</summary>
                <ActionForm action={refundCreditAction.bind(null, slug, { type: "document", id }, doc.contactId!, doc.currency)} className="mt-3 space-y-3">
                  <TextField label="Amount" name="amount" inputMode="decimal" required defaultValue={openAmt!.toFixed(2)} />
                  <TextField label="Date" name="date" type="date" required defaultValue={today} />
                  <SelectField label="Paid from" name="accountId" required placeholder="Choose…" options={moneyAccounts} />
                  <SelectField label="Method" name="method" defaultValue="check" options={["check", "ach", "wire", "card", "cash", "other"].map((m) => ({ value: m, label: m.toUpperCase() === "ACH" ? "ACH" : m[0]!.toUpperCase() + m.slice(1) }))} />
                  <TextField label="Reference" name="reference" />
                  <p className="text-xs text-slate-500">Recording a refund does not send money; pay it through your bank, then record it here.</p>
                  <SubmitButton>Record refund</SubmitButton>
                </ActionForm>
              </details>
            </Card>
          )}
          {kind === "invoice" && isOpen && canVoid && (
            <Card title="Write off">
              <p className="mb-3 text-sm text-slate-600">If the customer will not pay, write off what is open as bad debt.</p>
              <ConfirmButton
                action={writeOffAction.bind(null, slug, id)}
                label="Write off the balance"
                title={`Write off ${openAmt!.toFixed(2)} ${doc.currency}?`}
                body="A write-off is posted to bad debt and applied to this invoice, closing it. Sales tax already reported is not reduced automatically; record a sales-tax adjustment if your jurisdiction allows one."
                dateLabel="Write-off date"
                defaultDate={today}
                reasonLabel="Why is it uncollectible?"
                confirmLabel="Write off"
                variant="danger"
              />
            </Card>
          )}
          {kind === "invoice" && isOpen && (
            <Card title="Online payment">
              {openLink ? (
                <div className="space-y-2 text-sm">
                  <p>
                    Customers can pay at{" "}
                    <a href={openLink.url} className="break-all text-brand-700 hover:underline" target="_blank" rel="noopener noreferrer">
                      {openLink.url}
                    </a>
                  </p>
                  <p className="text-xs text-slate-500">
                    {openLink.provider === "sandbox" ? "Sandbox link: paying there moves no money." : "The link is included in emailed invoices and the PDF."} Amount {openLink.amount.replace(/0+$/, "").replace(/\.$/, "")} {openLink.currency}.
                  </p>
                  {canIssue && !Decimal.from(openLink.amount).eq(openAmt!) && <ActionButton size="sm" action={createPaymentLinkAction.bind(null, slug, id)}>Refresh for the open amount</ActionButton>}
                </div>
              ) : conn ? (
                canIssue ? (
                  <ActionButton action={createPaymentLinkAction.bind(null, slug, id)}>Create a payment link ({conn.provider === "sandbox" ? "sandbox" : "Stripe"})</ActionButton>
                ) : (
                  <p className="text-sm text-slate-600">No link yet.</p>
                )
              ) : (
                <p className="text-sm text-slate-600">
                  Connect a payment provider under <Link className="text-brand-700 hover:underline" href={`${base}/settings/integrations`}>Settings → Integrations</Link> to let customers pay online.
                </p>
              )}
            </Card>
          )}
          {mail && (
            <Card title="Send">
              <ActionForm action={emailDocumentAction.bind(null, slug, id)} className="space-y-3">
                <TextField label="To" name="to" type="email" required defaultValue={mail.to} />
                <TextField label="Copy to" name="cc" type="email" />
                <TextField label="Subject" name="subject" defaultValue={mail.subject} />
                <TextAreaField label="Message" name="body" rows={6} defaultValue={mail.body} />
                <SubmitButton pendingText="Queuing…">Email with PDF</SubmitButton>
              </ActionForm>
              {emails.length > 0 && (
                <ul className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-sm">
                  {emails.map((m) => (
                    <li key={m.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate">{m.toAddress}</span>
                        <Badge tone={m.status === "sent" || m.status === "delivered" ? "green" : m.status === "failed" || m.status === "bounced" ? "red" : "amber"}>
                          {m.status === "not_delivered" ? "not delivered (outbox)" : m.status}
                        </Badge>
                      </div>
                      <div className="text-xs text-slate-500">
                        {formatDateTime(m.createdAt, ctx.org.timezone)}
                        {m.lastError ? ` · ${m.lastError}` : ""}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {emails.some((m) => m.provider === "outbox") && (
                <p className="mt-2 text-xs text-slate-500">This server keeps mail in its outbox and does not deliver it. Download the PDF and send it yourself, or ask the administrator to configure email.</p>
              )}
            </Card>
          )}
          <Attachments org={slug} entityType="document" entityId={id} files={files} canUpload={canManage} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-4 ${strong ? "font-semibold" : ""}`}>
      <span className="text-slate-600">{label}</span>
      <span>{value}</span>
    </div>
  );
}

