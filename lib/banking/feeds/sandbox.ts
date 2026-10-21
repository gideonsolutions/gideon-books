/**
 * The sandbox feed: clearly labeled sample data, deterministic for a date
 * range, so the whole feed workflow (connect, link, sync, review) can be
 * tried without a bank. It never contacts anything.
 */
import { addDays, compareDates, parts } from "@/lib/dates";
import type { FeedAccount, FeedProvider, FeedTransaction } from "./types";

function txnsFor(accountId: string, start: string, end: string): FeedTransaction[] {
  const out: FeedTransaction[] = [];
  for (let d = start; compareDates(d, end) <= 0; d = addDays(d, 1)) {
    const [, m, day] = parts(d);
    const push = (n: number, amount: string, description: string, payee: string | null) =>
      out.push({ id: `sbx-${accountId}-${d}-${n}`, postedDate: d, amount, description, payee, memo: "Sandbox sample data", raw: { sandbox: true, date: d, n, amount, description } });
    if (accountId === "sbx-checking") {
      if (day % 7 === 1) push(1, "1250.00", `CLIENT DEPOSIT ${m}${day}`, "Client deposit");
      if (day === 1) push(2, "-1500.00", "RENT PAYMENT", "Landlord LLC");
      if (day % 5 === 2) push(3, "-42.17", "OFFICE SUPPLY STORE", "Office Supply Store");
      if (day === 15) push(4, "-89.00", "INTERNET SERVICE", "Fiber Co");
      if (day === 28) push(5, "-12.50", "MONTHLY SERVICE FEE", null);
    } else {
      if (day % 3 === 0) push(1, "-4.75", "COFFEE SHOP", "Corner Coffee");
      if (day % 10 === 4) push(2, "-61.30", "FUEL STATION", "Fuel Station");
      if (day === 20) push(3, "-19.99", "SOFTWARE SUBSCRIPTION", "Cloud Tools Inc");
    }
  }
  return out;
}

export const sandboxFeedProvider: FeedProvider = {
  name: "sandbox",
  label: "Sandbox bank (sample data)",
  mode: "sandbox",
  async connect() {
    return { secret: "sandbox", displayName: "Sandbox bank — sample data, not a real bank" };
  },
  async fetch(_secret, range) {
    const accounts: FeedAccount[] = [
      { id: "sbx-checking", name: "Sandbox Checking", institution: "Sandbox Bank", currency: null, balance: null, balanceDate: range.end, transactions: txnsFor("sbx-checking", range.start, range.end) },
      { id: "sbx-card", name: "Sandbox Card", institution: "Sandbox Bank", currency: null, balance: null, balanceDate: range.end, transactions: txnsFor("sbx-card", range.start, range.end) },
    ];
    return { accounts, warnings: [] };
  },
};
