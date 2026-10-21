"use client";

/**
 * Match a bank transaction to entries already in the books: tick one or
 * more entry lines (and, for a deposit of several bank items, other bank
 * transactions); the two sides must add up exactly.
 */
import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/client/forms";
import { cx } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface MatchLine {
  lineId: string;
  entryNumber: number | null;
  entryDate: string;
  description: string;
  contactName: string | null;
  amount: string;
  suggested?: boolean;
}

export interface OtherBankTxn {
  id: string;
  date: string;
  description: string;
  amount: string;
}

export function MatchForm({
  action,
  amount,
  currency,
  lines,
  otherTxns,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  amount: string;
  currency: string;
  lines: MatchLine[];
  otherTxns: OtherBankTxn[];
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(lines.filter((l) => l.suggested).slice(0, 1).map((l) => l.lineId)));
  const [extra, setExtra] = useState<Set<string>>(new Set());
  const bankTotal = useMemo(() => Decimal.from(amount).add(Decimal.sum(otherTxns.filter((t) => extra.has(t.id)).map((t) => t.amount))), [amount, otherTxns, extra]);
  const booksTotal = useMemo(() => Decimal.sum(lines.filter((l) => picked.has(l.lineId)).map((l) => l.amount)), [lines, picked]);
  const diff = bankTotal.sub(booksTotal);
  const flip = (set: Set<string>, id: string) => {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  };
  return (
    <ActionForm action={action} className="space-y-4">
      {[...picked].map((id) => (
        <input key={id} type="hidden" name="lineId" value={id} />
      ))}
      {[...extra].map((id) => (
        <input key={id} type="hidden" name="bankTransactionId" value={id} />
      ))}
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-slate-800">Entries in the books on this account, not yet matched</legend>
        {lines.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing unmatched in the range. Search a wider range above, or categorize the transaction instead.</p>
        ) : (
          <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {lines.map((l) => (
              <li key={l.lineId}>
                <label className={cx("flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50", picked.has(l.lineId) && "bg-brand-50")}>
                  <input type="checkbox" checked={picked.has(l.lineId)} onChange={() => setPicked((p) => flip(p, l.lineId))} />
                  <span className="w-24 shrink-0 text-slate-600">{formatDate(l.entryDate)}</span>
                  <span className="min-w-0 flex-1 truncate">
                    {l.description}
                    {l.contactName ? <span className="text-slate-500"> · {l.contactName}</span> : null}
                    {l.entryNumber ? <span className="text-xs text-slate-400"> #{l.entryNumber}</span> : null}
                    {l.suggested && <span className="ml-2 text-xs font-medium text-emerald-700">suggested</span>}
                  </span>
                  <span className="num shrink-0">{formatMoney(l.amount, currency)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {otherTxns.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-800">Other bank transactions on this account to match together (e.g. several card settlements in one deposit)</legend>
          <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {otherTxns.map((t) => (
              <li key={t.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50">
                  <input type="checkbox" checked={extra.has(t.id)} onChange={() => setExtra((p) => flip(p, t.id))} />
                  <span className="w-24 shrink-0 text-slate-600">{formatDate(t.date)}</span>
                  <span className="min-w-0 flex-1 truncate">{t.description}</span>
                  <span className="num shrink-0">{formatMoney(t.amount, currency)}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-sm">
        <span>
          Bank <span className="num font-medium">{formatMoney(bankTotal.toString(), currency)}</span> · Books{" "}
          <span className="num font-medium">{formatMoney(booksTotal.toString(), currency)}</span>
        </span>
        <span role="status" className={diff.isZero() && picked.size ? "text-emerald-700" : "text-amber-700"}>
          {!picked.size ? "Tick the entries this transaction is." : diff.isZero() ? "Adds up." : `Difference ${formatMoney(diff.toString(), currency)}`}
        </span>
        <SubmitButton disabled={!picked.size || !diff.isZero()} pendingText="Matching…">
          Match
        </SubmitButton>
      </div>
    </ActionForm>
  );
}
