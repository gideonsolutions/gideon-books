import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bankFeedAccounts } from "@/lib/db/schema/banking";
import { integrationConnections } from "@/lib/db/schema/core";
import { connectFeed, disconnectFeed, linkFeedAccount, listFeedConnections, syncConnection } from "@/lib/banking/feeds/sync";
import { mapSimplefinAccounts, setSimplefinFetchForTests } from "@/lib/banking/feeds/simplefin";
import { rejectsWith, setupOrg, type TestOrg } from "../helpers";
import { txnsOf } from "./helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});
afterAll(() => setSimplefinFetchForTests(null));

describe("sandbox feed", () => {
  it("connects, links, and syncs idempotently by the provider's ids", async () => {
    const conn = await connectFeed(t.ctx, { provider: "sandbox" });
    expect(conn.mode).toBe("sandbox");
    const [conns] = await listFeedConnections(getDb(), t.orgId);
    const accounts = conns!.accounts;
    const checking = accounts.find((a) => a.externalAccountId === "sbx-checking")!;
    const bank = await t.acct("1000");
    await linkFeedAccount(t.ctx, checking.id, bank);
    const first = await syncConnection(t.ctx, conn.id);
    expect(first.imported).toBeGreaterThan(0);
    const count = (await txnsOf(t.orgId, bank)).length;
    const second = await syncConnection(t.ctx, conn.id);
    expect(second.imported).toBe(0);
    expect((await txnsOf(t.orgId, bank)).length).toBe(count);
    // One feed account per money account.
    const card = accounts.find((a) => a.externalAccountId === "sbx-card")!;
    await rejectsWith(linkFeedAccount(t.ctx, card.id, bank), "already_linked");
    await disconnectFeed(t.ctx, conn.id);
    const [row] = await getDb().select().from(integrationConnections).where(eq(integrationConnections.id, conn.id));
    expect(row!.secretEnc).toBeNull();
    const linked = await getDb().select().from(bankFeedAccounts).where(and(eq(bankFeedAccounts.orgId, t.orgId), eq(bankFeedAccounts.linkedAccountId, bank)));
    expect(linked.length).toBe(0);
  });
});

describe("SimpleFIN", () => {
  it("claims an access URL from a setup token and maps accounts, skipping pending transactions", async () => {
    const claimUrl = "https://bridge.example.test/simplefin/claim/abc";
    const access = "https://user:secret@bridge.example.test/simplefin";
    const calls: { url: string; auth: string | null; method: string }[] = [];
    setSimplefinFetchForTests((async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, auth: new Headers(init?.headers).get("authorization"), method: init?.method ?? "GET" });
      if (u === claimUrl) return new Response(access, { status: 200 });
      return new Response(
        JSON.stringify({
          errors: [],
          accounts: [
            {
              id: "ACT-1",
              name: "Business Checking",
              currency: "USD",
              balance: "1500.25",
              "balance-date": 1767225600,
              org: { name: "Example Bank" },
              transactions: [
                { id: "T1", posted: 1767225600, amount: "-12.34", description: "COFFEE", payee: "Cafe" },
                { id: "T2", posted: 0, amount: "-5.00", description: "PENDING", pending: true },
              ],
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    const conn = await connectFeed(t.ctx, { provider: "simplefin", setupToken: Buffer.from(claimUrl).toString("base64") });
    expect(calls[0]).toMatchObject({ url: claimUrl, method: "POST" });
    // The access URL's credentials go in a header, never the URL.
    const fetchCall = calls.find((c) => c.url.includes("/accounts"))!;
    expect(fetchCall.url).not.toContain("secret@");
    expect(fetchCall.auth).toBe(`Basic ${Buffer.from("user:secret").toString("base64")}`);
    const sf = (await listFeedConnections(getDb(), t.orgId)).find((x) => x.connection.id === conn.id)!;
    expect(sf.accounts.map((a) => a.name)).toEqual(["Business Checking"]);
    const mapped = mapSimplefinAccounts({ accounts: [{ id: "A", transactions: [{ id: "T2", posted: 0, amount: "1" }] }] });
    expect(mapped.accounts[0]!.transactions.length).toBe(0);
  });

  it("refuses live providers for a demonstration company, and a bad token", async () => {
    const demo = await setupOrg({ isDemo: true });
    await rejectsWith(connectFeed(demo.ctx, { provider: "simplefin", setupToken: "x" }), "validation_failed");
    await rejectsWith(connectFeed(t.ctx, { provider: "simplefin", setupToken: Buffer.from("not a url").toString("base64") }), "validation_failed");
  });
});
