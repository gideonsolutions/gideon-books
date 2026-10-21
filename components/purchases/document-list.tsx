import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listDocuments } from "@/lib/commerce/documents";
import { listReimbursements } from "@/lib/purchases/queries";
import { contactOptions } from "@/lib/web/options";
import { dateParam, intParam } from "@/lib/web/params";
import { displayStatus, STATUS_LABELS } from "@/lib/commerce/states";
import { todayIn } from "@/lib/dates";
import type { Ctx } from "@/lib/context";
import { DateText, EmptyState, FilterBar, FilterField, LinkButton, Money, Pagination, SortTh, StatusBadge, Table, Td, Th, inputClass, Badge } from "@/components/ui";
import { PURCHASE_KINDS, type PurchaseKind } from "./kinds";

const STATUS_FILTERS: Record<PurchaseKind, string[]> = {
  bill: ["draft", "open", "overdue", "partially_paid", "paid", "void"],
  expense: ["draft", "paid", "void"],
  vendor_credit: ["draft", "issued", "closed", "void"],
  purchase_order: ["draft", "issued", "partially_received", "received", "closed", "cancelled"],
};

/** The list page body for a purchase document kind: filters, sortable table, pagination. */
export async function PurchaseDocumentList({ org, ctx, kind, sp, canCreate }: { org: string; ctx: Ctx; kind: PurchaseKind; sp: Record<string, string | undefined>; canCreate: boolean }) {
  const cfg = PURCHASE_KINDS[kind];
  const page = intParam(sp.page, 1);
  const today = todayIn(ctx.org.timezone);
  const overdue = sp.status === "overdue";
  const db = getDb();
  const reimbursementsOnly = kind === "bill" && sp.reimbursements === "1";
  const query = {
    kind,
    status: overdue ? undefined : sp.status,
    overdue,
    today,
    contactId: sp.vendor,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    q: sp.q,
    page,
    sort: (sp.sort as never) ?? "date_desc",
  } as const;
  const { rows: shown, total, pageSize } = reimbursementsOnly
    ? await listReimbursements(db, ctx.orgId, { contactId: sp.vendor, from: dateParam(sp.from), to: dateParam(sp.to), status: sp.status, page })
    : await listDocuments(db, ctx.orgId, query);
  const vendors = [...(await contactOptions(db, ctx.orgId, "vendor")), ...(kind === "bill" ? (await contactOptions(db, ctx.orgId, "employee")).map((e) => ({ ...e, label: `${e.label} (employee)` })) : [])];
  const base = `/o/${org}`;
  const filtered = !!(sp.q || sp.vendor || sp.from || sp.to || sp.status || reimbursementsOnly);
  return (
    <>
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, reference, vendor, memo" className={inputClass} />
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
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            {STATUS_FILTERS[kind].map((s) => (
              <option key={s} value={s}>
                {s === "open" ? "Open (unpaid)" : s === "overdue" ? "Overdue" : STATUS_LABELS[s as keyof typeof STATUS_LABELS]}
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
        {kind === "bill" && (
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" name="reimbursements" value="1" defaultChecked={reimbursementsOnly} /> Reimbursements only
          </label>
        )}
      </FilterBar>
      {shown.length === 0 ? (
        <EmptyState title={filtered ? `No ${cfg.plural.toLowerCase()} match` : `No ${cfg.plural.toLowerCase()} yet`} action={canCreate && !filtered && <LinkButton href={`${base}${cfg.path}/new`}>New {cfg.label.toLowerCase()}</LinkButton>}>
          {filtered ? "Change or clear the filters." : cfg.description}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="Number" sortKey="number" current={sp.sort} params={sp} />
                <SortTh label="Date" sortKey="date" current={sp.sort ?? "date_desc"} params={sp} />
                <Th>Vendor</Th>
                <Th className="hidden md:table-cell">Reference</Th>
                {(kind === "bill" || kind === "purchase_order") && <SortTh label={kind === "bill" ? "Due" : "Expected"} sortKey="due" current={sp.sort} params={sp} />}
                <Th>Status</Th>
                <SortTh label="Total" sortKey="total" current={sp.sort} params={sp} align="right" />
                {(kind === "bill" || kind === "vendor_credit") && <Th align="right">Open</Th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {shown.map(({ doc, contactName, openAmount }) => (
                <tr key={doc.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`${base}${cfg.path}/${doc.id}`} className="font-medium text-brand-700 hover:underline">
                      {doc.number ?? "Draft"}
                    </Link>
                    {doc.isReimbursement && (
                      <span className="ml-2">
                        <Badge tone="blue">reimbursement</Badge>
                      </span>
                    )}
                  </Td>
                  <Td>
                    <DateText date={doc.issueDate} />
                  </Td>
                  <Td className="max-w-48 truncate">{contactName}</Td>
                  <Td className="hidden max-w-40 truncate text-slate-600 md:table-cell">{doc.reference}</Td>
                  {(kind === "bill" || kind === "purchase_order") && (
                    <Td>
                      <DateText date={kind === "bill" ? doc.dueDate : doc.expiryDate} />
                    </Td>
                  )}
                  <Td>
                    <StatusBadge status={displayStatus(doc, today)} />
                  </Td>
                  <Td align="right">
                    <Money amount={doc.total} currency={doc.currency} />
                  </Td>
                  {(kind === "bill" || kind === "vendor_credit") && (
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
