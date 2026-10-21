/**
 * Export packages for Gideon Tax: a JSON document following the published
 * contract (docs/integrations/gideon-tax-export.md and its JSON Schema), and
 * a CSV of the same figures. There is no live Gideon Tax import API to send
 * them to; the package is downloaded and given to Gideon Tax (or a preparer).
 *
 * Packages are deterministic: the same books, mappings and adjustments give
 * the same content hash (the generation time and author are outside it), and
 * generating again returns the existing package instead of a duplicate.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { taxExports, taxMappingVersions, type TaxReturnType } from "@/lib/db/schema/taxexport";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx, type Org } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { uploadAttachment } from "@/lib/storage/attachments";
import type { Basis } from "@/lib/reports/scope";
import pkg from "@/package.json";
import { catalogFor } from "./catalogs";
import { lockVersion } from "./mappings";
import { canonicalJson, reconcile, sha256, type Reconciliation } from "./reconcile";
import { depreciationDifferences } from "./adjustments";

export const EXPORT_FORMAT = "gideon-books.tax-export";
export const EXPORT_FORMAT_VERSION = "1.0";

export interface ExportPackage {
  format: typeof EXPORT_FORMAT;
  formatVersion: string;
  organization: { id: string; name: string; legalName: string | null; entityType: string; country: string; baseCurrency: string; fiscalYearStartMonth: number };
  period: { start: string; end: string };
  basis: Basis;
  returnType: TaxReturnType;
  catalog: { name: string; taxYear: string | null; package: string | null; source: ReturnType<typeof catalogFor>["source"] };
  mapping: { setVersion: number; versionId: string };
  amountsAre: string;
  categories: { code: string; line: string | null; description: string; kind: string; origin: string; bookAmount: string; adjustments: string; taxAmount: string; accounts: string[] }[];
  accounts: { id: string; code: string; name: string; type: string; subtype: string; dimension: string | null; ledgerAmount: string; categoryCode: string | null; mappingConfirmed: boolean }[];
  unmapped: { id: string; code: string; name: string; ledgerAmount: string }[];
  adjustments: { id: string; categoryCode: string; kind: string; amount: string; description: string; source: string; sourceRef: string | null }[];
  taxDepreciation: { available: boolean; assets: { assetId: string; assetName: string; bookDepreciation: string; taxDepreciation: string; difference: string }[] };
  totals: { bookNetIncome: string; taxableIncomeBeforeSpecialItems: string };
  review: { status: string; by: string; at: string; current: boolean } | null;
  provenance: {
    application: string;
    applicationVersion: string;
    sourceHash: string;
    contentHash: string;
    entryCount: number;
    lastEntryNumber: number | null;
    generatedAt: string;
    generatedBy: string;
  };
}

function money(v: Decimal, mu: number): string {
  return v.round(mu, "half_up").toFixed(mu);
}

export async function buildPackage(db: DbOrTx, org: Org, rec: Reconciliation, generatedBy: string, generatedAt: Date): Promise<ExportPackage> {
  if (!rec.version) throw new ValidationError("Map the accounts before exporting.");
  const mu = minorUnits(org.baseCurrency);
  const cat = catalogFor(rec.returnType);
  const dep = await depreciationDifferences(db, org.id, rec.taxYearStart, rec.taxYearEnd);
  const body: Omit<ExportPackage, "provenance"> & { provenance: Omit<ExportPackage["provenance"], "contentHash" | "generatedAt" | "generatedBy"> } = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    organization: {
      id: org.id,
      name: org.name,
      legalName: org.legalName,
      entityType: org.entityType,
      country: org.country,
      baseCurrency: org.baseCurrency,
      fiscalYearStartMonth: org.fiscalYearStartMonth,
    },
    period: { start: rec.taxYearStart, end: rec.taxYearEnd },
    basis: rec.basis,
    returnType: rec.returnType,
    catalog: { name: cat.name, taxYear: cat.taxYear, package: cat.package, source: cat.source },
    mapping: { setVersion: rec.version.version, versionId: rec.version.id },
    amountsAre:
      "Decimal strings in the base currency. Income and nontaxable categories are credit-positive; cost of goods sold, deductions and nondeductible categories are debit-positive. Account ledger amounts are debit-positive.",
    categories: rec.categories.map((c) => ({
      code: c.category.code,
      line: c.category.line,
      description: c.category.description,
      kind: c.category.kind,
      origin: c.category.origin,
      bookAmount: money(c.bookAmount, mu),
      adjustments: money(c.adjustments, mu),
      taxAmount: money(c.taxAmount, mu),
      accounts: [...c.accounts].sort(),
    })),
    accounts: rec.sources.map((s) => ({
      id: s.accountId,
      code: s.code,
      name: s.name,
      type: s.type,
      subtype: s.subtype,
      dimension: s.dimensionKey || null,
      ledgerAmount: money(Decimal.from(s.ledgerAmount), mu),
      categoryCode: s.categoryCode,
      mappingConfirmed: s.confirmed,
    })),
    unmapped: rec.unmapped.map((s) => ({ id: s.accountId, code: s.code, name: s.name, ledgerAmount: money(Decimal.from(s.ledgerAmount), mu) })),
    adjustments: rec.adjustments.map((a) => ({ id: a.id, categoryCode: a.categoryCode, kind: a.kind, amount: money(Decimal.from(a.amount), mu), description: a.description, source: a.source, sourceRef: a.sourceRef })),
    taxDepreciation: { available: dep !== null, assets: dep ?? [] },
    totals: { bookNetIncome: money(rec.bookNetIncome, mu), taxableIncomeBeforeSpecialItems: money(rec.taxableBeforeSpecialItems, mu) },
    review: rec.review ? { status: rec.review.status, by: rec.review.reviewedByLabel, at: rec.review.createdAt.toISOString(), current: rec.reviewCurrent } : null,
    provenance: {
      application: "Gideon Books",
      applicationVersion: pkg.version,
      sourceHash: rec.dataHash,
      entryCount: rec.entryCount,
      lastEntryNumber: rec.lastEntryNumber,
    },
  };
  const contentHash = sha256(canonicalJson(body));
  return { ...body, provenance: { ...body.provenance, contentHash, generatedAt: generatedAt.toISOString(), generatedBy } };
}

function csvCell(v: string | number | null | boolean): string {
  const s = v === null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function packageCsv(p: ExportPackage): string {
  const rows: (string | number | null | boolean)[][] = [
    ["Gideon Books tax export", p.returnType, p.period.start, p.period.end, p.basis, p.organization.baseCurrency],
    ["content hash", p.provenance.contentHash, "mapping version", p.mapping.setVersion],
    [],
    ["section", "code", "line", "description", "kind", "book amount", "adjustments", "tax amount"],
    ...p.categories.map((c) => ["category", c.code, c.line, c.description, c.kind, c.bookAmount, c.adjustments, c.taxAmount]),
    [],
    ["section", "account code", "account name", "dimension", "category", "ledger amount (debit positive)", "confirmed"],
    ...p.accounts.map((a) => ["account", a.code, a.name, a.dimension, a.categoryCode, a.ledgerAmount, a.mappingConfirmed]),
    [],
    ["section", "category", "kind", "amount", "description", "source"],
    ...p.adjustments.map((a) => ["adjustment", a.categoryCode, a.kind, a.amount, a.description, a.source]),
    [],
    ["totals", "book net income", p.totals.bookNetIncome, "taxable income before special items", p.totals.taxableIncomeBeforeSpecialItems],
  ];
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export type TaxExport = typeof taxExports.$inferSelect;

/**
 * Generate (or return the identical existing) export package for a tax year,
 * locking the mapping version it used.
 */
