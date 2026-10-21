import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { memberships } from "@/lib/db/schema/core";
import { createOrganization } from "@/lib/orgs/orgs";
import { userCtx, type Ctx } from "@/lib/context";
import { postManualEntry } from "@/lib/ledger/journals";
import { systemAccountId } from "@/lib/ledger/accounts";
import {
  addGroupRate,
  addMember,
  addPair,
  adoptChartAndAutoMap,
  createElimination,
  createGroup,
  groupContext,
  listGroupAccounts,
  listGroupsForUser,
  saveGroupAccount,
  setMapping,
  voidElimination,
  type GroupActor,
} from "@/lib/consolidation/groups";
import { consolidate, intercompanyBalances, suggestEliminations } from "@/lib/consolidation/report";
import { newUser, rejectsDb, rejectsWith } from "../helpers";

async function org(userId: string, email: string, name: string, baseCurrency: string, extra: Record<string, unknown> = {}): Promise<Ctx> {
  const o = await createOrganization(userId, { name, baseCurrency, template: "services", ...extra });
  return userCtx(o, userId, "owner", email);
}

async function acct(ctx: Ctx, code: string) {
  const [a] = await getDb().select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.code, code)));
  return a!.id;
}

let actor: GroupActor;
let A: Ctx;
let B: Ctx;
let groupId: string;

beforeAll(async () => {
  const u = await newUser("Group Accountant");
  actor = { userId: u.id, label: u.email };
  A = await org(u.id, u.email, "Parent Co", "USD");
  B = await org(u.id, u.email, "Euro Sub", "EUR", { fiscalYearStartMonth: 4 });
  const icRecv = await withTransaction((tx) => systemAccountId(tx, A.orgId, "intercompany_receivable"));
  const icPay = await withTransaction((tx) => systemAccountId(tx, B.orgId, "intercompany_payable"));
  // Parent: capital 10,000; revenue 3,000; lends 1,100 USD to the subsidiary.
  await postManualEntry(A, { entryDate: "2026-03-02", description: "Capital", lines: [{ accountId: await acct(A, "1000"), debit: "10000" }, { accountId: await acct(A, "3100"), credit: "10000" }] });
  await postManualEntry(A, { entryDate: "2026-03-10", description: "Fees", lines: [{ accountId: await acct(A, "1000"), debit: "3000" }, { accountId: await acct(A, "4100"), credit: "3000" }] });
  await postManualEntry(A, { entryDate: "2026-03-05", description: "Loan to Euro Sub", lines: [{ accountId: icRecv, debit: "1100" }, { accountId: await acct(A, "1000"), credit: "1100" }] });
  // Subsidiary (EUR): receives 1,000 EUR, earns 500, spends 200.
  await postManualEntry(B, { entryDate: "2026-03-05", description: "Loan from parent", lines: [{ accountId: await acct(B, "1000"), debit: "1000" }, { accountId: icPay, credit: "1000" }] });
  await postManualEntry(B, { entryDate: "2026-03-10", description: "Fees", lines: [{ accountId: await acct(B, "1000"), debit: "500" }, { accountId: await acct(B, "4100"), credit: "500" }] });
  await postManualEntry(B, { entryDate: "2026-03-12", description: "Rent", lines: [{ accountId: await acct(B, "6550"), debit: "200" }, { accountId: await acct(B, "1000"), credit: "200" }] });

  const group = await createGroup(actor, { name: "Holdings", reportingCurrency: "USD" });
  groupId = group.id;
  let g = await groupContext(getDb(), actor, groupId, "manage");
  await addMember(g, A.orgId);
  g = await groupContext(getDb(), actor, groupId, "manage");
  await addMember(g, B.orgId, "80");
  g = await groupContext(getDb(), actor, groupId, "manage");
  for (const [d, r] of [
    ["2026-03-01", "1.08"],
    ["2026-03-15", "1.10"],
    ["2026-03-31", "1.12"],
  ] as const) {
    await addGroupRate(g, { currency: "EUR", rateDate: d, rate: r });
  }
});

