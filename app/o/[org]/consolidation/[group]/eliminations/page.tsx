import { getDb } from "@/lib/db/client";
import { groupContext, listEliminations, listGroupAccounts, memberAccountsWithMappings } from "@/lib/consolidation/groups";
import { intercompanyBalances, suggestEliminations } from "@/lib/consolidation/report";
import { orgCtx, requireUser } from "@/lib/web/session";
import { readParams, dateParam, type SearchParams } from "@/lib/web/params";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, FilterBar, FilterField, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { EliminationForm } from "@/components/consolidation/elimination-form";
import { addPairAction, createEliminationAction, removePairAction, voidEliminationAction } from "../../actions";

export const metadata = { title: "Intercompany and eliminations" };

export default async function Eliminations({ params, searchParams }: { params: Promise<{ org: string; group: string }>; searchParams: SearchParams }) {
  const { org, group: groupId } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const user = await requireUser();
  const db = getDb();
  const g = await groupContext(db, { userId: user.id, label: user.email }, groupId);
  const today = todayIn(ctx.org.timezone);
  const to = dateParam(sp.to) ?? today;
  const from = dateParam(sp.from) ?? `${to.slice(0, 4)}-01-01`;
  const gaccts = await listGroupAccounts(db, groupId);
  const ic = await intercompanyBalances(db, g, from, to);
  const suggestions = g.canManage ? await suggestEliminations(db, g, from, to) : [];
  const entries = await listEliminations(db, groupId);
  const memberAccounts = await memberAccountsWithMappings(db, g);
  const accName = new Map(memberAccounts.map((r) => [r.account.id, `${r.account.code} ${r.account.name}`]));
  const orgName = new Map(g.members.map((m) => [m.org.id, m.org.name]));
  const gaName = new Map(gaccts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const rc = g.group.reportingCurrency;
  const accountChoices = memberAccounts.map((r) => ({ value: `${r.account.orgId}:${r.account.id}`, label: `${r.account.code} ${r.account.name}`, group: orgName.get(r.account.orgId) ?? "" }));
  return (
    <>
      <PageHeader
        title="Intercompany and eliminations"
        back={{ href: `/o/${org}/consolidation/${groupId}`, label: g.group.name }}
        description="Pair the accounts that mirror each other across members, see where they disagree, and record eliminations. Eliminations live only in the group, in the reporting currency; members' books are never changed."
      />
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </FilterField>
      </FilterBar>
      <div className="space-y-6">
        <Card title={`Intercompany balances at ${to}`} padded={false}>
          {ic.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No intercompany pairs yet.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Pair</Th>
                  <Th align="right">Side A ({rc})</Th>
                  <Th align="right">Side B ({rc})</Th>
                  <Th align="right">Difference</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {ic.map((r) => (
                  <tr key={r.pairId}>
                    <Td>
                      <div className="font-medium">{r.description ?? "Intercompany"}</div>
                      <div className="text-xs text-slate-500">
                        {orgName.get(r.orgA)} {accName.get(r.accountA)} ↔ {orgName.get(r.orgB)} {accName.get(r.accountB)}
                      </div>
                    </Td>
                    <Td align="right">
                      <Money amount={r.translatedA} currency={rc} />
                    </Td>
                    <Td align="right">
                      <Money amount={r.translatedB} currency={rc} />
                    </Td>
                    <Td align="right">{Decimal.from(r.difference).isZero() ? <Badge tone="green">mirrors</Badge> : <Money amount={r.difference} currency={rc} />}</Td>
                    <Td align="right">{g.canManage && <ActionButton action={removePairAction.bind(null, org, groupId, r.pairId)} size="sm" variant="ghost">Remove</ActionButton>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          {g.canManage && g.members.length > 1 && (
            <div className="border-t border-slate-200 p-4">
              <ActionForm action={addPairAction.bind(null, org, groupId)} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_1fr_1fr_auto] md:items-end" resetOnSuccess>
                <SelectField label="Account in one member" name="a" placeholder="Choose…" options={accountChoices} />
                <SelectField label="Mirror account in another member" name="b" placeholder="Choose…" options={accountChoices} />
                <TextField label="Description" name="description" placeholder="e.g. Loan from parent" />
                <SubmitButton>Add pair</SubmitButton>
              </ActionForm>
            </div>
          )}
        </Card>

        {suggestions.length > 0 && (
          <Card title="Suggested eliminations">
            <div className="space-y-3">
              {suggestions.map((s) => (
                <div key={s.pairId} className="rounded-md border border-slate-200 p-3">
                  <div className="text-sm font-medium">{s.description}</div>
                  {s.blocked ? (
                    <p className="mt-1 text-sm text-amber-700">{s.blocked}</p>
                  ) : (
                    <ActionForm action={createEliminationAction.bind(null, org, groupId)} className="mt-2">
                      <input type="hidden" name="entryDate" value={to} />
                      <input type="hidden" name="description" value={s.description} />
                      <input type="hidden" name="source" value="suggested" />
                      {s.lines.map((l, i) => (
                        <span key={i}>
                          <input type="hidden" name={`lines.${i}.groupAccountId`} value={l.groupAccountId} />
                          <input type="hidden" name={`lines.${i}.orgId`} value={l.orgId} />
                          <input type="hidden" name={`lines.${i}.${Decimal.from(l.amount).isPositive() ? "debit" : "credit"}`} value={Decimal.from(l.amount).abs().toString()} />
                        </span>
                      ))}
                      <ul className="mb-2 text-sm text-slate-700">
                        {s.lines.map((l, i) => (
                          <li key={i}>
                            {Decimal.from(l.amount).isPositive() ? "Debit" : "Credit"} {gaName.get(l.groupAccountId)} <Money amount={Decimal.from(l.amount).abs().toString()} currency={rc} /> ({orgName.get(l.orgId)})
                          </li>
                        ))}
                      </ul>
                      {!Decimal.from(s.remainder).isZero() && <p className="mb-2 text-xs text-amber-700">After this, {s.remainder} {rc} remains unreconciled on the pair; investigate it in the members&apos; books.</p>}
                      <SubmitButton variant="secondary">Record this elimination</SubmitButton>
                    </ActionForm>
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}

        {g.canManage && (
          <Card title="Record an elimination">
            <EliminationForm
              action={createEliminationAction.bind(null, org, groupId)}
              accounts={gaccts.map((a) => ({ value: a.id, label: `${a.code} · ${a.name}`, group: a.type }))}
              members={g.members.map((m) => ({ value: m.org.id, label: m.org.name }))}
              currency={rc}
              defaultDate={to}
            />
          </Card>
        )}

        <Card title="Eliminations" padded={false}>
          {entries.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">None recorded.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Description</Th>
                  <Th>Lines</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entries.map((e) => (
                  <tr key={e.id} className={e.status === "void" ? "opacity-60" : ""}>
                    <Td>
                      <DateText date={e.entryDate} />
                    </Td>
                    <Td>
                      {e.description} {e.source === "suggested" && <Badge>suggested</Badge>} {e.status === "void" && <Badge tone="red">void: {e.voidReason}</Badge>}
                    </Td>
                    <Td>
                      <ul className="text-xs text-slate-600">
                        {e.lines.map((l) => (
                          <li key={l.id}>
                            {gaName.get(l.groupAccountId)}: <Money amount={l.amount} currency={rc} />
                            {l.orgId ? ` (${orgName.get(l.orgId) ?? "former member"})` : ""}
                          </li>
                        ))}
                      </ul>
                    </Td>
                    <Td align="right">
                      {g.canManage && e.status === "active" && (
                        <ConfirmButton action={voidEliminationAction.bind(null, org, groupId, e.id)} label="Void" size="sm" title="Void this elimination?" reasonLabel="Why?" confirmLabel="Void" variant="danger" />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        {!g.canManage && <Alert tone="info">Recording eliminations needs the accountant role in every member.</Alert>}
      </div>
    </>
  );
}
