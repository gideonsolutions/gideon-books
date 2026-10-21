"use client";

/**
 * The allocation table of the pay-bills form: what to apply to each open
 * item, with "pay in full" shortcuts and a running total compared with the
 * payment amount (exact decimals).
 */
import { useMemo, useState } from "react";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney, formatDate } from "@/lib/money/format";
import { cx, inputClass } from "@/components/ui";

export interface AllocationCandidate {
  type: "document" | "payment";
  id: string;
  label: string;
  date: string;
  dueDate: string | null;
  open: string;
  overdue: boolean;
}

function n(v: string): Decimal {
  return Decimal.tryFrom(v.replace(/[,\s$]/g, "")) ?? Decimal.ZERO;
}

export function PayAllocations({ candidates, currency, preselect, amountName = "amount", defaultAmount }: { candidates: AllocationCandidate[]; currency: string; preselect?: string | null; amountName?: string; defaultAmount?: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const c of candidates) if (c.id === preselect) init[c.id] = Decimal.from(c.open).normalize().toString();
    return init;
  });
  const allocated = useMemo(() => Decimal.sum(Object.values(values).map(n)), [values]);
  const [amount, setAmount] = useState(defaultAmount ?? (allocated.isZero() ? "" : allocated.toString()));
  const amt = n(amount);
  const fmt = (d: Decimal) => formatMoney(d.toString(), currency);
  const unapplied = amt.sub(allocated);
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-800 sm:w-64">
        Amount ({currency})<span className="sr-only"> required</span>
        <input name={amountName} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required className={cx(inputClass, "num text-right")} />
      </label>
      {candidates.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Item</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Due</th>
                <th className="px-3 py-2 text-right">Open</th>
                <th className="px-3 py-2 text-right">Apply</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {candidates.map((c) => (
                <tr key={c.id}>
                  <td className="px-3 py-2">{c.label}</td>
                  <td className="px-3 py-2">{formatDate(c.date)}</td>
                  <td className={cx("px-3 py-2", c.overdue && "font-medium text-danger-700")}>{c.dueDate ? formatDate(c.dueDate) : "—"}</td>
                  <td className="num px-3 py-2 text-right">{fmt(Decimal.from(c.open))}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        type="button"
                        className="text-xs text-brand-700 hover:underline"
                        onClick={() => {
                          const next = { ...values, [c.id]: Decimal.from(c.open).normalize().toString() };
                          setValues(next);
                          if (!amount) setAmount(Decimal.sum(Object.values(next).map(n)).toString());
                        }}
                      >
                        Full
                      </button>
                      <input
                        name={`apply.${c.type}.${c.id}`}
                        value={values[c.id] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [c.id]: e.target.value }))}
                        inputMode="decimal"
                        placeholder="0.00"
                        className={cx(inputClass, "num w-28 text-right")}
                        aria-label={`Amount to apply to ${c.label}`}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p role="status" className={cx("text-sm", unapplied.isNegative() ? "text-danger-700" : "text-slate-600")}>
        Applied {fmt(allocated)} of {fmt(amt)}.{" "}
        {unapplied.isNegative()
          ? `That is ${fmt(unapplied.abs())} more than the payment.`
          : unapplied.isPositive()
            ? `${fmt(unapplied)} will stay unapplied as a credit with the vendor.`
            : ""}
      </p>
    </div>
  );
}
