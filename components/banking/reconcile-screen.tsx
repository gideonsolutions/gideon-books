"use client";

/**
 * The reconciliation screen: tick each item that appears on the statement;
 * the cleared balance and the difference update as you go. Progress can be
 * saved; completing needs a zero difference or a reasoned adjustment.
 */
import { useMemo, useState, useTransition } from "react";
import { ActionForm, SubmitButton, TextAreaField } from "@/components/client/forms";
import { Badge, buttonClass, cx } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface ScreenLine {
  lineId: string;
  entryId: string;
  entryNumber: number | null;
  entryDate: string;
  description: string;
  contactName: string | null;
  amount: string;
  bankMatched: boolean;
  reversed: boolean;
  isReversal: boolean;
  checked: boolean;
}

export function ReconcileScreen({
  lines,
  opening,
  statement,
  currency,
  base,
  save,
  complete,
  canAdjust,
}: {
  lines: ScreenLine[];
  opening: string;
  statement: string;
  currency: string;
  base: string;
  save: (ids: string[]) => Promise<ActionResult<{ difference: string; cleared: string }>>;
  complete: (ids: string[], prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  canAdjust: boolean;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(lines.filter((l) => l.checked).map((l) => l.lineId)));
  const [filter, setFilter] = useState<"all" | "in" | "out" | "unchecked">("all");
  const [saved, setSaved] = useState<string | null>(null);
  const [adjust, setAdjust] = useState(false);
  const [pending, start] = useTransition();

  const totals = useMemo(() => {
    let inn = Decimal.ZERO;
    let out = Decimal.ZERO;
    for (const l of lines) {
      if (!checked.has(l.lineId)) continue;
      const a = Decimal.from(l.amount);
      if (a.isPositive()) inn = inn.add(a);
      else out = out.add(a);
    }
    const cleared = Decimal.from(opening).add(inn).add(out);
    return { inn, out, cleared, difference: Decimal.from(statement).sub(cleared) };
  }, [lines, checked, opening, statement]);

  const visible = lines.filter((l) => {
    const a = Decimal.from(l.amount);
    if (filter === "in") return a.isPositive();
    if (filter === "out") return a.isNegative();
    if (filter === "unchecked") return !checked.has(l.lineId);
    return true;
  });
  const fmt = (d: Decimal | string) => formatMoney(typeof d === "string" ? d : d.toString(), currency);
  const toggle = (id: string) => {
    setSaved(null);
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };
  const allVisibleChecked = visible.length > 0 && visible.every((l) => checked.has(l.lineId));
  const zero = totals.difference.isZero();

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {(["all", "in", "out", "unchecked"] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={buttonClass(filter === f ? "primary" : "secondary", "sm")} aria-pressed={filter === f}>
              {f === "all" ? "All" : f === "in" ? "Deposits" : f === "out" ? "Payments" : "Not ticked"}
            </button>
          ))}
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            onClick={() =>
              setChecked((s) => {
                const n = new Set(s);
                for (const l of visible) {
                  if (allVisibleChecked) n.delete(l.lineId);
                  else n.add(l.lineId);
                }
                return n;
              })
            }
          >
            {allVisibleChecked ? "Untick shown" : "Tick shown"}
          </button>
        </div>
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
              <tr>
                <th className="w-10 px-3 py-2.5">
                  <span className="sr-only">Cleared</span>
                </th>
                <th className="px-3 py-2.5 text-left">Date</th>
                <th className="px-3 py-2.5 text-left">Description</th>
                <th className="px-3 py-2.5 text-right">Deposit</th>
                <th className="px-3 py-2.5 text-right">Payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {visible.map((l) => {
                const a = Decimal.from(l.amount);
                return (
                  <tr key={l.lineId} className={cx("cursor-pointer", checked.has(l.lineId) ? "bg-emerald-50/60" : "hover:bg-slate-50")} onClick={() => toggle(l.lineId)}>
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={checked.has(l.lineId)} onChange={() => toggle(l.lineId)} aria-label={`Cleared: ${l.description} ${l.amount}`} />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{formatDate(l.entryDate)}</td>
                    <td className="px-3 py-2">
                      <a href={`${base}/accounting/journal/${l.entryId}`} onClick={(e) => e.stopPropagation()} className="hover:text-brand-700">
                        {l.description}
                      </a>
                      <span className="ml-1 text-xs text-slate-500">
                        {l.contactName ?? ""}
                        {l.entryNumber ? ` #${l.entryNumber}` : ""}
                      </span>
                      <span className="ml-1 inline-flex gap-1">
                        {l.bankMatched && <Badge tone="blue">bank matched</Badge>}
                        {l.reversed && <Badge tone="red">reversed (voided)</Badge>}
                        {l.isReversal && <Badge tone="amber">reversal</Badge>}
                      </span>
                    </td>
                    <td className="num px-3 py-2 text-right">{a.isPositive() ? fmt(a) : ""}</td>
                    <td className="num px-3 py-2 text-right">{a.isNegative() ? fmt(a.neg()) : ""}</td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                    Nothing here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Items marked “reversed” were voided or undone after they were recorded; their reversal is listed too. Tick both if neither reached the bank, or tick the one the statement shows.
        </p>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <dl className="space-y-1.5">
            <Row label="Opening balance" value={fmt(opening)} />
            <Row label="Deposits ticked" value={fmt(totals.inn)} />
            <Row label="Payments ticked" value={fmt(totals.out.neg())} />
            <div className="border-t border-slate-200 pt-1.5">
              <Row label="Cleared balance" value={fmt(totals.cleared)} strong />
            </div>
            <Row label="Statement ending balance" value={fmt(statement)} />
            <div className={cx("rounded-md px-2 py-1.5", zero ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-900")} role="status">
              <Row label="Difference" value={fmt(totals.difference)} strong />
            </div>
          </dl>
          <button
            type="button"
            className={cx(buttonClass("secondary"), "mt-4 w-full")}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await save([...checked]);
                setSaved(r.ok ? "Progress saved." : r.error);
              })
            }
          >
            {pending ? "Saving…" : "Save progress"}
          </button>
          {saved && <p className="mt-2 text-xs text-slate-600">{saved}</p>}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <ActionForm action={(prev, fd) => complete([...checked], prev, fd)} className="space-y-3">
            {!zero && canAdjust && (
              <>
                <label className="flex items-start gap-2 text-sm text-slate-700">
                  <input type="checkbox" name="adjust" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} className="mt-0.5" />
                  Record the difference of {fmt(totals.difference)} as a reconciliation adjustment
                </label>
                {adjust && <TextAreaField label="Why does it not reconcile?" name="reason" required rows={2} />}
              </>
            )}
            <SubmitButton className="w-full" disabled={!zero && !adjust} pendingText="Completing…">
              {zero ? "Finish reconciliation" : "Finish with adjustment"}
            </SubmitButton>
            {!zero && <p className="text-xs text-slate-500">Finish when the difference is zero. If it cannot be, record an adjustment with the reason; it is posted to Reconciliation Discrepancies.</p>}
          </ActionForm>
        </div>
      </aside>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx("flex justify-between gap-4", strong && "font-semibold")}>
      <dt>{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

