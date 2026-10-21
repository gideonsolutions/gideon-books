/**
 * Deleting an organization: its owner only. A demonstration company goes at
 * once; a real organization only after its name is typed back and a
 * complete export exists (or the owner explicitly declines one). Every row
 * the organization owns and every stored file is removed in one transaction
 * — the one place the integrity triggers are bypassed (gideon.allow_purge),
 * and only for this organization's rows. An instance-level audit event
 * records who deleted what.
 */
import { and, eq } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db/client";
import { dataExports } from "@/lib/db/schema/ops";
import { auditInstance } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, ValidationError } from "@/lib/errors";
import { storage } from "@/lib/storage/storage";
import { log } from "@/lib/log";
import { describeOrgTables } from "./tables";

export async function hasCompletedExport(orgId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: dataExports.id })
    .from(dataExports)
    .where(and(eq(dataExports.orgId, orgId), eq(dataExports.kind, "export"), eq(dataExports.status, "completed")))
    .limit(1);
  return !!row;
}

export async function deleteOrganization(ctx: Ctx, input: { confirmName?: string | null; skipExport?: boolean; reason?: string | null }): Promise<{ deletedRows: number; deletedFiles: number }> {
  requirePermission(ctx, "org.delete");
  if (!ctx.org.isDemo) {
    if ((input.confirmName ?? "").trim() !== ctx.org.name) {
      throw new ValidationError(`Type the organization's name exactly (${ctx.org.name}) to confirm.`, { confirmName: "Does not match." });
    }
    if (!input.skipExport && !(await hasCompletedExport(ctx.orgId))) {
      throw new ConflictError("Download a complete export first, or tick the box that says you do not want one. Deleted books cannot be recovered.", "export_required");
    }
  }
  const client = await getPool().connect();
  let deletedRows = 0;
  let keys: string[] = [];
  try {
    await client.query("begin");
    await client.query("set local gideon.allow_purge = 'on'");
    const tables = await describeOrgTables(client);
    keys = [
      ...(await client.query<{ k: string }>("select storage_key as k from attachments where org_id = $1", [ctx.orgId])).rows.map((r) => r.k),
      ...(await client.query<{ k: string | null }>("select storage_key as k from data_exports where org_id = $1 and storage_key is not null", [ctx.orgId])).rows
        .map((r) => r.k)
        .filter((k): k is string => !!k),
    ];
    // Cyclic references first, then children before parents.
    for (const t of tables) {
      if (!t.deferredColumns.length || t.scope.kind !== "org_id") continue;
      await client.query(`update "${t.name}" set ${t.deferredColumns.map((c) => `"${c}" = null`).join(", ")} where org_id = $1`, [ctx.orgId]);
    }
    for (const t of [...tables].reverse()) {
      if (t.scope.kind === "org_id") {
        deletedRows += (await client.query(`delete from "${t.name}" where org_id = $1`, [ctx.orgId])).rowCount ?? 0;
      } else {
        const s = t.scope;
        deletedRows += (await client.query(`delete from "${t.name}" where "${s.column}" in (select "${s.parentColumn}" from "${s.parentTable}" where org_id = $1)`, [ctx.orgId])).rowCount ?? 0;
      }
    }
    // Anything else pointing at the organization row (memberships, subscriptions, group membership) cascades.
    deletedRows += (await client.query("delete from organizations where id = $1", [ctx.orgId])).rowCount ?? 0;
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  let deletedFiles = 0;
  for (const k of keys) {
    if (!k.startsWith(`orgs/${ctx.orgId}/`)) continue;
    try {
      await storage().delete(k);
      deletedFiles++;
    } catch (e) {
      log.warn("could not delete a stored file of a deleted organization", { key: k, error: (e as Error).message });
    }
  }
  await auditInstance(getDb(), {
    action: "organization.deleted",
    actorUserId: ctx.actor.userId,
    actorLabel: ctx.actor.label,
    entityType: "organization",
    entityId: ctx.orgId,
    reason: input.reason ?? null,
    metadata: { name: ctx.org.name, isDemo: ctx.org.isDemo, deletedRows, deletedFiles, exportSkipped: !!input.skipExport },
  });
  return { deletedRows, deletedFiles };
}
