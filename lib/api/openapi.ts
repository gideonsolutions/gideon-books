/**
 * The API's OpenAPI 3.1 description, generated from the same zod schemas
 * the handlers validate with, so the document cannot drift from the code.
 */
import { z, type ZodType } from "zod";
import * as S from "./schemas";


export interface Operation {
  method: "get" | "post" | "patch";
  path: string;
  summary: string;
  tag: string;
  permission: string;
  body?: ZodType;
  query?: Record<string, string>;
  idempotent?: boolean;
}

const ORG = "/orgs/{org}";

export const OPERATIONS: Operation[] = [
  { method: "get", path: "/me", summary: "Who the token acts as", tag: "Auth", permission: "any token" },
  { method: "get", path: `${ORG}/accounts`, summary: "List the chart of accounts", tag: "Accounts", permission: "ledger.read", query: { archived: "1 to include archived accounts" } },
  { method: "post", path: `${ORG}/accounts`, summary: "Create an account", tag: "Accounts", permission: "accounts.manage", body: S.AccountBody },
  { method: "get", path: `${ORG}/accounts/{id}`, summary: "Get an account with its balance", tag: "Accounts", permission: "ledger.read", query: { as_of: "Balance as of this date" } },
  { method: "patch", path: `${ORG}/accounts/{id}`, summary: "Update an account", tag: "Accounts", permission: "accounts.manage", body: S.AccountBody },
  { method: "get", path: `${ORG}/journal-entries`, summary: "List journal entries", tag: "Journal", permission: "ledger.read", query: { from: "Posting date from", to: "Posting date to", status: "draft|posted", kind: "Entry kind", q: "Search", account_id: "Entries touching this account", page: "Page (1-based)", page_size: "Up to 500" } },
  { method: "post", path: `${ORG}/journal-entries`, summary: "Post a manual journal entry", tag: "Journal", permission: "ledger.post", body: S.JournalEntryBody, idempotent: true },
  { method: "get", path: `${ORG}/journal-entries/{id}`, summary: "Get a journal entry with its lines", tag: "Journal", permission: "ledger.read" },
  { method: "post", path: `${ORG}/journal-entries/{id}/reverse`, summary: "Reverse a manual entry", tag: "Journal", permission: "ledger.reverse", body: S.ReverseBody, idempotent: true },
  { method: "get", path: `${ORG}/contacts`, summary: "List customers, vendors, employees and beneficiaries", tag: "Contacts", permission: "org.read", query: { role: "customer|vendor|employee|beneficiary", q: "Search", archived: "1 to include archived", page: "Page", page_size: "Up to 500" } },
  { method: "post", path: `${ORG}/contacts`, summary: "Create a contact", tag: "Contacts", permission: "contacts.manage", body: S.ContactBody },
  { method: "get", path: `${ORG}/contacts/{id}`, summary: "Get a contact", tag: "Contacts", permission: "org.read" },
  { method: "patch", path: `${ORG}/contacts/{id}`, summary: "Update a contact", tag: "Contacts", permission: "contacts.manage", body: S.ContactBody },
  { method: "get", path: `${ORG}/items`, summary: "List products and services", tag: "Items", permission: "org.read", query: { q: "Search", kind: "service|non_stock|stock", page: "Page", page_size: "Up to 500" } },
  { method: "post", path: `${ORG}/items`, summary: "Create an item", tag: "Items", permission: "items.manage", body: S.ItemBody },
  { method: "get", path: `${ORG}/items/{id}`, summary: "Get an item", tag: "Items", permission: "org.read" },
  { method: "patch", path: `${ORG}/items/{id}`, summary: "Update an item", tag: "Items", permission: "items.manage", body: S.ItemBody },
  { method: "get", path: `${ORG}/documents`, summary: "List sales and purchase documents", tag: "Documents", permission: "org.read", query: { kind: "Comma-separated kinds", status: "A status, or open", contact_id: "Contact", from: "Document date from", to: "to", q: "Search", overdue: "1 for overdue only", page: "Page", page_size: "Up to 500" } },
  { method: "post", path: `${ORG}/documents`, summary: "Create a document (and optionally issue it)", tag: "Documents", permission: "sales.manage or purchases.manage", body: S.DocumentBody, idempotent: true },
  { method: "get", path: `${ORG}/documents/{id}`, summary: "Get a document with lines, taxes, open balance and applications", tag: "Documents", permission: "org.read" },
  { method: "post", path: `${ORG}/documents/{id}/issue`, summary: "Issue (post) a draft", tag: "Documents", permission: "sales.issue or purchases.manage", idempotent: true },
  { method: "post", path: `${ORG}/documents/{id}/void`, summary: "Void an issued document", tag: "Documents", permission: "sales.void or purchases.void", body: S.VoidBody, idempotent: true },
  { method: "get", path: `${ORG}/payments`, summary: "List payments", tag: "Payments", permission: "org.read", query: { kind: "Payment kind", side: "customer|vendor", contact_id: "Contact", account_id: "Money account", from: "Date from", to: "to", unapplied: "1 for payments with an unapplied balance", page: "Page", page_size: "Up to 500" } },
  { method: "post", path: `${ORG}/payments`, summary: "Record a payment and apply it (never moves money)", tag: "Payments", permission: "payments.record", body: S.PaymentBody, idempotent: true },
  { method: "get", path: `${ORG}/payments/{id}`, summary: "Get a payment with its applications", tag: "Payments", permission: "org.read" },
  { method: "post", path: `${ORG}/payments/{id}/void`, summary: "Void a payment", tag: "Payments", permission: "payments.void", body: S.VoidBody, idempotent: true },
  { method: "get", path: `${ORG}/open-items`, summary: "A contact's open receivable or payable items", tag: "Payments", permission: "ledger.read", query: { contact_id: "Contact (required)", side: "receivables|payables (required)", as_of: "As of date" } },
  { method: "get", path: `${ORG}/periods`, summary: "Fiscal years and periods", tag: "Periods", permission: "ledger.read" },
  { method: "post", path: `${ORG}/periods/{id}/close`, summary: "Close a period", tag: "Periods", permission: "periods.close", body: S.PeriodCloseBody },
  { method: "post", path: `${ORG}/periods/{id}/reopen`, summary: "Reopen a period (reason required)", tag: "Periods", permission: "periods.reopen", body: S.PeriodReopenBody },
  { method: "get", path: `${ORG}/exchange-rates`, summary: "Stored exchange rates", tag: "Currencies", permission: "ledger.read", query: { currency: "Filter by currency" } },
  { method: "post", path: `${ORG}/exchange-rates`, summary: "Add a manual rate", tag: "Currencies", permission: "fx.manage", body: S.ExchangeRateBody },
  { method: "get", path: `${ORG}/audit-events`, summary: "The audit trail", tag: "Audit", permission: "audit.read", query: { entity_type: "Filter", entity_id: "Filter", action: "Filter", before: "Page: events before this id", limit: "Up to 500" } },
  { method: "get", path: `${ORG}/jobs/{id}`, summary: "A background job's status", tag: "Jobs", permission: "jobs.read" },
  { method: "get", path: `${ORG}/bank-imports`, summary: "Bank statement import batches", tag: "Banking", permission: "banking.read", query: { account_id: "Money account" } },
  { method: "post", path: `${ORG}/bank-imports`, summary: "Import (or preview) a bank statement CSV; duplicates are skipped", tag: "Banking", permission: "banking.import", body: S.BankImportBody, idempotent: true },
  { method: "get", path: `${ORG}/payroll-imports`, summary: "Payroll imports", tag: "Payroll", permission: "ledger.read" },
  { method: "post", path: `${ORG}/payroll-imports`, summary: "Import a payroll run (docs/payroll-import-format.md), optionally posting it", tag: "Payroll", permission: "payroll.import", body: S.PayrollImportBody, idempotent: true },
  { method: "get", path: `${ORG}/reports`, summary: "Reports available", tag: "Reports", permission: "reports.read" },
  {
    method: "get",
    path: `${ORG}/reports/{report}`,
    summary: "A report as data (trial-balance, balance-sheet, profit-and-loss, cash-flow, ar-aging, ap-aging, sales-tax, …)",
    tag: "Reports",
    permission: "reports.read",
    query: { from: "Start date", to: "End date", asOf: "As-of date (balance sheet, aging)", basis: "accrual|cash", compare: "previous_period|previous_year|months|quarters", format: "json (default) or csv", account: "Account filter", project: "Project filter", class: "Class filter", department: "Department filter", location: "Location filter", fund: "Fund filter" },
  },
];

