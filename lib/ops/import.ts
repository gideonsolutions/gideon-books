/**
 * Import an organization export into a NEW organization (never into one
 * that already has books). Every file is checked against the manifest's
 * checksum first.
 *
 * Identifiers: every row id in the export is replaced by a fresh UUID, and
 * every reference to it — foreign keys, text columns holding an id, ids
 * inside JSON — is rewritten to match, so an export can be imported into the
 * same server it came from (a copy) or another one. Postings go through the
 * same database checks as live ones: entries are inserted as drafts with
 * their lines and then posted one by one, in their original order, keeping
 * their numbers and posting times; closed periods, the lock date, archived
 * accounts and document states are restored after the postings. Everything
 * happens in one transaction: an import either completes or leaves nothing.
 */
import { createHash, randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { eq } from "drizzle-orm";
import type pg from "pg";
import { getDb, getPool } from "@/lib/db/client";
import { dataExports } from "@/lib/db/schema/ops";
import { audit, auditInstance } from "@/lib/audit";
import { loadOrg, requirePermission, userCtx, type Ctx } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { storage } from "@/lib/storage/storage";
import { slugify } from "@/lib/orgs/orgs";
import { getUser } from "@/lib/auth/users";
import { EXCLUDED_TABLES, EXPORT_FORMAT, EXPORT_VERSION, type ExportManifest } from "./export";
import { describeOrgTables, orderSelfReferencing, type TableInfo } from "./tables";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export interface ParsedExport {
  manifest: ExportManifest;
  organization: Record<string, unknown>;
  tables: Map<string, Record<string, unknown>[]>;
  attachments: Map<string, Uint8Array>;
}

/** Unzip and verify an export against its manifest. */
export function parseExport(zip: Uint8Array): ParsedExport {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new ValidationError("That file is not a ZIP archive.");
  }
  const mf = files["manifest.json"];
  if (!mf) throw new ValidationError("That archive has no manifest.json; it is not a Gideon Books export.");
  const manifest = JSON.parse(strFromU8(mf)) as ExportManifest;
  if (manifest.format !== EXPORT_FORMAT) throw new ValidationError("That archive is not a Gideon Books organization export.");
  if (manifest.version > EXPORT_VERSION) throw new ValidationError(`That export is format version ${manifest.version}; this server reads up to ${EXPORT_VERSION}. Upgrade this server first.`);
  const orgBytes = files["organization.json"];
  if (!orgBytes) throw new ValidationError("The archive is missing organization.json.");
  const tables = new Map<string, Record<string, unknown>[]>();
  for (const t of manifest.tables) {
    const bytes = files[t.file];
    if (!bytes) throw new ValidationError(`The archive is missing ${t.file}.`);
    if (sha(bytes) !== t.sha256) throw new ValidationError(`${t.file} does not match its checksum; the archive is damaged or was altered.`);
    const text = strFromU8(bytes);
    const rows = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l, (_k, v) => (v && typeof v === "object" && typeof v.$base64 === "string" ? Buffer.from(v.$base64, "base64") : v)) as Record<string, unknown>);
    if (rows.length !== t.rows) throw new ValidationError(`${t.file} has ${rows.length} rows; the manifest says ${t.rows}.`);
    tables.set(t.name, rows);
  }
  const attachments = new Map<string, Uint8Array>();
  for (const a of manifest.attachments) {
    if (a.missing) continue;
    const bytes = files[a.file];
    if (!bytes) throw new ValidationError(`The archive is missing ${a.file}.`);
    if (sha(bytes) !== a.sha256) throw new ValidationError(`${a.file} does not match its checksum.`);
    attachments.set(a.id, bytes);
  }
  return { manifest, organization: JSON.parse(strFromU8(orgBytes)) as Record<string, unknown>, tables, attachments };
}

function remapValue(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === "string") return UUID_RE.test(v) && map.has(v.toLowerCase()) ? map.get(v.toLowerCase()) : v;
  if (Array.isArray(v)) return v.map((x) => remapValue(x, map));
  if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = remapValue(x, map);
    return out;
  }
  return v;
}

async function insertRows(client: pg.PoolClient, t: TableInfo, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = t.columns.filter((c) => !c.isSerial && rows.some((r) => c.name in r));
  const perRow = cols.length;
  const chunk = Math.max(1, Math.floor(60000 / Math.max(perRow, 1)));
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params: unknown[] = [];
    const values = slice
      .map((r) => {
        const ph = cols.map((c) => {
          let v = r[c.name] ?? null;
          if ((c.udt === "jsonb" || c.udt === "json") && v !== null) v = JSON.stringify(v);
          params.push(v);
          return `$${params.length}`;
        });
        return `(${ph.join(", ")})`;
      })
      .join(", ");
    await client.query(`insert into "${t.name}" (${cols.map((c) => `"${c.name}"`).join(", ")}) values ${values}`, params);
  }
}

