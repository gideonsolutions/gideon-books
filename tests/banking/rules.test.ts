import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { organizations } from "@/lib/db/schema/core";
import { bankRuleApplications, bankRules } from "@/lib/db/schema/banking";
import { mayAutoPost } from "@/lib/banking/rules-engine";
import { moveRule, previewRule, saveRule, listRules, runRulesNow } from "@/lib/banking/rules";
import { confirmReviewed, undoMatch } from "@/lib/banking/transactions";
import { listAudit } from "@/lib/audit";
import { refresh, rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { csv, importCsv, txnsOf } from "./helpers";

let t: TestOrg;
let bank: string;
beforeAll(async () => {
  t = await setupOrg();
  bank = await t.acct("1000");
});

const coffeeRule = async (mode: "suggest" | "auto_categorize", priority?: number) => ({
  name: `Coffee ${mode}`,
  priority: priority ?? null,
  conditions: { descriptionContains: "coffee", direction: "out" as const },
  actions: { splits: [{ accountId: await t.acct("6350") }] },
  mode,
});

describe("bank rules", () => {
  it("validates conditions and splits", async () => {
    await rejectsWith(saveRule(t.ctx, { name: "Everything", conditions: {}, actions: { splits: [{ accountId: await t.acct("6350") }] }, mode: "suggest" }), "validation_failed");
    await rejectsWith(
      saveRule(t.ctx, { name: "Bad pct", conditions: { descriptionContains: "x" }, actions: { splits: [{ accountId: await t.acct("6350"), percent: "60" }, { accountId: await t.acct("6000"), percent: "30" }] }, mode: "suggest" }),
      "validation_failed",
    );
    const staff = await t.as("staff");
    await rejectsWith(saveRule(staff, await coffeeRule("suggest")), "forbidden");
  });

  it("previews which waiting transactions a rule would take, and what a higher rule claims", async () => {
    await importCsv(t.ctx, bank, csv([["2026-05-01", "CORNER COFFEE", "-4.75"], ["2026-05-01", "COFFEE BEANS WHOLESALE", "-250.00"], ["2026-05-02", "FUEL", "-40.00"]]));
    const { rule: big } = await saveRule(t.ctx, { name: "Big coffee", priority: 1, conditions: { descriptionContains: "coffee", minAmount: "100" }, actions: { splits: [{ accountId: await t.acct("5000") }] }, mode: "suggest" });
    const preview = await previewRule(getDb(), t.ctx, { ...(await coffeeRule("suggest")), priority: 50 });
    expect(preview.map((p) => [p.txn.description, p.claimedBy])).toEqual(
      expect.arrayContaining([
        ["CORNER COFFEE", null],
        ["COFFEE BEANS WHOLESALE", big.name],
      ]),
    );
    expect(preview.find((p) => p.txn.description === "CORNER COFFEE")!.splits![0]!.amount.toString()).toBe("4.75");
  });

  it("suggests only, unless the organization allows auto-posting and the editor may", async () => {
    const { rule } = await saveRule(t.ctx, await coffeeRule("auto_categorize", 10));
    // Organization setting off: suggestion only.
    await importCsv(t.ctx, bank, csv([["2026-05-03", "COFFEE SHOP 1", "-3.50"]]));
    let txn = (await txnsOf(t.orgId, bank)).find((x) => x.description === "COFFEE SHOP 1")!;
    expect(txn.status).toBe("unreviewed");
    expect(txn.ruleId).toBe(rule.id);

    // Turn it on; the rule was saved by an owner (who holds the permission): it posts, and still waits for review.
    await getDb().update(organizations).set({ bankRulesAutoPost: true }).where(eq(organizations.id, t.orgId));
    const ctx = await refresh(t.ctx);
    await importCsv(ctx, bank, csv([["2026-05-04", "COFFEE SHOP 2", "-3.60"]]));
    txn = (await txnsOf(t.orgId, bank)).find((x) => x.description === "COFFEE SHOP 2")!;
    expect(txn.status).toBe("categorized");
    expect(txn.autoCategorized).toBe(true);
    expect(txn.reviewedAt).toBeNull();
    const apps = await getDb().select().from(bankRuleApplications).where(and(eq(bankRuleApplications.orgId, t.orgId), eq(bankRuleApplications.bankTransactionId, txn.id)));
    expect(apps.map((a) => a.outcome)).toContain("auto_categorized");
    await confirmReviewed(ctx, [txn.id]);

    // Saving records whether the editor held banking.rules.autopost (an accountant does).
    const accountant = await t.as("accountant");
    const { rule: saved } = await saveRule(accountant, { ...(await coffeeRule("auto_categorize", 10)), name: "Coffee (accountant)" }, rule.id);
    expect(saved.editorMayAutopost).toBe(true);
    expect(mayAutoPost({ ...saved, editorMayAutopost: false }, true)).toBe(false);
    expect(mayAutoPost(saved, false)).toBe(false);
    // A rule last saved by someone without the permission only suggests, even with the setting on.
    await getDb().update(bankRules).set({ editorMayAutopost: false }).where(eq(bankRules.id, rule.id));
    await importCsv(ctx, bank, csv([["2026-05-05", "COFFEE SHOP 3", "-3.70"]]));
    txn = (await txnsOf(t.orgId, bank)).find((x) => x.description === "COFFEE SHOP 3")!;
    expect(txn.status).toBe("unreviewed");
    expect(txn.ruleId).toBe(rule.id);
  });

  it("lets an auto-categorization be undone", async () => {
    const txn = (await txnsOf(t.orgId, bank)).find((x) => x.description === "COFFEE SHOP 2")!;
    await undoMatch(t.ctx, txn.matchGroupId!, "should be meals with a client");
    const after = (await txnsOf(t.orgId, bank)).find((x) => x.description === "COFFEE SHOP 2")!;
    expect(after.status).toBe("unreviewed");
    const apps = await getDb().select().from(bankRuleApplications).where(and(eq(bankRuleApplications.orgId, t.orgId), eq(bankRuleApplications.bankTransactionId, txn.id)));
    expect(apps.map((a) => a.outcome)).toContain("undone");
  });

  it("reorders precedence and audits rule changes", async () => {
    const before = await listRules(getDb(), t.orgId);
    const last = before[before.length - 1]!;
    await moveRule(t.ctx, last.id, "up");
    const after = await listRules(getDb(), t.orgId);
    expect(after.findIndex((r) => r.id === last.id)).toBe(before.length - 2);
    const events = await listAudit(getDb(), t.orgId, { entityType: "bank_rule" });
    expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["banking.rule_created", "banking.rule_updated", "banking.rule_moved"]));
    const r = await runRulesNow(t.ctx);
    expect(r.suggested + r.posted).toBeGreaterThan(0);
  });
});
