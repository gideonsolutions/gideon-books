/** Integration settings for bank feeds: connect SimpleFIN or the sandbox bank, link feed accounts, sync. */
import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { can, type Ctx } from "@/lib/context";
import { listFeedConnections } from "@/lib/banking/feeds/sync";
import { moneyAccountOptions } from "@/lib/web/options";
import { formatDateTime } from "@/lib/money/format";
import { Badge, Card, Money } from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { connectFeedAction, disconnectFeedAction, linkFeedAction, refreshFeedAccountsAction, syncFeedAction } from "@/app/o/[org]/banking/actions";

export async function BankFeedsSection({ ctx }: { ctx: Ctx }) {
  const db = getDb();
  const connections = await listFeedConnections(db, ctx.orgId);
  const accounts = await moneyAccountOptions(db, ctx.orgId);
  const slug = ctx.org.slug;
  const manage = can(ctx, "integrations.manage");
  return (
    <Card title="Bank feeds">
      <p className="mb-4 text-sm text-slate-700">
        A feed brings bank transactions in automatically (daily, and on “Sync now”). Without one, import CSV statements under{" "}
        <Link href={`/o/${slug}/banking/imports`} className="text-brand-700 hover:underline">
          Banking → Imports
        </Link>
        ; everything else works the same. Feed transactions arrive for review — nothing is posted by a sync.
      </p>
      {connections.length > 0 && (
        <ul className="mb-6 space-y-4">
          {connections.map(({ connection: c, accounts: feedAccounts }) => (
            <li key={c.id} className="rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-medium text-slate-900">{c.displayName}</span>{" "}
                  <Badge tone={c.mode === "sandbox" ? "amber" : "blue"}>{c.mode === "sandbox" ? "sandbox — sample data" : "live"}</Badge>{" "}
                  <Badge tone={c.status === "active" ? "green" : "red"}>{c.status}</Badge>
                  <div className="text-xs text-slate-500">{c.lastSyncedAt ? `Last synced ${formatDateTime(c.lastSyncedAt, ctx.org.timezone)}` : "Not synced yet"}</div>
                  {c.lastError && <div className="mt-1 text-xs text-danger-700">Last error: {c.lastError}</div>}
                </div>
                <div className="flex flex-wrap gap-2">
                  {can(ctx, "banking.import") && (
                    <>
                      <ActionButton action={syncFeedAction.bind(null, slug, c.id)} size="sm" variant="primary">
                        Sync now
                      </ActionButton>
                      <ActionButton action={refreshFeedAccountsAction.bind(null, slug, c.id)} size="sm">
                        Refresh accounts
                      </ActionButton>
                    </>
                  )}
                  {manage && (
                    <ConfirmButton
                      action={disconnectFeedAction.bind(null, slug, c.id)}
                      label="Disconnect"
                      size="sm"
                      variant="danger"
                      title="Disconnect this feed?"
                      body="Its stored access is destroyed. Transactions it already brought in stay, with their history."
                      confirmLabel="Disconnect"
                    />
                  )}
                </div>
              </div>
              {feedAccounts.length > 0 && (
                <table className="mt-3 min-w-full text-sm">
                  <thead className="text-xs uppercase text-slate-500">
                    <tr>
                      <th className="py-1 text-left">Feed account</th>
                      <th className="py-1 text-right">Bank balance</th>
                      <th className="py-1 text-left">Feeds into</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {feedAccounts.map((fa) => (
                      <tr key={fa.id}>
                        <td className="py-2 pr-3">
                          {fa.name}
                          <div className="text-xs text-slate-500">
                            {fa.institution ?? ""}
                            {fa.lastSyncedAt ? ` · synced ${formatDateTime(fa.lastSyncedAt, ctx.org.timezone)}` : ""}
                          </div>
                        </td>
                        <td className="py-2 pr-3 text-right">{fa.balance ? <Money amount={fa.balance} currency={fa.currency ?? ctx.org.baseCurrency} /> : <span className="text-slate-400">—</span>}</td>
                        <td className="py-2">
                          {manage ? (
                            <ActionForm action={linkFeedAction.bind(null, slug, fa.id)} className="flex items-end gap-2">
                              <SelectField label="Account" name="accountId" options={accounts} placeholder="Not linked" defaultValue={fa.linkedAccountId ?? ""} className="min-w-48" />
                              <SubmitButton variant="secondary">Save</SubmitButton>
                            </ActionForm>
                          ) : (
                            (accounts.find((a) => a.value === fa.linkedAccountId)?.label ?? "Not linked")
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage ? (
        <div className="grid gap-4 md:grid-cols-2">
          {!ctx.org.isDemo && (
            <ActionForm action={connectFeedAction.bind(null, slug)} className="space-y-3 rounded-md border border-slate-200 p-3">
              <input type="hidden" name="provider" value="simplefin" />
              <div className="text-sm font-medium text-slate-900">Connect SimpleFIN Bridge</div>
              <p className="text-xs text-slate-600">
                SimpleFIN is an open protocol for read-only bank access. Get a setup token from a SimpleFIN Bridge (a paid service you sign up for yourself) and paste it here; it is used once to
                obtain an access URL, which is stored encrypted.
              </p>
              <TextField label="Setup token" name="setupToken" required autoComplete="off" />
              <SubmitButton>Connect</SubmitButton>
            </ActionForm>
          )}
          <ActionForm action={connectFeedAction.bind(null, slug)} className="space-y-3 rounded-md border border-amber-200 bg-amber-50/50 p-3">
            <input type="hidden" name="provider" value="sandbox" />
            <div className="text-sm font-medium text-slate-900">Connect the sandbox bank</div>
            <p className="text-xs text-slate-600">Sample transactions for trying feeds out. It is not a real bank and nothing it delivers is real; exclude or undo its imports before using these books for real.</p>
            <SubmitButton variant="secondary">Connect sandbox</SubmitButton>
          </ActionForm>
        </div>
      ) : (
        <p className="text-sm text-slate-500">An administrator connects bank feeds.</p>
      )}
    </Card>
  );
}
