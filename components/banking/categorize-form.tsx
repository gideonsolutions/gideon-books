"use client";

/**
 * Categorize a bank transaction: one or more category lines (a split) that
 * add up to the transaction, a fee line if the bank took one.
 */
import { useMemo, useState } from "react";
import { ActionForm, Options, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";

export interface SplitDraft {
  accountId: string;
  amount: string;
  description: string;
  contactId: string;
  projectId: string;
  classId: string;
  departmentId: string;
  locationId: string;
  fundId: string;
}

const blank = (amount = ""): SplitDraft => ({ accountId: "", amount, description: "", contactId: "", projectId: "", classId: "", departmentId: "", locationId: "", fundId: "" });

export function CategorizeForm({
  action,
  amount,
  currency,
  accounts,
  contacts,
  dims,
  defaults,
  ruleId,
  feeAccountId,
  postingDate,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  /** Absolute amount of the transaction. */
  amount: string;
  currency: string;
  accounts: Option[];
  contacts: Option[];
  dims: { classes: Option[]; departments: Option[]; locations: Option[]; funds: Option[]; projects: Option[] };
  defaults?: Partial<SplitDraft>[];
  ruleId?: string | null;
  feeAccountId?: string | null;
  postingDate: string;
}) {
  const [splits, setSplits] = useState<SplitDraft[]>(defaults?.length ? defaults.map((d) => ({ ...blank(), ...d })) : [blank(amount)]);
  const [showDims, setShowDims] = useState(false);
  const hasDims = dims.projects.length + dims.classes.length + dims.departments.length + dims.locations.length + dims.funds.length > 0;
  const total = useMemo(() => Decimal.sum(splits.map((s) => Decimal.tryFrom(s.amount.replace(/[,\s$]/g, "")) ?? Decimal.ZERO)), [splits]);
  const remaining = Decimal.from(amount).sub(total);
  const set = (i: number, patch: Partial<SplitDraft>) => setSplits((ss) => ss.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const addRemainder = (patch: Partial<SplitDraft> = {}) => setSplits((ss) => [...ss, { ...blank(remaining.isPositive() ? remaining.toString() : ""), ...patch }]);
  return (
    <ActionForm action={action} className="space-y-4">
      {ruleId && <input type="hidden" name="ruleId" value={ruleId} />}
      <div className="space-y-2">
        {splits.map((s, i) => (
          <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-2 sm:grid-cols-[minmax(0,1fr)_8rem_1fr_auto]">
            <select name={`splits.${i}.accountId`} value={s.accountId} onChange={(e) => set(i, { accountId: e.target.value })} className={inputClass} aria-label={`Category ${i + 1}`} required>
              <option value="">Category account…</option>
              <Options options={accounts} />
            </select>
            <input name={`splits.${i}.amount`} value={s.amount} onChange={(e) => set(i, { amount: e.target.value })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Amount ${i + 1}`} />
            <input name={`splits.${i}.description`} value={s.description} onChange={(e) => set(i, { description: e.target.value })} className={inputClass} placeholder="Description (optional)" aria-label={`Description ${i + 1}`} />
            <button type="button" onClick={() => setSplits((ss) => ss.filter((_, k) => k !== i))} disabled={splits.length <= 1} className="rounded px-2 text-slate-400 hover:text-danger-600 disabled:opacity-30" aria-label={`Remove line ${i + 1}`}>
              ✕
            </button>
            <div className={cx("grid gap-2 sm:col-span-4", showDims ? "sm:grid-cols-3" : "sm:grid-cols-1")}>
              <select name={`splits.${i}.contactId`} value={s.contactId} onChange={(e) => set(i, { contactId: e.target.value })} className={cx(inputClass, "text-xs")} aria-label={`Contact ${i + 1}`}>
                <option value="">Contact (optional)…</option>
                <Options options={contacts} />
              </select>
              {showDims && (
                <>
                  {dims.projects.length > 0 && <Dim name={`splits.${i}.projectId`} label="Project" value={s.projectId} options={dims.projects} onChange={(v) => set(i, { projectId: v })} />}
                  {dims.classes.length > 0 && <Dim name={`splits.${i}.classId`} label="Class" value={s.classId} options={dims.classes} onChange={(v) => set(i, { classId: v })} />}
                  {dims.departments.length > 0 && <Dim name={`splits.${i}.departmentId`} label="Department" value={s.departmentId} options={dims.departments} onChange={(v) => set(i, { departmentId: v })} />}
                  {dims.locations.length > 0 && <Dim name={`splits.${i}.locationId`} label="Location" value={s.locationId} options={dims.locations} onChange={(v) => set(i, { locationId: v })} />}
                  {dims.funds.length > 0 && <Dim name={`splits.${i}.fundId`} label="Fund" value={s.fundId} options={dims.funds} onChange={(v) => set(i, { fundId: v })} />}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => addRemainder()}>
          + Split
        </button>
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => addRemainder({ accountId: feeAccountId ?? "", description: "Bank fee" })}>
          + Fee line
        </button>
        {hasDims && (
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setShowDims((d) => !d)}>
            {showDims ? "Hide dimensions" : "Dimensions"}
          </button>
        )}
        <span role="status" className={cx("ml-auto text-sm", remaining.isZero() ? "text-emerald-700" : "text-amber-700")}>
          {remaining.isZero() ? "Adds up." : `${formatMoney(remaining.abs().toString(), currency)} ${remaining.isPositive() ? "left to assign" : "too much"}`}
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Memo" name="memo" placeholder="Shown on the entry" />
        <TextField label="Posting date" name="postingDate" type="date" defaultValue={postingDate} hint="The bank's date unless that period is closed." />
      </div>
      <div className="flex justify-end">
        <SubmitButton pendingText="Posting…" disabled={!remaining.isZero()}>
          Categorize and post
        </SubmitButton>
      </div>
    </ActionForm>
  );
}

function Dim({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return (
    <select name={name} value={value} onChange={(e) => onChange(e.target.value)} className={cx(inputClass, "text-xs")} aria-label={label}>
      <option value="">{label}…</option>
      <Options options={options} />
    </select>
  );
}
