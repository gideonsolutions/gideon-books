import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { postManualEntry } from "@/lib/ledger/journals";
import { saveDraft, issueDocument } from "@/lib/commerce/documents";
import { compareSnapshots, snapshot } from "@/lib/ops/verify";
import { urlFor, withAdmin } from "../setup/db";
import { customer, setupOrg } from "../helpers";

function pgBin(): string | null {
  for (const dir of [process.env.PG_BIN, "/usr/lib/postgresql/16/bin", "/usr/lib/postgresql/17/bin", "/usr/lib/postgresql/18/bin"]) {
    if (dir && fs.existsSync(path.join(dir, "pg_dump")) && fs.existsSync(path.join(dir, "pg_restore"))) return dir;
  }
  return null;
}

describe("backup and verified restore", () => {
  const bin = pgBin();
  it.skipIf(!bin)("restores a pg_dump into a fresh database with identical row counts and trial balances", async () => {
    const o = await setupOrg({ name: "Backed Up" });
    await postManualEntry(o.ctx, { entryDate: "2026-03-01", description: "Capital", lines: [{ accountId: await o.acct("1000"), debit: "2500.55" }, { accountId: await o.acct("owner_contributions"), credit: "2500.55" }] });
    const c = await customer(o.ctx);
    const d = await saveDraft(o.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-03-02", lines: [{ unitPrice: "99.99", quantity: "3" }] });
    await issueDocument(o.ctx, d.id);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "books-backup-"));
    const dump = path.join(dir, "database.dump");
    const source = process.env.DATABASE_URL!;
    execFileSync(path.join(bin!, "pg_dump"), ["--format=custom", "--no-owner", "--no-privileges", "--file", dump, source]);
    const scratch = `books_t_restore_${randomBytes(4).toString("hex")}_${process.env.TEST_RUN_TAG ?? "x"}`;
    await withAdmin((a) => a.query(`create database "${scratch}"`));
    try {
      execFileSync(path.join(bin!, "pg_restore"), ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", urlFor(scratch), dump]);
      const [s1, s2] = await Promise.all([snapshot(source), snapshot(urlFor(scratch))]);
      expect(compareSnapshots(s1, s2)).toEqual([]);
      expect(Object.keys(s1.trialBalances)).toContain(o.orgId);
      expect(s1.tables.journal_lines).toBeGreaterThan(0);
      // The comparison does catch a difference.
      const tampered = structuredClone(s2);
      tampered.tables.journal_lines = (tampered.tables.journal_lines ?? 0) + 1;
      expect(compareSnapshots(s1, tampered).length).toBe(1);
    } finally {
      await withAdmin((a) => a.query(`drop database if exists "${scratch}" with (force)`));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  if (!bin) it("needs pg_dump/pg_restore (set PG_BIN) for the restore test", () => expect(bin).toBeNull());
});
