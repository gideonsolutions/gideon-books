/**
 * The database connection. One pool per process, created on first use from
 * DATABASE_URL, so tests can point each file at its own database before
 * anything connects.
 */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Calendar dates stay strings ("2026-03-31"); a JavaScript Date would shift
// them across time zones. Numerics stay strings (exact decimals). int8 stays
// a string unless a column asks for a number.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export type Schema = typeof schema;
export type Db = NodePgDatabase<Schema>;
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
/** Either the database or a transaction: functions that only read take this. */
export type DbOrTx = Db | Tx;

interface Holder {
  pool: pg.Pool;
  db: Db;
  url: string;
}

const g = globalThis as unknown as { __gideonBooksDb?: Holder };

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. See .env.example.");
  return url;
}

function create(url: string): Holder {
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    application_name: "gideon-books",
  });
  pool.on("error", (err) => {
    // An idle client lost its connection; the pool replaces it.
    console.error(JSON.stringify({ level: "error", msg: "postgres pool error", error: err.message }));
  });
  return { pool, db: drizzle(pool, { schema }), url };
}

function holder(): Holder {
  const url = databaseUrl();
  if (!g.__gideonBooksDb || g.__gideonBooksDb.url !== url) {
    g.__gideonBooksDb = create(url);
  }
  return g.__gideonBooksDb;
}

export function getDb(): Db {
  return holder().db;
}

export function getPool(): pg.Pool {
  return holder().pool;
}

export async function closeDb(): Promise<void> {
  const h = g.__gideonBooksDb;
  g.__gideonBooksDb = undefined;
  if (h) await h.pool.end();
}

/**
 * Run `fn` in a transaction. Serialization failures and deadlocks are
 * retried (the whole function runs again), so `fn` must not have side
 * effects outside the database.
 */
export async function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  opts: { isolationLevel?: "read committed" | "repeatable read" | "serializable"; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      return await getDb().transaction(fn, { isolationLevel: opts.isolationLevel ?? "read committed" });
    } catch (err) {
      const code = pgErrorCode(err);
      if ((code === "40001" || code === "40P01") && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/** The SQLSTATE of a Postgres error, looking through drizzle's wrapper. */
export function pgErrorCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The message of a Postgres error raised by one of our triggers (RAISE EXCEPTION). */
export function pgErrorMessage(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e; i++) {
    const code = (e as { code?: unknown }).code;
    const msg = (e as { message?: unknown }).message;
    if (typeof code === "string" && typeof msg === "string" && /^[0-9A-Z]{5}$/.test(code)) return msg;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export { schema };
