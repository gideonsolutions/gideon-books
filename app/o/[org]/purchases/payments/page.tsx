import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listPayments, PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import { can } from "@/lib/context";
import { contactOptions } from "@/lib/web/options";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Alert, DateText, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, StatusBadge, Table, Td, Th, inputClass } from "@/components/ui";
import type { PaymentKind } from "@/lib/db/schema/commerce";

export const metadata = { title: "Payments made" };

const KINDS: PaymentKind[] = ["vendor_payment", "vendor_prepayment", "vendor_refund"];

export default async function Payments({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const page = intParam(sp.page, 1);
  const { rows, total, pageSize } = await listPayments(db, ctx.orgId, {
    side: "vendor",
    kind: KINDS.includes(sp.kind as PaymentKind) ? (sp.kind as PaymentKind) : undefined,
    contactId: sp.vendor,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    q: sp.q,
    status: sp.status === "void" || sp.status === "posted" ? sp.status : undefined,
    unapplied: sp.unapplied === "1",
    page,
    sort: (sp.sort as never) ?? "date_desc",
  });
  const vendors = await contactOptions(db, ctx.orgId, "vendor");
  const base = `/o/${org}`;
  const canPay = can(ctx, "payments.record");
  return (
    <>
      <PageHeader
        title="Payments made"
        description="Payments to vendors, prepayments, and refunds vendors sent back."
        actions={
          canPay && (
            <>
              <LinkButton variant="secondary" href={`${base}/purchases/payments/new?kind=vendor_prepayment`}>
                Prepayment
              </LinkButton>
              <LinkButton href={`${base}/purchases/payments/new`}>Pay bills</LinkButton>
            </>
          )
        }
      />
      <div className="mb-4">
        <Alert tone="info">Recording a payment here records that it was made. Gideon Books never sends money; pay through your bank as usual.</Alert>
      </div>
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, reference, vendor" className={inputClass} />
        </FilterField>
        <FilterField label="Vendor">
          <select name="vendor" defaultValue={sp.vendor ?? ""} className={inputClass}>
            <option value="">All</option>
            {vendors.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Kind">
          <select name="kind" defaultValue={sp.kind ?? ""} className={inputClass}>
            <option value="">All</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {PAYMENT_KIND_LABELS[k]}
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
          <input type="checkbox" name="unapplied" value="1" defaultChecked={sp.unapplied === "1"} /> With unapplied amounts
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No payments" action={canPay && <LinkButton href={`${base}/purchases/payments/new`}>Pay bills</LinkButton>}>
          Payments you record against bills appear here.
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Number</Th>
                <SortTh label="Date" sortKey="date" current={sp.sort ?? "date_desc"} params={sp} />
                <Th>Vendor</Th>
                <Th className="hidden md:table-cell">Kind</Th>
                <Th className="hidden lg:table-cell">Account</Th>
                <Th>Status</Th>
                <SortTh label="Amount" sortKey="amount" current={sp.sort} params={sp} align="right" />
                <Th align="right">Unapplied</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ payment: p, contactName, accountName, unapplied }) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td>
                    <Link className="font-medium text-brand-700 hover:underline" href={`${base}/purchases/payments/${p.id}`}>
                      {p.number}
                    </Link>
                    {p.reference && <div className="text-xs text-slate-500">{p.reference}</div>}
                  </Td>
                  <Td>
                    <DateText date={p.paymentDate} />
                  </Td>
                  <Td>{contactName}</Td>
                  <Td className="hidden text-slate-600 md:table-cell">{PAYMENT_KIND_LABELS[p.kind]}</Td>
                  <Td className="hidden text-slate-600 lg:table-cell">{accountName}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td align="right">
                    <Money amount={p.amount} currency={p.currency} />
                  </Td>
                  <Td align="right">{p.status === "void" ? <span className="text-slate-400">—</span> : <Money amount={unapplied} currency={p.currency} showZero={false} />}</Td>
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
