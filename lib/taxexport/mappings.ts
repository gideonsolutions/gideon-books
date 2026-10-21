/**
 * Versioned mappings from accounts (optionally account + dimension value) to
 * tax-return categories, and the organization's custom categories.
 *
 * A mapping set has versions. The current version is edited in place until an
 * export uses it; from then on it is locked, and the next change starts a new
 * version (a copy), so every export names exactly the mappings it used.
 */
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { taxCustomCategories, taxMappings, taxMappingSets, taxMappingVersions, TAX_RETURN_TYPES, type TaxReturnType } from "@/lib/db/schema/taxexport";
import { accounts } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError, ConflictError } from "@/lib/errors";
import { catalogFor, categoriesFor, suggestCategory, type CategoryKind, type TaxCategory } from "./catalogs";

export type MappingSet = typeof taxMappingSets.$inferSelect;
export type MappingVersion = typeof taxMappingVersions.$inferSelect;
export type Mapping = typeof taxMappings.$inferSelect;
export type DimensionKind = "project" | "class" | "department" | "location" | "fund";

export function assertReturnType(rt: string): TaxReturnType {
  if (!(TAX_RETURN_TYPES as readonly string[]).includes(rt)) throw new ValidationError("Unknown return type.", { returnType: "Choose a return type." });
  return rt as TaxReturnType;
}

export async function customCategories(db: DbOrTx, orgId: string, returnType: TaxReturnType): Promise<TaxCategory[]> {
  const rows = await db
    .select()
    .from(taxCustomCategories)
    .where(and(eq(taxCustomCategories.orgId, orgId), eq(taxCustomCategories.returnType, returnType)))
    .orderBy(asc(taxCustomCategories.code));
  return rows.map((r) => ({ code: r.code, line: null, description: r.description, kind: r.kind as CategoryKind, origin: "custom" as const }));
}

export async function allCategories(db: DbOrTx, orgId: string, returnType: TaxReturnType): Promise<TaxCategory[]> {
  return categoriesFor(returnType, await customCategories(db, orgId, returnType));
}

export async function addCustomCategory(ctx: Ctx, input: { returnType: TaxReturnType; code: string; description: string; kind: CategoryKind }) {
  requirePermission(ctx, "tax_export.manage");
  const code = input.code.trim().toUpperCase();
  const fields: Record<string, string> = {};
  if (!/^[A-Z0-9][A-Z0-9_.-]{0,31}$/.test(code)) fields.code = "Use letters, digits, dots, dashes or underscores.";
  if (code.startsWith("L") && /^L\d/.test(code)) fields.code = "Codes starting with L and a digit are reserved for form lines.";
  if (code.startsWith("BK_")) fields.code = "Codes starting with BK_ are reserved.";
  if (!input.description?.trim()) fields.description = "Describe the category.";
  if (Object.keys(fields).length) throw new ValidationError("Check the category.", fields);
  return withTransaction(async (tx) => {
    const [existing] = await tx
      .select({ id: taxCustomCategories.id })
      .from(taxCustomCategories)
      .where(and(eq(taxCustomCategories.orgId, ctx.orgId), eq(taxCustomCategories.returnType, input.returnType), eq(taxCustomCategories.code, code)));
    if (existing) throw new ConflictError("A category with that code exists.", "duplicate");
    const [row] = await tx
      .insert(taxCustomCategories)
      .values({ orgId: ctx.orgId, returnType: input.returnType, code, description: input.description.trim(), kind: input.kind, createdBy: ctx.actor.userId })
      .returning();
    await audit(tx, ctx, { action: "tax_export.category_added", entityType: "tax_category", entityId: row!.id, after: row });
    return row!;
  });
}

/** The mapping set for a return type, created on first use with version 1. */
export async function ensureSet(tx: Tx, ctx: Ctx, returnType: TaxReturnType): Promise<{ set: MappingSet; version: MappingVersion }> {
  await tx
    .insert(taxMappingSets)
    .values({ orgId: ctx.orgId, returnType, catalogTaxYear: catalogFor(returnType).taxYear, createdBy: ctx.actor.userId })
    .onConflictDoNothing();
  const [set] = await tx.select().from(taxMappingSets).where(and(eq(taxMappingSets.orgId, ctx.orgId), eq(taxMappingSets.returnType, returnType))).for("update");
  let version = await currentVersion(tx, ctx.orgId, set!.id);
  if (!version) {
    [version] = (await tx.insert(taxMappingVersions).values({ orgId: ctx.orgId, setId: set!.id, version: 1, createdBy: ctx.actor.userId }).returning()) as [MappingVersion];
  }
  return { set: set!, version };
}

