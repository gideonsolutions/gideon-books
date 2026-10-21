/**
 * Apply pending database migrations (`npm run db:migrate`). Safe to run on
 * every deploy: applied migrations are recorded and skipped, and a failure
 * rolls back and exits non-zero.
 */
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, getDb } from "../lib/db/client";
import { log } from "../lib/log";

async function main() {
  const migrationsFolder = path.resolve(__dirname, "../lib/db/migrations");
  const started = Date.now();
  await migrate(getDb(), { migrationsFolder });
  log.info("migrations applied", { ms: Date.now() - started });
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    log.error("migration failed", { error: (err as Error).message });
    await closeDb().catch(() => {});
    process.exit(1);
  });
