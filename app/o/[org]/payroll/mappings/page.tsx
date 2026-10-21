import { getDb, withTransaction } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { COMPONENT_LABELS, COMPONENT_SIDES, ensureDefaultMappings, listMappings } from "@/lib/payroll/mappings";
import { listAccounts } from "@/lib/ledger/accounts";
import { PAYROLL_COMPONENT_TYPES } from "@/lib/db/schema/payroll";
import { Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { MappingForm } from "@/components/payroll/mapping-form";
import { PayrollTabs } from "@/components/payroll/tabs";
import { deleteMappingAction, saveMappingAction } from "../actions";

export const metadata = { title: "Payroll mappings" };

export default async function Mappings({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const may = can(ctx, "payroll.import");
  if (may) await withTransaction((tx) => ensureDefaultMappings(tx, ctx));
  const mappings = await listMappings(db, ctx.orgId);
  const accounts = await listAccounts(db, ctx.orgId);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const expenseAccounts = accounts.filter((a) => !a.control && (a.type === "expense" || a.type === "asset")).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const liabilityAccounts = accounts.filter((a) => !a.control && (a.type === "liability" || ["bank", "cash", "clearing"].includes(a.subtype))).map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));
  const types = PAYROLL_COMPONENT_TYPES.map((t) => ({ value: t, label: COMPONENT_LABELS[t] }));
  const name = (id: string | null) => (id ? `${byId.get(id)?.code ?? ""} ${byId.get(id)?.name ?? "(missing)"}` : "—");
  return (
    <>
      <PageHeader
        title="Payroll mappings"
        description="Which account each payroll component posts to. A code of * is the default for its type; give a component its own mapping to post it elsewhere. Every change is in the audit log, and each run keeps the mappings it posted with."
      />
      <PayrollTabs org={org} current="mappings" />
      <Table>
        <thead>
          <tr>
            <Th>Component</Th>
            <Th>Code</Th>
            <Th>Debits (expense)</Th>
            <Th>Credits (liability / net pay)</Th>
            <Th />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {mappings.map((m) => (
            <tr key={m.id} className="align-top">
              <Td>{COMPONENT_LABELS[m.componentType]}</Td>
              <Td className="font-mono text-xs">{m.componentCode === "*" ? "* (default)" : m.componentCode}</Td>
              <Td>{COMPONENT_SIDES[m.componentType].expense ? name(m.expenseAccountId) : <span className="text-slate-400">—</span>}</Td>
              <Td>{COMPONENT_SIDES[m.componentType].liability ? name(m.liabilityAccountId) : <span className="text-slate-400">—</span>}</Td>
              <Td>
                {may && (
                  <details>
                    <summary className="cursor-pointer text-sm text-brand-700">Edit</summary>
                    <div className="mt-2 w-[min(60rem,80vw)]">
                      <MappingForm
                        action={saveMappingAction.bind(null, org, m.id)}
                        types={types}
                        expenseAccounts={expenseAccounts}
                        liabilityAccounts={liabilityAccounts}
                        defaults={{ componentType: m.componentType, componentCode: m.componentCode, label: m.label ?? "", expenseAccountId: m.expenseAccountId ?? "", liabilityAccountId: m.liabilityAccountId ?? "" }}
                        submitLabel="Save"
                        lockType
                      />
                      {m.componentCode !== "*" && (
                        <div className="mt-2">
                          <ConfirmButton action={deleteMappingAction.bind(null, org, m.id)} label="Delete mapping" size="sm" variant="danger" title="Delete this mapping?" body="The component will use its type's default account." confirmLabel="Delete" />
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      {may && (
        <Card title="Add a mapping for a specific component" className="mt-6">
          <MappingForm action={saveMappingAction.bind(null, org, null)} types={types} expenseAccounts={expenseAccounts} liabilityAccounts={liabilityAccounts} submitLabel="Add mapping" />
        </Card>
      )}
    </>
  );
}
