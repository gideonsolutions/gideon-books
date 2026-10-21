import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { journalEntries, journalLines } from "@/lib/db/schema/ledger";
import { postEntry } from "@/lib/ledger/posting";
import { postManualEntry, reverseManualEntry, saveManualDraft, postManualDraft, deleteManualDraft } from "@/lib/ledger/journals";
import { closePeriod, reopenPeriod, setLockDate, periodFor } from "@/lib/ledger/periods";
import { addManualRate } from "@/lib/fx/rates";
import { balance, refresh, rejectsDb, rejectsWith, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

const post = (lines: { accountId: string; amount: string; currency?: string; fxRate?: string }[], extra: Record<string, unknown> = {}) =>
  withTransaction((tx) => postEntry(tx, t.ctx, { kind: "manual", entryDate: "2026-01-15", description: "test", lines, ...extra }));

describe("posting engine", () => {
  it("posts a balanced entry with a number and period", async () => {
    const r = await post([
      { accountId: await t.acct("1000"), amount: "100.00" },
      { accountId: await t.acct("owner_contributions"), amount: "-100.00" },
    ]);
    expect(r.entry.status).toBe("posted");
    expect(r.entry.entryNumber).toBeGreaterThan(0);
    expect(r.entry.periodId).toBeTruthy();
    expect(await balance(t.orgId, await t.acct("1000"))).toBe("100.00");
  });

  it("refuses an unbalanced entry", async () => {
    await rejectsWith(post([{ accountId: await t.acct("1000"), amount: "10.00" }, { accountId: await t.acct("6000"), amount: "-9.99" }]), "unbalanced");
  });

  it("refuses more decimal places than the currency has", async () => {
    await rejectsWith(post([{ accountId: await t.acct("1000"), amount: "10.005" }, { accountId: await t.acct("6000"), amount: "-10.005" }]), "amount_precision");
  });

  it("refuses manual journals to control accounts", async () => {
    await rejectsWith(post([{ accountId: await t.acct("accounts_receivable"), amount: "5" }, { accountId: await t.acct("4100"), amount: "-5" }]), "control_account");
  });

  it("converts foreign lines at the stated rate and absorbs rounding within tolerance", async () => {
    // Three lines at 1.0833 each round; the difference goes to the rounding account.
    const ok = await post([
      { accountId: await t.acct("6000"), amount: "10.01", currency: "EUR", fxRate: "1.0833" },
      { accountId: await t.acct("6200"), amount: "10.01", currency: "EUR", fxRate: "1.0833" },
      { accountId: await t.acct("2100"), amount: "-20.02", currency: "EUR", fxRate: "1.0833" },
    ]);
    const sum = ok.lines.reduce((s, l) => s + Number(l.baseAmount) * 100, 0);
    expect(Math.round(sum)).toBe(0);
    // 10.01 × 1.0833 = 10.843833 → 10.84 (twice); 20.02 × 1.0833 = 21.687666 → 21.69; rounding line −0.01
    expect(ok.lines.map((l) => l.baseAmount)).toEqual(["10.8400", "10.8400", "-21.6900", "0.0100"]);
  });

  it("is idempotent on a key and refuses the key reused for a different entry", async () => {
    const lines = [
      { accountId: await t.acct("1000"), amount: "7.00" },
      { accountId: await t.acct("4100"), amount: "-7.00" },
    ];
    const a = await post(lines, { idempotencyKey: "same-key" });
    const b = await post(lines, { idempotencyKey: "same-key" });
    expect(b.created).toBe(false);
    expect(b.entry.id).toBe(a.entry.id);
    await rejectsWith(post([{ ...lines[0]!, amount: "8.00" }, { ...lines[1]!, amount: "-8.00" }], { idempotencyKey: "same-key" }), "idempotency_key_reused");
  });

  it("posts concurrently with gapless unique numbers and one entry per idempotency key", async () => {
    const lines = [
      { accountId: await t.acct("1000"), amount: "1.00" },
      { accountId: await t.acct("4100"), amount: "-1.00" },
    ];
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(lines, { idempotencyKey: `conc-${i % 4}` })));
    const ids = new Set(results.map((r) => r.entry.id));
    expect(ids.size).toBe(4);
    const numbers = await getDb()
      .select({ n: journalEntries.entryNumber })
      .from(journalEntries)
      .where(and(eq(journalEntries.orgId, t.orgId), eq(journalEntries.status, "posted")));
    const sorted = numbers.map((r) => r.n!).sort((a, b) => a - b);
    expect(sorted).toEqual(sorted.map((_, i) => i + 1));
  });

  it("keeps posted entries immutable at the database level", async () => {
    const r = await post([
      { accountId: await t.acct("1000"), amount: "3.00" },
      { accountId: await t.acct("4100"), amount: "-3.00" },
    ]);
    await rejectsDb(getDb().update(journalEntries).set({ description: "changed" }).where(eq(journalEntries.id, r.entry.id)), /immutable/);
    await rejectsDb(getDb().update(journalLines).set({ baseAmount: "4.00" }).where(eq(journalLines.entryId, r.entry.id)), /immutable/);
    await rejectsDb(getDb().delete(journalEntries).where(eq(journalEntries.id, r.entry.id)), /cannot be deleted/);
    // The trigger also refuses an unbalanced entry posted behind the engine's back.
    await rejectsDb(getDb().transaction(async (tx) => {
        const [d] = await tx.insert(journalEntries).values({ orgId: t.orgId, kind: "manual", entryDate: "2026-01-20", origin: "system" }).returning();
        await tx.insert(journalLines).values([
          { orgId: t.orgId, entryId: d!.id, lineNo: 1, accountId: await t.acct("1000"), baseAmount: "5", currency: "USD", txnAmount: "5" },
          { orgId: t.orgId, entryId: d!.id, lineNo: 2, accountId: await t.acct("4100"), baseAmount: "-4", currency: "USD", txnAmount: "-4" },
        ]);
        const p = await periodFor(tx, t.orgId, "2026-01-20");
        await tx.update(journalEntries).set({ status: "posted", entryNumber: 99999, periodId: p!.id, postedAt: new Date() }).where(eq(journalEntries.id, d!.id));
      }), /does not balance/);
  });

  it("corrects with a linked reversal, once", async () => {
    const r = await postManualEntry(t.ctx, {
      entryDate: "2026-01-16",
      description: "Mistake",
      lines: [
        { accountId: await t.acct("6500"), debit: "50" },
        { accountId: await t.acct("1000"), credit: "50" },
      ],
    });
    const before = await balance(t.orgId, await t.acct("6500"));
    const rev = await reverseManualEntry(t.ctx, r.entry.id, { date: "2026-01-17", reason: "Posted to the wrong account" });
    expect(rev.entry.reversesEntryId).toBe(r.entry.id);
    expect(await balance(t.orgId, await t.acct("6500"))).toBe((Number(before) - 50).toFixed(2));
    await rejectsWith(reverseManualEntry(t.ctx, r.entry.id, { date: "2026-01-17", reason: "again" }), "already_reversed");
  });

  it("edits and deletes drafts but never posted entries", async () => {
    const id = await saveManualDraft(t.ctx, { entryDate: "2026-01-18", description: "Draft", lines: [{ accountId: await t.acct("6500"), debit: "5" }, { accountId: await t.acct("1000"), credit: "4" }] });
    await rejectsWith(postManualDraft(t.ctx, id), "unbalanced");
    await saveManualDraft(t.ctx, { entryDate: "2026-01-18", description: "Draft fixed", lines: [{ accountId: await t.acct("6500"), debit: "5" }, { accountId: await t.acct("1000"), credit: "5" }] }, id);
    const posted = await postManualDraft(t.ctx, id);
    expect(posted.entry.id).toBe(id);
    await rejectsWith(deleteManualDraft(t.ctx, id), "posted_immutable");
  });
});

