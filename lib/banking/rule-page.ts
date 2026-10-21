/** Shared loading for the rule editor pages. */
import { getDb } from "@/lib/db/client";
import { can, type Ctx } from "@/lib/context";
import { accountOptions, contactOptions, dimensionOptions, moneyAccountOptions } from "@/lib/web/options";

export async function ruleEditorOptions(ctx: Ctx) {
  const db = getDb();
  const autoPostNote = !ctx.org.bankRulesAutoPost
    ? "This organization has automatic categorization turned off, so the rule will only suggest until an administrator turns it on."
    : !can(ctx, "banking.rules.autopost")
      ? "Your role cannot let rules post on their own, so saved by you it will only suggest."
      : "The organization allows it and your role may let rules post.";
  return {
    accounts: await accountOptions(db, ctx.orgId, { excludeControl: true }),
    moneyAccounts: await moneyAccountOptions(db, ctx.orgId),
    contacts: await contactOptions(db, ctx.orgId),
    dims: await dimensionOptions(db, ctx.orgId),
    autoPostNote,
  };
}
