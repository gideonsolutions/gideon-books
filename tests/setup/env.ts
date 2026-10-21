/**
 * Runs before each test file: give the file its own database, copied from
 * the migrated template, and the environment the application expects.
 */
import { afterAll } from "vitest";
import { createTestDatabase } from "./db";

process.env.LOG_LEVEL ??= "error";
process.env.BOOKS_ENCRYPTION_KEY ??= "test-key-0123456789abcdef0123456789abcdef";
process.env.APP_URL ??= "http://localhost:3200";
process.env.EMAIL_PROVIDER ??= "outbox";
process.env.STORAGE_DIR ??= `/tmp/gideon-books-test-storage-${process.pid}`;
process.env.FX_PROVIDER ??= "none";
process.env.DATABASE_URL = await createTestDatabase();

afterAll(async () => {
  const { closeDb } = await import("@/lib/db/client");
  await closeDb();
});