describe("consolidation", () => {
  it("reports unmapped balances as blockers, then maps, translates and balances with a translation adjustment", async () => {
    let g = await groupContext(getDb(), actor, groupId, "manage");
    const before = await consolidate(getDb(), g, "2026-03-01", "2026-03-31");
    expect(before.blockers.length).toBeGreaterThan(0);
    expect(before.balanced).toBe(true);

    await adoptChartAndAutoMap(g, A.orgId);
    g = await groupContext(getDb(), actor, groupId, "manage");
    const after1 = await consolidate(getDb(), g, "2026-03-01", "2026-03-31");
    // The subsidiary's intercompany payable (2500) has no counterpart in the parent's chart yet.
    expect(after1.blockers.map((b) => b.code)).toEqual(["2500"]);
    const ga = await saveGroupAccount(g, { code: "2500", name: "Due to related entities", type: "liability" });
    await setMapping(g, B.orgId, await withTransaction((tx) => systemAccountId(tx, B.orgId, "intercompany_payable")), ga.id);

    const r = await consolidate(getDb(), g, "2026-03-01", "2026-03-31");
    expect(r.blockers).toEqual([]);
    expect(r.balanced).toBe(true);
    const sub = r.members.find((m) => m.orgId === B.orgId)!;
    expect(sub.closing!.rate.toString()).toBe("1.120000000000");
    expect(sub.average!.rate.toString()).toBe("1.100000000000");
    // Net income 300 EUR at average 1.10 = 330, held at closing 1.12 = 336: the adjustment is −6.
    expect(sub.cta).toBe("-6.00");
    const row = (code: string) => r.rows.find((x) => x.groupAccount.code === code)!;
    expect(row("1000").perMember[B.orgId]).toBe("1456.00");
    expect(row("1000").perMember[A.orgId]).toBe("11900.00");
    expect(row("1000").total).toBe("13356.00");
    expect(row("4100").total).toBe("-3550.00"); // 3,000 + 500 × 1.10
    expect(row("6550").total).toBe("220.00");
    expect(r.totals.netIncome).toBe("3330.00");
    expect(r.warnings.some((w) => w.includes("different fiscal years"))).toBe(true);
  });

  it("finds intercompany differences, suggests the elimination, and eliminates at group level only", async () => {
    const g = await groupContext(getDb(), actor, groupId, "manage");
    await addPair(g, {
      orgA: A.orgId,
      accountA: await withTransaction((tx) => systemAccountId(tx, A.orgId, "intercompany_receivable")),
      orgB: B.orgId,
      accountB: await withTransaction((tx) => systemAccountId(tx, B.orgId, "intercompany_payable")),
      description: "Loan",
    });
    const ic = await intercompanyBalances(getDb(), g, "2026-03-01", "2026-03-31");
    expect(ic[0]!.translatedA).toBe("1100.00");
    expect(ic[0]!.translatedB).toBe("-1120.00");
    expect(ic[0]!.difference).toBe("-20.00");
    const [s] = await suggestEliminations(getDb(), g, "2026-03-01", "2026-03-31");
    expect(s!.lines.map((l) => l.amount)).toEqual(["-1100.00", "1100.00"]);
    const e = await createElimination(g, { entryDate: "2026-03-31", description: s!.description, lines: s!.lines, source: "suggested" });
    const r = await consolidate(getDb(), g, "2026-03-01", "2026-03-31");
    expect(r.balanced).toBe(true);
    const row = (code: string) => r.rows.find((x) => x.groupAccount.code === code)!;
    expect(row("1400").total).toBe("0.00");
    expect(row("2500").total).toBe("-20.00");
    expect(row("1400").eliminations).toBe("-1100.00");
    // The members' own books are untouched.
    const sum = await getDb().execute(
      sql`select count(*)::int as n from journal_entries where org_id in (${A.orgId}, ${B.orgId}) and description ilike '%eliminat%'`,
    );
    expect((sum.rows[0] as { n: number }).n).toBe(0);
    // Unbalanced eliminations are refused; voiding keeps the record.
    await rejectsWith(createElimination(g, { entryDate: "2026-03-31", description: "bad", lines: [{ groupAccountId: s!.lines[0]!.groupAccountId, amount: "5" }, { groupAccountId: s!.lines[1]!.groupAccountId, amount: "-4" }] }), "validation_failed");
    await voidElimination(g, e.id, "Recorded twice");
    const r2 = await consolidate(getDb(), g, "2026-03-01", "2026-03-31");
    expect(r2.rows.find((x) => x.groupAccount.code === "1400")!.total).toBe("1100.00");
    await rejectsDb(getDb().execute(sql`delete from elimination_lines where entry_id = ${e.id}`), /permanent/);
  });

  it("refuses access without rights in every member, and refuses mixing demo with real organizations", async () => {
    const outsider = await newUser("Outsider");
    await getDb().insert(memberships).values({ orgId: A.orgId, userId: outsider.id, role: "accountant" });
    await rejectsWith(groupContext(getDb(), { userId: outsider.id, label: outsider.email }, groupId), "not_found");
    expect((await listGroupsForUser(getDb(), outsider.id)).map((x) => x.group.id)).not.toContain(groupId);

    const viewer = await newUser("Viewer");
    await getDb().insert(memberships).values([
      { orgId: A.orgId, userId: viewer.id, role: "read_only" },
      { orgId: B.orgId, userId: viewer.id, role: "read_only" },
    ]);
    const v = await groupContext(getDb(), { userId: viewer.id, label: viewer.email }, groupId);
    expect(v.canManage).toBe(false);
    await rejectsWith(groupContext(getDb(), { userId: viewer.id, label: viewer.email }, groupId, "manage"), "forbidden");
    await rejectsWith(saveGroupAccount(v, { code: "9", name: "x", type: "asset" }), "forbidden");

    const demo = await createOrganization(actor.userId, { name: "Demo Co", baseCurrency: "USD", template: "services", isDemo: true });
    const g = await groupContext(getDb(), actor, groupId, "manage");
    await rejectsWith(addMember(g, demo.id), "demo_mixing");
    expect((await listGroupAccounts(getDb(), groupId)).some((a) => a.role === "cta")).toBe(true);
  });
});