/** Operations other modules add (reports, banking imports) register here at module load. */
export const EXTRA_OPERATIONS: Operation[] = [];

export function openApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of [...OPERATIONS, ...EXTRA_OPERATIONS]) {
    const params = [...op.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const query = Object.entries(op.query ?? {}).map(([name, description]) => ({ name, in: "query", required: false, description, schema: { type: "string" } }));
    const headers = op.idempotent ? [{ name: "Idempotency-Key", in: "header", required: false, description: "8–200 characters. A retry with the same key and body returns the first response; a different body is refused (409).", schema: { type: "string" } }] : [];
    paths[op.path] ??= {};
    paths[op.path]![op.method] = {
      summary: op.summary,
      tags: [op.tag],
      description: `Requires permission: ${op.permission}.`,
      parameters: [...params, ...query, ...headers],
      ...(op.body ? { requestBody: { required: true, content: { "application/json": { schema: z.toJSONSchema(op.body, { io: "input", unrepresentable: "any" }) } } } } : {}),
      responses: {
        "200": { description: "OK. Single resources are `{ data }`; lists are `{ data, page, page_size, total, has_more }`." },
        "201": { description: "Created" },
        "401": { description: "Missing or invalid token" },
        "403": { description: "The token's role lacks the permission" },
        "404": { description: "Not found in this organization" },
        "409": { description: "Conflict (already done, idempotency key reused, refused by the ledger)" },
        "422": { description: "Validation failed: `{ error: { code, message, fields } }`" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Gideon Books API",
      version: "1",
      description:
        "REST API for one organization's books. Authenticate with an API token (Settings → API tokens) as `Authorization: Bearer gbk_…`. Amounts are decimal strings. Dates are YYYY-MM-DD. POST endpoints marked idempotent accept an Idempotency-Key header.",
      license: { name: "Apache-2.0" },
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths,
  };
}
