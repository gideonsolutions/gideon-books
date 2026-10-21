"use client";

/**
 * The review queue's table: select rows, accept clear suggestions in bulk,
 * exclude in bulk (with a reason), or open a transaction to review it.
 */
import Link from "next/link";
import { useState } from "react";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { Badge, buttonClass, cx } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface ReviewRow {
  id: string;
  date: string;
  accountName: string;
  description: string;
  payee: string | null;
  amount: string;
  currency: string;
  status: string;
  autoCategorized: boolean;
  possibleDuplicate: boolean;
  suggestion: { type: string; label: string; quick: boolean } | null;
}

type Action = (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;

export function ReviewTable({
  rows,
  base,
  accept,
  exclude,
  confirm,
  canAct,
}: {
  rows: ReviewRow[];
  base: string;
  accept: Action;
  exclude: Action;
  confirm: Action;
  canAct: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluding, setExcluding] = useState(false);
  const all = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const hidden = [...selected].map((id) => <input key={id} type="hidden" name="id" value={id} />);
  const autoSelected = rows.filter((r) => selected.has(r.id) && r.autoCategorized);

  return (
    <div>
      {canAct && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2 shadow-sm">
          <span className="px-1 text-sm text-slate-600">{selected.size} selected</span>
          <ActionForm action={accept} className="inline" onSuccess={() => setSelected(new Set())}>
            {hidden}
            <SubmitButton variant="secondary" disabled={!selected.size} pendingText="Accepting…">
              Accept suggestions
            </SubmitButton>
          </ActionForm>
          {autoSelected.length > 0 && (
            <ActionForm action={confirm} className="inline" onSuccess={() => setSelected(new Set())}>
              {autoSelected.map((r) => (
                <input key={r.id} type="hidden" name="id" value={r.id} />
              ))}
              <SubmitButton variant="secondary">Confirm {autoSelected.length} auto-categorized</SubmitButton>
            </ActionForm>
          )}
          <button type="button" className={buttonClass("ghost")} disabled={!selected.size} onClick={() => setExcluding((e) => !e)}>
            Exclude…
          </button>
          {excluding && selected.size > 0 && (
            <ActionForm action={exclude} className="flex flex-wrap items-end gap-2" onSuccess={() => { setSelected(new Set()); setExcluding(false); }}>
              {hidden}
              <TextField label="Why exclude them?" name="reason" required placeholder="Duplicate, personal, not this business…" />
              <SubmitButton variant="danger">Exclude {selected.size}</SubmitButton>
            </ActionForm>
          )}
          <span className="ml-auto px-1 text-xs text-slate-500">Accepting applies a rule or a single exact match; anything less certain stays for you to review.</span>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-600">
            <tr>
              {canAct && (
                <th className="w-8 px-3 py-2.5">
                  <input type="checkbox" aria-label="Select all" checked={all} onChange={() => setSelected(all ? new Set() : new Set(rows.map((r) => r.id)))} />
                </th>
              )}
              <th className="px-3 py-2.5 text-left">Date</th>
              <th className="px-3 py-2.5 text-left">Bank transaction</th>
              <th className="px-3 py-2.5 text-right">Amount</th>
              <th className="px-3 py-2.5 text-left">Suggestion</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.id} className={cx(selected.has(r.id) && "bg-brand-50/50")}>
                {canAct && (
                  <td className="px-3 py-2.5">
                    <input type="checkbox" aria-label={`Select ${r.description}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2.5">{formatDate(r.date)}</td>
                <td className="px-3 py-2.5">
                  <div className="font-medium text-slate-900">{r.description}</div>
                  <div className="text-xs text-slate-500">
                    {r.accountName}
                    {r.payee ? ` · ${r.payee}` : ""}
                  </div>
                  <div className="mt-0.5 flex gap-1">
                    {r.autoCategorized && <Badge tone="amber">auto-categorized — confirm</Badge>}
                    {r.possibleDuplicate && <Badge tone="red">possible duplicate</Badge>}
                  </div>
                </td>
                <td className={cx("num whitespace-nowrap px-3 py-2.5 text-right", r.amount.startsWith("-") ? "text-slate-900" : "text-emerald-700")}>
                  {formatMoney(r.amount, r.currency)}
                </td>
                <td className="px-3 py-2.5 text-xs text-slate-700">
                  {r.suggestion ? (
                    <span>
                      <Badge tone={r.suggestion.quick ? "green" : "blue"}>{r.suggestion.type}</Badge> {r.suggestion.label}
                    </span>
                  ) : (
                    <span className="text-slate-400">No suggestion</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right">
                  <Link href={`${base}/banking/transactions/${r.id}`} className={buttonClass("secondary", "sm")}>
                    Review
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
