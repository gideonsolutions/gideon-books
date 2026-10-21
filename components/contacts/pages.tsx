/**
 * Customer and vendor pages, shared: the list, the form, and the contact's
 * page with what is open, recent documents and payments. `role` decides the
 * labels and which side's items are shown.
 */
import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { paymentTerms } from "@/lib/db/schema/ledger";
import { orgCtx } from "@/lib/web/session";
import { getContact, getContactPersons, listContacts } from "@/lib/contacts/contacts";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { contactActivity } from "@/lib/sales/documents";
import { KIND_LABELS, displayStatus } from "@/lib/commerce/states";
import { PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import { listAttachments } from "@/lib/storage/attachments";
import { listAudit } from "@/lib/audit";
import { accountOptions, currencyOptions } from "@/lib/web/options";
import { documentPath, paymentPath } from "@/lib/web/routes";
import { can, requirePermission, type Ctx } from "@/lib/context";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Decimal } from "@/lib/money/decimal";
import { todayIn } from "@/lib/dates";
import { Alert, Badge, Card, DateText, DescriptionList, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, StatusBadge, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { ContactForm, type ContactDefaults } from "./contact-form";
import { archiveContactAction, createContactAction, updateContactAction } from "./actions";

export type ContactRole = "customer" | "vendor";

const LABELS = {
  customer: { one: "Customer", many: "Customers", path: "/sales/customers", side: "receivables" as const },
  vendor: { one: "Vendor", many: "Vendors", path: "/purchases/vendors", side: "payables" as const },
};

/** Balance owed to us (customers) or by us (vendors), per contact, in each contact's currency. */
async function balances(ctx: Ctx, role: ContactRole, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const controls = role === "customer" ? sql`('receivables', 'customer_deposits')` : sql`('payables', 'vendor_prepayments')`;
  const res = await getDb().execute<{ contact_id: string; txn: string }>(sql`
    select l.contact_id, sum(l.txn_amount)::text as txn
    from journal_lines l
    join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    join accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${ctx.orgId} and e.status = 'posted' and a.control in ${controls}
      and l.contact_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    group by l.contact_id`);
  return new Map(res.rows.map((r) => [r.contact_id, role === "customer" ? r.txn : Decimal.from(r.txn).neg().toString()]));
}

export async function ContactListPage({ slug, role, searchParams }: { slug: string; role: ContactRole; searchParams: SearchParams }) {
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(slug);
  const L = LABELS[role];
  const page = intParam(sp.page, 1);
  const { rows, total, pageSize } = await listContacts(getDb(), ctx.orgId, {
    role,
    q: sp.q,
    includeArchived: sp.archived === "1",
    page,
    sort: (sp.sort as "name_asc" | "name_desc" | "created_desc" | undefined) ?? "name_asc",
  });
  const bal = await balances(ctx, role, rows.map((r) => r.id));
  const base = `/o/${slug}`;
  return (
    <>
      <PageHeader
        title={L.many}
        description={role === "customer" ? "Everyone you invoice. Balances include unapplied payments and deposits." : "Everyone you buy from or reimburse. Balances are what you owe, net of prepayments and credits."}
        actions={can(ctx, "contacts.manage") && <LinkButton href={`${base}${L.path}/new`}>New {L.one.toLowerCase()}</LinkButton>}
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Name, company or email" className={inputClass} />
        </FilterField>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === "1"} /> Include archived
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={sp.q ? `No ${L.many.toLowerCase()} match` : `No ${L.many.toLowerCase()} yet`} action={can(ctx, "contacts.manage") && <LinkButton href={`${base}${L.path}/new`}>New {L.one.toLowerCase()}</LinkButton>}>
          {role === "customer" ? "Add the people and businesses you sell to; invoices and statements go to them." : "Add the businesses you buy from, so bills and payments are tracked by vendor."}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="Name" sortKey="name" current={sp.sort ?? "name_asc"} params={sp} />
                <Th className="hidden md:table-cell">Email</Th>
                <Th className="hidden sm:table-cell">Phone</Th>
                <Th align="right">{role === "customer" ? "Owes you" : "You owe"}</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((c) => (
                <tr key={c.id} className={c.isArchived ? "opacity-60" : "hover:bg-slate-50"}>
                  <Td>
                    <Link href={`${base}${L.path}/${c.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                      {c.displayName}
                    </Link>
                    {c.companyName && c.companyName !== c.displayName && <div className="text-xs text-slate-500">{c.companyName}</div>}
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {c.currency && <Badge tone="blue">{c.currency}</Badge>}
                      {c.taxExempt && role === "customer" && <Badge tone="amber">tax-exempt</Badge>}
                      {c.is1099 && role === "vendor" && <Badge>1099</Badge>}
                      {c.isArchived && <Badge tone="amber">archived</Badge>}
                    </div>
                  </Td>
                  <Td className="hidden text-slate-600 md:table-cell">{c.email}</Td>
                  <Td className="hidden text-slate-600 sm:table-cell">{c.phone}</Td>
                  <Td align="right">
                    <Money amount={bal.get(c.id) ?? "0"} currency={c.currency ?? ctx.org.baseCurrency} />
                  </Td>
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

async function formOptions(ctx: Ctx) {
  const db = getDb();
  const terms = await db.select().from(paymentTerms).where(and(eq(paymentTerms.orgId, ctx.orgId), eq(paymentTerms.isArchived, false))).orderBy(asc(paymentTerms.daysDue));
  return {
    currencies: currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency),
    terms: terms.map((t) => ({ value: t.id, label: t.name })),
    incomeAccounts: await accountOptions(db, ctx.orgId, { types: ["income"] }),
    expenseAccounts: await accountOptions(db, ctx.orgId, { types: ["expense", "asset"], excludeControl: true }),
    baseCurrency: ctx.org.baseCurrency,
  };
}

export async function ContactNewPage({ slug, role }: { slug: string; role: ContactRole }) {
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "contacts.manage");
  const L = LABELS[role];
  return (
    <>
      <PageHeader title={`New ${L.one.toLowerCase()}`} back={{ href: `/o/${slug}${L.path}`, label: L.many }} />
      <Card className="max-w-3xl">
        <ContactForm action={createContactAction.bind(null, slug, L.path)} defaults={{}} primaryRole={role} submitLabel={`Create ${L.one.toLowerCase()}`} {...await formOptions(ctx)} />
      </Card>
    </>
  );
}

export async function ContactEditPage({ slug, role, id }: { slug: string; role: ContactRole; id: string }) {
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "contacts.manage");
  const L = LABELS[role];
  const db = getDb();
  const c = await getContact(db, ctx.orgId, id).catch(() => notFound());
  const persons = await getContactPersons(db, ctx.orgId, id);
  const defaults: ContactDefaults = { ...c, billingAddress: c.billingAddress as ContactDefaults["billingAddress"], shippingAddress: c.shippingAddress as ContactDefaults["shippingAddress"], persons };
  return (
    <>
      <PageHeader title={`Edit ${c.displayName}`} back={{ href: `/o/${slug}${L.path}/${id}`, label: c.displayName }} />
      <Card className="max-w-3xl">
        <ContactForm action={updateContactAction.bind(null, slug, L.path, id)} defaults={defaults} primaryRole={role} submitLabel="Save changes" {...await formOptions(ctx)} />
      </Card>
    </>
  );
}

export async function ContactDetailPage({ slug, role, id }: { slug: string; role: ContactRole; id: string }) {
  const ctx = await orgCtx(slug);
  const L = LABELS[role];
  const db = getDb();
  const c = await getContact(db, ctx.orgId, id).catch(() => notFound());
  const [persons, open, activity, files, history] = await Promise.all([
    getContactPersons(db, ctx.orgId, id),
    openItemsForContact(db, ctx.orgId, L.side, id),
    contactActivity(db, ctx.orgId, id),
    listAttachments(db, ctx.orgId, "contact", id),
    listAudit(db, ctx.orgId, { entityType: "contact", entityId: id, limit: 20 }),
  ]);
  const [termsRow] = c.paymentTermsId ? await db.select().from(paymentTerms).where(and(eq(paymentTerms.orgId, ctx.orgId), eq(paymentTerms.id, c.paymentTermsId))) : [];
  const currency = c.currency ?? ctx.org.baseCurrency;
  const bal = (await balances(ctx, role, [id])).get(id) ?? "0";
  const today = todayIn(ctx.org.timezone);
  const base = `/o/${slug}`;
  const sideDocs = activity.docs.filter((d) => (role === "customer" ? d.side === "sales" : d.side === "purchases"));
  const sidePays = activity.pays.filter((p) => (role === "customer" ? p.kind.startsWith("customer") : p.kind.startsWith("vendor")));
  const otherRole = role === "customer" ? c.isVendor : c.isCustomer;
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.displayName}
            {c.isArchived && <Badge tone="amber">archived</Badge>}
            {c.taxExempt && role === "customer" && <Badge tone="amber">tax-exempt</Badge>}
          </span>
        }
        description={c.companyName && c.companyName !== c.displayName ? c.companyName : undefined}
        back={{ href: `${base}${L.path}`, label: L.many }}
        actions={
          <>
            {role === "customer" && can(ctx, "sales.manage") && !c.isArchived && (
              <>
                <LinkButton href={`${base}/sales/invoices/new?customer=${id}`}>New invoice</LinkButton>
                <LinkButton variant="secondary" href={`${base}/sales/payments/new?customer=${id}`}>
                  Receive payment
                </LinkButton>
                <LinkButton variant="secondary" href={`${base}/sales/customers/${id}/statement`}>
                  Statement
                </LinkButton>
              </>
            )}
            {role === "vendor" && can(ctx, "purchases.manage") && !c.isArchived && (
              <>
                <LinkButton href={`${base}/purchases/bills/new?vendor=${id}`}>New bill</LinkButton>
                <LinkButton variant="secondary" href={`${base}/purchases/payments/new?vendor=${id}`}>
                  Pay
                </LinkButton>
              </>
            )}
            {can(ctx, "contacts.manage") && (
              <>
                <LinkButton variant="secondary" href={`${base}${L.path}/${id}/edit`}>
                  Edit
                </LinkButton>
                <ActionButton action={archiveContactAction.bind(null, slug, id, !c.isArchived)}>{c.isArchived ? "Restore" : "Archive"}</ActionButton>
              </>
            )}
          </>
        }
      />
      {otherRole && (
        <div className="mb-4">
          <Alert tone="info">
            Also a {role === "customer" ? "vendor" : "customer"}:{" "}
            <Link className="underline" href={`${base}${role === "customer" ? LABELS.vendor.path : LABELS.customer.path}/${id}`}>
              see the {role === "customer" ? "vendor" : "customer"} side
            </Link>
            .
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title={`Open items (${open.length})`} padded={false}>
            {open.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing is open.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Date</Th>
                    <Th>Due</Th>
                    <Th align="right">Open</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {open.map((o) => (
                    <tr key={o.id}>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={`${base}/${o.type === "document" ? "documents" : "payments"}/${o.id}`}>
                          {o.type === "document" ? KIND_LABELS[o.kind as keyof typeof KIND_LABELS] : PAYMENT_KIND_LABELS[o.kind as keyof typeof PAYMENT_KIND_LABELS]} {o.number}
                        </Link>
                        {o.nature === (role === "customer" ? "credit" : "debit") && <span className="ml-2 text-xs text-slate-500">(credit available)</span>}
                      </Td>
                      <Td>
                        <DateText date={o.date} />
                      </Td>
                      <Td>
                        <DateText date={o.dueDate} />
                        {o.dueDate && o.dueDate < today && <Badge tone="red">overdue</Badge>}
                      </Td>
                      <Td align="right">
                        <Money amount={o.nature === (role === "customer" ? "debit" : "credit") ? o.openTxn : Decimal.from(o.openTxn).neg().toString()} currency={o.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Recent documents" padded={false}>
            {sideDocs.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No documents yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Date</Th>
                    <Th>Status</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sideDocs.map((d) => (
                    <tr key={d.id}>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={documentPath(base, d.kind, d.id)}>
                          {KIND_LABELS[d.kind]} {d.number ?? d.reference ?? "(draft)"}
                        </Link>
                      </Td>
                      <Td>
                        <DateText date={d.issueDate} />
                      </Td>
                      <Td>
                        <StatusBadge status={displayStatus(d, today)} />
                      </Td>
                      <Td align="right">
                        <Money amount={d.total} currency={d.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title="Recent payments" padded={false}>
            {sidePays.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No payments yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Payment</Th>
                    <Th>Date</Th>
                    <Th>Status</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {sidePays.map((p) => (
                    <tr key={p.id}>
                      <Td>
                        <Link className="text-brand-700 hover:underline" href={paymentPath(base, p.kind, p.id)}>
                          {PAYMENT_KIND_LABELS[p.kind]} {p.number}
                        </Link>
                      </Td>
                      <Td>
                        <DateText date={p.paymentDate} />
                      </Td>
                      <Td>
                        <StatusBadge status={p.status} />
                      </Td>
                      <Td align="right">
                        <Money amount={p.amount} currency={p.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title={role === "customer" ? "Owes you" : "You owe"}>
            <div className="num text-2xl font-semibold">
              <Money amount={bal} currency={currency} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Net of unapplied payments, credits, {role === "customer" ? "and deposits" : "and prepayments"}.</p>
          </Card>
          <Card title="Details">
            <DescriptionList
              items={[
                { label: "Email", value: c.email },
                { label: "Phone", value: c.phone },
                { label: "Currency", value: currency },
                { label: "Payment terms", value: termsRow?.name },
                ...(role === "customer" && c.taxExempt ? [{ label: "Tax exemption", value: `${c.taxExemptionReason ?? ""}${c.taxExemptionCertificate ? ` (certificate ${c.taxExemptionCertificate})` : ""}` }] : []),
                ...(role === "vendor" ? [{ label: "Form 1099", value: c.is1099 ? "Yes" : "No" }] : []),
                {
                  label: "Billing address",
                  value: c.billingAddress ? Object.values(c.billingAddress).filter(Boolean).join(", ") : null,
                },
                { label: "Notes", value: c.notes },
              ]}
            />
          </Card>
          {persons.length > 0 && (
            <Card title="People">
              <ul className="space-y-2 text-sm">
                {persons.map((p) => (
                  <li key={p.id}>
                    <div className="font-medium">
                      {p.name} {p.isPrimary && <Badge tone="blue">primary</Badge>}
                    </div>
                    <div className="text-xs text-slate-500">{[p.role, p.email, p.phone].filter(Boolean).join(" · ")}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Attachments org={slug} entityType="contact" entityId={id} files={files} canUpload={can(ctx, "contacts.manage")} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
