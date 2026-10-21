import { beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { createApiToken } from "@/lib/auth/users";
import { GET as listAccounts } from "@/app/api/v1/orgs/[org]/accounts/route";
import { GET as listEntries, POST as postEntry } from "@/app/api/v1/orgs/[org]/journal-entries/route";
import { POST as createDocument } from "@/app/api/v1/orgs/[org]/documents/route";
import { POST as recordPayment } from "@/app/api/v1/orgs/[org]/payments/route";
import { openApiDocument } from "@/lib/api/openapi";
import { customer, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
let ownerToken: string;
let readToken: string;

beforeAll(async () => {
  t = await setupOrg();
  ownerToken = (await createApiToken(t.ctx, { name: "test admin", role: "admin" })).token;
  readToken = (await createApiToken(t.ctx, { name: "test read", role: "read_only" })).token;
});

function req(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost:3200/api/v1/orgs/${t.ctx.org.slug}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ org: t.ctx.org.slug, ...extra }) });

describe("REST API", () => {
  it("requires a token and refuses another organization's token", async () => {
    expect((await listAccounts(req("GET", "/accounts", null), params())).status).toBe(401);
    const other = await setupOrg({ name: "Other" });
    const otherToken = (await createApiToken(other.ctx, { name: "x", role: "admin" })).token;
    expect((await listAccounts(req("GET", "/accounts", otherToken), params())).status).toBe(403);
    const ok = await listAccounts(req("GET", "/accounts", readToken), params());
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.length).toBeGreaterThan(10);
  });

  it("enforces the token's role on the server", async () => {
    const body = { entryDate: "2026-03-01", description: "API entry", lines: [{ accountId: await t.acct("6500"), debit: "10.00" }, { accountId: await t.acct("1000"), credit: "10.00" }] };
    const r = await postEntry(req("POST", "/journal-entries", readToken, body), params());
    expect(r.status).toBe(403);
  });

  it("validates bodies and refuses floats for amounts", async () => {
    const r = await postEntry(req("POST", "/journal-entries", ownerToken, { entryDate: "2026-03-01", description: "x", lines: [{ accountId: await t.acct("6500"), debit: 10 }, { accountId: await t.acct("1000"), credit: 10 }] }), params());
    expect(r.status).toBe(422);
    const j = await r.json();
    expect(j.error.code).toBe("validation_failed");
  });

  it("replays an idempotent request and refuses a reused key with a different body", async () => {
    const body = { entryDate: "2026-03-02", description: "Idempotent", lines: [{ accountId: await t.acct("6500"), debit: "12.34" }, { accountId: await t.acct("1000"), credit: "12.34" }] };
    const a = await postEntry(req("POST", "/journal-entries", ownerToken, body, { "idempotency-key": "api-test-key-1" }), params());
    expect(a.status).toBe(201);
    const b = await postEntry(req("POST", "/journal-entries", ownerToken, body, { "idempotency-key": "api-test-key-1" }), params());
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect((await b.json()).data.id).toBe((await a.json()).data.id);
    const c = await postEntry(req("POST", "/journal-entries", ownerToken, { ...body, description: "Different" }, { "idempotency-key": "api-test-key-1" }), params());
    expect(c.status).toBe(409);
    const list = await listEntries(req("GET", "/journal-entries?q=Idempotent", readToken), params());
    expect((await list.json()).total).toBe(1);
  });

  it("creates and issues an invoice, then records and applies a payment", async () => {
    const c = await customer(t.ctx, "API Customer");
    const inv = await createDocument(req("POST", "/documents", ownerToken, { kind: "invoice", contactId: c.id, issueDate: "2026-03-05", issue: true, lines: [{ description: "Work", quantity: "2", unitPrice: "150.00" }] }, { "idempotency-key": "api-inv-1" }), params());
    expect(inv.status).toBe(201);
    const doc = (await inv.json()).data;
    expect(doc.status).toBe("issued");
    expect(doc.total).toBe("300.0000");
    const pay = await recordPayment(
      req("POST", "/payments", ownerToken, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-10", accountId: await t.acct("1000"), amount: "300.00", allocations: [{ itemType: "document", itemId: doc.id, amount: "300.00" }] }, { "idempotency-key": "api-pay-1" }),
      params(),
    );
    expect(pay.status).toBe(201);
    const again = await recordPayment(
      req("POST", "/payments", ownerToken, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-03-10", accountId: await t.acct("1000"), amount: "300.00", allocations: [{ itemType: "document", itemId: doc.id, amount: "300.00" }] }, { "idempotency-key": "api-pay-1" }),
      params(),
    );
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("describes itself in OpenAPI", () => {
    const docs = openApiDocument("http://localhost:3200");
    expect(docs.openapi).toBe("3.1.0");
    expect(Object.keys(docs.paths)).toContain("/orgs/{org}/journal-entries");
    const post = (docs.paths["/orgs/{org}/journal-entries"] as Record<string, { requestBody?: unknown }>).post;
    expect(post?.requestBody).toBeTruthy();
  });
});

describe("reports API", () => {
  it("returns the same report the page shows, as JSON or CSV", async () => {
    const { GET: report } = await import("@/app/api/v1/orgs/[org]/reports/[report]/route");
    const r = await report(req("GET", "/reports/trial-balance?asOf=2026-12-31&basis=accrual", readToken), params({ report: "trial-balance" }));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.data.rows.length).toBeGreaterThan(0);
    const csv = await report(req("GET", "/reports/trial-balance?asOf=2026-12-31&format=csv", readToken), params({ report: "trial-balance" }));
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const missing = await report(req("GET", "/reports/nope", readToken), params({ report: "nope" }));
    expect(missing.status).toBe(404);
  });
});
