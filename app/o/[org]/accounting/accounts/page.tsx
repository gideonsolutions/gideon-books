import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listAccounts, SUBTYPE_LABELS } from "@/lib/ledger/accounts";
import { accountBalances } from "@/lib/ledger/balances";
import { can } from "@/lib/context";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Badge, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import type { AccountType } from "@/lib/db/schema/ledger";
import { todayIn } from "@/lib/dates";

export const metadata = { title: "Chart of accounts" };

const TYPES: { type: AccountType; label: string }[] = [
  { type: "asset", label: "Assets" },
  { type: "liability", label: "Liabilities" },
  { type: "equity", label: "Equity" },
  { type: "income", label: "Income" },
  { type: "expense", label: "Expenses" },
];

export default async function Accounts({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const all = await listAccounts(db, ctx.orgId, { includeArchived: sp.archived === "1" });
  const asOf = todayIn(ctx.org.timezone);
  const balances = await accountBalances(db, ctx.orgId, { asOf });
  const q = sp.q?.toLowerCase();
  const rows = all.filter((a) => (!q || a.name.toLowerCase().includes(q) || a.code.toLowerCase().includes(q)) && (!sp.type || a.type === sp.type));
  const byId = new Map(all.map((a) => [a.id, a]));
  const depth = (id: string | null, n = 0): number => (id && n < 6 ? depth(byId.get(id)?.parentId ?? null, n + 1) : n);
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description={`Balances as of ${asOf}. Each balance links to its general ledger. Accounts marked “subledger” are kept by invoices, bills, stock or the asset register, not by journal entries.`}
        actions={can(ctx, "accounts.manage") && <LinkButton href={`${base}/accounting/accounts/new`}>New account</LinkButton>}
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Code or name" className={inputClass} />
        </FilterField>
        <FilterField label="Type">
          <select name="type" defaultValue={sp.type ?? ""} className={inputClass}>
            <option value="">All</option>
            {TYPES.map((t) => (
              <option key={t.type} value={t.type}>
                {t.label}
              </option>
            ))}
          </select>
        </FilterField>
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input type="checkbox" name="archived" value="1" defaultChecked={sp.archived === "1"} /> Show archived
        </label>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No accounts match">Clear the search to see the whole chart.</EmptyState>
      ) : (
        <div className="space-y-6">
          {TYPES.map(({ type, label }) => {
            const group = rows.filter((a) => a.type === type);
            if (!group.length) return null;
            return (
              <section key={type}>
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{label}</h2>
                <Table>
                  <thead>
                    <tr>
                      <Th className="w-24">Code</Th>
                      <Th>Name</Th>
                      <Th className="hidden md:table-cell">Type</Th>
                      <Th align="right">Balance</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {group.map((a) => {
                      const b = balances.get(a.id);
                      return (
                        <tr key={a.id} className={a.isArchived ? "opacity-60" : ""}>
                          <Td className="num font-mono text-xs text-slate-600">{a.code}</Td>
                          <Td>
                            <span style={{ paddingLeft: `${depth(a.parentId) * 1.25}rem` }} className="inline-flex flex-wrap items-center gap-2">
                              <Link href={`${base}/accounting/accounts/${a.id}`} className="font-medium text-slate-900 hover:text-brand-700">
                                {a.name}
                              </Link>
                              {a.currency && <Badge tone="blue">{a.currency}</Badge>}
                              {a.control && <Badge>subledger</Badge>}
                              {a.isArchived && <Badge tone="amber">archived</Badge>}
                            </span>
                          </Td>
                          <Td className="hidden text-slate-600 md:table-cell">{SUBTYPE_LABELS[a.subtype]}</Td>
                          <Td align="right">
                            <Link href={`${base}/reports/general-ledger?account=${a.id}&to=${asOf}`} className="hover:underline">
                              <Money amount={b?.base ?? "0"} currency={ctx.org.baseCurrency} />
                            </Link>
                            {a.currency && b && (
                              <div className="text-xs text-slate-500">
                                <Money amount={b.txn} currency={a.currency} />
                              </div>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
