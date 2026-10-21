import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { journalEntries } from "@/lib/db/schema/ledger";
import { depreciationRunLines } from "@/lib/db/schema/assets";
import { computeSchedule } from "@/lib/assets/schedule";
import { capitalizeAsset, createAsset, disposeAsset, reverseDisposal, getAsset, updateAsset, type AssetInput } from "@/lib/assets/assets";
import { postRun, prepareRun, reverseRun, discardRun, runMonthlyDepreciation, setAutoPostDepreciation } from "@/lib/assets/depreciation";
import { assetRollforward, rollforwardCsv } from "@/lib/assets/reports";
import { saveTaxBook, setEnteredTaxDepreciation, taxDepreciationDifferences } from "@/lib/assets/tax-book";
import { saveDraft, issueDocument } from "@/lib/commerce/documents";
import { Decimal } from "@/lib/money/decimal";
import { balance, rejectsWith, setupOrg, vendor, type TestOrg } from "../helpers";

const sum = (xs: { amount: Decimal }[]) => Decimal.sum(xs.map((x) => x.amount)).toString();

describe("depreciation schedules", () => {
  it("straight line spreads cost less residual exactly, the last month taking the remainder", () => {
    const rows = computeSchedule({ cost: "100.00", residualValue: "0", usefulLifeMonths: 3, method: "straight_line", inServiceDate: "2026-01-15", currency: "USD" });
    expect(rows.map((r) => r.amount.toString())).toEqual(["33.33", "33.34", "33.33"]);
    expect(rows.map((r) => r.periodEnd)).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    const big = computeSchedule({ cost: "12345.67", residualValue: "345.67", usefulLifeMonths: 60, method: "straight_line", inServiceDate: "2026-01-01", currency: "USD" });
    expect(big.length).toBe(60);
    expect(sum(big)).toBe("12000.00");
    expect(big.every((r) => r.amount.isPositive())).toBe(true);
  });

  it("declining balance switches to straight line and never goes below the residual", () => {
    const rows = computeSchedule({ cost: "1000.00", residualValue: "100.00", usefulLifeMonths: 12, method: "declining_balance", decliningFactor: "2", inServiceDate: "2026-01-01", currency: "USD" });
    expect(rows[0]!.amount.toString()).toBe("166.67");
    expect(sum(rows)).toBe("900.00");
    expect(rows[rows.length - 1]!.netBookValue.toString()).toBe("100.00");
    // Monotone non-increasing until the switch to straight line evens it out.
    expect(rows.every((r) => r.amount.isPositive())).toBe(true);
  });

  it("continues an opening asset from its accumulated depreciation and computes nothing for land", () => {
    const rows = computeSchedule(
      { cost: "1200.00", residualValue: "0", usefulLifeMonths: 12, method: "straight_line", inServiceDate: "2025-07-01", currency: "USD" },
      { accumulated: "650.00", monthsUsed: 6 },
    );
    expect(rows.length).toBe(6);
    expect(sum(rows)).toBe("550.00");
    expect(computeSchedule({ cost: "50000", residualValue: "0", usefulLifeMonths: 12, method: "none", inServiceDate: "2026-01-01", currency: "USD" })).toEqual([]);
  });
});

