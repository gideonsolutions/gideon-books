/** Classes, departments, locations and funds: the line-level dimensions. */
import { and, asc, eq } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { dimensionValues } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";

export type DimensionValue = typeof dimensionValues.$inferSelect;
export type DimensionKind = DimensionValue["kind"];

export const DIMENSION_LABELS: Record<DimensionKind, string> = { class: "Class", department: "Department", location: "Location", fund: "Fund" };

export interface DimensionInput {
  kind: DimensionKind;
  name: string;
  code?: string | null;
  parentId?: string | null;
  restriction?: DimensionValue["restriction"];
  isArchived?: boolean;
}

function validate(input: DimensionInput) {
  const fields: Record<string, string> = {};
  if (!["class", "department", "location", "fund"].includes(input.kind)) fields.kind = "Choose a kind.";
  if (!input.name?.trim()) fields.name = "Enter a name.";
  if (input.kind === "fund" && !input.restriction) fields.restriction = "Say whether the fund carries a donor restriction.";
  if (Object.keys(fields).length) throw new ValidationError("Check the dimension.", fields);
}

export async function listDimensions(db: DbOrTx, orgId: string, kind?: DimensionKind, opts: { includeArchived?: boolean } = {}) {
  const conds = [eq(dimensionValues.orgId, orgId)];
  if (kind) conds.push(eq(dimensionValues.kind, kind));
  if (!opts.includeArchived) conds.push(eq(dimensionValues.isArchived, false));
  return db.select().from(dimensionValues).where(and(...conds)).orderBy(asc(dimensionValues.kind), asc(dimensionValues.name));
}

export async function createDimension(ctx: Ctx, input: DimensionInput): Promise<DimensionValue> {
  requirePermission(ctx, "accounts.manage");
  validate(input);
  return withTransaction(async (tx) => {
    const [clash] = await tx
      .select({ id: dimensionValues.id })
      .from(dimensionValues)
      .where(and(eq(dimensionValues.orgId, ctx.orgId), eq(dimensionValues.kind, input.kind), eq(dimensionValues.name, input.name.trim())));
    if (clash) throw new ConflictError(`A ${input.kind} named “${input.name.trim()}” exists.`, "duplicate");
    const [row] = await tx
      .insert(dimensionValues)
      .values({
        orgId: ctx.orgId,
        kind: input.kind,
        name: input.name.trim(),
        code: input.code?.trim() || null,
        parentId: input.parentId || null,
        restriction: input.kind === "fund" ? (input.restriction ?? "without_donor_restrictions") : null,
      })
      .returning();
    await audit(tx, ctx, { action: "dimension.created", entityType: "dimension", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateDimension(ctx: Ctx, id: string, input: DimensionInput): Promise<DimensionValue> {
  requirePermission(ctx, "accounts.manage");
  validate(input);
  return withTransaction(async (tx) => {
    const [before] = await tx.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, ctx.orgId), eq(dimensionValues.id, id)));
    if (!before) throw new NotFoundError("The dimension");
    if (before.kind !== input.kind) throw new ConflictError("A dimension's kind cannot change.", "kind_fixed");
    if (input.parentId === id) throw new ValidationError("A value cannot be its own parent.", { parentId: "Pick another." });
    const [row] = await tx
      .update(dimensionValues)
      .set({
        name: input.name.trim(),
        code: input.code?.trim() || null,
        parentId: input.parentId || null,
        restriction: before.kind === "fund" ? (input.restriction ?? before.restriction) : null,
        isArchived: input.isArchived ?? before.isArchived,
      })
      .where(eq(dimensionValues.id, id))
      .returning();
    await audit(tx, ctx, { action: "dimension.updated", entityType: "dimension", entityId: id, before, after: row });
    return row!;
  });
}
