# Banking and reconciliation

Banking keeps **what the bank says** apart from **what the books say**. Imported
and fed bank transactions are observations (`bank_transactions`); they never
change balances. Balances change only when a person — or a rule they allowed to
post — turns a bank transaction into a posting, or matches it to a posting that
already exists. Code: `lib/banking/`; pages: `/o/<org>/banking/…`.

## Accounts

Any account of type Bank, Cash, Clearing or Credit card is a money account
(`bank_account_details` holds the institution and last digits). Amounts on a
money account are read in the account's currency: the transaction amount on a
foreign-currency account, the base amount otherwise.

## Importing statements (`lib/banking/imports.ts`, `csv.ts`)

1. **Parse.** RFC 4180 CSV: quoted fields, doubled quotes, delimiters and line
   breaks inside quotes, CRLF or LF, a leading byte-order mark. The delimiter
   (`,` `;` tab `|`) is detected from the first lines unless chosen. Files that
   are not UTF-8 are read as Windows-1252 in the browser.
2. **Map.** Date column and format (`YYYY-MM-DD`, `MM/DD/YYYY`, `M/D/YY`,
   `DD/MM/YYYY`, `DD.MM.YYYY`, `YYYY/MM/DD`; two-digit years are 20xx below 70),
   one signed amount column or separate debit (money out) and credit (money in)
   columns, an option to flip signs (card exports that show charges as
   positive), decimal commas, description, payee, reference and balance
   columns, a header row and rows to skip. A guess is made from the header; a
   mapping can be saved by name and is offered again for a file with the same
   header.
3. **Preview.** Every row is checked before anything is saved: unparseable
   dates or amounts, more decimal places than the currency has, zero amounts and
   empty descriptions are listed per row; duplicates are flagged.
4. **Commit.** One transaction writes the batch (file name, SHA-256, mapping as
   used, counts, who, when), **every raw row verbatim** with its outcome
   (`imported`, `duplicate`, `error`) — the rows are append-only, enforced by a
   trigger — and the new bank transactions. The original file is also kept as
   an attachment on the batch. Imports into one account are serialized with an
   advisory lock. Rules run over the new transactions.

Amounts are parsed by `parseUserAmount` (`"$1,234.56"`, `"(12.00)"`, `"12-"`,
`"12.00 DR"`, `"USD 99.99"`, decimal commas) straight into `Decimal`; no
floating point is involved.

### Duplicate detection

Each row's fingerprint is a hash of the account, date, amount, normalized
description (case, accents, punctuation and spacing ignored) and its
**occurrence number** among identical rows in the same file. So:

- the same file imported twice produces the same fingerprints: nothing new the
  second time;
- two identical rows in one file (two coffees, same day, same price) are two
  transactions;
- an overlapping export (last week's rows plus this week's) imports only the new
  rows.

A flagged duplicate is imported only if the person ticks it ("import anyway");
it then gets a fingerprint of its own. Feed transactions are also deduplicated
by the provider's transaction id; a feed transaction whose fingerprint equals a
file-imported one is imported but marked "possible duplicate" for the person to
compare.

### Undoing an import

Allowed while none of the batch's transactions is matched or categorized (undo
those first). Its transactions are marked `removed` with the reason — kept for
history, out of review — and the same file can be imported again. The batch and
its raw rows stay.

## Reviewing (`lib/banking/transactions.ts`)

The review queue shows transactions that are unreviewed, plus those a rule
auto-categorized and nobody has confirmed. For each, **suggestions** are
computed together for a page of transactions:

| suggestion | when | score |
|---|---|---|
| match | an unmatched posted line on the same account with exactly the same amount within ±7 days | 60 + up to 30 for date closeness + up to 10 for shared words (+20 if the reference equals the entry's reference) |
| rule | the first active rule that matches (see below) | 75 |
| transfer | an unreviewed bank transaction on another money account, opposite amount, same currency, within ±5 days | 50 + up to 30 for date closeness |
| invoice / bill | an open invoice (money in) or bill (money out) whose open amount equals the transaction | 40 + up to 40 for name/number similarity |

Actions:

- **Match** to one or more existing lines on the account, optionally together
  with other bank transactions on the account (several card settlements in one
  deposit). The two sides must add up exactly; a line can belong to one active
  match (unique index), a bank transaction to one.
- **Categorize**: post an entry (kind `bank`, source `bank_transaction`) of the
  bank line against one or more category lines (a split, each with its own
  contact and dimensions). A bank fee is one more split line. The splits must
  add up to the transaction. Control accounts (receivables, payables, inventory,
  assets) are refused — record a payment instead. A refund coming in is a
  categorization back to the expense account (or a recorded refund).
- **Transfer** to or from another of the organization's money accounts (same
  currency): one entry; the other side's bank transaction, if imported, is
  matched too.