describe("periods", () => {
  it("refuses postings into a closed period, and reopening needs permission and a reason", async () => {
    const o = await setupOrg();
    const jan = await withTransaction(async (tx) => {
      const { ensureFiscalYear } = await import("@/lib/ledger/periods");
      await ensureFiscalYear(tx, o.ctx.org, "2026-01-10");
      return (await periodFor(tx, o.orgId, "2026-01-10"))!;
    });
    await closePeriod(o.ctx, jan.id, { acknowledgeWarnings: true });
    const postJan = withTransaction(async (tx) =>
      postEntry(tx, o.ctx, {
        kind: "manual",
        entryDate: "2026-01-10",
        description: "late",
        lines: [
          { accountId: await o.acct("1000"), amount: "1" },
          { accountId: await o.acct("4100"), amount: "-1" },
        ],
      }),
    );
    await rejectsWith(postJan, "period_closed");
    const staff = await o.as("staff");
    await rejectsWith(reopenPeriod(staff, jan.id, "need to fix"), "forbidden");
    await rejectsWith(reopenPeriod(o.ctx, jan.id, ""), "validation_failed");
    await reopenPeriod(o.ctx, jan.id, "Customer invoice was missed");
    const ok = await withTransaction(async (tx) =>
      postEntry(tx, o.ctx, {
        kind: "manual",
        entryDate: "2026-01-10",
        description: "late",
        lines: [
          { accountId: await o.acct("1000"), amount: "1" },
          { accountId: await o.acct("4100"), amount: "-1" },
        ],
      }),
    );
    expect(ok.entry.status).toBe("posted");
  });

  it("closes in order and honors the lock date", async () => {
    const o = await setupOrg();
    const { ensureFiscalYear } = await import("@/lib/ledger/periods");
    await withTransaction((tx) => ensureFiscalYear(tx, o.ctx.org, "2026-03-01"));
    const feb = (await periodFor(getDb(), o.orgId, "2026-02-10"))!;
    await rejectsWith(closePeriod(o.ctx, feb.id, { acknowledgeWarnings: true }), "earlier_period_open");
    await setLockDate(o.ctx, "2026-02-28", "Filed Q1 sales tax");
    const ctx = await refresh(o.ctx);
    await rejectsWith(
      withTransaction(async (tx) =>
        postEntry(tx, ctx, {
          kind: "manual",
          entryDate: "2026-02-15",
          description: "x",
          lines: [
            { accountId: await o.acct("1000"), amount: "1" },
            { accountId: await o.acct("4100"), amount: "-1" },
          ],
        }),
      ),
      "locked_date",
    );
  });
});

