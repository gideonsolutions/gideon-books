import Link from "next/link";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { finishOnboardingAction } from "./actions";

export const metadata = { title: "Set up" };

export default async function Onboarding({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const r = await db.execute<{ banks: number; opening: number; contacts: number; members: number; jurisdictions: number; postings: number; imports: number }>(sql`
    select
      (select count(*) from accounts where org_id = ${ctx.orgId} and subtype in ('bank','credit_card') and not is_archived)::int as banks,
      (select count(*) from journal_entries where org_id = ${ctx.orgId} and kind = 'opening_balance' and status = 'posted')::int
        + (select count(*) from documents where org_id = ${ctx.orgId} and is_opening_balance)::int as opening,
      (select count(*) from contacts where org_id = ${ctx.orgId})::int as contacts,
      (select count(*) from memberships where org_id = ${ctx.orgId})::int as members,
      (select count(*) from tax_jurisdictions where org_id = ${ctx.orgId})::int as jurisdictions,
      (select count(*) from journal_entries where org_id = ${ctx.orgId} and status = 'posted')::int as postings,
      coalesce((select count(*) from information_schema.tables where table_name = 'bank_import_batches'), 0)::int as imports
  `);
  const s = r.rows[0]!;
  let imported = 0;
  if (s.imports > 0) {
    const q = await db.execute<{ n: number }>(sql`select count(*)::int as n from bank_import_batches where org_id = ${ctx.orgId}`).catch(() => ({ rows: [{ n: 0 }] }));
    imported = q.rows[0]?.n ?? 0;
  }
  const base = `/o/${org}`;
  const p = ctx.org.profile;
  const steps = [
    { title: "Business details", body: "Address, contact details and tax ID for invoices and statements; fiscal year and report basis.", href: "/settings", done: !!(p.email || p.address?.line1) },
    { title: "Chart of accounts", body: "Your template is in place. Rename, renumber or add accounts to match how you think about the business.", href: "/accounting/accounts", done: true },
    { title: "Bank and credit-card accounts", body: "One account per real bank account or card, with its last digits.", href: "/accounting/accounts/new", done: s.banks > 2 },
    { title: "Opening balances", body: "Balances from your last balance sheet, plus each unpaid invoice and bill, so the books start where the old ones ended.", href: "/accounting/opening-balances", done: s.opening > 0 },
    { title: "Import bank transactions", body: "Upload a CSV export from your bank (or connect a feed) to start categorizing and reconciling.", href: "/banking/imports", done: imported > 0 },
    { title: "Customers and vendors", body: "Add the people you sell to and buy from, with their terms and currency.", href: "/sales/customers/new", done: s.contacts > 0 },
    { title: "Sales tax", body: "If you collect sales tax: the jurisdictions, their rates and dates, and tax codes. Skip if you don't.", href: "/accounting/sales-tax", done: s.jurisdictions > 0 },
    { title: "Invite your accountant and team", body: "Each person gets a role: owner, administrator, accountant, staff or read-only.", href: "/settings/members", done: s.members > 1 },
  ];
  const done = steps.filter((x) => x.done).length;
  return (
    <>
      <PageHeader
        title={`Set up ${ctx.org.name}`}
        description={`${done} of ${steps.length} done. Do these in any order; every step can be revisited later from the menu.`}
        actions={<ActionButton action={finishOnboardingAction.bind(null, org)} variant="primary">{ctx.org.onboardingCompletedAt ? "Back to the dashboard" : "I'm done — go to the dashboard"}</ActionButton>}
      />
      <ol className="space-y-3">
        {steps.map((st, i) => (
          <li key={st.title}>
            <Card>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${st.done ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`} aria-hidden="true">
                    {st.done ? "✓" : i + 1}
                  </span>
                  <div>
                    <h2 className="font-semibold text-slate-900">
                      {st.title} {st.done && <Badge tone="green">done</Badge>}
                    </h2>
                    <p className="text-sm text-slate-600">{st.body}</p>
                  </div>
                </div>
                <Link href={`${base}${st.href}`} className="shrink-0 text-sm font-medium text-brand-700 hover:underline">
                  {st.done ? "Review" : "Start"} →
                </Link>
              </div>
            </Card>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-sm text-slate-600">
        Want to look around first?{" "}
        <Link href="/orgs" className="text-brand-700 hover:underline">
          Open a demonstration company
        </Link>{" "}
        — it is clearly labeled and never mixes with these books.
      </p>
    </>
  );
}
