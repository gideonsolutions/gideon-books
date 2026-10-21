import { beforeAll, describe, expect, it } from "vitest";
import { postManualEntry } from "@/lib/ledger/journals";
import { createContact } from "@/lib/contacts/contacts";
import { beneficiaryDistributions, principalIncomeStatement, recordDistribution, undistributedIncome } from "@/lib/specialized/trusts";
import { getDb } from "@/lib/db/client";
import { rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
let ben: string;
let notBen: string;

beforeAll(async () => {
  t = await setupOrg({ template: "trust", entityType: "trust" });
  ben = (await createContact(t.ctx, { displayName: "Ruth Beneficiary", isBeneficiary: true })).id;
  notBen = (await createContact(t.ctx, { displayName: "A Vendor", isVendor: true })).id;
  const bank = await t.acct("1000");
  await postManualEntry(t.ctx, { entryDate: "2026-04-01", description: "Interest", lines: [{ accountId: bank, debit: "1200", trustComponent: "income" }, { accountId: await t.acct("4100"), credit: "1200", trustComponent: "income" }] });
  await postManualEntry(t.ctx, { entryDate: "2026-04-02", description: "Gain on sale", lines: [{ accountId: bank, debit: "5000", trustComponent: "principal" }, { accountId: await t.acct("4400"), credit: "5000", trustComponent: "principal" }] });
  await postManualEntry(t.ctx, {
    entryDate: "2026-04-03",
    description: "Trustee fee, half to each",
    lines: [
      { accountId: await t.acct("6100"), debit: "150", trustComponent: "principal" },
      { accountId: await t.acct("6100"), debit: "150", trustComponent: "income" },
      { accountId: bank, credit: "300" },
    ],
  });
});

describe("trusts and estates", () => {
  it("records distributions and reports principal and income separately", async () => {
    await recordDistribution(t.ctx, { beneficiaryId: ben, component: "income", amount: "500", date: "2026-04-15", paidFromAccountId: await t.acct("1000") });
    const st = await principalIncomeStatement(getDb(), t.orgId, "2026-01-01", "2026-12-31");
    expect(st.totals.principal).toEqual({ receipts: "5000.0000", disbursements: "150.0000", distributions: "0", net: "4850.0000" });
    expect(st.totals.income).toEqual({ receipts: "1200.0000", disbursements: "150.0000", distributions: "500.0000", net: "550.0000" });
    const d = await beneficiaryDistributions(getDb(), t.orgId, "2026-01-01", "2026-12-31");
    expect(d).toHaveLength(1);
    expect([d[0]!.beneficiaryName, d[0]!.income, d[0]!.principal]).toEqual(["Ruth Beneficiary", "500.0000", "0"]);
    const u = await undistributedIncome(getDb(), t.orgId, "2026-01-01", "2026-12-31");
    expect(u.period.net).toBe("550.0000");
  });

  it("refuses a distribution to a contact who is not a beneficiary", async () => {
    await rejectsWith(recordDistribution(t.ctx, { beneficiaryId: notBen, component: "income", amount: "10", date: "2026-04-16", paidFromAccountId: await t.acct("1000") }), "validation_failed");
  });
});
