# REST API

The full reference is served by every instance at `/api-docs`, and as
OpenAPI 3.1 at `/api/v1/openapi.json` — both generated from the same zod
schemas the handlers validate with (`lib/api/schemas.ts`, `lib/api/openapi.ts`).

## Authentication and scope

Create a token under **Settings → API tokens**. Send it as
`Authorization: Bearer gbk_…`. A token belongs to one organization and acts
with a role no higher than its creator's current role (lowered if theirs is
lowered; revoked if they leave). Every request is permission-checked on the
server and recorded in the audit log as the token.

Paths are under `/api/v1/orgs/{org}/…`, where `{org}` is the organization's
slug or id; a token for another organization is refused with 403.

## Conventions

- **Amounts are decimal strings** (`"1234.50"`), never JSON numbers. Dates are `YYYY-MM-DD`.
- **Lists** take `page` (1-based) and `page_size` (≤ 500) and return `{ data, page, page_size, total, has_more }`.
- **Errors** are `{ error: { code, message, fields? }, request_id }` with 401, 403, 404, 409 (conflict, refused by the ledger, idempotency key reused) or 422 (validation).
- **Idempotency**: endpoints that create or post accept an `Idempotency-Key` header (8–200 characters). A retry with the same key and body returns the first response (header `idempotent-replayed: true`); the same key with a different body is refused; a request that failed can be retried with its key.

## Endpoints

| Area | Endpoints |
|---|---|
| Accounts | `GET/POST /accounts`, `GET/PATCH /accounts/{id}` |
| Journal | `GET/POST /journal-entries`, `GET /journal-entries/{id}`, `POST /journal-entries/{id}/reverse` |
| Contacts | `GET/POST /contacts`, `GET/PATCH /contacts/{id}` |
| Items | `GET/POST /items`, `GET/PATCH /items/{id}` |
| Documents | `GET/POST /documents` (invoices, estimates, credit notes, bills, purchase orders, expenses…; `"issue": true` posts), `GET /documents/{id}`, `POST /documents/{id}/issue`, `POST /documents/{id}/void` |
| Payments | `GET/POST /payments` (with allocations), `GET /payments/{id}`, `POST /payments/{id}/void`, `GET /open-items` |
| Banking | `GET/POST /bank-imports` (statement CSV, with preview and duplicate detection) |
| Payroll | `GET/POST /payroll-imports` ([format](payroll-import-format.md)) |
| Periods | `GET /periods`, `POST /periods/{id}/close`, `POST /periods/{id}/reopen` |
| Currencies | `GET/POST /exchange-rates` |
| Reports | `GET /reports`, `GET /reports/{report}` (JSON, or `format=csv`) — the same tables the pages and exports show |
| Audit | `GET /audit-events` |
| Jobs | `GET /jobs/{id}` |
| Identity | `GET /api/v1/me` |

Recording a payment through the API records it; it never moves money.
