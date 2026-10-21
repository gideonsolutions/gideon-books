# Organization export format

Format name `gideon-books-organization-export`, version 1. A ZIP containing:

| path | contents |
|---|---|
| `manifest.json` | what is in the archive and how to check it (below) |
| `organization.json` | the organization row (settings, base currency, fiscal year, profile) |
| `tables/<table>.jsonl` | one JSON object per line per row of that table |
| `attachments/<attachment id>` | the bytes of each attached file |
| `README.txt` | a human note pointing here |

## manifest.json

```json
{
  "format": "gideon-books-organization-export",
  "version": 1,
  "exportedAt": "2026-10-21T15:04:05.000Z",
  "appVersion": "0.1.0",
  "schemaMigration": "0001_integrity",
  "organization": { "id": "…", "name": "…", "slug": "…", "baseCurrency": "USD" },
  "tables": [{ "name": "journal_entries", "file": "tables/journal_entries.jsonl", "rows": 42, "sha256": "…" }],
  "attachments": [{ "id": "…", "file": "attachments/…", "size": 1234, "sha256": "…", "missing": false }],
  "excludedTables": { "memberships": "why…" },
  "notes": ["…"]
}
```

Every file's SHA-256 is in the manifest; an importer must refuse a file that
does not match.

## Rows

- One line per row, keys are the database column names (snake_case), values
  exactly as stored.
- Amounts, rates and quantities are **decimal strings** (`"1234.5600"`), never
  floating-point numbers. Calendar dates are `YYYY-MM-DD`; timestamps are ISO
  8601 in UTC. JSON columns are JSON values.
- Tables are listed in dependency order (a row's foreign-key parents come
  first). Every organization-scoped table is included except those in
  `excludedTables`: access grants (members, invitations, API tokens),
  operational state (jobs, idempotency keys), hosted metering and billing,
  replay-protection records of provider webhooks, export records, and
  entity-group data (which spans several organizations).
- `integration_connections` rows have `secret_enc` set to null and status
  `disconnected`: provider credentials never leave the server.
- Child rows without their own `org_id` (for example `email_events` under
  `email_messages`) are included through their parent.

The ledger itself is in `journal_entries` (posted entries carry
`entry_number`, `posted_at`) and `journal_lines` (`base_amount` signed, debits
positive). Documents, payments, settlements, stock moves, assets, bank
transactions, payroll runs and the audit trail (`audit_events`) are in their
own tables; the column comments in `lib/db/schema/*.ts` describe each one.

## Importing

`lib/ops/import.ts` imports an export into a **new** organization:

- every row id is replaced with a fresh UUID and every reference to it —
  foreign keys, text columns holding an id, ids inside JSON — is rewritten,
  so the same export can be imported on the server it came from;
- journal entries are inserted as drafts with their lines and then posted in
  their original order, keeping their numbers and posting times, so each one
  passes the same database checks (balance, open period) as when first
  posted; closed periods, the lock date, archived accounts and document
  states are restored afterwards;
- attachment bytes are stored under the new organization;
- it all happens in one transaction: an import completes or leaves nothing.

An export from a newer schema than the server's is refused (upgrade first).
