import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bankTransactions } from "@/lib/db/schema/banking";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { ruleEditorOptions } from "@/lib/banking/rule-page";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Decimal } from "@/lib/money/decimal";
import { PageHeader } from "@/components/ui";
import { RuleForm, type RulePayloadClient } from "@/components/banking/rule-form";
import { previewRuleAction, saveRuleAction } from "../../actions";

export const metadata = { title: "New bank rule" };

export default async function NewRule({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "banking.rules.manage");
  let initial: RulePayloadClient = { name: "", priority: null, conditions: { direction: "any" }, actions: { splits: [{ accountId: "", percent: null, amount: null }] }, mode: "suggest", isActive: true };
  if (sp.from) {
    const [t] = await getDb().select().from(bankTransactions).where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.id, sp.from)));
    if (t) {
      const words = t.description.replace(/[0-9#*]+/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");
      initial = { ...initial, name: words || t.description.slice(0, 40), conditions: { descriptionContains: words || t.description, direction: Decimal.from(t.amount).isPositive() ? "in" : "out" } };
    }
  }
  return (
    <>
      <PageHeader title="New bank rule" back={{ href: `/o/${org}/banking/rules`, label: "Bank rules" }} />
      <RuleForm initial={initial} {...await ruleEditorOptions(ctx)} save={saveRuleAction.bind(null, org, null)} preview={previewRuleAction.bind(null, org, null)} />
    </>
  );
}