describe("fixed asset lifecycle", () => {
  let t: TestOrg;
  let base: AssetInput;
  beforeAll(async () => {
    t = await setupOrg();
    base = {
      name: "Delivery van",
      category: "Vehicles",
      acquisitionDate: "2026-01-10",
      cost: "36000.00",
      residualValue: "0",
      usefulLifeMonths: 36,
      method: "straight_line",
      acquisitionType: "direct",
      fundingAccountId: await t.acct("1000"),
    };
  });

  it("capitalizes directly, depreciates with catch-up, and posts each asset-month once", async () => {
    const a = await createAsset(t.ctx, base);
    expect(a.status).toBe("draft");
    const active = await capitalizeAsset(t.ctx, a.id);
    expect(active.status).toBe("active");
    expect(await balance(t.orgId, await t.acct("fixed_assets"))).toBe("36000.00");
    expect(await balance(t.orgId, await t.acct("1000"))).toBe("-36000.00");

    const run = await prepareRun(t.ctx, "2026-03-31");
    const lines = await getDb().select().from(depreciationRunLines).where(eq(depreciationRunLines.runId, run.id));
    expect(lines.map((l) => l.periodEnd).sort()).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
    expect(run.total).toBe("3000.0000");
    await rejectsWith(prepareRun(t.ctx, "2026-03-31"), "nothing_due");

    // Two people post at once: one entry.
    const [r1, r2] = await Promise.all([postRun(t.ctx, run.id), postRun(t.ctx, run.id)]);
    expect(r1.journalEntryId).toBe(r2.journalEntryId);
    const again = await postRun(t.ctx, run.id);
    expect(again.journalEntryId).toBe(r1.journalEntryId);
    const [{ n }] = (await getDb().execute(sql`select count(*)::int as n from journal_entries where org_id = ${t.orgId} and kind = 'depreciation'`)).rows as [{ n: number }];
    expect(n).toBe(1);
    expect(await balance(t.orgId, await t.acct("depreciation_expense"))).toBe("3000.00");
    expect(await balance(t.orgId, await t.acct("accumulated_depreciation"))).toBe("-3000.00");
    await rejectsWith(prepareRun(t.ctx, "2026-02-28"), "nothing_due");
  });

  it("refuses two concurrent preparations of the same months", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    const results = await Promise.allSettled([prepareRun(o.ctx, "2026-01-31"), prepareRun(o.ctx, "2026-01-31")]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  it("reverses a run (latest first) and frees its months", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    const jan = await postRun(o.ctx, (await prepareRun(o.ctx, "2026-01-31")).id);
    const feb = await postRun(o.ctx, (await prepareRun(o.ctx, "2026-02-28")).id);
    await rejectsWith(reverseRun(o.ctx, jan.id, { reason: "wrong life" }), "later_run_posted");
    await reverseRun(o.ctx, feb.id, { reason: "posted too early" });
    expect(await balance(o.orgId, await o.acct("accumulated_depreciation"))).toBe("-1000.00");
    const again = await prepareRun(o.ctx, "2026-02-28");
    expect(again.total).toBe("1000.0000");
    await discardRun(o.ctx, again.id);
  });

  it("changes estimates prospectively", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, cost: "1200.00", usefulLifeMonths: 12, fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    await postRun(o.ctx, (await prepareRun(o.ctx, "2026-03-31")).id); // 3 × 100
    await updateAsset(o.ctx, a.id, { ...base, cost: "1200.00", usefulLifeMonths: 6, fundingAccountId: await o.acct("1000") });
    const r = await prepareRun(o.ctx, "2026-06-30");
    expect(r.total).toBe("900.0000"); // the remaining 900 over the remaining 3 months
    await rejectsWith(updateAsset(o.ctx, a.id, { ...base, cost: "1300.00", usefulLifeMonths: 6, fundingAccountId: await o.acct("1000") }), "asset_capitalized");
  });

  it("disposes with a gain or loss, removing cost and accumulated depreciation", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, cost: "1200.00", usefulLifeMonths: 12, fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    await postRun(o.ctx, (await prepareRun(o.ctx, "2026-03-31")).id);
    // April's depreciation is not posted, so a May disposal is refused.
    await rejectsWith(disposeAsset(o.ctx, a.id, { date: "2026-05-15", proceeds: "1000", proceedsAccountId: await o.acct("1000"), reason: "Sold" }), "depreciation_outstanding");
    const d = await disposeAsset(o.ctx, a.id, { date: "2026-04-20", proceeds: "1000.00", proceedsAccountId: await o.acct("1000"), reason: "Sold to a neighbor" });
    // NBV 900, proceeds 1000: a 100 gain.
    expect(d.gainLoss).toBe("100.0000");
    expect(await balance(o.orgId, await o.acct("fixed_assets"))).toBe("0.00");
    expect(await balance(o.orgId, await o.acct("accumulated_depreciation"))).toBe("0.00");
    expect(await balance(o.orgId, await o.acct("asset_disposal_gain_loss"))).toBe("-100.00");
    expect((await getAsset(getDb(), o.orgId, a.id)).status).toBe("disposed");
    const rf = await assetRollforward(getDb(), o.orgId, "2026-01-01", "2026-12-31");
    expect(rf.reconciled).toBe(true);
    expect(rf.totals.additions.toString()).toBe("1200.0000");
    expect(rf.totals.disposals.toString()).toBe("1200.0000");
    expect(rf.totals.closingCost.isZero()).toBe(true);
    await reverseDisposal(o.ctx, a.id, { date: "2026-04-30", reason: "Sale fell through" });
    expect(await balance(o.orgId, await o.acct("fixed_assets"))).toBe("1200.00");
    expect((await assetRollforward(getDb(), o.orgId, "2026-01-01", "2026-12-31")).reconciled).toBe(true);
  });

  it("writes off without proceeds as a loss", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, cost: "500.00", usefulLifeMonths: 10, acquisitionDate: "2026-06-01", fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    const d = await disposeAsset(o.ctx, a.id, { date: "2026-06-30", reason: "Destroyed" });
    expect(d.gainLoss).toBe("-500.0000");
    expect(await balance(o.orgId, await o.acct("asset_disposal_gain_loss"))).toBe("500.00");
  });

  it("brings an opening asset with its prior depreciation", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, {
      ...base,
      name: "Press",
      acquisitionDate: "2024-01-05",
      cost: "2400.00",
      usefulLifeMonths: 24,
      acquisitionType: "opening",
      fundingAccountId: null,
      openingAccumulatedDepreciation: "2000.00",
      openingDepreciationThrough: "2025-08-31",
    });
    await capitalizeAsset(o.ctx, a.id);
    expect(await balance(o.orgId, await o.acct("fixed_assets"))).toBe("2400.00");
    expect(await balance(o.orgId, await o.acct("accumulated_depreciation"))).toBe("-2000.00");
    expect(await balance(o.orgId, await o.acct("opening_balance_equity"))).toBe("-400.00");
    // 20 of 24 months used; 400 left over 4 months.
    const run = await prepareRun(o.ctx, "2025-12-31");
    expect(run.total).toBe("400.0000");
    await postRun(o.ctx, run.id);
    expect((await getAsset(getDb(), o.orgId, a.id)).status).toBe("fully_depreciated");
  });

  it("capitalizes from a bill line only at the line's amount", async () => {
    const o = await setupOrg();
    const v = await vendor(o.ctx, "Equipment Seller");
    const bill = await saveDraft(o.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-02-01", reference: "E-1", lines: [{ description: "Laser cutter", unitPrice: "8000", accountId: await o.acct("fixed_assets") }] });
    const issued = await issueDocument(o.ctx, bill.id);
    const { getDocument } = await import("@/lib/commerce/documents");
    const { lines } = await getDocument(getDb(), o.orgId, issued.id);
    const wrong = await createAsset(o.ctx, { ...base, name: "Laser cutter", acquisitionDate: "2026-02-01", cost: "7999.00", acquisitionType: "document_line", sourceDocumentLineId: lines[0]!.id, fundingAccountId: null });
    await rejectsWith(capitalizeAsset(o.ctx, wrong.id), "validation_failed");
    const right = await createAsset(o.ctx, { ...base, name: "Laser cutter", acquisitionDate: "2026-02-01", cost: "8000.00", acquisitionType: "document_line", sourceDocumentLineId: lines[0]!.id, fundingAccountId: null });
    const before = (await getDb().select().from(journalEntries).where(eq(journalEntries.orgId, o.orgId))).length;
    await capitalizeAsset(o.ctx, right.id);
    const after = (await getDb().select().from(journalEntries).where(eq(journalEntries.orgId, o.orgId))).length;
    expect(after).toBe(before); // the bill already put it on the books
    const rf = await assetRollforward(getDb(), o.orgId, "2026-01-01", "2026-12-31");
    expect(rf.reconciled).toBe(true);
    expect(rollforwardCsv(rf, "USD")).toContain("8000.00");
  });

  it("keeps tax depreciation off the ledger and reports book-to-tax differences", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, cost: "1200.00", usefulLifeMonths: 12, acquisitionDate: "2026-01-01", fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    await postRun(o.ctx, (await prepareRun(o.ctx, "2026-12-31")).id);
    const entriesBefore = (await getDb().select().from(journalEntries).where(eq(journalEntries.orgId, o.orgId))).length;
    await saveTaxBook(o.ctx, a.id, { method: "straight_line", methodLabel: "5-year (label)", taxBasis: "1200.00", usefulLifeMonths: 6, placedInService: "2026-01-01" });
    let diff = await taxDepreciationDifferences(getDb(), o.orgId, "2026-01-01", "2026-12-31");
    expect(diff).toEqual([{ assetId: a.id, assetName: expect.stringContaining("Delivery van"), bookDepreciation: "1200.00", taxDepreciation: "1200.00", difference: "0.00" }]);
    await saveTaxBook(o.ctx, a.id, { method: "entered", taxBasis: "1200.00", placedInService: "2026-01-01" });
    await setEnteredTaxDepreciation(o.ctx, a.id, { taxYearStart: "2026-01-01", taxYearEnd: "2026-12-31", amount: "1000.00" });
    diff = await taxDepreciationDifferences(getDb(), o.orgId, "2026-01-01", "2026-12-31");
    expect(diff[0]!.difference).toBe("-200.00");
    const entriesAfter = (await getDb().select().from(journalEntries).where(eq(journalEntries.orgId, o.orgId))).length;
    expect(entriesAfter).toBe(entriesBefore);
  });

  it("prepares the monthly run for review unless auto-post is on", async () => {
    const o = await setupOrg();
    const a = await createAsset(o.ctx, { ...base, cost: "120.00", usefulLifeMonths: 12, fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    const r1 = await runMonthlyDepreciation(o.orgId, "2026-01-31");
    expect(r1.posted).toBe(false);
    const again = await runMonthlyDepreciation(o.orgId, "2026-01-31");
    expect(again.runId).toBe(r1.runId);
    await postRun(o.ctx, r1.runId!);
    await setAutoPostDepreciation(o.ctx, true);
    const r2 = await runMonthlyDepreciation(o.orgId, "2026-02-28");
    expect(r2.posted).toBe(true);
    const [{ n }] = (await getDb().execute(sql`select count(*)::int as n from journal_entries where org_id = ${o.orgId} and kind = 'depreciation'`)).rows as [{ n: number }];
    expect(n).toBe(2);
  });
});
