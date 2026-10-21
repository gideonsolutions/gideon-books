/**
 * Test databases. A template database with every migration applied is built
 * once per migration set (named by a hash of the migration files); each test
 * file gets its own copy, so files run in parallel against real Postgres.
 *
 * TEST_DATABASE_URL points at a server where the test user may create
 * databases (default: the development container, docker-compose.yml).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export const ADMIN_URL = process.env.TEST_DATABASE_URL ?? "postgres://books:books@localhost:54329/postgres";
const DB_DIR = path.resolve(__dirname, "../../lib/db");

/** A hash of everything that defines the schema the tests run against. */
export function schemaHash(): string {
  const h = createHash("sha256");
  const source = process.env.TEST_SCHEMA_SOURCE ?? "migrations";
  h.update(source);
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else h.update(f).update(fs.readFileSync(p));
    }
  };
  if (source === "push") {
    walk(path.join(DB_DIR, "schema"));
    walk(path.join(DB_DIR, "sql"));
  } else {
    walk(path.join(DB_DIR, "migrations"));
  }
  return h.digest("hex").slice(0, 12);
}

export function templateName(): string {
  return `books_tpl_${schemaHash()}`;
}

export function urlFor(dbName: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${dbName}`;
  return u.toString();
}

export async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function createTestDatabase(): Promise<string> {
  const name = `books_t_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}_${process.env.TEST_RUN_TAG ?? "x"}`;
  const tpl = templateName();
  // Copying a template fails if anything is connected to it; retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await withAdmin((c) => c.query(`CREATE DATABASE "${name}" TEMPLATE "${tpl}"`));
      break;
    } catch (e) {
      if (attempt > 20) throw e;
      await new Promise((r) => setTimeout(r, 100 + attempt * 50));
    }
  }
  return urlFor(name);
}