/** Import an export into a new organization owned by `userId`. Returns the new organization's id and slug. */
export async function importOrganization(userId: string, zip: Uint8Array, opts: { name?: string | null } = {}): Promise<{ orgId: string; slug: string }> {
  const parsed = parseExport(zip);
  const user = await getUser(getDb(), userId);
  const client = await getPool().connect();
  const writtenKeys: string[] = [];
  try {
    await client.query("begin");
    const live = await describeOrgTables(client);
    const liveByName = new Map(live.map((t) => [t.name, t]));
    for (const name of parsed.tables.keys()) {
      const t = liveByName.get(name);
      if (!t) throw new ValidationError(`The export has a table (${name}) this server does not know. Upgrade this server before importing.`);
      const known = new Set(t.columns.map((c) => c.name));
      const sample = parsed.tables.get(name)![0];
      const unknown = sample ? Object.keys(sample).filter((k) => !known.has(k)) : [];
      if (unknown.length) throw new ValidationError(`The export's ${name} has columns this server does not know (${unknown.join(", ")}). Upgrade this server before importing.`);
    }

    // New identities for every row id, and the organization.
    const map = new Map<string, string>();
    const oldOrgId = String(parsed.organization.id).toLowerCase();
    const newOrgId = randomUUID();
    map.set(oldOrgId, newOrgId);
    for (const rows of parsed.tables.values()) {
      for (const r of rows) if (typeof r.id === "string" && UUID_RE.test(r.id)) map.set(r.id.toLowerCase(), randomUUID());
    }

    // The organization row, unlocked until its postings are in.
    const o = parsed.organization;
    const name = opts.name?.trim() || `${String(o.name)} (imported)`;
    let slug = slugify(name);
    for (let i = 2; (await client.query("select 1 from organizations where slug = $1", [slug])).rowCount; i++) slug = `${slugify(name).slice(0, 44)}-${i}`;
    await client.query(
      `insert into organizations (id, slug, name, legal_name, base_currency, country, timezone, fiscal_year_start_month, reporting_basis, books_start_date, lock_date, is_demo, entity_type, tax_rounding, bank_rules_auto_post, onboarding_completed_at, profile)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null,$11,$12,$13,$14,$15,$16)`,
      [
        newOrgId,
        slug,
        name,
        o.legal_name ?? null,
        o.base_currency,
        o.country ?? "US",
        o.timezone ?? "UTC",
        o.fiscal_year_start_month ?? 1,
        o.reporting_basis ?? "accrual",
        o.books_start_date ?? null,
        o.is_demo ?? false,
        o.entity_type ?? "other",
        o.tax_rounding ?? "line",
        false,
        o.onboarding_completed_at ?? null,
        JSON.stringify(remapValue(o.profile ?? {}, map)),
      ],
    );
    await client.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [newOrgId, userId]);

    const fixups = {
      entries: [] as { id: string; number: unknown; postedAt: unknown; postedBy: unknown }[],
      documents: [] as { id: string; status: unknown }[],
      periods: [] as { id: string; status: unknown; closedAt: unknown; closedBy: unknown }[],
      archived: [] as string[],
      deferred: [] as { table: string; id: string; values: Record<string, unknown> }[],
    };

    for (const t of live) {
      const rows0 = parsed.tables.get(t.name);
      if (!rows0 || EXCLUDED_TABLES[t.name]) continue;
      const uuidCols = new Set(t.columns.filter((c) => c.udt === "uuid").map((c) => c.name));
      const textCols = new Set(t.columns.filter((c) => c.udt === "text" || c.udt === "varchar").map((c) => c.name));
      const jsonCols = new Set(t.columns.filter((c) => c.udt === "jsonb" || c.udt === "json").map((c) => c.name));
      let rows = rows0.map((r) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (k === "org_id") out[k] = newOrgId;
          else if (uuidCols.has(k) || textCols.has(k) || jsonCols.has(k)) out[k] = remapValue(v, map);
          else out[k] = v;
        }
        return out;
      });
      rows = orderSelfReferencing(t, rows);
      // Rows go in the way live ones would, then are brought to their exported state below.
      if (t.name === "journal_entries") {
        rows = rows.map((r) => {
          if (r.status === "posted") {
            fixups.entries.push({ id: String(r.id), number: r.entry_number, postedAt: r.posted_at, postedBy: r.posted_by });
            return { ...r, status: "draft", entry_number: null, posted_at: null, posted_by: null };
          }
          return r;
        });
      }
      if (t.name === "documents") {
        rows = rows.map((r) => {
          fixups.documents.push({ id: String(r.id), status: r.status });
          return { ...r, status: "draft" };
        });
      }
      if (t.name === "fiscal_periods") {
        rows = rows.map((r) => {
          fixups.periods.push({ id: String(r.id), status: r.status, closedAt: r.closed_at, closedBy: r.closed_by });
          return { ...r, status: "open", closed_at: null, closed_by: null };
        });
      }
      if (t.name === "accounts") {
        rows = rows.map((r) => {
          if (r.is_archived) fixups.archived.push(String(r.id));
          return { ...r, is_archived: false };
        });
      }
      if (t.name === "attachments") {
        rows = rows.map((r) => ({ ...r, storage_key: `orgs/${newOrgId}/attachments/${r.id}` }));
      }
      if (t.deferredColumns.length) {
        rows = rows.map((r) => {
          const values: Record<string, unknown> = {};
          const out = { ...r };
          for (const c of t.deferredColumns) {
            if (out[c] != null) values[c] = out[c];
            out[c] = null;
          }
          if (Object.keys(values).length) fixups.deferred.push({ table: t.name, id: String(r.id), values });
          return out;
        });
      }
      await insertRows(client, t, rows);
    }

    for (const d of fixups.deferred) {
      const cols = Object.keys(d.values);
      await client.query(`update "${d.table}" set ${cols.map((c, i) => `"${c}" = $${i + 2}`).join(", ")} where id = $1`, [d.id, ...cols.map((c) => d.values[c])]);
    }
    // Post the entries in their original order; the posting trigger re-checks each one.
    fixups.entries.sort((a, b) => Number(a.number) - Number(b.number));
    for (const e of fixups.entries) {
      await client.query(`update journal_entries set status = 'posted', entry_number = $2, posted_at = $3, posted_by = $4 where id = $1`, [e.id, e.number, e.postedAt, e.postedBy]);
    }
    for (const d of fixups.documents) if (d.status !== "draft") await client.query(`update documents set status = $2 where id = $1`, [d.id, d.status]);
    for (const p of fixups.periods) if (p.status !== "open") await client.query(`update fiscal_periods set status = $2, closed_at = $3, closed_by = $4 where id = $1`, [p.id, p.status, p.closedAt, p.closedBy]);
    if (fixups.archived.length) await client.query(`update accounts set is_archived = true where id = any($1::uuid[])`, [fixups.archived]);
    await client.query(`update organizations set lock_date = $2, bank_rules_auto_post = $3 where id = $1`, [newOrgId, o.lock_date ?? null, o.bank_rules_auto_post ?? false]);

    // Attachment bytes, under the new organization's keys.
    for (const r of parsed.tables.get("attachments") ?? []) {
      const bytes = parsed.attachments.get(String(r.id));
      if (!bytes) continue;
      const key = `orgs/${newOrgId}/attachments/${map.get(String(r.id).toLowerCase())}`;
      await storage().put(key, Buffer.from(bytes), String(r.content_type));
      writtenKeys.push(key);
    }
    await client.query("commit");
    const newOrg = await loadOrg(getDb(), newOrgId);
    await audit(getDb(), userCtx(newOrg, userId, "owner", user.email, "import"), {
      action: "data.imported",
      entityType: "organization",
      entityId: newOrgId,
      metadata: { sourceOrganization: parsed.manifest.organization, exportedAt: parsed.manifest.exportedAt, schemaMigration: parsed.manifest.schemaMigration, tables: parsed.manifest.tables.length },
    });
    return { orgId: newOrgId, slug };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    for (const k of writtenKeys) await storage().delete(k).catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Upload an export to import as a new organization; the import runs as a job. */
