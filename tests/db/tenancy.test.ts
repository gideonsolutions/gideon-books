/**
 * Structural guarantees of the schema, checked against the migrated database:
 * every organization-owned table carries org_id, and every foreign key from
 * one organization-owned table to another includes org_id — so the database
 * itself refuses a row that points into another organization.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

/** Tables that are not organization-owned (people, sessions, instance settings, shared rate limits, entity groups spanning organizations). */
const GLOBAL = new Set([
  "users",
  "sessions",
  "user_tokens",
  "auth_throttle",
  "organizations",
  "instance_settings",
  "__drizzle_migrations",
  "email_events",
]);
/**
 * Entity-group tables belong to a group of organizations, not to one; every
 * reference they make into a member's books is a composite foreign key on
 * that member's (org_id, id), and access is checked against every member.
 */
const GROUP_SCOPED = new Set(["entity_groups", "entity_group_members", "group_accounts", "group_account_mappings", "group_rates", "group_audit_events", "intercompany_pairs", "elimination_entries", "elimination_lines"]);
/** Tables whose org_id may be null (instance-level rows, or group-level lines), still scoped when set. */
const NULLABLE_ORG = new Set(["audit_events", "jobs", "email_messages", "webhook_events", "elimination_lines"]);

describe("tenancy", () => {
  it("every table except the global ones has an org_id column", async () => {
    const r = await getDb().execute<{ table_name: string; has_org: boolean }>(sql`
      select t.table_name, exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = t.table_name and c.column_name = 'org_id') as has_org
      from information_schema.tables t where t.table_schema = 'public' and t.table_type = 'BASE TABLE'`);
    const missing = r.rows.filter((x) => !x.has_org && !GLOBAL.has(x.table_name) && !GROUP_SCOPED.has(x.table_name)).map((x) => x.table_name);
    expect(missing).toEqual([]);
  });

  it("org_id is required wherever it is not explicitly instance-level", async () => {
    const r = await getDb().execute<{ table_name: string; is_nullable: string }>(sql`
      select table_name, is_nullable from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`);
    const nullable = r.rows.filter((x) => x.is_nullable === "YES" && !NULLABLE_ORG.has(x.table_name)).map((x) => x.table_name);
    expect(nullable).toEqual([]);
  });

  it("every foreign key between organization-owned tables includes org_id", async () => {
    const r = await getDb().execute<{ constraint_name: string; table_name: string; foreign_table: string; columns: string[] }>(sql`
      select con.conname as constraint_name, src.relname as table_name, dst.relname as foreign_table,
             array(select att.attname from unnest(con.conkey) k join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k)::text[] as columns
      from pg_constraint con
      join pg_class src on src.oid = con.conrelid
      join pg_class dst on dst.oid = con.confrelid
      join pg_namespace n on n.oid = src.relnamespace
      where con.contype = 'f' and n.nspname = 'public'`);
    const orgOwned = await getDb().execute<{ table_name: string }>(sql`
      select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`);
    const owned = new Set(orgOwned.rows.map((x) => x.table_name));
    const bad = r.rows
      .filter((fk) => owned.has(fk.table_name) && owned.has(fk.foreign_table) && fk.foreign_table !== "organizations")
      .filter((fk) => !fk.columns.includes("org_id"))
      .map((fk) => `${fk.table_name}.${fk.columns.join(",")} → ${fk.foreign_table} (${fk.constraint_name})`);
    expect(bad).toEqual([]);
  });
});
