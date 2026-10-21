/**
 * Bank rules, evaluated: which rule a transaction matches (lowest priority
 * number first; the first match wins) and how a rule splits its amount.
 * Pure — no database — so preview, suggestion and auto-categorization all
 * agree.
 */
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import type { BankRuleActions, BankRuleConditions, bankRules } from "@/lib/db/schema/banking";

export type BankRule = typeof bankRules.$inferSelect;

export interface RuleTxn {
  accountId: string;
  amount: string;
  description: string;
  payee: string | null;
  currency: string;
}

function contains(hay: string | null | undefined, needle: string) {
  return (hay ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function compileRegex(pattern: string): RegExp | null {
  if (!pattern || pattern.length > 200) return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

export function ruleMatches(conditions: BankRuleConditions, t: RuleTxn): boolean {
  const amount = Decimal.from(t.amount);
  const abs = amount.abs();
  if (conditions.accountId && conditions.accountId !== t.accountId) return false;
  if (conditions.direction === "in" && !amount.isPositive()) return false;
  if (conditions.direction === "out" && !amount.isNegative()) return false;
  if (conditions.descriptionContains && !contains(t.description, conditions.descriptionContains)) return false;
  if (conditions.descriptionEquals && t.description.trim().toLowerCase() !== conditions.descriptionEquals.trim().toLowerCase()) return false;
  if (conditions.descriptionRegex) {
    const re = compileRegex(conditions.descriptionRegex);
    if (!re || !re.test(t.description.slice(0, 1000))) return false;
  }
  if (conditions.payeeContains && !contains(t.payee ?? t.description, conditions.payeeContains)) return false;
  const min = Decimal.tryFrom(conditions.minAmount ?? null);
  const max = Decimal.tryFrom(conditions.maxAmount ?? null);
  if (min && abs.lt(min)) return false;
  if (max && abs.gt(max)) return false;
  // A rule with no conditions at all never matches (it would categorize everything).
  return !!(
    conditions.descriptionContains ||
    conditions.descriptionEquals ||
    conditions.descriptionRegex ||
    conditions.payeeContains ||
    min ||
    max ||
    (conditions.direction && conditions.direction !== "any")
  );
}

export interface ComputedSplit {
  accountId: string;
  /** Positive, in the transaction's currency. */
  amount: Decimal;
  description: string | null;
}

/**
 * Split |amount| by the rule: fixed amounts first, then percentages of the
 * remainder (largest-remainder allocation so the parts add up exactly).
 * Returns null if the rule's fixed amounts do not fit this transaction.
 */
export function computeSplits(actions: BankRuleActions, amount: string, currency: string): ComputedSplit[] | null {
  const total = Decimal.from(amount).abs();
  const mu = minorUnits(currency);
  const splits = actions.splits ?? [];
  if (!splits.length) return null;
  const fixed = splits.filter((s) => s.amount && Decimal.tryFrom(s.amount));
  const pct = splits.filter((s) => !(s.amount && Decimal.tryFrom(s.amount)));
  const fixedSum = Decimal.sum(fixed.map((s) => Decimal.from(s.amount!).abs()));
  if (fixedSum.gt(total)) return null;
  const remainder = total.sub(fixedSum).round(mu, "half_up");
  const out: ComputedSplit[] = [];
  for (const s of splits) {
    if (fixed.includes(s)) out.push({ accountId: s.accountId, amount: Decimal.from(s.amount!).abs().rescale(mu), description: s.description ?? null });
  }
  if (pct.length) {
    const weights = pct.map((s) => Decimal.tryFrom(s.percent ?? "") ?? (pct.length === 1 ? Decimal.from(100) : Decimal.ZERO));
    const parts = remainder.allocate(weights, mu);
    pct.forEach((s, i) => out.push({ accountId: s.accountId, amount: parts[i]!, description: s.description ?? null }));
  } else if (!remainder.isZero()) {
    return null;
  }
  // Keep the rule's order.
  out.sort((a, b) => splits.findIndex((s) => s.accountId === a.accountId) - splits.findIndex((s) => s.accountId === b.accountId));
  return out.filter((s) => !s.amount.isZero());
}

/** The first active rule (by priority) that matches and whose splits fit. */
export function firstMatchingRule(rules: BankRule[], t: RuleTxn): { rule: BankRule; splits: ComputedSplit[] } | null {
  const ordered = [...rules].filter((r) => r.isActive).sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  for (const r of ordered) {
    if (!ruleMatches(r.conditions, t)) continue;
    const splits = computeSplits(r.actions, t.amount, t.currency);
    if (splits?.length) return { rule: r, splits };
  }
  return null;
}

/** Whether a rule may post on its own: the organization allows it and whoever last saved it held the permission. */
export function mayAutoPost(rule: BankRule, orgAllows: boolean): boolean {
  return rule.mode === "auto_categorize" && rule.isActive && orgAllows && rule.editorMayAutopost;
}