export async function findSet(db: DbOrTx, orgId: string, returnType: TaxReturnType): Promise<MappingSet | null> {
  const [set] = await db.select().from(taxMappingSets).where(and(eq(taxMappingSets.orgId, orgId), eq(taxMappingSets.returnType, returnType)));
  return set ?? null;
}

export async function currentVersion(db: DbOrTx, orgId: string, setId: string): Promise<MappingVersion | null> {
  const [v] = await db
    .select()
    .from(taxMappingVersions)
    .where(and(eq(taxMappingVersions.orgId, orgId), eq(taxMappingVersions.setId, setId)))
    .orderBy(desc(taxMappingVersions.version))
    .limit(1);
  return v ?? null;
}

export async function listVersions(db: DbOrTx, orgId: string, setId: string) {
  return db.select().from(taxMappingVersions).where(and(eq(taxMappingVersions.orgId, orgId), eq(taxMappingVersions.setId, setId))).orderBy(desc(taxMappingVersions.version));
}

export async function mappingsOf(db: DbOrTx, orgId: string, versionId: string): Promise<Mapping[]> {
  return db.select().from(taxMappings).where(and(eq(taxMappings.orgId, orgId), eq(taxMappings.versionId, versionId)));
}

/** The version to edit: the current one if unlocked, otherwise a new copy of it. */
async function editableVersion(tx: Tx, ctx: Ctx, returnType: TaxReturnType, note?: string): Promise<MappingVersion> {
  const { set, version } = await ensureSet(tx, ctx, returnType);
  if (!version.lockedAt) return version;
  const [next] = await tx
    .insert(taxMappingVersions)
    .values({ orgId: ctx.orgId, setId: set.id, version: version.version + 1, note: note ?? `Changed after version ${version.version} was exported`, createdBy: ctx.actor.userId })
    .returning();
  const rows = await mappingsOf(tx, ctx.orgId, version.id);
  if (rows.length) {
    await tx.insert(taxMappings).values(
      rows.map((r) => ({
        orgId: ctx.orgId,
        versionId: next!.id,
        accountId: r.accountId,
        dimensionKind: r.dimensionKind,
        dimensionValueId: r.dimensionValueId,
        dimensionKey: r.dimensionKey,
        categoryCode: r.categoryCode,
        confirmed: r.confirmed,
        confirmedBy: r.confirmedBy,
        confirmedAt: r.confirmedAt,
      })),
    );
  }
  await audit(tx, ctx, { action: "tax_export.mapping_version_created", entityType: "tax_mapping_version", entityId: next!.id, metadata: { returnType, version: next!.version, from: version.version } });
  return next!;
}

export interface MappingChange {
  accountId: string;
  dimensionKind?: DimensionKind | null;
  dimensionValueId?: string | null;
  /** null removes the mapping. */
  categoryCode: string | null;
  /** The person has checked this mapping. */
  confirm?: boolean;
}