- **Record a payment** (customer payment, deposit, vendor refund for money in;
  vendor payment, prepayment, customer refund for money out) through the
  receivables/payables engine, applied to the chosen documents, then matched. A
  customer payment can be net of a processor fee (recorded gross; fee expensed).
  **Recording a payment never moves money.**
- **Exclude** with a reason (duplicate, personal); restorable.
- **Undo** any of the above with a reason: a categorization or transfer entry
  is reversed (both entries stay in the books); a match or payment match is
  unmatched (a recorded payment stays — void it on its own page). Refused while
  the entry is cleared in a completed reconciliation (undo that first) or ticked
  in one in progress.
- **Accept suggestions** in bulk applies only a rule or a single exact match;
  anything ambiguous is left for a person.

## Rules (`lib/banking/rules.ts`, `rules-engine.ts`)

A rule has conditions (description contains / equals / matches a regular
expression of at most 200 characters, payee contains, amount range on the
absolute amount, direction, account) — all must hold, and a rule with no
condition is refused — and actions (one or more category accounts: fixed
amounts first, then percentages of the remainder, which must total 100; contact;
dimensions; memo).

**Precedence:** rules are tried by priority number, lowest first (ties by
creation); the first that matches *and whose fixed amounts fit* wins. The list
shows the order; ↑/↓ swaps neighbours (priorities are renumbered 10, 20, 30…).

**Preview** lists the waiting transactions a rule (saved or being edited) would
take and what it would post, and marks those a higher-priority rule takes first.

**Modes.** `suggest` (default) only suggests. `auto_categorize` posts on its own
**only if both**:

1. the organization's setting *bank rules may auto-post* is on
   (`organizations.bank_rules_auto_post`, changed by an administrator holding
   `banking.rules.autopost`), and
2. whoever last saved the rule held `banking.rules.autopost` at the time
   (recorded as `editor_may_autopost`).

Otherwise it suggests. Auto-posted transactions are marked "auto-categorized —
confirm" and stay in the review queue until a person confirms them; they can be
undone like any categorization. If an auto-post fails (a closed period, an
archived account) the rule falls back to a suggestion and the failure is logged.
Every rule change (`banking.rule_created/updated/moved/deleted`) and every
application (`banking.rule_applied`, plus `bank_rule_applications` with
`suggested`, `auto_categorized`, `accepted`, `undone`) is recorded.

## Reconciliation (`lib/banking/reconcile.ts`)

- **Start** with the statement's closing date and ending balance. The opening
  balance is the previous completed reconciliation's ending balance (zero for
  the first). The statement date must be after the last one. One reconciliation
  per account can be in progress.
- The screen lists every posted line on the account dated on or before the
  statement date that no completed reconciliation has cleared. Lines already
  matched to a bank transaction dated within the statement start ticked.
  Entries that were later reversed (a voided payment) are badged, and their
  reversal lines appear too, so the two can be ticked together or the voided
  one left out.
- **Cleared balance** = opening + ticked lines; **difference** = statement −
  cleared. Progress can be saved.
- **Complete** only at a zero difference — or with an explicit adjustment and a
  reason (permission `banking.reconcile`): the difference is posted on the
  statement date between the account and *Reconciliation Discrepancies* (kind
  `reconciliation_adjustment`) and cleared with the rest. Completed figures are
  final (database trigger).
- Unticked lines dated on or before the statement date are its **outstanding
  items**; the report shows them, and when each cleared later.
- **Undo** (permission `banking.reconcile.reopen`, a reason) only the latest
  completed reconciliation of an account, with none in progress: its lines are
  uncleared and its adjustment entry reversed.
- A line is cleared by at most one active reconciliation (unique index).

## Period close

`lib/banking/close-check.ts` adds two warnings to the close checklist: bank and
card accounts with postings not reconciled through the period end, and bank
transactions dated in the period still waiting for review.

## Jobs

`banking.feed_sync` — with `{ orgId, connectionId }` syncs one feed; with `{}`
syncs every active feed (`syncAllFeeds()`; the scheduler enqueues it daily).

## Permissions

| action | permission |
|---|---|
| see banking | `banking.read` |
| import, sync, undo an import | `banking.import` |
| match, categorize, transfer, exclude, undo, confirm | `banking.categorize` (+ `payments.record` to record a payment) |
| create/edit/order rules | `banking.rules.manage` |
| let rules post on their own | `banking.rules.autopost` (and the organization setting) |
| reconcile, adjust | `banking.reconcile` |
| undo a reconciliation | `banking.reconcile.reopen` |
| connect/disconnect feeds, link accounts | `integrations.manage` |
