/**
 * Complete data export of one organization (docs/data-export-format.md): a
 * ZIP with every organization-scoped table as JSON Lines, every attachment's
 * bytes, and a manifest with row counts and SHA-256 checksums. Read from one
 * consistent snapshot. Provider secrets are not exported (connections come
 * out disconnected), nor are access grants (members, invitations, API
 * tokens) or operational state (jobs, idempotency keys, metering).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { strToU8, zipSync, type Zippable } from "fflate";
import { and, desc, eq } from "drizzle-orm";
import { getDb, getPool } from "@/lib/db/client";
import { dataExports } from "@/lib/db/schema/ops";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { NotFoundError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { storage } from "@/lib/storage/storage";
import { describeOrgTables, orderByFor, type TableInfo } from "./tables";

export const EXPORT_FORMAT = "gideon-books-organization-export";
export const EXPORT_VERSION = 1;

/** Organization-scoped tables deliberately left out, and why. */
export const EXCLUDED_TABLES: Record<string, string> = {
  memberships: "Access grants belong to people on the source server; the importer becomes the owner.",
  invitations: "Pending invitations are tied to the source server.",
  api_tokens: "Credentials are never exported.",
  jobs: "Operational queue state.",
  idempotency_keys: "Operational retry state.",
  usage_events: "Hosted-service metering of the source server.",
  subscriptions: "Hosted-service billing of the source server.",
  data_exports: "Records of exports themselves.",
  webhook_events: "Replay protection for the source server's provider connections.",
  entity_group_members: "Entity groups span several organizations and are not part of one organization's books.",
  group_account_mappings: "Belongs to an entity group.",
  intercompany_pairs: "Belongs to an entity group.",
  sessions: "Sign-in sessions.",
};

export interface ExportManifest {
  format: string;
  version: number;
  exportedAt: string;
  appVersion: string;
  schemaMigration: string;
  organization: { id: string; name: string; slug: string; baseCurrency: string };
  tables: { name: string; file: string; rows: number; sha256: string }[];
  attachments: { id: string; file: string; size: number; sha256: string; missing?: boolean }[];
  excludedTables: Record<string, string>;
  notes: string[];
}

export function currentSchemaMigration(): string {
  try {
    const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "lib/db/migrations/meta/_journal.json"), "utf8")) as { entries: { tag: string }[] };
    return journal.entries[journal.entries.length - 1]?.tag ?? "unknown";
  } catch {
    return "unknown";
  }
}