export async function requestImport(ctx: Ctx, bytes: Buffer, name?: string | null) {
  requirePermission(ctx, "data.import");
  parseExport(new Uint8Array(bytes)); // fail fast on a damaged or foreign file
  const db = getDb();
  const [row] = await db.insert(dataExports).values({ orgId: ctx.orgId, kind: "import", status: "queued", createdBy: ctx.actor.userId, fileName: name ?? null }).returning();
  const key = `orgs/${ctx.orgId}/imports/${row!.id}.zip`;
  await storage().put(key, bytes, "application/zip");
  const job = await enqueue(db, "ops.import_org", { importId: row!.id }, { orgId: ctx.orgId, createdBy: ctx.actor.userId, maxAttempts: 1 });
  await db.update(dataExports).set({ jobId: job.id, storageKey: key, sizeBytes: bytes.length, sha256: sha(bytes) }).where(eq(dataExports.id, row!.id));
  await audit(db, ctx, { action: "data.import_requested", entityType: "data_export", entityId: row!.id });
  return row!;
}

export async function runImport(importId: string) {
  const db = getDb();
  const [row] = await db.select().from(dataExports).where(eq(dataExports.id, importId));
  if (!row || row.kind !== "import") return { skipped: "missing" };
  if (row.status === "completed") return { skipped: "completed", orgId: row.resultOrgId };
  if (!row.createdBy || !row.storageKey) throw new Error("import without requester or file");
  await db.update(dataExports).set({ status: "running" }).where(eq(dataExports.id, importId));
  try {
    const bytes = await storage().get(row.storageKey);
    const r = await importOrganization(row.createdBy, new Uint8Array(bytes), { name: row.fileName });
    await db.update(dataExports).set({ status: "completed", resultOrgId: r.orgId, completedAt: new Date(), error: null }).where(eq(dataExports.id, importId));
    await auditInstance(db, { action: "organization.imported", actorUserId: row.createdBy, actorLabel: "job: data import", entityType: "organization", entityId: r.orgId, source: "system" });
    return r;
  } catch (e) {
    await db.update(dataExports).set({ status: "failed", error: (e as Error).message.slice(0, 1000) }).where(eq(dataExports.id, importId));
    throw e;
  }
}