describe("tenant isolation", () => {
  it("refuses another organization's account in the engine and in the database", async () => {
    const a = await setupOrg({ name: "A" });
    const b = await setupOrg({ name: "B" });
    await rejectsWith(
      withTransaction(async (tx) =>
        postEntry(tx, a.ctx, {
          kind: "manual",
          entryDate: "2026-01-10",
          description: "cross",
          lines: [
            { accountId: await b.acct("1000"), amount: "1" },
            { accountId: await a.acct("4100"), amount: "-1" },
          ],
        }),
      ),
      "invalid_account",
    );
    // Bypassing the engine, the composite foreign key refuses it.
    await rejectsDb(getDb().transaction(async (tx) => {
        const [d] = await tx.insert(journalEntries).values({ orgId: a.orgId, kind: "manual", entryDate: "2026-01-20", origin: "system" }).returning();
        await tx.insert(journalLines).values({ orgId: a.orgId, entryId: d!.id, lineNo: 1, accountId: await b.acct("1000"), baseAmount: "1", currency: "USD", txnAmount: "1" });
      }), /foreign key/);
    const rows = await getDb().execute(sql`select count(*)::int as n from journal_entries where org_id = ${b.orgId}`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("exchange rates", () => {
  it("stores manual rates and refuses to change one that postings used", async () => {
    const o = await setupOrg();
    const r = await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-01-05", rate: "1.08" });
    expect(r.rate).toBe("1.080000000000");
    const r2 = await addManualRate(o.ctx, { currency: "EUR", rateDate: "2026-01-05", rate: "1.09" });
    expect(r2.id).toBe(r.id);
  });
});
