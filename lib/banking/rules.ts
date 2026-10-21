/**
 * Bank rules: saving, ordering, previewing and applying them.
 *
 * A rule in "suggest" mode (the default) only suggests. A rule in
 * "auto_categorize" mode posts on its own only if the organization has
 * turned on rule auto-posting (an administrator's setting) and whoever last
 * saved the rule held `banking.rules.autopost` at the time; otherwise it too
 * only suggests. Auto-posted transactions still wait for a person to confirm
 * them, and can be undone. Every change and every application is recorded.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { bankRuleApplications, bankRules, bankTransactions, type BankRuleActions, type BankRuleConditions } from "@/lib/db/schema/banking";
import { audit } from "@/lib/audit";
import { can, requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { compileRegex, computeSplits, firstMatchingRule, mayAutoPost, ruleMatches, type BankRule, type ComputedSplit } from "./rules-engine";
import { categorizeInTx, type BankTxn } from "./transactions";
import { log } from "@/lib/log";

export interface RuleInput {
  name: string;
  priority?: number | null;
  conditions: BankRuleConditions;
  actions: BankRuleActions;
  mode: "suggest" | "auto_categorize";
  isActive?: boolean;
}

async function validate(db: DbOrTx, ctx: Ctx, input: RuleInput) {
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the rule.";
  const c = input.conditions;
  if (c.descriptionRegex && !compileRegex(c.descriptionRegex)) fields["conditions.descriptionRegex"] = "Not a valid pattern (at most 200 characters).";
  for (const k of ["minAmount", "maxAmount"] as const) {
    if (c[k] && (!Decimal.tryFrom(c[k]!) || Decimal.from(c[k]!).isNegative())) fields[`conditions.${k}`] = "Enter a positive amount.";
  }
  if (!(c.descriptionContains || c.descriptionEquals || c.descriptionRegex || c.payeeContains || c.minAmount || c.maxAmount || (c.direction && c.direction !== "any"))) {
    fields.conditions = "Give the rule at least one condition, or it would match everything.";
  }
  const splits = input.actions.splits ?? [];
  if (!splits.length) fields["actions.splits"] = "Choose at least one category account.";
  const pctSplits = splits.filter((s) => !s.amount);
  if (pctSplits.length > 1) {
    const sum = Decimal.sum(pctSplits.map((s) => Decimal.tryFrom(s.percent ?? "") ?? Decimal.ZERO));
    if (!sum.eq(100)) fields["actions.splits"] = `Percentages must add up to 100 (they add up to ${sum.toString()}).`;
  }
  for (const [i, s] of splits.entries()) {
    if (s.amount && (!Decimal.tryFrom(s.amount) || !Decimal.from(s.amount).isPositive())) fields[`actions.splits.${i}.amount`] = "Enter a positive amount.";
    if (s.percent && (!Decimal.tryFrom(s.percent) || Decimal.from(s.percent).isNegative())) fields[`actions.splits.${i}.percent`] = "Enter a percentage.";
  }
  const ids = splits.map((s) => s.accountId).filter(Boolean);
  if (ids.length) {
    const rows = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, ids)));
    for (const [i, s] of splits.entries()) {
      const a = rows.find((r) => r.id === s.accountId);
      if (!a) fields[`actions.splits.${i}.accountId`] = "Choose an account.";
      else if (a.control) fields[`actions.splits.${i}.accountId`] = `${a.name} is kept by its subledger; record payments instead.`;
      else if (a.isArchived) fields[`actions.splits.${i}.accountId`] = `${a.name} is archived.`;
    }
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the rule.", fields);
}

export async function listRules(db: DbOrTx, orgId: string): Promise<BankRule[]> {
  return db.select().from(bankRules).where(eq(bankRules.orgId, orgId)).orderBy(asc(bankRules.priority), asc(bankRules.createdAt));
}

export async function getRule(db: DbOrTx, orgId: string, id: string): Promise<BankRule> {
  const [r] = await db.select().from(bankRules).where(and(eq(bankRules.orgId, orgId), eq(bankRules.id, id)));
  if (!r) throw new NotFoundError("The rule");
  return r;
}

export async function saveRule(ctx: Ctx, input: RuleInput, id?: string | null): Promise<{ rule: BankRule; autoPostEffective: boolean }> {
  requirePermission(ctx, "banking.rules.manage");
  return withTransaction(async (tx) => {
    await validate(tx, ctx, input);
    const editorMayAutopost = can(ctx, "banking.rules.autopost");
    let rule: BankRule;
    if (id) {
      const before = await getRule(tx, ctx.orgId, id);
      [rule] = (await tx
        .update(bankRules)
        .set({
          name: input.name.trim(),
          priority: input.priority ?? before.priority,
          conditions: input.conditions,
          actions: input.actions,
          mode: input.mode,
          isActive: input.isActive ?? before.isActive,
          updatedBy: ctx.actor.userId,
          editorMayAutopost,
          updatedAt: new Date(),
        })
        .where(eq(bankRules.id, id))
        .returning()) as [BankRule];
      await audit(tx, ctx, { action: "banking.rule_updated", entityType: "bank_rule", entityId: id, before, after: rule });
    } else {
      const [max] = await tx.select({ p: sql<number>`coalesce(max(${bankRules.priority}), 0)::int` }).from(bankRules).where(eq(bankRules.orgId, ctx.orgId));
      [rule] = (await tx
        .insert(bankRules)
        .values({
          orgId: ctx.orgId,
          name: input.name.trim(),
          priority: input.priority ?? (max?.p ?? 0) + 10,
          conditions: input.conditions,
          actions: input.actions,
          mode: input.mode,
          isActive: input.isActive ?? true,
          createdBy: ctx.actor.userId,
          updatedBy: ctx.actor.userId,
          editorMayAutopost,
        })
        .returning()) as [BankRule];
      await audit(tx, ctx, { action: "banking.rule_created", entityType: "bank_rule", entityId: rule.id, after: rule });
    }
    return { rule, autoPostEffective: mayAutoPost(rule, ctx.org.bankRulesAutoPost) };
  });
}

export async function deleteRule(ctx: Ctx, id: string) {
  requirePermission(ctx, "banking.rules.manage");
  await withTransaction(async (tx) => {
    const before = await getRule(tx, ctx.orgId, id);
    await tx.update(bankTransactions).set({ ruleId: null }).where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.ruleId, id), eq(bankTransactions.status, "unreviewed")));
    await tx.update(bankRules).set({ isActive: false, updatedAt: new Date(), updatedBy: ctx.actor.userId }).where(eq(bankRules.id, id));
    // Rules with applications are kept (deactivated) so the history still names them.
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(bankRuleApplications).where(and(eq(bankRuleApplications.orgId, ctx.orgId), eq(bankRuleApplications.ruleId, id)));
    const [inUse] = await tx.select({ n: sql<number>`count(*)::int` }).from(bankTransactions).where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.ruleId, id)));
    if ((used?.n ?? 0) === 0 && (inUse?.n ?? 0) === 0) await tx.delete(bankRules).where(eq(bankRules.id, id));
    await audit(tx, ctx, { action: "banking.rule_deleted", entityType: "bank_rule", entityId: id, before });
  });
}

/** Move a rule one place up or down in precedence (swaps priorities with its neighbor). */
export async function moveRule(ctx: Ctx, id: string, direction: "up" | "down") {
  requirePermission(ctx, "banking.rules.manage");
  await withTransaction(async (tx) => {
    const rules = await tx.select().from(bankRules).where(eq(bankRules.orgId, ctx.orgId)).orderBy(asc(bankRules.priority), asc(bankRules.createdAt)).for("update");
    // Renumber 10, 20, 30… so swaps are always clean.
    const ordered = rules.map((r, i) => ({ ...r, priority: (i + 1) * 10 }));
    const i = ordered.findIndex((r) => r.id === id);
    if (i < 0) throw new NotFoundError("The rule");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j >= 0 && j < ordered.length) {
      const a = ordered[i]!;
      const b = ordered[j]!;
      [a.priority, b.priority] = [b.priority, a.priority];
    }
    for (const r of ordered) await tx.update(bankRules).set({ priority: r.priority }).where(eq(bankRules.id, r.id));
    await audit(tx, ctx, { action: "banking.rule_moved", entityType: "bank_rule", entityId: id, metadata: { direction } });
  });
}

