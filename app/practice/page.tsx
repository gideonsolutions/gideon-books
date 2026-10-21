import Link from "next/link";
import { requireUser } from "@/lib/web/session";
import { practiceOverview } from "@/lib/ops/practice";
import { ROLE_LABELS } from "@/lib/authz/permissions";
import { formatDateTime } from "@/lib/money/format";
import { Badge, EmptyState, LinkButton, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Practice" };

function Count({ n, href, tone }: { n: number | null; href: string; tone?: "amber" | "red" }) {
  if (n === null) return <span className="text-slate-400">—</span>;
  if (n === 0) return <span className="text-slate-400">0</span>;
  return (
    <Link href={href} className="hover:underline">
      <Badge tone={tone ?? "amber"}>{n}</Badge>
    </Link>
  );
}

/** Every client organization with what needs attention, for accountants who keep several sets of books. */
export default async function Practice() {
  const user = await requireUser("/practice");
  const rows = await practiceOverview(user.id);
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link href="/orgs" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/gideon-logo.svg" alt="" className="h-8 w-8" />
            <span className="font-semibold text-slate-900">Gideon Books</span>
          </Link>
          <nav className="flex gap-4 text-sm">
            <Link href="/orgs" className="text-slate-600 hover:text-brand-700">
              Organizations
            </Link>
            <Link href="/account" className="text-slate-600 hover:text-brand-700">
              {user.email}
            </Link>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-semibold text-slate-900">Practice</h1>
        <p className="mt-1 text-sm text-slate-600">Each organization you have access to, with the work waiting in it. Numbers link to the list behind them.</p>
        <div className="mt-6">
          {rows.length === 0 ? (
            <EmptyState title="No organizations yet" action={<LinkButton href="/orgs/new">Set up an organization</LinkButton>}>
              Clients add you with an invitation; you can also create organizations yourself.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Organization</Th>
                  <Th>Your role</Th>
                  <Th align="center">Draft entries</Th>
                  <Th align="center">Draft documents</Th>
                  <Th align="center">Overdue invoices</Th>
                  <Th align="center">Bank items to review</Th>
                  <Th align="center">Periods to close</Th>
                  <Th>Last activity</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => {
                  const base = `/o/${r.org.slug}`;
                  return (
                    <tr key={r.org.id}>
                      <Td>
                        <Link href={base} className="font-medium text-brand-700 hover:underline">
                          {r.org.name}
                        </Link>
                        <div className="text-xs text-slate-500">
                          {r.org.baseCurrency}
                          {r.org.isDemo ? " · demonstration" : ""}
                        </div>
                      </Td>
                      <Td>{ROLE_LABELS[r.role]}</Td>
                      <Td align="center">
                        <Count n={r.draftEntries} href={`${base}/accounting/journal?status=draft`} />
                      </Td>
                      <Td align="center">
                        <Count n={r.draftDocuments} href={`${base}/sales/invoices?status=draft`} />
                      </Td>
                      <Td align="center">
                        <Count n={r.overdueInvoices} href={`${base}/sales/invoices?status=overdue`} tone="red" />
                      </Td>
                      <Td align="center">
                        <Count n={r.unreviewedBank} href={`${base}/banking/transactions`} />
                      </Td>
                      <Td align="center">
                        <Count n={r.periodsAwaitingClose} href={`${base}/accounting/periods`} />
                      </Td>
                      <Td className="text-xs text-slate-600">{r.lastActivity ? formatDateTime(r.lastActivity) : "—"}</Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      </main>
    </div>
  );
}
