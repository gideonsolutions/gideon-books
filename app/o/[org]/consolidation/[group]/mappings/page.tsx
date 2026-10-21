import { getDb } from "@/lib/db/client";
import { groupContext, listGroupAccounts, memberAccountsWithMappings } from "@/lib/consolidation/groups";
import { memberBalances } from "@/lib/consolidation/report";
import { orgCtx, requireUser } from "@/lib/web/session";
import { todayIn } from "@/lib/dates";
import { Alert, Badge, Card, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { adoptChartAction, saveGroupAccountAction, saveMappingsAction } from "../../actions";

export const metadata = { title: "Group account mappings" };

const TYPES = ["asset", "liability", "equity", "income", "expense"] as const;

export default async function Mappings({ params }: { params: Promise<{ org: string; group: string }> }) {
  const { org, group: groupId } = await params;
  const ctx = await orgCtx(org);
  const user = await requireUser();
  const db = getDb();
  const g = await groupContext(db, { userId: user.id, label: user.email }, groupId);
  const gaccts = await listGroupAccounts(db, groupId);
  const rows = await memberAccountsWithMappings(db, g);
  const today = todayIn(ctx.org.timezone);
  const balances = new Map<string, string>();
  for (const m of g.members) {
    for (const b of await memberBalances(db, m.org.id, `${today.slice(0, 4)}-01-01`, today)) balances.set(b.accountId, b.amount.add(b.prior).toString());
  }
  const unmappedWithBalance = rows.filter((r) => !r.mapping && balances.get(r.account.id) && balances.get(r.account.id) !== "0" && !/^-?0(\.0+)?$/.test(balances.get(r.account.id)!));
  return (
    <>
      <PageHeader
        title="Account mappings"
        back={{ href: `/o/${org}/consolidation/${groupId}`, label: g.group.name }}
        description="Each member account maps to one group account of the same type. An account with a balance and no mapping blocks complete consolidated statements."
      />
      {unmappedWithBalance.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning" title={`${unmappedWithBalance.length} account${unmappedWithBalance.length === 1 ? " has" : "s have"} a balance and no mapping`}>
            {unmappedWithBalance
              .slice(0, 8)
              .map((r) => `${g.members.find((m) => m.org.id === r.account.orgId)?.org.name}: ${r.account.code} ${r.account.name}`)
              .join("; ")}
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {g.members.map((m) => {
            const mine = rows.filter((r) => r.account.orgId === m.org.id);
            return (
              <Card
                key={m.org.id}
                title={`${m.org.name} (${m.org.baseCurrency})`}
                actions={g.canManage && <ActionButton action={adoptChartAction.bind(null, org, groupId, m.org.id)} size="sm">Use this chart for the group and auto-map by code</ActionButton>}
                padded={false}
              >
                <ActionForm action={saveMappingsAction.bind(null, org, groupId, m.org.id)}>
                  <Table className="rounded-none border-0 shadow-none">
                    <thead>
                      <tr>
                        <Th>Member account</Th>
                        <Th align="right">Balance</Th>
                        <Th>Group account</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mine.map(({ account, mapping }) => (
                        <tr key={account.id} className={account.isArchived ? "opacity-60" : ""}>
                          <Td>
                            <span className="font-mono text-xs text-slate-500">{account.code}</span> {account.name}
                            {!mapping && balances.has(account.id) && <Badge tone="amber">unmapped</Badge>}
                          </Td>
                          <Td align="right">{balances.has(account.id) ? <Money amount={balances.get(account.id)!} currency={m.org.baseCurrency} /> : <span className="text-slate-400">—</span>}</Td>
                          <Td>
                            <input type="hidden" name={`was.${account.id}`} value={mapping?.groupAccountId ?? ""} />
                            <select name={`map.${account.id}`} defaultValue={mapping?.groupAccountId ?? ""} disabled={!g.canManage} className={inputClass} aria-label={`Group account for ${account.code} ${account.name}`}>
                              <option value="">— not mapped —</option>
                              {gaccts
                                .filter((a) => a.type === account.type)
                                .map((a) => (
                                  <option key={a.id} value={a.id}>
                                    {a.code} · {a.name}
                                  </option>
                                ))}
                            </select>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {g.canManage && (
                    <div className="flex justify-end border-t border-slate-200 p-3">
                      <SubmitButton>Save {m.org.name} mappings</SubmitButton>
                    </div>
                  )}
                </ActionForm>
              </Card>
            );
          })}
        </div>
        <div className="space-y-6">
          <Card title="Group chart" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Type</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {gaccts.map((a) => (
                  <tr key={a.id}>
                    <Td className="font-mono text-xs">{a.code}</Td>
                    <Td>
                      {a.name} {a.role && <Badge>{a.role === "cta" ? "translation" : "prior earnings"}</Badge>}
                    </Td>
                    <Td className="text-slate-600">{a.type}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
          {g.canManage && (
            <Card title="Add a group account">
              <ActionForm action={saveGroupAccountAction.bind(null, org, groupId, null)} className="space-y-3" resetOnSuccess>
                <TextField label="Code" name="code" required />
                <TextField label="Name" name="name" required />
                <SelectField label="Type" name="type" options={TYPES.map((t) => ({ value: t, label: t }))} />
                <SubmitButton>Add</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
