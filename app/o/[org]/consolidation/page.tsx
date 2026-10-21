import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listGroupsForUser } from "@/lib/consolidation/groups";
import { orgCtx, requireUser } from "@/lib/web/session";
import { currencyOptions } from "@/lib/web/options";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { createGroupAction } from "./actions";

export const metadata = { title: "Entity groups" };

export default async function Groups({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const user = await requireUser();
  const groups = await listGroupsForUser(getDb(), user.id);
  return (
    <>
      <PageHeader
        title="Entity groups"
        description="Consolidated statements across organizations you keep the books for: map each member's accounts to a group chart, translate to one reporting currency, and eliminate intercompany balances. Nothing here posts to any member's books."
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div>
          {groups.length === 0 ? (
            <EmptyState title="No entity groups yet">
              Create a group, then add the organizations it consolidates. You need the accountant role (or higher) in every member to manage a group, and read access to every member to see it.
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {groups.map(({ group, members, canManage }) => (
                <li key={group.id}>
                  <Link href={`/o/${org}/consolidation/${group.id}`} className="block rounded-lg border border-slate-200 bg-white p-4 shadow-sm hover:border-brand-200">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900">{group.name}</span>
                      <span className="flex gap-2">
                        <Badge tone="blue">{group.reportingCurrency}</Badge>
                        {group.isDemo && <Badge tone="amber">demo</Badge>}
                        {!canManage && <Badge>view only</Badge>}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-slate-600">{members.length ? members.map((m) => m.org.name).join(" · ") : "No members yet"}</div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        <Card title="New group">
          <ActionForm action={createGroupAction.bind(null, org)} className="space-y-3">
            <TextField label="Name" name="name" required placeholder="e.g. Harbor Holdings" />
            <SelectField label="Reporting currency" name="reportingCurrency" defaultValue={ctx.org.baseCurrency} options={currencyOptions()} />
            <SubmitButton>Create group</SubmitButton>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
