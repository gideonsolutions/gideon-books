"use client";

/**
 * Manual journal entry editor: debit/credit lines with optional contact,
 * dimensions and foreign currency, totals computed with exact decimals as
 * you type. Save as a draft or post.
 */
import { useMemo, useState } from "react";
import { ActionForm, CheckboxField, Options, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface JournalLineDraft {
  accountId: string;
  debit: string;
  credit: string;
  description: string;
  contactId: string;
  currency: string;
  fxRate: string;
  projectId: string;
  classId: string;
  departmentId: string;
  locationId: string;
  fundId: string;
}

const blank = (): JournalLineDraft => ({ accountId: "", debit: "", credit: "", description: "", contactId: "", currency: "", fxRate: "", projectId: "", classId: "", departmentId: "", locationId: "", fundId: "" });

function parse(v: string): Decimal {
  const d = Decimal.tryFrom(v.replace(/[,\s]/g, ""));
  return d ?? Decimal.ZERO;
}

export function JournalForm({
  action,
  accounts,
  contacts,
  dims,
  baseCurrency,
  currencies,
  defaults,
  canPost,
  idempotencyKey,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  accounts: Option[];
  contacts: Option[];
  dims: { classes: Option[]; departments: Option[]; locations: Option[]; funds: Option[]; projects: Option[] };
  baseCurrency: string;
  currencies: Option[];
  defaults?: { entryDate: string; description: string; reference?: string; isAdjusting?: boolean; autoReverseOn?: string; lines: JournalLineDraft[] };
  canPost: boolean;
  idempotencyKey: string;
}) {
  const [lines, setLines] = useState<JournalLineDraft[]>(defaults?.lines.length ? defaults.lines : [blank(), blank()]);
  const [showDims, setShowDims] = useState(defaults?.lines.some((l) => l.projectId || l.classId || l.departmentId || l.locationId || l.fundId) ?? false);
  const [showFx, setShowFx] = useState(defaults?.lines.some((l) => l.currency && l.currency !== baseCurrency) ?? false);
  const hasDims = dims.classes.length + dims.departments.length + dims.locations.length + dims.funds.length + dims.projects.length > 0;

  const totals = useMemo(() => {
    let dr = Decimal.ZERO;
    let cr = Decimal.ZERO;
    let foreign = false;
    for (const l of lines) {
      if (l.currency && l.currency !== baseCurrency) {
        foreign = true;
        const rate = parse(l.fxRate);
        dr = dr.add(parse(l.debit).mul(rate));
        cr = cr.add(parse(l.credit).mul(rate));
      } else {
        dr = dr.add(parse(l.debit));
        cr = cr.add(parse(l.credit));
      }
    }
    return { dr, cr, diff: dr.sub(cr), foreign };
  }, [lines, baseCurrency]);

  const update = (i: number, patch: Partial<JournalLineDraft>) => setLines((ls) => ls.map((l, n) => (n === i ? { ...l, ...patch } : l)));
  const fmt = (d: Decimal) => formatMoney(d.round(2, "half_up").toString(), baseCurrency);
  const balanced = totals.diff.round(2, "half_up").isZero() && !totals.dr.isZero();

  return (
    <ActionForm action={action} className="space-y-5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="grid gap-4 sm:grid-cols-[12rem_1fr_12rem]">
        <TextField label="Posting date" name="entryDate" type="date" required defaultValue={defaults?.entryDate} />
        <TextField label="Description" name="description" required defaultValue={defaults?.description} />
        <TextField label="Reference" name="reference" defaultValue={defaults?.reference} />
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <CheckboxField label="Period-end adjusting entry" name="isAdjusting" defaultChecked={defaults?.isAdjusting} />
        {hasDims && (
          <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setShowDims((s) => !s)}>
            {showDims ? "Hide dimensions" : "Show dimensions"}
          </button>
        )}
        <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setShowFx((s) => !s)}>
          {showFx ? "Hide currencies" : "Foreign-currency lines"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left">Account</th>
              <th className="px-2 py-2 text-left">Description</th>
              <th className="px-2 py-2 text-left">Contact</th>
              {showFx && <th className="px-2 py-2 text-left">Currency / rate</th>}
              <th className="w-32 px-2 py-2 text-right">Debit</th>
              <th className="w-32 px-2 py-2 text-right">Credit</th>
              <th className="w-10 px-2 py-2">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {lines.map((l, i) => (
              <tr key={i} className="align-top">
                <td className="px-2 py-1.5">
                  <select name={`lines.${i}.accountId`} value={l.accountId} onChange={(e) => update(i, { accountId: e.target.value })} className={cx(inputClass, "min-w-56")} aria-label={`Line ${i + 1} account`}>
                    <option value="">Choose…</option>
                    <Options options={accounts} />
                  </select>
                  {showDims && (
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                      {dims.projects.length > 0 && <DimSelect name={`lines.${i}.projectId`} label="Project" value={l.projectId} options={dims.projects} onChange={(v) => update(i, { projectId: v })} />}
                      {dims.classes.length > 0 && <DimSelect name={`lines.${i}.classId`} label="Class" value={l.classId} options={dims.classes} onChange={(v) => update(i, { classId: v })} />}
                      {dims.departments.length > 0 && <DimSelect name={`lines.${i}.departmentId`} label="Department" value={l.departmentId} options={dims.departments} onChange={(v) => update(i, { departmentId: v })} />}
                      {dims.locations.length > 0 && <DimSelect name={`lines.${i}.locationId`} label="Location" value={l.locationId} options={dims.locations} onChange={(v) => update(i, { locationId: v })} />}
                      {dims.funds.length > 0 && <DimSelect name={`lines.${i}.fundId`} label="Fund" value={l.fundId} options={dims.funds} onChange={(v) => update(i, { fundId: v })} />}
                    </div>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <input name={`lines.${i}.description`} value={l.description} onChange={(e) => update(i, { description: e.target.value })} className={inputClass} aria-label={`Line ${i + 1} description`} />
                </td>
                <td className="px-2 py-1.5">
                  <select name={`lines.${i}.contactId`} value={l.contactId} onChange={(e) => update(i, { contactId: e.target.value })} className={cx(inputClass, "min-w-40")} aria-label={`Line ${i + 1} contact`}>
                    <option value="">—</option>
                    <Options options={contacts} />
                  </select>
                </td>
                {showFx && (
                  <td className="px-2 py-1.5">
                    <div className="flex gap-1">
                      <select name={`lines.${i}.currency`} value={l.currency} onChange={(e) => update(i, { currency: e.target.value })} className={cx(inputClass, "w-24")} aria-label={`Line ${i + 1} currency`}>
                        <option value="">{baseCurrency}</option>
                        <Options options={currencies} />
                      </select>
                      {l.currency && l.currency !== baseCurrency && (
                        <input name={`lines.${i}.fxRate`} value={l.fxRate} onChange={(e) => update(i, { fxRate: e.target.value })} placeholder="stored rate" className={cx(inputClass, "num w-28")} aria-label={`Line ${i + 1} exchange rate`} inputMode="decimal" />
                      )}
                    </div>
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <input name={`lines.${i}.debit`} value={l.debit} onChange={(e) => update(i, { debit: e.target.value, credit: e.target.value ? "" : l.credit })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} debit`} />
                </td>
                <td className="px-2 py-1.5">
                  <input name={`lines.${i}.credit`} value={l.credit} onChange={(e) => update(i, { credit: e.target.value, debit: e.target.value ? "" : l.debit })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} credit`} />
                </td>
                <td className="px-2 py-1.5 text-center">
                  <button type="button" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-danger-600 disabled:opacity-30" onClick={() => setLines((ls) => ls.filter((_, n) => n !== i))} disabled={lines.length <= 2} aria-label={`Remove line ${i + 1}`}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-50 text-sm font-medium">
            <tr>
              <td className="px-2 py-2" colSpan={showFx ? 4 : 3}>
                <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setLines((ls) => [...ls, blank()])}>
                  + Add line
                </button>
              </td>
              <td className="num px-2 py-2 text-right">{fmt(totals.dr)}</td>
              <td className="num px-2 py-2 text-right">{fmt(totals.cr)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p role="status" className={cx("text-sm", balanced ? "text-emerald-700" : "text-amber-700")}>
          {balanced
            ? "Balanced."
            : totals.dr.isZero()
              ? "Enter amounts."
              : `Out of balance by ${fmt(totals.diff.abs())}${totals.foreign ? " (estimated at the rates entered)" : ""}.`}
        </p>
        <div className="flex gap-2">
          <SubmitButton name="intent" value="draft" variant="secondary">
            Save draft
          </SubmitButton>
          {canPost && (
            <SubmitButton name="intent" value="post" pendingText="Posting…">
              Post entry
            </SubmitButton>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500">Posting makes the entry permanent. To correct a posted entry, reverse it and post a new one; the history keeps both.</p>
    </ActionForm>
  );
}

function DimSelect({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return (
    <select name={name} value={value} onChange={(e) => onChange(e.target.value)} className={cx(inputClass, "text-xs")} aria-label={label}>
      <option value="">{label}…</option>
      <Options options={options} />
    </select>
  );
}
