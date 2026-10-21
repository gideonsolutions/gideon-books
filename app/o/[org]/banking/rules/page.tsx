import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listRules } from "@/lib/banking/rules";
import { mayAutoPost } from "@/lib/banking/rules-engine";
import { Alert, Badge, EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { moveRuleAction, runRulesAction } from "../actions";

export const metadata = { title: "Bank rules" };

function summary(c: { descriptionContains?: string | null; descriptionEquals?: string | null; descriptionRegex?: string | null; payeeContains?: string | null; minAmount?: string | null; maxAmount?: string | null; direction?: string }) {
  const parts: string[] = [];
  if (c.direction && c.direction !== "any") parts.push(c.direction === "in" ? "money in" : "money out");
  if (c.descriptionContains) parts.push(`description contains “${c.descriptionContains}”`);
  if (c.descriptionEquals) parts.push(`description is “${c.descriptionEquals}”`);
  if (c.descriptionRegex) parts.push(`description matches /${c.descriptionRegex}/`);
  if (c.payeeContains) parts.push(`payee contains “${c.payeeContains}”`);
  if (c.minAmount) parts.push(`at least ${c.minAmount}`);
  if (c.maxAmount) parts.push(`at most ${c.maxAmount}`);
  return parts.join(", ");
}

export default async function Rules({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const rules = await listRules(getDb(), ctx.orgId);
  const base = `/o/${org}`;
  const manage = can(ctx, "banking.rules.manage");
  return (
    <>
      <PageHeader
        title="Bank rules"
        description="Rules recognize recurring transactions and say how to categorize them. They are tried in order, top first; the first that matches wins."
        actions={
          <>
            {can(ctx, "banking.categorize") && rules.length > 0 && <ActionButton action={runRulesAction.bind(null, org)}>Run rules on waiting transactions</ActionButton>}
            {manage && <LinkButton href={`${base}/banking/rules/new`}>New rule</LinkButton>}
          </>
        }
      />
      <div className="mb-4">
        <Alert tone={ctx.org.bankRulesAutoPost ? "warning" : "info"}>
          {ctx.org.bankRulesAutoPost
            ? "Automatic categorization is on for this organization: rules in automatic mode, last saved by someone allowed to auto-post, post new transactions as they arrive. Those transactions still wait for a person to confirm them."
            : "Automatic categorization is off for this organization (Settings → Organization). Every rule only suggests; nothing posts until a person accepts it."}
        </Alert>
      </div>
      {rules.length === 0 ? (
        <EmptyState title="No rules yet" action={manage && <LinkButton href={`${base}/banking/rules/new`}>New rule</LinkButton>}>
          Make one from any bank transaction (“Make a rule from this”), or from scratch.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th className="w-16">Order</Th>
              <Th>Rule</Th>
              <Th>Mode</Th>
              {manage && <Th align="right">Move</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((r, i) => (
              <tr key={r.id} className={r.isActive ? "" : "opacity-60"}>
                <Td className="num text-slate-500">{i + 1}</Td>
                <Td>
                  <Link href={`${base}/banking/rules/${r.id}`} className="font-medium text-brand-700 hover:underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-slate-500">{summary(r.conditions)}</div>
                </Td>
                <Td>
                  {!r.isActive ? (
                    <Badge>inactive</Badge>
                  ) : r.mode === "suggest" ? (
                    <Badge tone="blue">suggest</Badge>
                  ) : mayAutoPost(r, ctx.org.bankRulesAutoPost) ? (
                    <Badge tone="amber">auto-categorize</Badge>
                  ) : (
                    <Badge tone="gray">auto (suggesting only)</Badge>
                  )}
                </Td>
                {manage && (
                  <Td align="right">
                    <span className="inline-flex gap-1">
                      <ActionButton action={moveRuleAction.bind(null, org, r.id, "up")} size="sm" variant="ghost">
                        ↑<span className="sr-only">Move up</span>
                      </ActionButton>
                      <ActionButton action={moveRuleAction.bind(null, org, r.id, "down")} size="sm" variant="ghost">
                        ↓<span className="sr-only">Move down</span>
                      </ActionButton>
                    </span>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
