import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgsForUser } from "@/lib/orgs/orgs";
import { requireUser } from "@/lib/web/session";
import { ROLE_LABELS } from "@/lib/authz/permissions";
import { Badge, EmptyState, LinkButton } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { createDemoAction } from "./actions";

export const metadata = { title: "Organizations" };

export default async function Orgs() {
  const user = await requireUser("/orgs");
  const orgs = await orgsForUser(getDb(), user.id);
  const real = orgs.filter((o) => !o.org.isDemo);
  const demo = orgs.filter((o) => o.org.isDemo);
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <Link href="/orgs" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/gideon-logo.svg" alt="" className="h-8 w-8" />
            <span className="font-semibold text-slate-900">Gideon Books</span>
          </Link>
          <div className="flex items-center gap-4 text-sm">
            <Link href="/practice" className="text-slate-600 hover:text-brand-700">
              Practice view
            </Link>
            <Link href="/account" className="text-slate-600 hover:text-brand-700">
              {user.email}
            </Link>
            <form action="/sign-out" method="post">
              <button className="text-slate-600 hover:text-brand-700">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">Organizations</h1>
            <p className="mt-1 text-sm text-slate-600">Every set of books you keep or have access to. Accountants see each client they were invited to.</p>
          </div>
          <div className="flex gap-2">
            <ActionButton action={createDemoAction}>Try a demonstration company</ActionButton>
            <LinkButton href="/orgs/new">New organization</LinkButton>
          </div>
        </div>
        {real.length === 0 ? (
          <EmptyState title="No books yet" action={<LinkButton href="/orgs/new">Set up your organization</LinkButton>}>
            Create the organization whose books you keep. You can explore a clearly labeled demonstration company first; it never mixes with real books.
          </EmptyState>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {real.map(({ org, role }) => (
              <li key={org.id}>
                <Link href={`/o/${org.slug}`} className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-200 hover:shadow">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-slate-900">{org.name}</div>
                      <div className="text-xs text-slate-500">
                        {org.baseCurrency} · fiscal year from month {org.fiscalYearStartMonth} · {org.entityType.replace(/_/g, " ")}
                      </div>
                    </div>
                    <Badge tone="blue">{ROLE_LABELS[role]}</Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {demo.length > 0 && (
          <>
            <h2 className="mb-3 mt-10 text-sm font-semibold uppercase tracking-wide text-slate-500">Demonstration companies</h2>
            <ul className="grid gap-3 sm:grid-cols-2">
              {demo.map(({ org }) => (
                <li key={org.id}>
                  <Link href={`/o/${org.slug}`} className="block rounded-lg border border-amber-200 bg-amber-50 p-4 hover:border-amber-300">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-amber-900">{org.name}</span>
                      <Badge tone="amber">Demo data</Badge>
                    </div>
                    <div className="mt-1 text-xs text-amber-800">Synthetic records for exploring. Not real books.</div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </main>
    </div>
  );
}
