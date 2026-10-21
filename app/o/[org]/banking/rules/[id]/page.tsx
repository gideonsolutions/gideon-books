import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getRule, ruleApplications } from "@/lib/banking/rules";
import { ruleEditorOptions } from "@/lib/banking/rule-page";
import { listAudit } from "@/lib/audit";
import { formatDateTime } from "@/lib/money/format";
import { Badge, Card, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { AuditTrail } from "@/components/audit-trail";
import { RuleForm } from "@/components/banking/rule-form";
import { deleteRuleAction, previewRuleAction, saveRuleAction } from "../../actions";

export const metadata = { title: "Bank rule" };

export default async function RulePage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const rule = await getRule(db, ctx.orgId, id);
  const apps = await ruleApplications(db, ctx.orgId, id);
  const history = await listAudit(db, ctx.orgId, { entityType: "bank_rule", entityId: id });
  const base = `/o/${org}`;
  const manage = can(ctx, "banking.rules.manage");
  return (
    <>
      <PageHeader
        title={rule.name}
        back={{ href: `${base}/banking/rules`, label: "Bank rules" }}
        actions={
          manage && (
            <ConfirmButton
              action={deleteRuleAction.bind(null, org, id)}
              label="Delete"
              title="Delete this rule?"
              body="Transactions it already categorized stay as they are. A rule that has been used is kept, inactive, so its history still names it."
              confirmLabel="Delete"
              variant="danger"
            />
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {manage ? (
            <RuleForm
              initial={{ name: rule.name, priority: rule.priority, conditions: rule.conditions, actions: rule.actions, mode: rule.mode, isActive: rule.isActive }}
              {...await ruleEditorOptions(ctx)}
              save={saveRuleAction.bind(null, org, id)}
              preview={previewRuleAction.bind(null, org, id)}
            />
          ) : (
            <Card title="Rule">
              <pre className="overflow-x-auto text-xs">{JSON.stringify({ conditions: rule.conditions, actions: rule.actions, mode: rule.mode }, null, 2)}</pre>
            </Card>
          )}
          <Card title="Recent applications" padded={false}>
            {apps.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Not applied yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Transaction</Th>
                    <Th>Outcome</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {apps.map(({ app, txn }) => (
                    <tr key={app.id}>
                      <Td className="text-xs">{formatDateTime(app.createdAt, ctx.org.timezone)}</Td>
                      <Td>
                        <Link href={`${base}/banking/transactions/${txn.id}`} className="hover:text-brand-700">
                          {txn.description}
                        </Link>
                      </Td>
                      <Td>
                        <Badge tone={app.outcome === "undone" ? "red" : app.outcome === "auto_categorized" ? "amber" : "blue"}>{app.outcome.replace("_", " ")}</Badge>
                      </Td>
                      <Td align="right">
                        <Money amount={txn.amount} currency={txn.currency} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <AuditTrail events={history} />
      </div>
    </>
  );
}
