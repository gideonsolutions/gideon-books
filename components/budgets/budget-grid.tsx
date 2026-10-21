"use client";

/**
 * The budget grid: accounts down, months across, with row and column totals
 * computed exactly as you type.
 */
import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/client/forms";
import { cx, inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface GridAccount {
  id: string;
  label: string;
  type: "income" | "expense";
}

function parse(v: string): Decimal {
  return Decimal.tryFrom(v.replace(/[,\s$]/g, "")) ?? Decimal.ZERO;
}

export function BudgetGrid({
  action,
  accounts,
  months,
  dimensionKey,
  initial,
  currency,
  canEdit,
}: {
  action: (p: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  accounts: GridAccount[];
  months: string[];
  dimensionKey: string;
  initial: Record<string, string>;
  currency: string;
  canEdit: boolean;
}) {
  const [cells, setCells] = useState<Record<string, string>>(initial);
  const [showAll, setShowAll] = useState(Object.keys(initial).length === 0);
  const key = (a: string, m: string) => `cell|${a}|${dimensionKey}|${m}`;
  const visible = showAll ? accounts : accounts.filter((a) => months.some((m) => cells[key(a.id, m)]));
  const totals = useMemo(() => {
    const byType = { income: months.map(() => Decimal.ZERO), expense: months.map(() => Decimal.ZERO) };
    for (const a of accounts) months.forEach((m, i) => (byType[a.type][i] = byType[a.type][i]!.add(parse(cells[key(a.id, m)] ?? ""))));
    return byType;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, accounts, months, dimensionKey]);
  const fmt = (d: Decimal) => formatMoney(d.toString(), currency, { symbol: false });
  const fill = (a: string) => {
    const first = cells[key(a, months[0]!)] ?? "";
    setCells((c) => ({ ...c, ...Object.fromEntries(months.map((m) => [key(a, m), first])) }));
  };
  return (
    <ActionForm action={action} className="space-y-3">
      <div className="flex items-center justify-between gap-3 text-sm">
        <label className="flex items-center gap-2 text-slate-700">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show every income and expense account
        </label>
        {canEdit && <SubmitButton>Save budget</SubmitButton>}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="sticky left-0 bg-slate-50 px-2 py-2 text-left">Account</th>
              {months.map((m) => (
                <th key={m} className="px-1 py-2 text-right">
                  {m.slice(0, 7)}
                </th>
              ))}
              <th className="px-2 py-2 text-right">Year</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((a) => {
              const year = Decimal.sum(months.map((m) => parse(cells[key(a.id, m)] ?? "")));
              return (
                <tr key={a.id}>
                  <td className="sticky left-0 bg-white px-2 py-1 whitespace-nowrap">
                    {a.label}
                    {canEdit && (
                      <button type="button" onClick={() => fill(a.id)} className="ml-2 text-brand-700 hover:underline" title="Copy the first month to every month">
                        fill →
                      </button>
                    )}
                  </td>
                  {months.map((m) => (
                    <td key={m} className="px-0.5 py-0.5">
                      <input
                        name={key(a.id, m)}
                        value={cells[key(a.id, m)] ?? ""}
                        onChange={(e) => setCells((c) => ({ ...c, [key(a.id, m)]: e.target.value }))}
                        disabled={!canEdit}
                        inputMode="decimal"
                        aria-label={`${a.label} ${m.slice(0, 7)}`}
                        className={cx(inputClass, "num w-24 px-1.5 py-1 text-right text-xs")}
                      />
                    </td>
                  ))}
                  <td className="num px-2 py-1 text-right font-medium">{fmt(year)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-slate-50 font-medium">
            {(["income", "expense"] as const).map((t) => (
              <tr key={t}>
                <td className="sticky left-0 bg-slate-50 px-2 py-1.5">{t === "income" ? "Total income" : "Total expenses"}</td>
                {totals[t].map((v, i) => (
                  <td key={i} className="num px-1 py-1.5 text-right">
                    {fmt(v)}
                  </td>
                ))}
                <td className="num px-2 py-1.5 text-right">{fmt(Decimal.sum(totals[t]))}</td>
              </tr>
            ))}
            <tr>
              <td className="sticky left-0 bg-slate-50 px-2 py-1.5">Net income</td>
              {months.map((_, i) => (
                <td key={i} className="num px-1 py-1.5 text-right">
                  {fmt(totals.income[i]!.sub(totals.expense[i]!))}
                </td>
              ))}
              <td className="num px-2 py-1.5 text-right">{fmt(Decimal.sum(totals.income).sub(Decimal.sum(totals.expense)))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-slate-500">Enter income and expenses as positive amounts. A blank cell is zero.</p>
    </ActionForm>
  );
}