export async function saveMappings(ctx: Ctx, returnType: TaxReturnType, changes: MappingChange[]): Promise<MappingVersion> {
  requirePermission(ctx, "tax_export.manage");
  return withTransaction(async (tx) => {
    const cats = new Set((await allCategories(tx, ctx.orgId, returnType)).map((c) => c.code));
    const fields: Record<string, string> = {};
    for (const c of changes) {
      if (c.categoryCode && !cats.has(c.categoryCode)) fields[`map.${c.accountId}`] = `Unknown category ${c.categoryCode}.`;
      if (!!c.dimensionKind !== !!c.dimensionValueId) fields[`map.${c.accountId}`] = "A dimension mapping needs both the dimension and its value.";
    }
    if (Object.keys(fields).length) throw new ValidationError("Check the mappings.", fields);
    const accIds = [...new Set(changes.map((c) => c.accountId))];
    if (accIds.length) {
      const own = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.orgId, ctx.orgId));
      const ownSet = new Set(own.map((a) => a.id));
      if (accIds.some((id) => !ownSet.has(id))) throw new ValidationError("A mapping names an account outside this organization.");
    }
    const version = await editableVersion(tx, ctx, returnType);
    let changed = 0;
    for (const c of changes) {
      const dimensionKey = c.dimensionKind && c.dimensionValueId ? `${c.dimensionKind}:${c.dimensionValueId}` : "";
      const [existing] = await tx
        .select()
        .from(taxMappings)
        .where(and(eq(taxMappings.versionId, version.id), eq(taxMappings.accountId, c.accountId), eq(taxMappings.dimensionKey, dimensionKey)));
      if (!c.categoryCode) {
        if (existing) {
          await tx.delete(taxMappings).where(eq(taxMappings.id, existing.id));
          changed++;
        }
        continue;
      }
      const confirmed = c.confirm ?? existing?.confirmed ?? false;
      if (existing && existing.categoryCode === c.categoryCode && existing.confirmed === confirmed) continue;
      if (existing) {
        await tx
          .update(taxMappings)
          .set({ categoryCode: c.categoryCode, confirmed, confirmedBy: confirmed ? ctx.actor.userId : null, confirmedAt: confirmed ? new Date() : null })
          .where(eq(taxMappings.id, existing.id));
      } else {
        await tx.insert(taxMappings).values({
          orgId: ctx.orgId,
          versionId: version.id,
          accountId: c.accountId,
          dimensionKind: c.dimensionKind ?? null,
          dimensionValueId: c.dimensionValueId ?? null,
          dimensionKey,
          categoryCode: c.categoryCode,
          confirmed,
          confirmedBy: confirmed ? ctx.actor.userId : null,
          confirmedAt: confirmed ? new Date() : null,
        });
      }
      changed++;
    }
    if (changed) await audit(tx, ctx, { action: "tax_export.mappings_saved", entityType: "tax_mapping_version", entityId: version.id, metadata: { returnType, version: version.version, changes: changed } });
    return version;
  });
}

/**
 * Fill in suggestions for income and expense accounts that have no mapping.
 * Suggestions are unconfirmed until a person confirms them.
 */
export async function suggestMappings(ctx: Ctx, returnType: TaxReturnType): Promise<number> {
  requirePermission(ctx, "tax_export.manage");
  return withTransaction(async (tx) => {
    const version = await editableVersion(tx, ctx, returnType);
    const existing = new Set((await mappingsOf(tx, ctx.orgId, version.id)).filter((m) => !m.dimensionKey).map((m) => m.accountId));
    const accs = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId))).orderBy(asc(accounts.code));
    const rows = accs
      .filter((a) => (a.type === "income" || a.type === "expense") && !existing.has(a.id))
      .map((a) => ({ a, code: suggestCategory(returnType, a) }))
      .filter((x): x is { a: (typeof accs)[number]; code: string } => !!x.code);
    if (rows.length) {
      await tx.insert(taxMappings).values(rows.map(({ a, code }) => ({ orgId: ctx.orgId, versionId: version.id, accountId: a.id, dimensionKey: "", categoryCode: code, confirmed: false })));
      await audit(tx, ctx, { action: "tax_export.mappings_suggested", entityType: "tax_mapping_version", entityId: version.id, metadata: { returnType, suggested: rows.length } });
    }
    return rows.length;
  });
}

/** Confirm every unconfirmed mapping in the current version. */
export async function confirmAllMappings(ctx: Ctx, returnType: TaxReturnType): Promise<number> {
  requirePermission(ctx, "tax_export.manage");
  return withTransaction(async (tx) => {
    const version = await editableVersion(tx, ctx, returnType);
    const res = await tx
      .update(taxMappings)
      .set({ confirmed: true, confirmedBy: ctx.actor.userId, confirmedAt: new Date() })
      .where(and(eq(taxMappings.versionId, version.id), eq(taxMappings.confirmed, false)))
      .returning({ id: taxMappings.id });
    if (res.length) await audit(tx, ctx, { action: "tax_export.mappings_confirmed", entityType: "tax_mapping_version", entityId: version.id, metadata: { returnType, confirmed: res.length } });
    return res.length;
  });
}

/** Lock a version (an export used it). */
export async function lockVersion(tx: Tx, versionId: string) {
  await tx.update(taxMappingVersions).set({ lockedAt: new Date() }).where(and(eq(taxMappingVersions.id, versionId), isNull(taxMappingVersions.lockedAt)));
}

export async function getVersion(db: DbOrTx, orgId: string, versionId: string): Promise<MappingVersion> {
  const [v] = await db.select().from(taxMappingVersions).where(and(eq(taxMappingVersions.orgId, orgId), eq(taxMappingVersions.id, versionId)));
  if (!v) throw new NotFoundError("The mapping version");
  return v;
}
