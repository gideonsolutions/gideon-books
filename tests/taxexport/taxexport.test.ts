import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { taxExports, taxMappingVersions } from "@/lib/db/schema/taxexport";
import { attachments } from "@/lib/db/schema/core";
import { CATALOGS, suggestCategory } from "@/lib/taxexport/catalogs";
import { confirmAllMappings, currentVersion, findSet, saveMappings, suggestMappings } from "@/lib/taxexport/mappings";
import { addAdjustment, importDepreciationAdjustments, voidAdjustment } from "@/lib/taxexport/adjustments";
import { reconcile, recordReview } from "@/lib/taxexport/reconcile";
import { buildPackage, generateExport } from "@/lib/taxexport/export";
import { readAttachment } from "@/lib/storage/attachments";
import { trialBalance } from "@/lib/reports/statements";
import { rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { journal } from "../reports/helpers";
import fs from "node:fs";
import path from "node:path";
import { checkSchema } from "./schema-check";

let t: TestOrg;
const year = { returnType: "1120" as const, taxYearStart: "2026-01-01", taxYearEnd: "2026-12-31", basis: "accrual" as const };

beforeAll(async () => {
  t = await setupOrg({ name: "Tax Corp", entityType: "c_corporation" });
  await journal(t.ctx, "2026-03-01", [
    [await t.acct("1000"), "1000"],
    [await t.acct("4100"), "-1000"],
  ]);
  await journal(t.ctx, "2026-03-02", [
    [await t.acct("6350"), "400"],
    [await t.acct("6550"), "300"],
    [await t.acct("1000"), "-700"],
  ]);
});

describe("tax categories", () => {
  it("catalog codes are unique per return type and suggestions only name catalog lines", () => {
    for (const c of CATALOGS) {
      const codes = c.categories.map((x) => x.code);
      expect(new Set(codes).size, c.returnType).toBe(codes.length);
    }
    expect(suggestCategory("1120", { type: "income", subtype: "operating_income", name: "Service Income" })).toBe("L1a");
    expect(suggestCategory("schedule_c", { type: "expense", subtype: "operating_expense", name: "Meals" })).toBe("L24b");
    expect(suggestCategory("1120", { type: "expense", subtype: "cost_of_goods_sold", name: "Cost of Goods Sold" })).toBe("L2");
    expect(suggestCategory("custom", { type: "expense", subtype: "operating_expense", name: "Meals" })).toBeNull();
  });
});

describe("book-to-tax reconciliation and export", () => {
  it("suggests mappings unconfirmed, blocks approval while accounts are unmapped, and never touches the ledger", async () => {
    const n = await suggestMappings(t.ctx, "1120");
    expect(n).toBeGreaterThan(5);
    let rec = await reconcile(getDb(), t.ctx.org, year);
    expect(rec.unconfirmed).toBe(3);
    expect(rec.categories.find((c) => c.category.code === "L1a")!.bookAmount.toFixed(2)).toBe("1000.00");
    expect(rec.categories.find((c) => c.category.code === "L16")!.bookAmount.toFixed(2)).toBe("300.00");
    // Unmap rent: it becomes a blocker.
    await saveMappings(t.ctx, "1120", [{ accountId: await t.acct("6550"), categoryCode: null }]);
    rec = await reconcile(getDb(), t.ctx.org, year);
    expect(rec.unmapped.map((u) => u.code)).toEqual(["6550"]);
    await rejectsWith(recordReview(t.ctx, { ...year, status: "approved" }), "validation_failed");
    await saveMappings(t.ctx, "1120", [{ accountId: await t.acct("6550"), categoryCode: "L16", confirm: true }]);
    await confirmAllMappings(t.ctx, "1120");
    const tbBefore = await trialBalance(getDb(), t.ctx.org, { asOf: "2026-12-31", basis: "accrual" });
    const entriesBefore = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id = ${t.orgId}`);
    const adj = await addAdjustment(t.ctx, { ...year, categoryCode: "L26", kind: "permanent", amount: "-200", description: "50% of meals not deductible", source: "meals_limitation" });
    rec = await reconcile(getDb(), t.ctx.org, year);
    const meals = rec.categories.find((c) => c.category.code === "L26")!;
    expect(meals.bookAmount.toFixed(2)).toBe("400.00");
    expect(meals.taxAmount.toFixed(2)).toBe("200.00");
    expect(rec.bookNetIncome.toFixed(2)).toBe("300.00");
    expect(rec.taxableBeforeSpecialItems.toFixed(2)).toBe("500.00");
    const entriesAfter = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from journal_entries where org_id = ${t.orgId}`);
    expect(entriesAfter.rows[0]!.n).toBe(entriesBefore.rows[0]!.n);
    const tbAfter = await trialBalance(getDb(), t.ctx.org, { asOf: "2026-12-31", basis: "accrual" });
    expect(tbAfter.totalDebit.toString()).toBe(tbBefore.totalDebit.toString());
    const review = await recordReview(t.ctx, { ...year, status: "approved" });
    expect(review.dataHash).toBe(rec.dataHash);
    expect((await reconcile(getDb(), t.ctx.org, year)).reviewCurrent).toBe(true);
    // A voided adjustment drops out (and the approval is no longer current).
    await voidAdjustment(t.ctx, adj.id, "Entered twice");
    expect((await reconcile(getDb(), t.ctx.org, year)).reviewCurrent).toBe(false);
    await addAdjustment(t.ctx, { ...year, categoryCode: "L26", kind: "permanent", amount: "-200", description: "50% of meals not deductible", source: "meals_limitation" });
  });

  it("exports deterministically, pins the mapping version, and versions later changes", async () => {
    const first = await generateExport(t.ctx, year);
    expect(first.reused).toBe(false);
    const set = (await findSet(getDb(), t.orgId, "1120"))!;
    const v1 = (await currentVersion(getDb(), t.orgId, set.id))!;
    expect(v1.version).toBe(1);
    expect(v1.lockedAt).not.toBeNull();
    expect(first.export.versionId).toBe(v1.id);
    expect(first.pkg.mapping.setVersion).toBe(1);
    expect(first.pkg.categories.find((c) => c.code === "L26")!.taxAmount).toBe("200.00");
    expect(first.pkg.unmapped).toEqual([]);
    expect(first.pkg.provenance.entryCount).toBe(2);
    // The same data gives the same package.
    const again = await generateExport(t.ctx, year);
    expect(again.reused).toBe(true);
    expect(again.export.id).toBe(first.export.id);
    const rec = await reconcile(getDb(), t.ctx.org, year);
    const p1 = await buildPackage(getDb(), t.ctx.org, rec, "a", new Date("2026-01-01T00:00:00Z"));
    const p2 = await buildPackage(getDb(), t.ctx.org, rec, "b", new Date("2027-06-01T00:00:00Z"));
    expect(p1.provenance.contentHash).toBe(p2.provenance.contentHash);
    // The stored JSON is the package.
    const { bytes } = await readAttachment(getDb(), t.ctx, first.export.jsonAttachmentId!);
    const stored = JSON.parse(bytes.toString("utf8"));
    expect(stored.provenance.contentHash).toBe(first.pkg.provenance.contentHash);
    expect(stored.format).toBe("gideon-books.tax-export");
    const schema = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../docs/integrations/gideon-tax-export.schema.json"), "utf8"));
    expect(checkSchema(schema, stored)).toEqual([]);
    expect(checkSchema(schema, { ...stored, extra: 1 })).toEqual(["$.extra: not allowed"]);
    const [att] = await getDb().select().from(attachments).where(eq(attachments.id, first.export.csvAttachmentId!));
    expect(att!.origin).toBe("generated");
    // Changing a mapping after the export starts version 2; the export keeps version 1.
    await saveMappings(t.ctx, "1120", [{ accountId: await t.acct("6350"), categoryCode: "BK_NONDEDUCTIBLE", confirm: true }]);
    const v2 = (await currentVersion(getDb(), t.orgId, set.id))!;
    expect(v2.version).toBe(2);
    expect(v2.lockedAt).toBeNull();
    const [still] = await getDb().select().from(taxExports).where(eq(taxExports.id, first.export.id));
    expect(still!.versionId).toBe(v1.id);
    const versions = await getDb().select().from(taxMappingVersions).where(and(eq(taxMappingVersions.orgId, t.orgId), eq(taxMappingVersions.setId, set.id)));
    expect(versions).toHaveLength(2);
    const second = await generateExport(t.ctx, year);
    expect(second.reused).toBe(false);
    expect(second.pkg.mapping.setVersion).toBe(2);
    expect(second.pkg.provenance.contentHash).not.toBe(first.pkg.provenance.contentHash);
  });

  it("imports tax depreciation from the asset register when it is available", async () => {
    const r = await importDepreciationAdjustments(t.ctx, { ...year, categoryCode: "L20" });
    expect(r.available).toBe(true);
    expect(r.created).toBe(0);
  });

  it("refuses read-only members", async () => {
    const ro = await t.as("read_only");
    await rejectsWith(suggestMappings(ro, "1120"), "forbidden");
    await rejectsWith(generateExport(ro, year), "forbidden");
  });
});
