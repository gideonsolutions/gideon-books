"use client";

/**
 * Receive a payment (or a deposit, or record a refund): choose the customer,
 * then how much goes to each open invoice. Anything not applied stays as an
 * unapplied credit. Amounts are checked with exact decimals as you type.
 */
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface OpenRow {
  type: "document" | "payment";
  id: string;
  label: string;
  date: string;
  dueDate: string | null;
  open: string;
}

const METHODS = [
  { value: "check", label: "Check" },
  { value: "ach", label: "ACH / bank transfer" },
  { value: "wire", label: "Wire" },
  { value: "card", label: "Card" },
  { value: "cash", label: "Cash" },
  { value: "other", label: "Other" },
];

function n(v: string) {
  return Decimal.tryFrom(v.replace(/[,\s$]/g, "")) ?? Decimal.ZERO;
}

export function ReceivePaymentForm({
  action,
  slug,
  customers,
  customerId,
  currency,
  baseCurrency,
  invoices,
  credits,
  accounts,
  feeAccounts,
  defaults,
  idempotencyKey,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  slug: string;
  customers: Option[];
  customerId: string;
  currency: string;
  baseCurrency: string;
  invoices: OpenRow[];
  credits: OpenRow[];
  accounts: Option[];
  feeAccounts: Option[];
  defaults: { kind: "customer_payment" | "customer_deposit" | "customer_refund"; date: string; preselect?: string | null; accountId?: string | null };
  idempotencyKey: string;
}) {
  const router = useRouter();
  const [kind, setKind] = useState(defaults.kind);
  const rows = useMemo(() => (kind === "customer_refund" ? credits : kind === "customer_payment" ? invoices : []), [kind, credits, invoices]);
  const pre = rows.find((r) => r.id === defaults.preselect);
  const [amount, setAmount] = useState(pre ? Decimal.from(pre.open).toFixed(2) : "");
  const [applied, setApplied] = useState<Record<string, string>>(pre ? { [pre.id]: Decimal.from(pre.open).toFixed(2) } : {});
  const [showFee, setShowFee] = useState(false);
  const foreign = currency !== baseCurrency;

  const totals = useMemo(() => {
    const appliedSum = Decimal.sum(rows.map((r) => n(applied[r.id] ?? "")));
    const amt = n(amount);
    return { appliedSum, amt, unapplied: amt.sub(appliedSum) };
  }, [rows, applied, amount]);

  const fmt = (d: Decimal | string) => formatMoney(Decimal.from(d).toString(), currency);

  const autoApply = () => {
    let left = n(amount);
    const next: Record<string, string> = {};
    for (const r of [...rows].sort((a, b) => (a.dueDate ?? a.date).localeCompare(b.dueDate ?? b.date))) {
      if (!left.isPositive()) break;
      const take = Decimal.min(left, Decimal.from(r.open));
      next[r.id] = take.toFixed(2);
      left = left.sub(take);
    }
    setApplied(next);
  };

  return (
    <ActionForm action={action} className="space-y-6">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="allocationCount" value={rows.length} />
      <input type="hidden" name="currency" value={currency} />
      <div className="grid gap-4 md:grid-cols-3">
        <SelectField
          label="Customer"
          name="contactId"
          required
          placeholder="Choose…"
          options={customers}
          value={customerId}
          onChange={(e) => router.push(`/o/${slug}/sales/payments/new?customer=${e.target.value}&kind=${kind}`)}
        />
        <SelectField
          label="This is a…"
          name="kind"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setApplied({});
          }}
          options={[
            { value: "customer_payment", label: "Payment (applied to invoices)" },
            { value: "customer_deposit", label: "Deposit or retainer (before invoicing)" },
            { value: "customer_refund", label: "Refund to the customer" },
          ]}
        />
        <TextField label={kind === "customer_refund" ? "Date paid" : "Date received"} name="paymentDate" type="date" required defaultValue={defaults.date} />
        <TextField label={`Amount (${currency})`} name="amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        <SelectField label={kind === "customer_refund" ? "Paid from" : "Deposit to"} name="accountId" required placeholder="Choose…" options={accounts} defaultValue={defaults.accountId ?? ""} hint={kind === "customer_refund" ? undefined : "Undeposited funds, if several receipts go to the bank as one deposit."} />
        <SelectField label="Method" name="method" options={METHODS} defaultValue="check" />
        <TextField label="Reference" name="reference" hint="Check number, transfer ID." />
        {foreign && (
          <>
            <TextField label={`Rate (${baseCurrency} per ${currency})`} name="fxRate" inputMode="decimal" hint="Blank: the stored rate for the date." />
            <TextField label={`Amount that reached the account (${baseCurrency})`} name="accountAmount" inputMode="decimal" hint="For a deposit in your base currency; sets the rate." />
          </>
        )}
      </div>
      {kind === "customer_payment" && !foreign && (
        <div>
          {!showFee ? (
            <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setShowFee(true)}>
              A processor kept a fee from this payment
            </button>
          ) : (
            <div className="grid gap-4 rounded-md border border-slate-200 p-3 md:grid-cols-3">
              <TextField label="Fee withheld" name="feeAmount" inputMode="decimal" hint="The deposit is the amount less the fee." />
              <SelectField label="Fee account" name="feeAccountId" placeholder="Payment processing fees" options={feeAccounts} />
            </div>
          )}
        </div>
      )}

      {kind !== "customer_deposit" && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">{kind === "customer_refund" ? "Credits being refunded" : "Apply to invoices"}</h3>
            {rows.length > 0 && (
              <button type="button" className={buttonClass("ghost", "sm")} onClick={autoApply}>
                Apply oldest first
              </button>
            )}
          </div>
          {!customerId ? (
            <p className="text-sm text-slate-500">Choose the customer to see what is open.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-slate-500">{kind === "customer_refund" ? "This customer has no unapplied credits to refund." : "This customer has no open invoices in this currency; the payment will be an unapplied credit."}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                  <tr>
                    <th className="px-3 py-2 text-left">Item</th>
                    <th className="px-3 py-2 text-left">Date</th>
                    <th className="px-3 py-2 text-left">Due</th>
                    <th className="px-3 py-2 text-right">Open</th>
                    <th className="w-36 px-3 py-2 text-right">Apply</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((r, i) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2">
                        <input type="hidden" name={`alloc.${i}.id`} value={r.id} />
                        <input type="hidden" name={`alloc.${i}.type`} value={r.type} />
                        {r.label}
                      </td>
                      <td className="px-3 py-2">{formatDate(r.date)}</td>
                      <td className="px-3 py-2">{formatDate(r.dueDate)}</td>
                      <td className="num px-3 py-2 text-right">{fmt(r.open)}</td>
                      <td className="px-3 py-1.5">
                        <input
                          name={`alloc.${i}.amount`}
                          value={applied[r.id] ?? ""}
                          onChange={(e) => setApplied((a) => ({ ...a, [r.id]: e.target.value }))}
                          inputMode="decimal"
                          className={cx(inputClass, "num text-right", n(applied[r.id] ?? "").gt(r.open) && "ring-danger-600")}
                          aria-label={`Amount applied to ${r.label}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-3 flex flex-wrap justify-end gap-6 text-sm">
            <span>
              Applied <span className="num font-medium">{fmt(totals.appliedSum)}</span>
            </span>
            <span className={totals.unapplied.isNegative() ? "text-danger-700" : ""}>
              {totals.unapplied.isNegative() ? "Over-applied by " : kind === "customer_refund" ? "Not tied to a credit " : "Left as unapplied credit "}
              <span className="num font-medium">{fmt(totals.unapplied.abs())}</span>
            </span>
          </div>
        </div>
      )}
      {kind === "customer_deposit" && (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">
          A deposit is held as a liability (customer deposits) until you apply it to an invoice from that invoice&apos;s page.
        </p>
      )}
      <TextAreaField label="Memo" name="memo" rows={2} />
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-slate-500">Recording a payment records it in the books; it does not move money.</p>
        <SubmitButton disabled={totals.unapplied.isNegative()} pendingText="Recording…">
          {kind === "customer_refund" ? "Record refund" : kind === "customer_deposit" ? "Record deposit" : "Record payment"}
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
