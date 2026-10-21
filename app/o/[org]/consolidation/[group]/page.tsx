import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { groupContext, groupHistory, listGroupRates } from "@/lib/consolidation/groups";
import { orgsForUser } from "@/lib/orgs/orgs";
import { ROLE_LABELS, roleHas } from "@/lib/authz/permissions";
import { orgCtx, requireUser } from "@/lib/web/session";
import { formatDateTime } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { currencyOptions } from "@/lib/web/options";
import { todayIn } from "@/lib/dates";
import { addMemberAction, addRateAction, archiveGroupAction, removeMemberAction, renameGroupAction } from "../actions";

export const metadata = { title: "Entity group" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default async function GroupPage({ params }: { params: Promise<{ org: string; group: string }> }) {
  const { org, group: groupId } = await params;
  const ctx = await orgCtx(org);
  const user = await requireUser();
  const db = getDb();
  const g = await groupContext(db, { userId: user.id, label: user.email }, groupId);
  const rates = await listGroupRates(db, groupId);
  const history = await groupHistory(db, groupId);
  const mine = await orgsForUser(db, user.id);
  const addable = mine.filter((m) => !g.members.some((x) => x.org.id === m.org.id) && roleHas(m.role, "consolidation.manage") && (g.members.length === 0 || m.org.isDemo === g.group.isDemo));
  const base = `/o/${org}/consolidation/${groupId}`;
  const currencies = [...new Set(g.members.map((m) => m.org.baseCurrency).filter((c) => c !== g.group.reportingCurrency))];
  const fy = new Set(g.members.map((m) => m.org.fiscalYearStartMonth));
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {g.group.name} <Badge tone="blue">{g.group.reportingCurrency}</Badge>
            {g.group.isDemo && <Badge tone="amber">demonstration</Badge>}
          </span>
        }
        back={{ href: `/o/${org}/consolidation`, label: "Entity groups" }}
        actions={
          <>
            <LinkButton href={`${base}/reports`}>Consolidated statements</LinkButton>
            <LinkButton variant="secondary" href={`${base}/mappings`}>
              Account mappings
            </LinkButton>
            <LinkButton variant="secondary" href={`${base}/eliminations`}>
              Intercompany & eliminations
            </LinkButton>
          </>
        }
      />
      {!g.canManage && (
        <div className="mb-4">
          <Alert tone="info">You can view this group. Managing it needs the accountant role (or higher) in every member organization.</Alert>
        </div>
      )}
      {fy.size > 1 && (
        <div className="mb-4">
          <Alert tone="warning">Members keep different fiscal years. Consolidated statements cover calendar date ranges for every member.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Members" padded={false}>
            {g.members.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No members yet. Add the organizations this group consolidates.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Organization</Th>
                    <Th>Currency</Th>
                    <Th>Fiscal year starts</Th>
                    <Th align="right">Ownership</Th>
                    <Th>Your role</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {g.members.map((m) => (
                    <tr key={m.org.id}>
                      <Td>
                        <Link href={`/o/${m.org.slug}`} className="font-medium text-brand-700 hover:underline">
                          {m.org.name}
                        </Link>
                      </Td>
                      <Td>{m.org.baseCurrency}</Td>
                      <Td>{MONTHS[m.org.fiscalYearStartMonth - 1]}</Td>
                      <Td align="right" className="num">
                        {Decimal.from(m.ownership).mul(100).normalize().toString()}%
                      </Td>
                      <Td>{m.role ? ROLE_LABELS[m.role] : "—"}</Td>
                      <Td align="right">
                        {g.canManage && (
                          <ConfirmButton
                            action={removeMemberAction.bind(null, org, groupId, m.org.id)}
                            label="Remove"
                            size="sm"
                            title={`Remove ${m.org.name} from the group?`}
                            body="Its mappings and intercompany pairs in this group are removed. Its own books are not touched."
                            reasonLabel="Why?"
                            confirmLabel="Remove"
                            variant="danger"
                          />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {g.canManage && (
              <div className="border-t border-slate-200 p-4">
                {addable.length ? (
                  <ActionForm action={addMemberAction.bind(null, org, groupId)} className="flex flex-wrap items-end gap-3" resetOnSuccess>
                    <SelectField label="Add an organization" name="orgId" placeholder="Choose…" options={addable.map((m) => ({ value: m.org.id, label: `${m.org.name} (${m.org.baseCurrency})` }))} className="min-w-64" />
                    <TextField label="Ownership %" name="ownership" defaultValue="100" inputMode="decimal" className="w-32" />
                    <SubmitButton>Add</SubmitButton>
                  </ActionForm>
                ) : (
                  <p className="text-sm text-slate-500">No other organization you manage can join{g.group.isDemo ? " (demonstration groups take only demonstration companies)" : ""}.</p>
                )}
              </div>
            )}
          </Card>
          <Card title="Translation rates" padded={false}>
            <p className="px-4 pt-3 text-sm text-slate-600">
              {g.group.reportingCurrency} per one unit of each member currency. Balance sheets translate at the latest rate on or before the end date; income and expense at the average of the rates within the range. Without group rates, the rates kept by a member whose base currency is {g.group.reportingCurrency} are used, then the member&apos;s own rates inverted.
            </p>
            {rates.length > 0 && (
              <Table className="mt-3 rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Currency</Th>
                    <Th align="right">Rate</Th>
                    <Th>Note</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rates.slice(0, 30).map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <DateText date={r.rateDate} />
                      </Td>
                      <Td>{r.currency}</Td>
                      <Td align="right" className="num">
                        {Decimal.from(r.rate).normalize().toString()}
                      </Td>
                      <Td className="text-slate-600">{r.note}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
            {g.canManage && (
              <div className="border-t border-slate-200 p-4">
                <ActionForm action={addRateAction.bind(null, org, groupId)} className="flex flex-wrap items-end gap-3" resetOnSuccess>
                  <SelectField label="Currency" name="currency" options={(currencies.length ? currencies.map((c) => ({ value: c, label: c })) : currencyOptions())} />
                  <TextField label="Date" name="rateDate" type="date" defaultValue={todayIn(ctx.org.timezone)} />
                  <TextField label={`${g.group.reportingCurrency} per 1`} name="rate" inputMode="decimal" />
                  <TextField label="Source / note" name="note" />
                  <SubmitButton>Save rate</SubmitButton>
                </ActionForm>
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          {g.canManage && (
            <Card title="Group settings">
              <ActionForm action={renameGroupAction.bind(null, org, groupId)} className="space-y-3">
                <TextField label="Name" name="name" defaultValue={g.group.name} />
                <SubmitButton variant="secondary">Rename</SubmitButton>
              </ActionForm>
              <div className="mt-4 border-t border-slate-100 pt-4">
                <ConfirmButton
                  action={archiveGroupAction.bind(null, org, groupId)}
                  label="Archive group"
                  title="Archive this group?"
                  body="It disappears from the list. Members' books are not affected."
                  reasonLabel="Why?"
                  confirmLabel="Archive"
                  variant="danger"
                />
              </div>
            </Card>
          )}
          <Card title="History">
            {history.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing yet.</p>
            ) : (
              <ol className="space-y-2">
                {history.slice(0, 25).map((h) => (
                  <li key={h.id} className="text-sm">
                    <div className="font-medium text-slate-800">{h.action.replace(/^group\./, "").replace(/_/g, " ")}</div>
                    <div className="text-xs text-slate-500">
                      {formatDateTime(h.createdAt)} · {h.actorLabel}
                    </div>
                    {h.reason && <div className="text-xs text-slate-700">“{h.reason}”</div>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
