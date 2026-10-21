import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { searchOrg, type SearchHit } from "@/lib/search";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Badge, EmptyState, PageHeader, inputClass, buttonClass } from "@/components/ui";

export const metadata = { title: "Search" };

const LABEL: Record<SearchHit["type"], string> = {
  contact: "Contact",
  document: "Document",
  payment: "Payment",
  item: "Item",
  account: "Account",
  journal_entry: "Journal entry",
};

function href(base: string, h: SearchHit): string {
  switch (h.type) {
    case "contact":
      return `${base}/contacts/${h.id}`;
    case "document":
      return `${base}/documents/${h.id}`;
    case "payment":
      return `${base}/payments/${h.id}`;
    case "item":
      return `${base}/inventory/items/${h.id}`;
    case "account":
      return `${base}/accounting/accounts/${h.id}`;
    case "journal_entry":
      return `${base}/accounting/journal/${h.id}`;
  }
}

export default async function Search({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const q = sp.q ?? "";
  const hits = q ? await searchOrg(getDb(), ctx.orgId, q, 15) : [];
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader title="Search" />
      <form method="get" className="mb-6 flex gap-2" role="search">
        <input name="q" defaultValue={q} autoFocus placeholder="Customer, invoice number, item, account, entry…" className={inputClass} aria-label="Search" />
        <button className={buttonClass("primary")}>Search</button>
      </form>
      {q && hits.length === 0 && <EmptyState title={`Nothing matches “${q}”`}>Try a name, a document number or part of a description.</EmptyState>}
      {hits.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {hits.map((h) => (
            <li key={`${h.type}-${h.id}`}>
              <Link href={href(base, h)} className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50">
                <span className="min-w-0">
                  <span className="block truncate font-medium text-slate-900">{h.title}</span>
                  <span className="block truncate text-xs text-slate-500">{h.subtitle}</span>
                </span>
                <Badge>{LABEL[h.type]}</Badge>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
