import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import {
  categorizeTransaction,
  excludeTransactions,
  matchTransactions,
  recordPaymentFromTransaction,
  restoreTransaction,
  suggestionsForMany,
  transferTransaction,
  undoMatch,
  acceptSuggestions,
} from "@/lib/banking/transactions";
import { postManualEntry } from "@/lib/ledger/journals";
import { getEntry } from "@/lib/ledger/posting";
import { issueDocument, saveDraft } from "@/lib/commerce/documents";
import { itemBalance } from "@/lib/commerce/open-items";
import { Decimal } from "@/lib/money/decimal";
import { balance, customer, rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { csv, importCsv, txnsOf } from "./helpers";

let t: TestOrg;
let bank: string;
let savings: string;
beforeAll(async () => {
  t = await setupOrg();
  bank = await t.acct("1000");
  savings = await t.acct("1010");
});

async function spend(date: string, amount: string, desc = "Supplies") {
  return postManualEntry(t.ctx, { entryDate: date, description: desc, lines: [{ accountId: await t.acct("6500"), debit: amount }, { accountId: bank, credit: amount }] });
}

async function txn(description: string) {
  return (await txnsOf(t.orgId, bank)).find((x) => x.description === description)!;
}

describe("matching", () => {
  it("suggests the ledger line with the same amount near the date, and matches one to one", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-03", "OFFICE DEPOT 4411", "-55.20"]]));
    const e = await spend("2026-04-01", "55.20", "Office Depot");
    const bt = await txn("OFFICE DEPOT 4411");
    const s = (await suggestionsForMany(getDb(), t.ctx, [bt])).get(bt.id)!;
    expect(s[0]).toMatchObject({ type: "match" });
    expect(s[0]!.type === "match" && s[0]!.line.entryId).toBe(e.entry.id);
    await matchTransactions(t.ctx, { bankTransactionIds: [bt.id], journalLineIds: [s[0]!.type === "match" ? s[0]!.line.lineId : ""] });
    expect((await txn("OFFICE DEPOT 4411")).status).toBe("matched");
  });

  it("matches many bank transactions to one deposit, and refuses totals that differ", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-05", "CARD SETTLEMENT A", "100.00"], ["2026-04-05", "CARD SETTLEMENT B", "50.00"]]));
    const dep = await postManualEntry(t.ctx, { entryDate: "2026-04-05", description: "Deposit", lines: [{ accountId: bank, debit: "150" }, { accountId: await t.acct("4100"), credit: "150" }] });
    const line = dep.lines.find((l) => l.accountId === bank)!.id;
    const a = await txn("CARD SETTLEMENT A");
    const b = await txn("CARD SETTLEMENT B");
    await rejectsWith(matchTransactions(t.ctx, { bankTransactionIds: [a.id], journalLineIds: [line] }), "validation_failed");
    await matchTransactions(t.ctx, { bankTransactionIds: [a.id, b.id], journalLineIds: [line] });
    // A line can be in only one match.
    await importCsv(t.ctx, bank, csv([["2026-04-05", "CARD SETTLEMENT C", "150.00"]]));
    await rejectsWith(matchTransactions(t.ctx, { bankTransactionIds: [(await txn("CARD SETTLEMENT C")).id], journalLineIds: [line] }), "line_already_matched");
  });

  it("matches one bank transaction to several entries", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-07", "BATCH PAYMENT", "-30.00"]]));
    const x = await spend("2026-04-07", "10.00");
    const y = await spend("2026-04-07", "20.00");
    await matchTransactions(t.ctx, {
      bankTransactionIds: [(await txn("BATCH PAYMENT")).id],
      journalLineIds: [x.lines.find((l) => l.accountId === bank)!.id, y.lines.find((l) => l.accountId === bank)!.id],
    });
  });
});

