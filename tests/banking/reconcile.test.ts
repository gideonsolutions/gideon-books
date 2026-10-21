import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { reconciliations } from "@/lib/db/schema/banking";
import {
  cancelReconciliation,
  completeReconciliation,
  getReconciliation,
  reconciliationLinesFor,
  reconciliationReport,
  setCleared,
  startReconciliation,
  summarize,
  undoReconciliation,
} from "@/lib/banking/reconcile";
import { matchTransactions, undoMatch } from "@/lib/banking/transactions";
import { postManualEntry } from "@/lib/ledger/journals";
import { bankingCloseChecks } from "@/lib/banking/close-check";
import { balance, rejectsDb, rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { csv, importCsv, txnsOf } from "./helpers";

let t: TestOrg;
let bank: string;
const lineIds: Record<string, string> = {};

beforeAll(async () => {
  t = await setupOrg();
  bank = await t.acct("1000");
  const post = async (key: string, date: string, debit: string | null, credit: string | null, other: string) => {
    const e = await postManualEntry(t.ctx, {
      entryDate: date,
      description: key,
      lines: [
        { accountId: bank, debit, credit },
        { accountId: await t.acct(other), debit: credit, credit: debit },
      ],
    });
    lineIds[key] = e.lines.find((l) => l.accountId === bank)!.id;
  };
  await post("capital", "2026-06-01", "1000.00", null, "owner_contributions");
  await post("rent", "2026-06-05", null, "400.00", "6550");
  await post("supplies", "2026-06-20", null, "50.00", "6500");
  await post("late deposit", "2026-06-29", "75.00", null, "4100");
  await post("july", "2026-07-02", null, "10.00", "6500");
});

describe("reconciliation", () => {
  let recId: string;

  it("starts with matched lines checked and lists everything else on or before the statement date", async () => {
    await importCsv(t.ctx, bank, csv([["2026-06-01", "DEPOSIT", "1000.00"]]));
    const [bt] = await txnsOf(t.orgId, bank);
    await matchTransactions(t.ctx, { bankTransactionIds: [bt!.id], journalLineIds: [lineIds.capital!] });
    const rec = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-06-30", statementBalance: "550.00" });
    recId = rec.id;
    const lines = await reconciliationLinesFor(getDb(), t.ctx, rec);
    expect(lines.map((l) => l.description).sort()).toEqual(["capital", "late deposit", "rent", "supplies"]);
    expect(lines.find((l) => l.lineId === lineIds.capital)!.checked).toBe(true);
    await rejectsWith(startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-07-31", statementBalance: "0" }), "in_progress");
  });

  it("refuses to complete with a difference, then completes at zero with outstanding items", async () => {
    // Statement: 1000 − 400 − 50 = 550; the 75 deposit is still in transit.
    let s = await setCleared(t.ctx, recId, [lineIds.capital!, lineIds.rent!]);
    expect(s.difference.eq("-50")).toBe(true);
    await rejectsWith(completeReconciliation(t.ctx, recId), "difference_remaining");
    s = await setCleared(t.ctx, recId, [lineIds.capital!, lineIds.rent!, lineIds.supplies!]);
    expect(s.difference.isZero()).toBe(true);
    expect(s.outstandingIn.eq("75")).toBe(true);
    await completeReconciliation(t.ctx, recId);
    const rec = await getReconciliation(getDb(), t.orgId, recId);
    expect(rec.status).toBe("completed");
    const report = await reconciliationReport(getDb(), t.ctx, rec);
    expect(report.outstanding.map((o) => o.description)).toEqual(["late deposit"]);
    expect(report.cleared.length).toBe(3);
    // Completed figures are final in the database too.
    await rejectsDb(getDb().update(reconciliations).set({ statementBalance: "1" }).where(eq(reconciliations.id, recId)), /final/);
  });

  it("carries the ending balance forward and posts a reasoned adjustment for a discrepancy", async () => {
    const before = await balance(t.orgId, bank);
    const rec = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-07-31", statementBalance: "610.00" });
    expect(rec.openingBalance).toBe("550.0000");
    await setCleared(t.ctx, rec.id, [lineIds["late deposit"]!, lineIds.july!]);
    // 550 + 75 − 10 = 615; the bank says 610 (an unrecorded 5.00 fee).
    await rejectsWith(completeReconciliation(t.ctx, rec.id, { adjustReason: "" }), "difference_remaining");
    const done = await completeReconciliation(t.ctx, rec.id, { adjustReason: "Bank fee not in the books" });
    expect(done.adjustmentEntryId).toBeTruthy();
    expect(Number(await balance(t.orgId, bank)) - Number(before)).toBeCloseTo(-5, 6);
    expect(await balance(t.orgId, await t.acct("reconciliation_discrepancies"))).toBe("5.00");
  });

  it("undoes only the latest reconciliation, reversing its adjustment", async () => {
    await rejectsWith(undoReconciliation(t.ctx, recId, "redo June"), "later_reconciliation");
    const recs = await getDb().select().from(reconciliations).where(eq(reconciliations.accountId, bank));
    const july = recs.find((r) => r.statementDate === "2026-07-31")!;
    const staff = await t.as("staff");
    await rejectsWith(undoReconciliation(staff, july.id, "no"), "forbidden");
    await undoReconciliation(t.ctx, july.id, "statement balance was misread");
    expect(await balance(t.orgId, await t.acct("reconciliation_discrepancies"))).toBe("0.00");
    await undoReconciliation(t.ctx, recId, "redo June");
    // Its lines are free again.
    const again = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-06-30", statementBalance: "550.00" });
    const lines = await reconciliationLinesFor(getDb(), t.ctx, again);
    expect(summarize(again, lines).opening.isZero()).toBe(true);
    expect(lines.length).toBe(4);
    await cancelReconciliation(t.ctx, again.id);
  });

  it("refuses to undo a match whose entry a completed reconciliation cleared", async () => {
    const rec = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-06-30", statementBalance: "550.00" });
    await setCleared(t.ctx, rec.id, [lineIds.capital!, lineIds.rent!, lineIds.supplies!]);
    await completeReconciliation(t.ctx, rec.id);
    const [bt] = await txnsOf(t.orgId, bank);
    await rejectsWith(undoMatch(t.ctx, bt!.matchGroupId!, "x"), "reconciled");
  });

  it("shows a cleared entry that was later reversed, and its reversal as outstanding", async () => {
    const e = await postManualEntry(t.ctx, {
      entryDate: "2026-08-03",
      description: "check 1001",
      lines: [
        { accountId: bank, credit: "20.00" },
        { accountId: await t.acct("6500"), debit: "20.00" },
      ],
    });
    const line = e.lines.find((l) => l.accountId === bank)!.id;
    const aug = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-08-31", statementBalance: "0" });
    const all = await reconciliationLinesFor(getDb(), t.ctx, aug);
    // Clear exactly what makes the statement: everything listed (computed), so it completes at zero.
    const s = await setCleared(t.ctx, aug.id, all.map((l) => l.lineId));
    await getDb().update(reconciliations).set({ statementBalance: s.cleared.toString() }).where(eq(reconciliations.id, aug.id));
    await completeReconciliation(t.ctx, aug.id);
    const { reverseManualEntry } = await import("@/lib/ledger/journals");
    await reverseManualEntry(t.ctx, e.entry.id, { date: "2026-09-02", reason: "check voided" });
    const done = await getReconciliation(getDb(), t.orgId, aug.id);
    const report = await reconciliationReport(getDb(), t.ctx, done);
    expect(report.cleared.find((c) => c.line_id === line)!.reversed).toBe(true);
    const sep = await startReconciliation(t.ctx, { accountId: bank, statementDate: "2026-09-30", statementBalance: s.cleared.toString() });
    const sepLines = await reconciliationLinesFor(getDb(), t.ctx, sep);
    const reversal = sepLines.find((l) => l.isReversal)!;
    expect(reversal.amount).toBe("20.0000");
    expect(summarize(sep, sepLines).outstandingIn.eq("20")).toBe(true);
    await cancelReconciliation(t.ctx, sep.id);
  });

  it("warns at period close when an account is not reconciled through the period end", async () => {
    const checks = await bankingCloseChecks(getDb(), t.ctx, { id: "x", startDate: "2026-09-01", endDate: "2026-09-30" });
    const rec = checks.find((c) => c.key === "bank_reconciled")!;
    expect(rec.status).toBe("fail");
    expect(rec.detail).toMatch(/reconciled to 2026-08-31/);
    const june = await bankingCloseChecks(getDb(), t.ctx, { id: "x", startDate: "2026-06-01", endDate: "2026-06-30" });
    expect(june.find((c) => c.key === "bank_reconciled")!.detail ?? "").not.toMatch(/1000 Checking/);
  });
});
