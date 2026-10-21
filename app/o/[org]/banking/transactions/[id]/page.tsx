import Link from "next/link";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bankImportBatches, bankImportRows, bankTransactions } from "@/lib/db/schema/banking";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getBankTransaction, suggestionsForMany, unmatchedLines } from "@/lib/banking/transactions";
import { loadMoneyAccount } from "@/lib/banking/common";
import { getSystemAccountReadOnly } from "@/lib/ledger/accounts";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { accountOptions, contactOptions, dimensionOptions, moneyAccountOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { addDays } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney } from "@/lib/money/format";
import { readParams, type SearchParams } from "@/lib/web/params";
import { Alert, Badge, Card, DateText, DescriptionList, LinkButton, Money, PageHeader, StatusBadge, Table, Td, Th, buttonClass, cx, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, Options, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { AuditTrail } from "@/components/audit-trail";
import { CategorizeForm } from "@/components/banking/categorize-form";
import { MatchForm } from "@/components/banking/match-form";
import { PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import type { PaymentKind } from "@/lib/db/schema/commerce";
import {
  categorizeAction,
  confirmReviewedAction,
  excludeAction,
  matchAction,
  paymentFromTxnAction,
  restoreAction,
  transferAction,
  undoMatchAction,
} from "../../actions";

export const metadata = { title: "Bank transaction" };

const TABS = [
  ["suggestions", "Suggestions"],
  ["match", "Match"],
  ["categorize", "Categorize"],
  ["transfer", "Transfer"],
  ["payment", "Payment"],
  ["exclude", "Exclude"],
] as const;

export default async function BankTransactionPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org, id } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const { txn, group, items, rule } = await getBankTransaction(db, ctx.orgId, id);
  const account = await loadMoneyAccount(db, ctx, txn.accountId);
  const base = `/o/${org}`;
  const here = `${base}/banking/transactions/${id}`;
  const amount = Decimal.from(txn.amount);
  const cur = txn.currency;
  const [raw] = txn.rawRowId ? await db.select().from(bankImportRows).where(and(eq(bankImportRows.orgId, ctx.orgId), eq(bankImportRows.id, txn.rawRowId))) : [];
  const [batch] = txn.batchId ? await db.select().from(bankImportBatches).where(and(eq(bankImportBatches.orgId, ctx.orgId), eq(bankImportBatches.id, txn.batchId))) : [];
  const history = await listAudit(db, ctx.orgId, { entityType: "bank_transaction", entityId: id });
  const canAct = can(ctx, "banking.categorize");
  const unreviewed = txn.status === "unreviewed";
  const tab = (TABS.find(([k]) => k === sp.tab)?.[0] ?? "suggestions") as (typeof TABS)[number][0];

  const header = (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          {txn.description}
          <StatusBadge status={txn.autoCategorized && !txn.reviewedAt ? "auto-categorized" : txn.status} />
        </span>
      }
      back={{ href: `${base}/banking/transactions${unreviewed ? `?account=${txn.accountId}` : "?status=all"}`, label: "Bank transactions" }}
    />
  );

  const facts = (
    <Card title="What the bank reported">
      <div className={cx("num mb-3 text-2xl font-semibold", amount.isPositive() ? "text-emerald-700" : "text-slate-900")}>
        {formatMoney(txn.amount, cur)} <span className="text-sm font-normal text-slate-500">{amount.isPositive() ? "money in" : "money out"}</span>
      </div>
      <DescriptionList
        items={[
          { label: "Date", value: <DateText date={txn.postedDate} /> },
          { label: "Account", value: <Link href={`${base}/banking/accounts/${account.id}`} className="text-brand-700 hover:underline">{account.name}</Link> },
          { label: "Payee", value: txn.payee },
          { label: "Reference", value: txn.reference },
          { label: "Bank balance after", value: txn.bankBalance ? <Money amount={txn.bankBalance} currency={cur} /> : null },
          { label: "Came from", value: batch ? <Link href={`${base}/banking/imports/${batch.id}`} className="text-brand-700 hover:underline">{batch.source === "feed" ? "Feed sync" : batch.fileName} (row {raw?.rowNumber ?? "?"})</Link> : "—" },
        ]}
      />
      {raw && (
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer">Original record, exactly as received</summary>
          <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2">{JSON.stringify(raw.raw, null, 2)}</pre>
        </details>
      )}
    </Card>
  );

  if (!unreviewed) {
    return (
      <>
        {header}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            {txn.status === "excluded" && (
              <Alert tone="warning" title="Excluded">
                {txn.statusReason}
                {canAct && (
                  <div className="mt-2">
                    <ActionButton action={restoreAction.bind(null, org, id)} size="sm">
                      Restore to review
                    </ActionButton>
                  </div>
                )}
              </Alert>
            )}
            {txn.status === "removed" && <Alert tone="warning" title="Removed">{txn.statusReason}</Alert>}
            {txn.autoCategorized && !txn.reviewedAt && (
              <Alert tone="warning" title={`Posted automatically by the rule “${rule?.name ?? "?"}”`}>
                Check the entry below. Confirm it, or undo it to categorize the transaction yourself.
                {canAct && (
                  <div className="mt-2 flex gap-2">
                    <ActionButton action={confirmReviewedAction.bind(null, org, [id])} size="sm" variant="primary">
                      Confirm
                    </ActionButton>
                  </div>
                )}
              </Alert>
            )}
            {group && (
              <Card
                title={group.kind === "match" ? "Matched to" : group.kind === "payment" ? "Recorded as a payment" : group.kind === "transfer" ? "Recorded as a transfer" : "Categorized as"}
                actions={
                  canAct &&
                  group.status === "active" && (
                    <ConfirmButton
                      action={undoMatchAction.bind(null, org, group.id)}
                      label="Undo"
                      size="sm"
                      title="Undo this?"
                      body={
                        group.kind === "categorized" || group.kind === "transfer"
                          ? "The entry it posted is reversed (both kept in the books), and the transaction goes back to review."
                          : group.kind === "payment"
                            ? "The transaction is unmatched and goes back to review. The payment stays recorded; void it from its own page if it should not exist."
                            : "The transaction is unmatched and goes back to review. Nothing in the books changes."
                      }
                      reasonLabel="Why?"
                      confirmLabel="Undo"
                      variant="danger"
                    />
                  )
                }
                padded={false}
              >
                <Table className="rounded-none border-0 shadow-none">
                  <thead>
                    <tr>
                      <Th>Item</Th>
                      <Th align="right">Amount</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map(({ item, line, entry, txn: other }) => (
                      <tr key={item.id}>
                        <Td>
                          {entry ? (
                            <Link href={`${base}/accounting/journal/${entry.id}`} className="text-brand-700 hover:underline">
                              Entry #{entry.entryNumber} · {line?.description || entry.description} · <DateText date={entry.entryDate} />
                            </Link>
                          ) : other ? (
                            <Link href={`${base}/banking/transactions/${other.id}`} className="hover:text-brand-700">
                              Bank: {other.description} · <DateText date={other.postedDate} />
                            </Link>
                          ) : null}
                        </Td>
                        <Td align="right">
                          <Money amount={item.amount} currency={cur} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {group.entryId && (
                  <div className="border-t border-slate-100 px-4 py-2 text-sm">
                    <Link href={`${base}/accounting/journal/${group.entryId}`} className="text-brand-700 hover:underline">
                      View the posted entry
                    </Link>
                  </div>
                )}
              </Card>
            )}
          </div>
          <div className="space-y-6">
            {facts}
            <AuditTrail events={history} />
          </div>
        </div>
      </>
    );
  }

  // Unreviewed: the actions.
  const suggestions = (await suggestionsForMany(db, ctx, [txn])).get(id) ?? [];
  const tabLink = (k: string) => `${here}?tab=${k}`;
  let body: React.ReactNode = null;

  if (tab === "suggestions") {
    body = suggestions.length === 0 ? (
      <p className="text-sm text-slate-600">
        No suggestions. <Link className="text-brand-700 hover:underline" href={tabLink("match")}>Find a match</Link> or{" "}
        <Link className="text-brand-700 hover:underline" href={tabLink("categorize")}>categorize it</Link>.
      </p>
    ) : (
      <ul className="space-y-3">
        {suggestions.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 p-3">
            <div className="min-w-0 text-sm">
              <Badge tone="blue">{s.type}</Badge>{" "}
              {s.type === "match" && (
                <>
                  Entry #{s.line.entryNumber} · {s.line.description} · <DateText date={s.line.entryDate} /> · {formatMoney(s.line.amount, cur)}
                  {s.line.contactName ? ` · ${s.line.contactName}` : ""}
                </>
              )}
              {s.type === "rule" && (
                <>
                  Rule “{s.rule.name}”: {s.splits.map((x) => formatMoney(x.amount.toString(), cur)).join(" + ")}
                </>
              )}
              {s.type === "transfer" && (
                <>
                  {amount.isNegative() ? "To" : "From"} {s.accountName}: {s.counterpart.description} on <DateText date={s.counterpart.postedDate} />
                </>
              )}
              {(s.type === "invoice" || s.type === "bill") && (
                <>
                  {s.type === "invoice" ? "Payment of" : "Payment of bill"} {s.number} from {s.contactName} ({formatMoney(s.openAmount, s.currency)} open)
                </>
              )}
            </div>
            {canAct && (
              <div className="shrink-0">
                {s.type === "match" && (
                  <ActionForm action={matchAction.bind(null, org, [id])} className="inline">
                    <input type="hidden" name="lineId" value={s.line.lineId} />
                    <SubmitButton pendingText="Matching…">Match</SubmitButton>
                  </ActionForm>
                )}
                {s.type === "rule" && (
                  <ActionForm action={categorizeAction.bind(null, org, id)} className="inline">
                    <input type="hidden" name="ruleId" value={s.rule.id} />
                    {s.rule.actions.memo && <input type="hidden" name="memo" value={s.rule.actions.memo} />}
                    {s.splits.map((x, k) => (
                      <span key={k}>
                        <input type="hidden" name={`splits.${k}.accountId`} value={x.accountId} />
                        <input type="hidden" name={`splits.${k}.amount`} value={x.amount.toString()} />
                        {x.description && <input type="hidden" name={`splits.${k}.description`} value={x.description} />}
                        {s.rule.actions.contactId && <input type="hidden" name={`splits.${k}.contactId`} value={s.rule.actions.contactId} />}
                        {s.rule.actions.projectId && <input type="hidden" name={`splits.${k}.projectId`} value={s.rule.actions.projectId} />}
                        {s.rule.actions.classId && <input type="hidden" name={`splits.${k}.classId`} value={s.rule.actions.classId} />}
                        {s.rule.actions.departmentId && <input type="hidden" name={`splits.${k}.departmentId`} value={s.rule.actions.departmentId} />}
                        {s.rule.actions.locationId && <input type="hidden" name={`splits.${k}.locationId`} value={s.rule.actions.locationId} />}
                        {s.rule.actions.fundId && <input type="hidden" name={`splits.${k}.fundId`} value={s.rule.actions.fundId} />}
                      </span>
                    ))}
                    <SubmitButton pendingText="Posting…">Apply rule</SubmitButton>
                  </ActionForm>
                )}
                {s.type === "transfer" && (
                  <ActionForm action={transferAction.bind(null, org, id)} className="inline">
                    <input type="hidden" name="toAccountId" value={s.counterpart.accountId} />
                    <input type="hidden" name="counterpartId" value={s.counterpart.id} />
                    <SubmitButton pendingText="Recording…">Record transfer</SubmitButton>
                  </ActionForm>
                )}
                {(s.type === "invoice" || s.type === "bill") && (
                  <Link className={buttonClass("secondary")} href={`${here}?tab=payment&contact=${s.contactId}&kind=${s.type === "invoice" ? "customer_payment" : "vendor_payment"}&doc=${s.documentId}`}>
                    Record payment…
                  </Link>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    );
  }

  if (tab === "match") {
    const from = sp.from || addDays(txn.postedDate, -45);
    const to = sp.to || addDays(txn.postedDate, 45);
    const lines = await unmatchedLines(db, ctx, account.id, { from, to, q: sp.q, limit: 300 });
    const suggestedIds = new Set(suggestions.filter((s) => s.type === "match").map((s) => (s.type === "match" ? s.line.lineId : "")));
    const others = await db
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.accountId, account.id), eq(bankTransactions.status, "unreviewed"), ne(bankTransactions.id, id), gte(bankTransactions.postedDate, addDays(txn.postedDate, -10)), lte(bankTransactions.postedDate, addDays(txn.postedDate, 10))));
    body = (
      <div className="space-y-4">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="match" />
          <label className="text-xs font-medium text-slate-600">
            From
            <input type="date" name="from" defaultValue={from} className={inputClass} />
          </label>
          <label className="text-xs font-medium text-slate-600">
            To
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Search
            <input name="q" defaultValue={sp.q} placeholder="Description, contact, amount" className={inputClass} />
          </label>
          <button className={buttonClass("secondary")}>Search</button>
        </form>
        <MatchForm
          action={matchAction.bind(null, org, [id])}
          amount={txn.amount}
          currency={cur}
          lines={lines.map((l) => ({ lineId: l.lineId, entryNumber: l.entryNumber, entryDate: l.entryDate, description: l.description, contactName: l.contactName, amount: l.amount, suggested: suggestedIds.has(l.lineId) }))}
          otherTxns={others.map((o) => ({ id: o.id, date: o.postedDate, description: o.description, amount: o.amount }))}
        />
      </div>
    );
  }

  if (tab === "categorize") {
    const accounts = (await accountOptions(db, ctx.orgId, { excludeControl: true })).filter((o) => o.value !== account.id);
    const feeAccount = (await getSystemAccountReadOnly(db, ctx.orgId, "payment_fees"))?.id ?? null;
    const ruleSuggestion = suggestions.find((s) => s.type === "rule");
    body = (
      <CategorizeForm
        action={categorizeAction.bind(null, org, id)}
        amount={amount.abs().toString()}
        currency={cur}
        accounts={accounts}
        contacts={await contactOptions(db, ctx.orgId)}
        dims={await dimensionOptions(db, ctx.orgId)}
        feeAccountId={feeAccount}
        postingDate={txn.postedDate}
        ruleId={ruleSuggestion?.type === "rule" ? ruleSuggestion.rule.id : null}
        defaults={
          ruleSuggestion?.type === "rule"
            ? ruleSuggestion.splits.map((x) => ({ accountId: x.accountId, amount: x.amount.toString(), description: x.description ?? "", contactId: ruleSuggestion.rule.actions.contactId ?? "" }))
            : undefined
        }
      />
    );
  }

  if (tab === "transfer") {
    const moneyAccounts = (await moneyAccountOptions(db, ctx.orgId)).filter((o) => o.value !== account.id);
    const counterparts = suggestions.filter((s) => s.type === "transfer");
    body = (
      <ActionForm action={transferAction.bind(null, org, id)} className="space-y-4">
        <p className="text-sm text-slate-600">
          Money moved {amount.isNegative() ? "from this account to" : "into this account from"} another account the organization owns (savings, a credit card payment, cash). Both sides
          are posted in one entry; if the other account&apos;s bank transaction is already imported, pick it so both are matched.
        </p>
        <SelectField label={amount.isNegative() ? "Transferred to" : "Transferred from"} name="toAccountId" options={moneyAccounts} placeholder="Choose…" required />
        <SelectField
          label="The other account's bank transaction"
          name="counterpartId"
          placeholder="Not imported yet"
          options={counterparts.map((c) => (c.type === "transfer" ? { value: c.counterpart.id, label: `${c.accountName}: ${c.counterpart.description} (${c.counterpart.postedDate}, ${formatMoney(c.counterpart.amount, cur)})` } : { value: "", label: "" }))}
        />
        <TextField label="Memo" name="memo" />
        <SubmitButton pendingText="Recording…">Record transfer</SubmitButton>
      </ActionForm>
    );
  }

  if (tab === "payment") {
    const inflow = amount.isPositive();
    const kinds: PaymentKind[] = inflow ? ["customer_payment", "customer_deposit", "vendor_refund"] : ["vendor_payment", "vendor_prepayment", "customer_refund"];
    const kind = (kinds.includes(sp.kind as PaymentKind) ? sp.kind : kinds[0]) as PaymentKind;
    const customerSide = kind.startsWith("customer");
    const contacts = await contactOptions(db, ctx.orgId, customerSide ? "customer" : "vendor");
    const contactId = sp.contact && contacts.some((c) => c.value === sp.contact) ? sp.contact : "";
    const open = contactId ? await openItemsForContact(db, ctx.orgId, customerSide ? "receivables" : "payables", contactId) : [];
    // What this kind of payment can be applied to.
    const applicable = open.filter((o) => {
      if (kind === "customer_payment") return o.kind === "invoice";
      if (kind === "vendor_payment") return o.kind === "bill";
      if (kind === "customer_refund") return o.nature === "credit";
      if (kind === "vendor_refund") return o.nature === "debit";
      return false;
    });
    let remaining = amount.abs();
    const prefill = new Map<string, string>();
    for (const o of applicable.filter((x) => x.id === sp.doc).concat(applicable.filter((x) => x.id !== sp.doc))) {
      if (o.currency !== cur || remaining.isZero()) continue;
      const take = Decimal.min(remaining, o.openTxn);
      prefill.set(o.id, take.toString());
      remaining = remaining.sub(take);
    }
    body = (
      <div className="space-y-4">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="tab" value="payment" />
          <label className="text-xs font-medium text-slate-600">
            Kind
            <select name="kind" defaultValue={kind} className={inputClass}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {PAYMENT_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            {customerSide ? "Customer" : "Vendor"}
            <select name="contact" defaultValue={contactId} className={inputClass}>
              <option value="">Choose…</option>
              <Options options={contacts} />
            </select>
          </label>
          <button className={buttonClass("secondary")}>Show open items</button>
        </form>
        {contactId && (
          <ActionForm action={paymentFromTxnAction.bind(null, org, id)} className="space-y-4">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="contactId" value={contactId} />
            {applicable.length > 0 ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Item</Th>
                    <Th>Date</Th>
                    <Th align="right">Open</Th>
                    <Th align="right">Apply</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {applicable.map((o) => (
                    <tr key={o.id}>
                      <Td>
                        {o.kind.replace(/_/g, " ")} {o.number}
                      </Td>
                      <Td>
                        <DateText date={o.date} />
                      </Td>
                      <Td align="right">
                        <Money amount={o.openTxn} currency={o.currency} />
                      </Td>
                      <Td align="right">
                        <input name={`alloc.${o.type}.${o.id}`} defaultValue={prefill.get(o.id) ?? ""} className={cx(inputClass, "num w-28 text-right")} inputMode="decimal" aria-label={`Apply to ${o.number}`} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-slate-600">Nothing open to apply this to; the payment will be recorded as an open {kind === "customer_deposit" ? "deposit" : kind === "vendor_prepayment" ? "prepayment" : "credit"}.</p>
            )}
            {kind === "customer_payment" && <TextField label="Processor fee withheld (if the deposit is net of a fee)" name="feeAmount" inputMode="decimal" hint="The payment is recorded gross; the fee is expensed." />}
            <TextField label="Memo" name="memo" defaultValue={txn.description} />
            <p className="text-xs text-slate-500">Recording a payment records it in the books. It does not move any money.</p>
            <SubmitButton pendingText="Recording…">Record {PAYMENT_KIND_LABELS[kind].toLowerCase()}</SubmitButton>
          </ActionForm>
        )}
      </div>
    );
  }

  if (tab === "exclude") {
    body = (
      <ActionForm action={excludeAction.bind(null, org, [id])} className="space-y-4">
        <p className="text-sm text-slate-600">Exclude a transaction that does not belong in these books — a duplicate, a personal charge on a business card, a bank error that reversed itself. It stays on record and can be restored.</p>
        <TextField label="Why?" name="reason" required />
        <SubmitButton variant="danger">Exclude</SubmitButton>
      </ActionForm>
    );
  }

  return (
    <>
      {header}
      {txn.possibleDuplicateOfId && (
        <div className="mb-4">
          <Alert tone="warning" title="This may duplicate a transaction already imported">
            A feed delivered it, but a file import already has one with the same date, amount and description.{" "}
            <Link className="underline" href={`${base}/banking/transactions/${txn.possibleDuplicateOfId}`}>
              Compare
            </Link>{" "}
            and exclude one of them if so.
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card padded={false}>
          <nav className="flex flex-wrap gap-1 border-b border-slate-200 px-2 pt-2" aria-label="Review actions">
            {TABS.filter(([k]) => canAct || k === "suggestions").map(([k, label]) => (
              <Link
                key={k}
                href={tabLink(k)}
                aria-current={tab === k ? "page" : undefined}
                className={cx("rounded-t-md px-3 py-2 text-sm", tab === k ? "border border-b-white border-slate-200 bg-white font-medium text-brand-700 -mb-px" : "text-slate-600 hover:text-slate-900")}
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="p-4">{canAct || tab === "suggestions" ? body : <p className="text-sm text-slate-600">Your role can view bank transactions but not review them.</p>}</div>
        </Card>
        <div className="space-y-6">
          {facts}
          <LinkButton variant="secondary" href={`${base}/banking/rules/new?from=${id}`}>
            Make a rule from this
          </LinkButton>
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
