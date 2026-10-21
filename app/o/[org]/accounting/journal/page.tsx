import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listEntries } from "@/lib/ledger/journals";
import { can } from "@/lib/context";
import { dateParam, intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, DateText, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, Table, Td, Th, inputClass } from "@/components/ui";
import { ENTRY_KINDS } from "@/lib/db/schema/ledger";

export const metadata = { title: "Journal entries" };

export default async function Journal({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const page = intParam(sp.page, 1);
  const { rows, total, pageSize } = await listEntries(getDb(), ctx.orgId, {
    q: sp.q,
    from: dateParam(sp.from),
    to: dateParam(sp.to),
    status: sp.status === "draft" || sp.status === "posted" ? sp.status : undefined,
    kind: sp.kind,
    page,
    sort: (sp.sort as never) ?? "date_desc",
  });
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Journal entries"
        description="Every posting in the books, from every source. Manual entries are made here; invoices, bills, payments and the rest post their own."
        actions={can(ctx, "ledger.draft") && <LinkButton href={`${base}/accounting/journal/new`}>New journal entry</LinkButton>}
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, description, reference" className={inputClass} />
        </FilterField>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            <option value="posted">Posted</option>
            <option value="draft">Draft</option>
          </select>
        </FilterField>
        <FilterField label="Source">
          <select name="kind" defaultValue={sp.kind ?? ""} className={inputClass}>
            <option value="">All</option>
            {ENTRY_KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No entries" action={can(ctx, "ledger.draft") && <LinkButton href={`${base}/accounting/journal/new`}>New journal entry</LinkButton>}>
          {sp.q || sp.from || sp.to ? "Nothing matches these filters." : "Entries appear here as you post invoices, bills, payments and journal entries."}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="No." sortKey="number" current={sp.sort} params={sp} />
                <SortTh label="Date" sortKey="date" current={sp.sort ?? "date_desc"} params={sp} />
                <Th>Description</Th>
                <Th className="hidden md:table-cell">Source</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ entry, total: amt, reversedBy }) => (
                <tr key={entry.id} className="hover:bg-slate-50">
                  <Td className="num">
                    <Link href={`${base}/accounting/journal/${entry.id}`} className="font-medium text-brand-700 hover:underline">
                      {entry.entryNumber ? `#${entry.entryNumber}` : "Draft"}
                    </Link>
                  </Td>
                  <Td>
                    <DateText date={entry.entryDate} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="max-w-md truncate">{entry.description}</span>
                      {entry.status === "draft" && <Badge tone="amber">draft</Badge>}
                      {entry.reversesEntryId && <Badge tone="gray">reversal</Badge>}
                      {reversedBy && <Badge tone="red">reversed by #{reversedBy}</Badge>}
                      {entry.isAdjusting && <Badge tone="blue">adjusting</Badge>}
                    </div>
                  </Td>
                  <Td className="hidden text-slate-600 md:table-cell">{entry.kind.replace(/_/g, " ")}</Td>
                  <Td align="right">
                    <Money amount={amt} currency={ctx.org.baseCurrency} />
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