export async function generateExport(ctx: Ctx, opts: { returnType: TaxReturnType; taxYearStart: string; taxYearEnd: string; basis: Basis }): Promise<{ export: TaxExport; reused: boolean; pkg: ExportPackage }> {
  requirePermission(ctx, "tax_export.manage");
  if (!isIsoDate(opts.taxYearStart) || !isIsoDate(opts.taxYearEnd) || opts.taxYearEnd < opts.taxYearStart) throw new ValidationError("Choose the tax year.");
  const db = getDb();
  const rec = await reconcile(db, ctx.org, opts);
  const pkgDoc = await buildPackage(db, ctx.org, rec, ctx.actor.label, new Date());
  const [existing] = await db
    .select()
    .from(taxExports)
    .where(and(eq(taxExports.orgId, ctx.orgId), eq(taxExports.contentHash, pkgDoc.provenance.contentHash)))
    .limit(1);
  if (existing) return { export: existing, reused: true, pkg: pkgDoc };
  const year = opts.taxYearEnd.slice(0, 4);
  const stem = `gideon-tax-export-${opts.returnType}-${year}-v${rec.version!.version}-${pkgDoc.provenance.contentHash.slice(0, 8)}`;
  const json = Buffer.from(JSON.stringify(pkgDoc, null, 2), "utf8");
  const csv = Buffer.from(packageCsv(pkgDoc), "utf8");
  const row = await withTransaction(async (tx) => {
    await lockVersion(tx, rec.version!.id);
    const [r] = await tx
      .insert(taxExports)
      .values({
        orgId: ctx.orgId,
        returnType: opts.returnType,
        versionId: rec.version!.id,
        periodStart: opts.taxYearStart,
        periodEnd: opts.taxYearEnd,
        basis: opts.basis,
        contentHash: pkgDoc.provenance.contentHash,
        sourceHash: rec.dataHash,
        entryCount: rec.entryCount,
        lastEntryNumber: rec.lastEntryNumber,
        unmappedCount: rec.unmapped.length,
        summary: { totals: pkgDoc.totals, categories: pkgDoc.categories.length, adjustments: pkgDoc.adjustments.length, reviewed: pkgDoc.review?.current ?? false },
        generatedBy: ctx.actor.userId,
        generatedByLabel: ctx.actor.label,
      })
      .returning();
    await audit(tx, ctx, {
      action: "tax_export.generated",
      entityType: "tax_export",
      entityId: r!.id,
      metadata: { returnType: opts.returnType, period: [opts.taxYearStart, opts.taxYearEnd], basis: opts.basis, version: rec.version!.version, contentHash: pkgDoc.provenance.contentHash, unmapped: rec.unmapped.length },
    });
    return r!;
  });
  const jsonAtt = await uploadAttachment(ctx, { entityType: "tax_export", entityId: row.id, fileName: `${stem}.json`, contentType: "application/json", bytes: json, origin: "generated" });
  const csvAtt = await uploadAttachment(ctx, { entityType: "tax_export", entityId: row.id, fileName: `${stem}.csv`, contentType: "text/csv", bytes: csv, origin: "generated" });
  const [updated] = await db.update(taxExports).set({ jsonAttachmentId: jsonAtt.id, csvAttachmentId: csvAtt.id }).where(eq(taxExports.id, row.id)).returning();
  return { export: updated!, reused: false, pkg: pkgDoc };
}

export async function listExports(db: DbOrTx, orgId: string, returnType?: TaxReturnType) {
  const conds = [eq(taxExports.orgId, orgId)];
  if (returnType) conds.push(eq(taxExports.returnType, returnType));
  const rows = await db
    .select({ e: taxExports, version: taxMappingVersions.version })
    .from(taxExports)
    .innerJoin(taxMappingVersions, and(eq(taxMappingVersions.orgId, taxExports.orgId), eq(taxMappingVersions.id, taxExports.versionId)))
    .where(and(...conds))
    .orderBy(desc(taxExports.createdAt))
    .limit(100);
  return rows.map((r) => ({ ...r.e, version: r.version }));
}