export interface RulePreviewRow {
  txn: BankTxn;
  splits: ComputedSplit[] | null;
  /** A higher-priority rule that would take this transaction instead. */
  claimedBy: string | null;
}

/** What a rule (saved or being edited) would do to the transactions waiting for review. */
export async function previewRule(db: DbOrTx, ctx: Ctx, input: { id?: string | null; conditions: BankRuleConditions; actions: BankRuleActions; priority?: number | null }): Promise<RulePreviewRow[]> {
  requirePermission(ctx, "banking.read");
  const txns = await db
    .select()
    .from(bankTransactions)
    .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.status, "unreviewed")))
    .orderBy(desc(bankTransactions.postedDate))
    .limit(2000);
  const others = (await listRules(db, ctx.orgId)).filter((r) => r.id !== input.id && r.isActive);
  const priority = input.priority ?? Number.MAX_SAFE_INTEGER;
  const higher = others.filter((r) => r.priority < priority);
  const out: RulePreviewRow[] = [];
  for (const t of txns) {
    const rt = { accountId: t.accountId, amount: t.amount, description: t.description, payee: t.payee, currency: t.currency };
    if (!ruleMatches(input.conditions, rt)) continue;
    const first = firstMatchingRule(higher, rt);
    out.push({ txn: t, splits: computeSplits(input.actions, t.amount, t.currency), claimedBy: first ? first.rule.name : null });
  }
  return out.slice(0, 200);
}

