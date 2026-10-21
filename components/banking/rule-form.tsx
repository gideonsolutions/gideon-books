"use client";

/** Create or edit a bank rule, with a live preview of what it would take. */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Options, type Option } from "@/components/client/forms";
import { Alert, Badge, buttonClass, cx, inputClass } from "@/components/ui";
import { formatDate, formatMoney } from "@/lib/money/format";
import type { ActionResult } from "@/lib/web/actions";
import type { BankRuleActions, BankRuleConditions } from "@/lib/db/schema/banking";

export interface RulePayloadClient {
  name: string;
  priority: number | null;
  conditions: BankRuleConditions;
  actions: BankRuleActions;
  mode: "suggest" | "auto_categorize";
  isActive: boolean;
}

interface PreviewRow {
  id: string;
  date: string;
  description: string;
  amount: string;
  currency: string;
  claimedBy: string | null;
  splits: { accountId: string; amount: string }[] | null;
}

export function RuleForm({
  initial,
  accounts,
  moneyAccounts,
  contacts,
  dims,
  save,
  preview,
  autoPostNote,
}: {
  initial: RulePayloadClient;
  accounts: Option[];
  moneyAccounts: Option[];
  contacts: Option[];
  dims: { classes: Option[]; departments: Option[]; locations: Option[]; funds: Option[]; projects: Option[] };
  save: (p: RulePayloadClient) => Promise<ActionResult<{ href: string; autoPostEffective: boolean }>>;
  preview: (p: RulePayloadClient) => Promise<ActionResult<PreviewRow[]>>;
  autoPostNote: string;
}) {
  const router = useRouter();
  const [p, setP] = useState<RulePayloadClient>(initial);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [error, setError] = useState<{ message: string; fields?: Record<string, string> } | null>(null);
  const [pending, start] = useTransition();
  const c = p.conditions;
  const a = p.actions;
  const setC = (patch: Partial<BankRuleConditions>) => setP((x) => ({ ...x, conditions: { ...x.conditions, ...patch } }));
  const setA = (patch: Partial<BankRuleActions>) => setP((x) => ({ ...x, actions: { ...x.actions, ...patch } }));
  const setSplit = (i: number, patch: Partial<BankRuleActions["splits"][number]>) => setA({ splits: a.splits.map((s, k) => (k === i ? { ...s, ...patch } : s)) });
  const accountName = new Map(accounts.map((o) => [o.value, o.label]));

  const doPreview = () =>
    start(async () => {
      const r = await preview(p);
      if (!r.ok) setError({ message: r.error, ...(r.fields ? { fields: r.fields } : {}) });
      else {
        setError(null);
        setRows(r.data ?? []);
      }
    });
  const doSave = () =>
    start(async () => {
      const r = await save(p);
      if (!r.ok) {
        setError({ message: r.error, ...(r.fields ? { fields: r.fields } : {}) });
        return;
      }
      router.push(r.data!.href);
      router.refresh();
    });

  return (
    <div className="space-y-6">
      {error && (
        <Alert tone="danger">
          {error.message}
          {error.fields && (
            <ul className="mt-1 list-disc pl-5">
              {Object.values(error.fields).map((v, i) => (
                <li key={i}>{v}</li>
              ))}
            </ul>
          )}
        </Alert>
      )}
      <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
          <L label="Name">
            <input value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} className={inputClass} required />
          </L>
          <L label="Priority (lower first)">
            <input type="number" value={p.priority ?? ""} onChange={(e) => setP({ ...p, priority: e.target.value === "" ? null : Number(e.target.value) })} className={inputClass} placeholder="last" />
          </L>
        </div>
        <h3 className="text-sm font-semibold text-slate-900">When a bank transaction…</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <L label="Description contains">
            <input value={c.descriptionContains ?? ""} onChange={(e) => setC({ descriptionContains: e.target.value || null })} className={inputClass} />
          </L>
          <L label="Description is exactly">
            <input value={c.descriptionEquals ?? ""} onChange={(e) => setC({ descriptionEquals: e.target.value || null })} className={inputClass} />
          </L>
          <L label="Description matches pattern (regular expression)">
            <input value={c.descriptionRegex ?? ""} onChange={(e) => setC({ descriptionRegex: e.target.value || null })} className={cx(inputClass, "font-mono")} />
          </L>
          <L label="Payee contains">
            <input value={c.payeeContains ?? ""} onChange={(e) => setC({ payeeContains: e.target.value || null })} className={inputClass} />
          </L>
          <L label="Direction">
            <select value={c.direction ?? "any"} onChange={(e) => setC({ direction: e.target.value as BankRuleConditions["direction"] })} className={inputClass}>
              <option value="any">In or out</option>
              <option value="out">Money out</option>
              <option value="in">Money in</option>
            </select>
          </L>
          <L label="On account">
            <select value={c.accountId ?? ""} onChange={(e) => setC({ accountId: e.target.value || null })} className={inputClass}>
              <option value="">Any account</option>
              <Options options={moneyAccounts} />
            </select>
          </L>
          <L label="Amount at least">
            <input value={c.minAmount ?? ""} onChange={(e) => setC({ minAmount: e.target.value || null })} className={cx(inputClass, "num text-right")} inputMode="decimal" />
          </L>
          <L label="Amount at most">
            <input value={c.maxAmount ?? ""} onChange={(e) => setC({ maxAmount: e.target.value || null })} className={cx(inputClass, "num text-right")} inputMode="decimal" />
          </L>
        </div>
        <h3 className="text-sm font-semibold text-slate-900">…categorize it as</h3>
        <div className="space-y-2">
          {a.splits.map((s, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_1fr_auto]">
              <select value={s.accountId} onChange={(e) => setSplit(i, { accountId: e.target.value })} className={inputClass} aria-label={`Account ${i + 1}`}>
                <option value="">Account…</option>
                <Options options={accounts} />
              </select>
              <input value={s.percent ?? ""} onChange={(e) => setSplit(i, { percent: e.target.value || null, amount: null })} placeholder="% of rest" className={cx(inputClass, "num text-right")} aria-label={`Percent ${i + 1}`} />
              <input value={s.amount ?? ""} onChange={(e) => setSplit(i, { amount: e.target.value || null, percent: null })} placeholder="or fixed" className={cx(inputClass, "num text-right")} aria-label={`Fixed amount ${i + 1}`} />
              <input value={s.description ?? ""} onChange={(e) => setSplit(i, { description: e.target.value || null })} placeholder="Line description" className={inputClass} aria-label={`Description ${i + 1}`} />
              <button type="button" onClick={() => setA({ splits: a.splits.filter((_, k) => k !== i) })} disabled={a.splits.length <= 1} className="px-2 text-slate-400 hover:text-danger-600 disabled:opacity-30" aria-label={`Remove ${i + 1}`}>
                ✕
              </button>
            </div>
          ))}
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setA({ splits: [...a.splits, { accountId: "", percent: null, amount: null }] })}>
            + Split
          </button>
          <p className="text-xs text-slate-500">One line takes the whole amount. With several, fixed amounts come off first and percentages share the rest (they must add up to 100).</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <L label="Contact">
            <select value={a.contactId ?? ""} onChange={(e) => setA({ contactId: e.target.value || null })} className={inputClass}>
              <option value="">None</option>
              <Options options={contacts} />
            </select>
          </L>
          {dims.projects.length > 0 && (
            <L label="Project">
              <select value={a.projectId ?? ""} onChange={(e) => setA({ projectId: e.target.value || null })} className={inputClass}>
                <option value="">None</option>
                <Options options={dims.projects} />
              </select>
            </L>
          )}
          {dims.classes.length > 0 && (
            <L label="Class">
              <select value={a.classId ?? ""} onChange={(e) => setA({ classId: e.target.value || null })} className={inputClass}>
                <option value="">None</option>
                <Options options={dims.classes} />
              </select>
            </L>
          )}
          {dims.departments.length > 0 && (
            <L label="Department">
              <select value={a.departmentId ?? ""} onChange={(e) => setA({ departmentId: e.target.value || null })} className={inputClass}>
                <option value="">None</option>
                <Options options={dims.departments} />
              </select>
            </L>
          )}
          {dims.locations.length > 0 && (
            <L label="Location">
              <select value={a.locationId ?? ""} onChange={(e) => setA({ locationId: e.target.value || null })} className={inputClass}>
                <option value="">None</option>
                <Options options={dims.locations} />
              </select>
            </L>
          )}
          {dims.funds.length > 0 && (
            <L label="Fund">
              <select value={a.fundId ?? ""} onChange={(e) => setA({ fundId: e.target.value || null })} className={inputClass}>
                <option value="">None</option>
                <Options options={dims.funds} />
              </select>
            </L>
          )}
          <L label="Memo on the entry">
            <input value={a.memo ?? ""} onChange={(e) => setA({ memo: e.target.value || null })} className={inputClass} />
          </L>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-slate-900">Mode</legend>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={p.mode === "suggest"} onChange={() => setP({ ...p, mode: "suggest" })} className="mt-1" />
            <span>
              <strong>Suggest</strong> — show it as the suggestion; a person accepts it.
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="radio" checked={p.mode === "auto_categorize"} onChange={() => setP({ ...p, mode: "auto_categorize" })} className="mt-1" />
            <span>
              <strong>Categorize automatically</strong> — post new matching transactions as they arrive. They still wait in review for a person to confirm, and can be undone. {autoPostNote}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.isActive} onChange={(e) => setP({ ...p, isActive: e.target.checked })} /> Active
          </label>
        </fieldset>
        <div className="flex justify-end gap-2">
          <button type="button" className={buttonClass("secondary")} onClick={doPreview} disabled={pending}>
            Preview
          </button>
          <button type="button" className={buttonClass("primary")} onClick={doSave} disabled={pending}>
            {pending ? "Saving…" : "Save rule"}
          </button>
        </div>
      </section>
      {rows && (
        <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">Would apply to {rows.filter((r) => !r.claimedBy).length} transaction(s) waiting for review</h3>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-500">No waiting transactions match.</p>
          ) : (
            <table className="min-w-full text-sm">
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={r.claimedBy ? "opacity-60" : ""}>
                    <td className="whitespace-nowrap py-1.5 pr-3">{formatDate(r.date)}</td>
                    <td className="py-1.5 pr-3">{r.description}</td>
                    <td className="num py-1.5 pr-3 text-right">{formatMoney(r.amount, r.currency)}</td>
                    <td className="py-1.5 text-xs text-slate-600">
                      {r.claimedBy ? (
                        <Badge tone="amber">taken first by “{r.claimedBy}”</Badge>
                      ) : r.splits ? (
                        r.splits.map((s) => `${accountName.get(s.accountId) ?? "?"} ${formatMoney(s.amount, r.currency)}`).join(" + ")
                      ) : (
                        <Badge tone="red">fixed amounts do not fit</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </div>
  );
}

function L({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
      {label}
      {children}
    </label>
  );
}
