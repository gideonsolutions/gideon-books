import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bankImportRows, bankTransactions } from "@/lib/db/schema/banking";
import { getImportBatch, previewImport, undoImport, listMappings } from "@/lib/banking/imports";
import { matchTransactions } from "@/lib/banking/transactions";
import { postManualEntry } from "@/lib/ledger/journals";
import { rejectsDb, rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { csv, importCsv, mappingFor, txnsOf } from "./helpers";

let t: TestOrg;
let bank: string;
beforeAll(async () => {
  t = await setupOrg();
  bank = await t.acct("1000");
});

describe("CSV import", () => {
  it("previews with errors and duplicate flags, saving nothing", async () => {
    const text = csv([
      ["2026-02-01", "Coffee", "-4.50"],
      ["2026-02-02", "Bad row", "abc"],
    ]);
    const p = await previewImport(getDb(), t.ctx, { accountId: bank, text, mapping: mappingFor(text) });
    expect(p.counts).toMatchObject({ total: 2, errors: 1, new: 1 });
    expect((await txnsOf(t.orgId, bank)).length).toBe(0);
  });

  it("imports once: the same file again brings in nothing; identical rows in one file are both kept", async () => {
    const text = csv([
      ["2026-02-03", "Coffee", "-4.50"],
      ["2026-02-03", "Coffee", "-4.50"],
      ["2026-02-04", "Client deposit", "1200.00"],
    ]);
    const first = await importCsv(t.ctx, bank, text);
    expect(first.importedCount).toBe(3);
    const second = await importCsv(t.ctx, bank, text);
    expect(second.importedCount).toBe(0);
    expect(second.duplicateCount).toBe(3);
    // An overlapping export: one old row and one new.
    const overlap = await importCsv(t.ctx, bank, csv([["2026-02-04", "CLIENT DEPOSIT", "1200.00"], ["2026-02-05", "Rent", "-1500.00"]]));
    expect(overlap.importedCount).toBe(1);
    expect(overlap.duplicateCount).toBe(1);
    // Every raw row is kept, with what became of it.
    const { rows } = await getImportBatch(getDb(), t.orgId, second.id);
    expect(rows.map((r) => r.outcome)).toEqual(["duplicate", "duplicate", "duplicate"]);
    await rejectsDb(getDb().update(bankImportRows).set({ outcome: "skipped" }).where(eq(bankImportRows.batchId, second.id)), /append-only/);
  });

  it("imports a flagged duplicate only when the person includes it", async () => {
    const text = csv([["2026-02-06", "Parking", "-3.00"]]);
    await importCsv(t.ctx, bank, text);
    const again = await importCsv(t.ctx, bank, text, {}, { includeDuplicateRows: [2] });
    expect(again.importedCount).toBe(1);
  });

  it("saves a mapping for reuse", async () => {
    const { commitImport } = await import("@/lib/banking/imports");
    const text = csv([["2026-02-07", "Fuel", "-40.00"]]);
    await commitImport(t.ctx, { accountId: bank, fileName: "x.csv", text, mapping: mappingFor(text), saveMappingAs: "My bank" });
    expect((await listMappings(getDb(), t.orgId)).map((m) => m.name)).toContain("My bank");
  });

  it("undoes an import, but not once a transaction from it is matched", async () => {
    const text = csv([["2026-03-01", "Undo me", "-10.00"]]);
    const b = await importCsv(t.ctx, bank, text);
    await undoImport(t.ctx, b.id, "wrong account");
    const [tx] = (await txnsOf(t.orgId, bank)).filter((x) => x.batchId === b.id);
    expect(tx!.status).toBe("removed");
    // Re-importing after an undo works.
    const again = await importCsv(t.ctx, bank, text);
    expect(again.importedCount).toBe(1);
    const entry = await postManualEntry(t.ctx, { entryDate: "2026-03-01", description: "Supplies", lines: [{ accountId: await t.acct("6500"), debit: "10" }, { accountId: bank, credit: "10" }] });
    const [newTxn] = (await txnsOf(t.orgId, bank)).filter((x) => x.batchId === again.id);
    await matchTransactions(t.ctx, { bankTransactionIds: [newTxn!.id], journalLineIds: [entry.lines.find((l) => l.accountId === bank)!.id] });
    await rejectsWith(undoImport(t.ctx, again.id, "oops"), "import_in_use");
  });

  it("keeps what the bank said immutable", async () => {
    const [any] = await txnsOf(t.orgId, bank);
    await rejectsDb(getDb().update(bankTransactions).set({ amount: "1.00" }).where(eq(bankTransactions.id, any!.id)), /cannot be edited/);
    await rejectsDb(getDb().delete(bankTransactions).where(eq(bankTransactions.id, any!.id)), /are kept/);
  });

  it("refuses an account that is not a money account, and read-only members", async () => {
    const text = csv([["2026-02-01", "x", "1.00"]]);
    await rejectsWith(importCsv(t.ctx, await t.acct("6500"), text), "validation_failed");
    const ro = await t.as("read_only");
    await rejectsWith(importCsv(ro, bank, text), "forbidden");
  });
});
