import { beforeAll, describe, expect, it } from "vitest";
import { postManualEntry } from "@/lib/ledger/journals";
import { createDimension } from "@/lib/ledger/dimensions";
import { financialPositionByRestriction, fundBalances, releaseFromRestriction, statementOfActivities } from "@/lib/specialized/funds";
import { getDb } from "@/lib/db/client";
import { rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
let building: string;
let endowment: string;

beforeAll(async () => {
  t = await setupOrg({ template: "nonprofit", entityType: "nonprofit" });
  building = (await createDimension(t.ctx, { kind: "fund", name: "Building Fund", restriction: "with_donor_restrictions_temporary" })).id;
  endowment = (await createDimension(t.ctx, { kind: "fund", name: "Endowment", restriction: "with_donor_restrictions_perpetual" })).id;
  await postManualEntry(t.ctx, { entryDate: "2026-02-01", description: "Restricted gift", lines: [{ accountId: await t.acct("1000"), debit: "5000" }, { accountId: await t.acct("4010"), credit: "5000", fundId: building }] });
  await postManualEntry(t.ctx, { entryDate: "2026-02-02", description: "Endowment gift", lines: [{ accountId: await t.acct("1010"), debit: "10000" }, { accountId: await t.acct("4010"), credit: "10000", fundId: endowment }] });
  await postManualEntry(t.ctx, { entryDate: "2026-02-03", description: "General gift", lines: [{ accountId: await t.acct("1000"), debit: "1000" }, { accountId: await t.acct("4010"), credit: "1000" }] });
  await postManualEntry(t.ctx, { entryDate: "2026-02-10", description: "Program costs", lines: [{ accountId: await t.acct("6010"), debit: "800" }, { accountId: await t.acct("1000"), credit: "800" }] });
});

describe("nonprofit funds", () => {
  it("releases from restriction and presents activities by restriction class", async () => {
    await releaseFromRestriction(t.ctx, { fundId: building, amount: "2000", date: "2026-02-20", reason: "Roof repair completed" });
    const act = await statementOfActivities(getDb(), t.orgId, "2026-01-01", "2026-12-31");
    expect(act.totals.byClass.with.revenue).toBe("15000.0000");
    expect(act.totals.byClass.without.revenue).toBe("1000.0000");
    expect(act.totals.byClass.without.releases).toBe("2000.0000");
    expect(act.totals.byClass.with.releases).toBe("-2000.0000");
    expect(act.totals.byClass.without.change).toBe("2200.0000");
    expect(act.totals.byClass.with.change).toBe("13000.0000");
    const pos = await financialPositionByRestriction(getDb(), t.orgId, "2026-12-31");
    expect(pos.assets).toBe("15200.0000");
    expect(pos.byClass.without).toBe("2200.0000");
    expect(pos.byClass.with).toBe("13000.0000");
    expect(pos.difference).toBe("0.0000");
    const balances = await fundBalances(getDb(), t.orgId, "2026-01-01", "2026-12-31");
    const b = balances.find((x) => x.id === building)!;
    expect([b.opening, b.revenue, b.releases, b.closing]).toEqual(["0", "5000.0000", "-2000.0000", "3000.0000"]);
  });

  it("refuses releasing more than the fund holds, or from a perpetual endowment", async () => {
    await rejectsWith(releaseFromRestriction(t.ctx, { fundId: building, amount: "3000.01", date: "2026-03-01", reason: "too much" }), "release_exceeds_fund");
    await rejectsWith(releaseFromRestriction(t.ctx, { fundId: endowment, amount: "1", date: "2026-03-01", reason: "no" }), "perpetual_restriction");
    const staff = await t.as("staff");
    await rejectsWith(releaseFromRestriction(staff, { fundId: building, amount: "1", date: "2026-03-01", reason: "no" }), "forbidden");
  });
});