/**
 * Run the rules over newly imported transactions: record a suggestion, or,
 * where allowed, categorize. Runs in the import's transaction; a rule that
 * fails to post (a closed period, an archived account) falls back to a
 * suggestion and the failure is logged.
 */
export async function applyRulesToTransactions(tx: Tx, ctx: Ctx, txnIds: string[]): Promise<{ suggested: number; posted: number }> {
  const rules = (await listRules(tx, ctx.orgId)).filter((r) => r.isActive);
  if (!rules.length || !txnIds.length) return { suggested: 0, posted: 0 };
  let suggested = 0;
  let posted = 0;
  for (let i = 0; i < txnIds.length; i += 500) {
    const txns = await tx
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.orgId, ctx.orgId), inArray(bankTransactions.id, txnIds.slice(i, i + 500)), eq(bankTransactions.status, "unreviewed")));
    for (const t of txns) {
      const hit = firstMatchingRule(rules, { accountId: t.accountId, amount: t.amount, description: t.description, payee: t.payee, currency: t.currency });
      if (!hit) continue;
      if (mayAutoPost(hit.rule, ctx.org.bankRulesAutoPost)) {
        try {
          const r = await tx.transaction(async (sp) =>
            categorizeInTx(sp as unknown as Tx, ctx, t, {
              splits: hit.splits.map((s) => ({
                accountId: s.accountId,
                amount: s.amount.toString(),
                description: s.description,
                contactId: hit.rule.actions.contactId ?? null,
                projectId: hit.rule.actions.projectId ?? null,
                classId: hit.rule.actions.classId ?? null,
                departmentId: hit.rule.actions.departmentId ?? null,
                locationId: hit.rule.actions.locationId ?? null,
                fundId: hit.rule.actions.fundId ?? null,
              })),
              memo: hit.rule.actions.memo ?? null,
              ruleId: hit.rule.id,
              auto: true,
            }),
          );
          await tx.insert(bankRuleApplications).values({ orgId: ctx.orgId, ruleId: hit.rule.id, bankTransactionId: t.id, outcome: "auto_categorized", entryId: r.entry.id, actorUserId: ctx.actor.userId });
          await audit(tx, ctx, { action: "banking.rule_applied", entityType: "bank_transaction", entityId: t.id, metadata: { ruleId: hit.rule.id, rule: hit.rule.name, outcome: "auto_categorized", entryId: r.entry.id } });
          posted++;
          continue;
        } catch (e) {
          log.warn("bank rule could not post; left as a suggestion", { ruleId: hit.rule.id, txnId: t.id, error: (e as Error).message });
        }
      }
      await tx.update(bankTransactions).set({ ruleId: hit.rule.id, updatedAt: new Date() }).where(eq(bankTransactions.id, t.id));
      await tx.insert(bankRuleApplications).values({ orgId: ctx.orgId, ruleId: hit.rule.id, bankTransactionId: t.id, outcome: "suggested", actorUserId: ctx.actor.userId });
      await audit(tx, ctx, { action: "banking.rule_applied", entityType: "bank_transaction", entityId: t.id, metadata: { ruleId: hit.rule.id, rule: hit.rule.name, outcome: "suggested" } });
      suggested++;
    }
  }
  return { suggested, posted };
}

/** Re-run every active rule over all transactions waiting for review. */
export async function runRulesNow(ctx: Ctx) {
  requirePermission(ctx, "banking.categorize");
  return withTransaction(async (tx) => {
    const ids = await tx.select({ id: bankTransactions.id }).from(bankTransactions).where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.status, "unreviewed")));
    return applyRulesToTransactions(tx, ctx, ids.map((r) => r.id));
  });
}

export async function ruleApplications(db: DbOrTx, orgId: string, ruleId: string) {
  return db
    .select({ app: bankRuleApplications, txn: bankTransactions })
    .from(bankRuleApplications)
    .innerJoin(bankTransactions, and(eq(bankTransactions.orgId, bankRuleApplications.orgId), eq(bankTransactions.id, bankRuleApplications.bankTransactionId)))
    .where(and(eq(bankRuleApplications.orgId, orgId), eq(bankRuleApplications.ruleId, ruleId)))
    .orderBy(desc(bankRuleApplications.createdAt))
    .limit(100);
}
