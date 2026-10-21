/**
 * A year of a small business — about 2,500 entries — must report well under
 * a second per report on the cash and accrual bases.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, withTransaction } from "@/lib/db/client";
import { postEntry } from "@/lib/ledger/posting";
import { addDays } from "@/lib/dates";
import { balanceSheet, profitAndLoss, trialBalance, cashFlow } from "@/lib/reports/statements";
import { generalLedger } from "@/lib/reports/gl";
import { setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;

beforeAll(async () => {
  t = await setupOrg({ name: "Busy Co" });
  const bank = await t.acct("1000");
  const income = await t.acct("4100");
  const expenses = ["6000", "6200", "6500", "6550", "6800"];
  const expIds = await Promise.all(expenses.map((c) => t.acct(c)));
  let day = "2026-01-01";
  for (let batch = 0; batch < 25; batch++) {
    await withTransaction(async (tx) => {
      for (let i = 0; i < 100; i++) {
        const n = batch * 100 + i;
        if (n % 7 === 0) day = addDays(day, 1);
        const sale = n % 3 === 0;
        const amount = `${(n % 97) + 10}.${String(n % 100).padStart(2, "0")}`;
        await postEntry(tx, t.ctx, {
          kind: "manual",
          entryDate: day,
          description: sale ? `Sale ${n}` : `Expense ${n}`,
          lines: sale
            ? [
                { accountId: bank, amount },
                { accountId: income, amount: `-${amount}` },
              ]
            : [
                { accountId: expIds[n % expIds.length]!, amount },
                { accountId: bank, amount: `-${amount}` },
              ],
        });
      }
    });
  }
  // In production autovacuum keeps planner statistics current; a test database
  // filled seconds ago has none yet, so gather them as autovacuum would.
  await getDb().execute(sql`analyze`);
}, 300_000);

/** Best of five runs: the machine may be busy with other work; this measures the report, not the noise. */
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  let best = Infinity;
  let r: T | undefined;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    r = await fn();
    best = Math.min(best, performance.now() - start);
  }
  return [r!, best];
}

describe("report performance", () => {
  it("renders a year of reports in well under a second each", async () => {
    const db = getDb();
    const org = t.ctx.org;
    const times: Record<string, number> = {};
    // Warm the connection pool and the planner once; then measure.
    await trialBalance(db, org, { asOf: "2026-12-31", basis: "accrual" });
    for (const basis of ["accrual", "cash"] as const) {
      [, times[`tb-${basis}`]] = await timed(() => trialBalance(db, org, { asOf: "2026-12-31", basis }));
      [, times[`bs-${basis}`]] = await timed(() => balanceSheet(db, org, { asOf: "2026-12-31", basis, compare: "previous_year" }));
      [, times[`pl-${basis}`]] = await timed(() => profitAndLoss(db, org, { from: "2026-01-01", to: "2026-12-31", basis, compare: "months" }));
      [, times[`cf-${basis}`]] = await timed(() => cashFlow(db, org, { from: "2026-01-01", to: "2026-12-31", basis }));
      [, times[`gl-${basis}`]] = await timed(() => generalLedger(db, org, { from: "2026-01-01", to: "2026-12-31", basis, page: 3, pageSize: 200 }));
    }
    console.log("report timings (ms):", Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])));
    for (const [k, v] of Object.entries(times)) expect(v, k).toBeLessThan(1000);
  });
});
