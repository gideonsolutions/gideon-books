"use client";

import { useMemo, useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney, formatDate } from "@/lib/money/format";
import { minorUnits } from "@/lib/money/currency";
import type { ActionResult } from "@/lib/web/actions";

export interface BillTime {
  id: string;
  workDate: string;
  person: string;
  hours: string;
  rate: string | null;
  description: string;
}
export interface BillExpense {
  lineId: string;
  date: string;
  label: string;
  amount: string;
  currency: string;
  eligible: boolean;
  reason?: string;
}

/** Choose unbilled time and expenses to put on a draft invoice. */
export function BillForm({
  action,
  time,
  expenses,
  currency,
  incomeAccounts,
  defaultIncomeAccountId,
  today,
  fixedFee,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  time: BillTime[];
  expenses: BillExpense[];
  currency: string;
  incomeAccounts: Option[];
  defaultIncomeAccountId: string;
  today: string;
  fixedFee: string | null;
}) {
  const [timeSel, setTimeSel] = useState<Set<string>>(new Set(time.filter((t) => t.rate).map((t) => t.id)));
  const [expSel, setExpSel] = useState<Set<string>>(new Set(expenses.filter((e) => e.eligible).map((e) => e.lineId)));
  const [markup, setMarkup] = useState("");
  const [extra, setExtra] = useState("");
  const total = useMemo(() => {
    const mu = minorUnits(currency);
    let t = Decimal.ZERO;
    for (const x of time) if (timeSel.has(x.id) && x.rate) t = t.add(Decimal.from(x.hours).mul(x.rate).round(mu, "half_up"));
    const m = Decimal.tryFrom(markup) ?? Decimal.ZERO;
    for (const e of expenses) if (expSel.has(e.lineId)) t = t.add(Decimal.from(e.amount).mul(Decimal.ONE.add(m.div(100, 8, "half_up"))).round(mu, "half_up"));
    const x = Decimal.tryFrom(extra.replace(/[,\s$]/g, ""));
    if (x) t = t.add(x);
    return t;
  }, [time, expenses, timeSel, expSel, markup, extra, currency]);
  const toggle = (set: Set<string>, id: string, upd: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    upd(n);
  };
  return (
    <ActionForm action={action} className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Unbilled time ({time.length})</h2>
        {time.length === 0 ? (
          <p className="text-sm text-slate-500">No unbilled billable time.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {time.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input type="checkbox" name="time" value={t.id} checked={timeSel.has(t.id)} disabled={!t.rate} onChange={() => toggle(timeSel, t.id, setTimeSel)} aria-label={`Bill time on ${t.workDate}`} />
                <span className="flex-1">
                  {formatDate(t.workDate)} · {t.person} · {t.description || "—"}
                  {!t.rate && <span className="ml-1 text-xs text-danger-700">(no rate: set the project rate)</span>}
                </span>
                <span className="num text-slate-600">
                  {Decimal.from(t.hours).normalize().toString()} h × {t.rate ? formatMoney(t.rate, currency) : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Billable expenses ({expenses.length})</h2>
        {expenses.length === 0 ? (
          <p className="text-sm text-slate-500">No unbilled expenses. Mark bill or expense lines “billable to” this project&apos;s customer and project to see them here.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {expenses.map((e) => (
              <li key={e.lineId} className="flex items-center gap-3 px-3 py-2 text-sm">
                <input type="checkbox" name="expense" value={e.lineId} checked={expSel.has(e.lineId)} disabled={!e.eligible} onChange={() => toggle(expSel, e.lineId, setExpSel)} aria-label={`Bill expense ${e.label}`} />
                <span className="flex-1">
                  {formatDate(e.date)} · {e.label}
                  {!e.eligible && <span className="ml-1 text-xs text-danger-700">({e.reason})</span>}
                </span>
                <span className="num">{formatMoney(e.amount, e.currency)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-4 md:grid-cols-4">
        <label className="text-sm font-medium text-slate-800">
          Markup on expenses (%)
          <input name="markupPercent" value={markup} onChange={(e) => setMarkup(e.target.value)} inputMode="decimal" className={`${inputClass} mt-1`} placeholder="0" />
        </label>
        <SelectField label="Income account" name="incomeAccountId" options={incomeAccounts} defaultValue={defaultIncomeAccountId} />
        <TextField label="Invoice date" name="issueDate" type="date" required defaultValue={today} />
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_12rem]">
        <TextField label="Additional line (fixed fee, milestone)" name="extraDescription" placeholder={fixedFee ? "Fixed fee" : "Optional"} />
        <label className="text-sm font-medium text-slate-800">
          Amount
          <input name="extraAmount" value={extra} onChange={(e) => setExtra(e.target.value)} inputMode="decimal" className={`${inputClass} mt-1`} placeholder={fixedFee ?? "0.00"} />
        </label>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 p-4">
        <p className="text-sm text-slate-700">
          Draft invoice total before tax: <strong className="num">{formatMoney(total.toString(), currency)}</strong>. You can edit the draft before issuing it.
        </p>
        <SubmitButton pendingText="Creating…">Create draft invoice</SubmitButton>
      </div>
    </ActionForm>
  );
}