function appVersion(): string {
  try {
    return (JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Serialize a row: dates as ISO strings, everything else as the driver returned it (numerics are already strings). */
function rowJson(row: Record<string, unknown>): string {
  return JSON.stringify(row, (_k, v) => (Buffer.isBuffer(v) ? { $base64: v.toString("base64") } : v));
}

export async function selectOrgRows(client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, t: TableInfo, orgId: string) {
  if (t.scope.kind === "org_id") {
    return (await client.query(`select * from "${t.name}" where org_id = $1 order by ${orderByFor(t)}`, [orgId])).rows;
  }
  const s = t.scope;
  return (
    await client.query(
      `select c.* from "${t.name}" c where c."${s.column}" in (select "${s.parentColumn}" from "${s.parentTable}" where org_id = $1) order by ${orderByFor(t)
        .split(", ")
        .map((x) => `c.${x}`)
        .join(", ")}`,
      [orgId],
    )
  ).rows;
}

/** Build the export ZIP for an organization. */
export async function buildOrgExport(orgId: string): Promise<{ zip: Uint8Array; manifest: ExportManifest }> {
  const client = await getPool().connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const orgRes = await client.query("select * from organizations where id = $1", [orgId]);
    const org = orgRes.rows[0] as Record<string, unknown> | undefined;
    if (!org) throw new NotFoundError("The organization");
    const tables = (await describeOrgTables(client)).filter((t) => !EXCLUDED_TABLES[t.name]);
    const files: Zippable = {};
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      appVersion: appVersion(),
      schemaMigration: currentSchemaMigration(),
      organization: { id: orgId, name: String(org.name), slug: String(org.slug), baseCurrency: String(org.base_currency) },
      tables: [],
      attachments: [],
      excludedTables: EXCLUDED_TABLES,
      notes: [
        "Each tables/<name>.jsonl line is one row, keyed by column name, exactly as stored. Amounts are decimal strings; dates are YYYY-MM-DD; timestamps are ISO 8601 UTC.",
        "integration_connections rows have their encrypted secrets removed and are marked disconnected.",
      ],
    };
    const orgBytes = strToU8(rowJson(org));
    files["organization.json"] = orgBytes;
    let attachmentRows: Record<string, unknown>[] = [];
    for (const t of tables) {
      let rows = await selectOrgRows(client, t, orgId);
      if (t.name === "integration_connections") rows = rows.map((r) => ({ ...r, secret_enc: null, status: "disconnected" }));
      if (t.name === "attachments") attachmentRows = rows;
      const text = rows.map(rowJson).join("\n") + (rows.length ? "\n" : "");
      const bytes = strToU8(text);
      const file = `tables/${t.name}.jsonl`;
      files[file] = bytes;
      manifest.tables.push({ name: t.name, file, rows: rows.length, sha256: sha(bytes) });
    }
    await client.query("commit");
    for (const a of attachmentRows) {
      const file = `attachments/${a.id}`;
      try {
        const bytes = new Uint8Array(await storage().get(String(a.storage_key)));
        files[file] = [bytes, { level: 0 }];
        manifest.attachments.push({ id: String(a.id), file, size: bytes.length, sha256: sha(bytes) });
      } catch {
        manifest.attachments.push({ id: String(a.id), file, size: 0, sha256: "", missing: true });
      }
    }
    files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
    files["README.txt"] = strToU8(
      `Gideon Books export of "${manifest.organization.name}" taken ${manifest.exportedAt}.\n` +
        `Format ${EXPORT_FORMAT} v${EXPORT_VERSION}; schema ${manifest.schemaMigration}.\n` +
        `See docs/data-export-format.md in the Gideon Books source for the layout.\n`,
    );
    return { zip: zipSync(files, { level: 6 }), manifest };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Ask for an export; it is built by a background job. */
export async function requestExport(ctx: Ctx) {
  requirePermission(ctx, "data.export");
  const db = getDb();
  const [row] = await db.insert(dataExports).values({ orgId: ctx.orgId, kind: "export", status: "queued", createdBy: ctx.actor.userId }).returning();
  const job = await enqueue(db, "ops.export_org", { exportId: row!.id }, { orgId: ctx.orgId, createdBy: ctx.actor.userId, maxAttempts: 3 });
  await db.update(dataExports).set({ jobId: job.id }).where(eq(dataExports.id, row!.id));
  await audit(db, ctx, { action: "data.export_requested", entityType: "data_export", entityId: row!.id });
  return row!;
}

/** The job: build, store, record. */
export async function runExport(exportId: string) {
  const db = getDb();
  const [row] = await db.select().from(dataExports).where(eq(dataExports.id, exportId));
  if (!row) return { skipped: "missing" };
  if (row.status === "completed") return { skipped: "completed" };
  await db.update(dataExports).set({ status: "running" }).where(eq(dataExports.id, exportId));
  try {
    const { zip, manifest } = await buildOrgExport(row.orgId);
    const key = `orgs/${row.orgId}/exports/${exportId}.zip`;
    await storage().put(key, Buffer.from(zip), "application/zip");
    const day = manifest.exportedAt.slice(0, 10);
    await db
      .update(dataExports)
      .set({
        status: "completed",
        storageKey: key,
        fileName: `${manifest.organization.slug}-export-${day}.zip`,
        sizeBytes: zip.length,
        sha256: sha(zip),
        manifest: manifest as never,
        completedAt: new Date(),
        error: null,
      })
      .where(eq(dataExports.id, exportId));
    const ctx = await systemCtx(row.orgId, "job: data export");
    await audit(db, ctx, { action: "data.exported", entityType: "data_export", entityId: exportId, metadata: { size: zip.length, tables: manifest.tables.length, attachments: manifest.attachments.length } });
    return { size: zip.length };
  } catch (e) {
    await db.update(dataExports).set({ status: "failed", error: (e as Error).message.slice(0, 1000) }).where(eq(dataExports.id, exportId));
    throw e;
  }
}

export async function listDataJobs(orgId: string) {
  return getDb().select().from(dataExports).where(eq(dataExports.orgId, orgId)).orderBy(desc(dataExports.createdAt)).limit(50);
}

export async function readExport(ctx: Ctx, exportId: string) {
  requirePermission(ctx, "data.export");
  const [row] = await getDb()
    .select()
    .from(dataExports)
    .where(and(eq(dataExports.orgId, ctx.orgId), eq(dataExports.id, exportId), eq(dataExports.kind, "export")));
  if (!row || row.status !== "completed" || !row.storageKey) throw new NotFoundError("The export");
  if (!row.storageKey.startsWith(`orgs/${ctx.orgId}/`)) throw new NotFoundError("The export");
  const bytes = await storage().get(row.storageKey);
  await audit(getDb(), ctx, { action: "data.export_downloaded", entityType: "data_export", entityId: exportId });
  return { row, bytes };
}