describe("categorizing", () => {
  it("posts a split with a fee line that balances, and undoes it with a reversal", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-10", "AMAZON MKTPLACE", "-100.00"]]));
    const bt = await txn("AMAZON MKTPLACE");
    const before = await balance(t.orgId, bank);
    const r = await categorizeTransaction(t.ctx, bt.id, {
      splits: [
        { accountId: await t.acct("6500"), amount: "60.00" },
        { accountId: await t.acct("6000"), amount: "37.50" },
        { accountId: await t.acct("6900"), amount: "2.50", description: "Fee" },
      ],
    });
    const { lines } = await getEntry(getDb(), t.orgId, r.entry.id);
    expect(Decimal.sum(lines.map((l) => l.baseAmount)).isZero()).toBe(true);
    expect(Decimal.from(await balance(t.orgId, bank)).sub(before).toString()).toBe("-100.00");
    expect((await txn("AMAZON MKTPLACE")).status).toBe("categorized");
    // The splits must add up to the transaction.
    await importCsv(t.ctx, bank, csv([["2026-04-11", "SPLIT WRONG", "-10.00"]]));
    await rejectsWith(categorizeTransaction(t.ctx, (await txn("SPLIT WRONG")).id, { splits: [{ accountId: await t.acct("6500"), amount: "9.99" }] }), "validation_failed");
    // Control accounts are refused (use a payment instead).
    await rejectsWith(categorizeTransaction(t.ctx, (await txn("SPLIT WRONG")).id, { splits: [{ accountId: await t.acct("accounts_payable"), amount: "10.00" }] }), "control_account");
    const undo = await undoMatch(t.ctx, (await txn("AMAZON MKTPLACE")).matchGroupId!, "wrong categories");
    expect(undo.reversalId).toBeTruthy();
    expect(await balance(t.orgId, bank)).toBe(before);
    expect((await txn("AMAZON MKTPLACE")).status).toBe("unreviewed");
  });

  it("records a refund coming in as a negative expense", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-12", "REFUND OFFICE STORE", "15.00"]]));
    const bt = await txn("REFUND OFFICE STORE");
    const exp = await t.acct("6500");
    const before = await balance(t.orgId, exp);
    await categorizeTransaction(t.ctx, bt.id, { splits: [{ accountId: exp, amount: "15.00" }] });
    expect(Decimal.from(await balance(t.orgId, exp)).sub(before).toString()).toBe("-15.00");
  });

  it("excludes with a reason and restores", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-13", "PERSONAL", "-9.00"]]));
    const bt = await txn("PERSONAL");
    await rejectsWith(excludeTransactions(t.ctx, [bt.id], ""), "validation_failed");
    await excludeTransactions(t.ctx, [bt.id], "personal card use");
    expect((await txn("PERSONAL")).status).toBe("excluded");
    await restoreTransaction(t.ctx, bt.id);
    expect((await txn("PERSONAL")).status).toBe("unreviewed");
  });
});

describe("transfers and payments", () => {
  it("transfers between two accounts, matching both sides, and undoes both together", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-15", "TRANSFER TO SAVINGS", "-500.00"]]));
    await importCsv(t.ctx, savings, csv([["2026-04-15", "TRANSFER FROM CHECKING", "500.00"]]));
    const out = await txn("TRANSFER TO SAVINGS");
    const inn = (await txnsOf(t.orgId, savings))[0]!;
    const s = (await suggestionsForMany(getDb(), t.ctx, [out])).get(out.id)!;
    expect(s.some((x) => x.type === "transfer" && x.counterpart.id === inn.id)).toBe(true);
    const bBefore = await balance(t.orgId, bank);
    await transferTransaction(t.ctx, out.id, { toAccountId: savings, counterpartId: inn.id });
    expect((await txnsOf(t.orgId, savings))[0]!.status).toBe("categorized");
    expect(Decimal.from(await balance(t.orgId, savings)).toString()).toBe("500.00");
    await undoMatch(t.ctx, (await txn("TRANSFER TO SAVINGS")).matchGroupId!, "wrong");
    expect((await txnsOf(t.orgId, savings))[0]!.status).toBe("unreviewed");
    expect(await balance(t.orgId, bank)).toBe(bBefore);
  });

  it("records a customer payment from a deposit, applied to the invoice it matches", async () => {
    const c = await customer(t.ctx, "Bank Customer");
    const d = await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-04-01", lines: [{ unitPrice: "240.00" }] });
    const inv = await issueDocument(t.ctx, d.id);
    await importCsv(t.ctx, bank, csv([["2026-04-20", "DEPOSIT BANK CUSTOMER", "240.00"]]));
    const bt = await txn("DEPOSIT BANK CUSTOMER");
    const s = (await suggestionsForMany(getDb(), t.ctx, [bt])).get(bt.id)!;
    expect(s.some((x) => x.type === "invoice" && x.documentId === inv.id)).toBe(true);
    await rejectsWith(recordPaymentFromTransaction(t.ctx, bt.id, { kind: "vendor_payment", contactId: c.id }), "validation_failed");
    await recordPaymentFromTransaction(t.ctx, bt.id, { kind: "customer_payment", contactId: c.id, allocations: [{ itemType: "document", itemId: inv.id, amount: "240.00" }] });
    expect((await itemBalance(getDb(), t.orgId, inv.id)).txn.isZero()).toBe(true);
    expect((await txn("DEPOSIT BANK CUSTOMER")).status).toBe("matched");
  });

  it("bulk-accepts unambiguous suggestions and leaves the rest", async () => {
    await importCsv(t.ctx, bank, csv([["2026-04-22", "UNIQUE 77.77", "-77.77"], ["2026-04-22", "NOTHING LIKE IT", "-1.23"]]));
    await spend("2026-04-21", "77.77");
    const a = await txn("UNIQUE 77.77");
    const b = await txn("NOTHING LIKE IT");
    const r = await acceptSuggestions(t.ctx, [a.id, b.id]);
    expect(r.accepted).toBe(1);
    expect(r.skipped.map((x) => x.id)).toEqual([b.id]);
  });
});
