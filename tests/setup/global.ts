/**
 * Build the template database once per schema version, and drop test
 * databases afterwards.
 *
 * TEST_SCHEMA_SOURCE=migrations (the default, and what CI runs) applies the
 * migrations on disk — so the migrations themselves are tested.
 * TEST_SCHEMA_SOURCE=push builds the schema straight from lib/db/schema plus
 * every lib/db/sql/integrity*.sql, for working on the schema before its
 * migration is generated.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { templateName, urlFor, withAdmin } from "./db";

const ROOT = path.resolve(__dirname, "../..");

async function build(dbName: string) {
  const url = urlFor(dbName);
  const env = { ...process.env, DATABASE_URL: url, LOG_LEVEL: "error" };
  if ((process.env.TEST_SCHEMA_SOURCE ?? "migrations") === "push") {
    execFileSync(process.execPath, [path.join(ROOT, "node_modules/drizzle-kit/bin.cjs"), "push", "--force", "--config", path.join(ROOT, "drizzle.config.ts")], {
      env,
      cwd: ROOT,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const sqlDir = path.join(ROOT, "lib/db/sql");
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      // The core integrity.sql first: module files use its functions (gb_purging, gb_append_only).
      const files = fs.readdirSync(sqlDir).filter((f) => /^integrity.*\.sql$/.test(f)).sort((a, b) => (a === "integrity.sql" ? -1 : b === "integrity.sql" ? 1 : a.localeCompare(b)));
      for (const f of files) {
        const text = fs.readFileSync(path.join(sqlDir, f), "utf8");
        for (const stmt of text.split("--> statement-breakpoint")) if (stmt.trim()) await c.query(stmt);
      }
    } finally {
      await c.end();
    }
    return;
  }
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/tsx/dist/cli.mjs"), path.join(ROOT, "scripts/migrate.ts")], { env, stdio: "inherit" });
}

export async function setup() {
  const tpl = templateName();
  const exists = await withAdmin(async (c) => (await c.query("select 1 from pg_database where datname = $1", [tpl])).rowCount === 1);
  if (exists) return;
  const building = `${tpl}_build_${process.pid}`;
  await withAdmin((c) => c.query(`CREATE DATABASE "${building}"`));
  try {
    await build(building);
  } catch (e) {
    await withAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`));
    throw e;
  }
  await withAdmin(async (c) => {
    try {
      await c.query(`ALTER DATABASE "${building}" RENAME TO "${tpl}"`);
    } catch {
      // Another run built it first.
      await c.query(`DROP DATABASE IF EXISTS "${building}" WITH (FORCE)`);
    }
  });
}

export async function teardown() {
  if (process.env.KEEP_TEST_DATABASES) return;
  await withAdmin(async (c) => {
    // Only this run's databases: others may be running concurrently.
    const r = await c.query("select datname from pg_database where datname like $1", [`books_t_%_${process.env.TEST_RUN_TAG ?? ""}%`]);
    for (const row of r.rows) {
      if (process.env.TEST_RUN_TAG) await c.query(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`).catch(() => {});
    }
  });
}
