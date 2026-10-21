"use client";

/** Manual elimination entry: debit/credit lines on group accounts, balanced in the reporting currency. */
import { useMemo, useState } from "react";
import { ActionForm, Options, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import type { ActionResult } from "@/lib/web/actions";

interface Line {
  groupAccountId: string;
  orgId: string;
  debit: string;
  credit: string;
  description: string;
}

const blank = (): Line => ({ groupAccountId: "", orgId: "", debit: "", credit: "", description: "" });
const n = (v: string) => Decimal.tryFrom(v.replace(/[,\s]/g, "")) ?? Decimal.ZERO;

export function EliminationForm({
  action,
  accounts,
  members,
  currency,
  defaultDate,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  accounts: Option[];
  members: Option[];
  currency: string;
  defaultDate: string;
}) {
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const diff = useMemo(() => lines.reduce((s, l) => s.add(n(l.debit)).sub(n(l.credit)), Decimal.ZERO), [lines]);
  const set = (i: number, p: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...p } : l)));
  return (
    <ActionForm action={action} className="space-y-4" resetOnSuccess onSuccess={() => setLines([blank(), blank()])}>
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <TextField label="Date" name="entryDate" type="date" defaultValue={defaultDate} required />
        <TextField label="Description" name="description" required placeholder="e.g. Eliminate management fees" />
      </div>
      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left">Group account</th>
              <th className="px-2 py-2 text-left">Member</th>
              <th className="px-2 py-2 text-right">Debit</th>
              <th className="px-2 py-2 text-right">Credit</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l, i) => (
              <tr key={i}>
                <td className="px-2 py-1.5">
                  <select name={`lines.${i}.groupAccountId`} value={l.groupAccountId} onChange={(e) => set(i, { groupAccountId: e.target.value })} className={inputClass} aria-label={`Line ${i + 1} group account`}>
                    <option value="">Choose…</option>
                    <Options options={accounts} />
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <select name={`lines.${i}.orgId`} value={l.orgId} onChange={(e) => set(i, { orgId: e.target.value })} className={inputClass} aria-label={`Line ${i + 1} member`}>
                    <option value="">—</option>
                    <Options options={members} />
                  </select>
                </td>
                <td className="px-2 py-1.5">
                  <input name={`lines.${i}.debit`} value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} debit`} />
                </td>
                <td className="px-2 py-1.5">
                  <input name={`lines.${i}.credit`} value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} credit`} />
                </td>
                <td className="px-1 text-center">
                  <button type="button" disabled={lines.length <= 2} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))} className="p-1 text-slate-400 hover:text-danger-600 disabled:opacity-30" aria-label={`Remove line ${i + 1}`}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setLines((ls) => [...ls, blank()])}>
          + Add line
        </button>
        <span role="status" className={cx("text-sm", diff.isZero() ? "text-emerald-700" : "text-amber-700")}>
          {diff.isZero() ? "Balanced." : `Out of balance by ${diff.abs().toString()} ${currency}.`}
        </span>
        <SubmitButton>Record elimination</SubmitButton>
      </div>
    </ActionForm>
  );
}
