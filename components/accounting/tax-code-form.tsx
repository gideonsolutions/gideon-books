"use client";

import { useState } from "react";
import { ActionForm, CheckboxField, SubmitButton, TextField, type Option } from "@/components/client/forms";
import { buttonClass, inputClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

export function TaxCodeForm({
  action,
  jurisdictions,
  defaults,
  submitLabel,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  jurisdictions: Option[];
  defaults?: { name: string; description: string; isExempt: boolean; isArchived?: boolean; components: { jurisdictionId: string; isCompound: boolean }[] };
  submitLabel: string;
}) {
  const [comps, setComps] = useState(defaults?.components.length ? defaults.components : [{ jurisdictionId: "", isCompound: false }]);
  return (
    <ActionForm action={action} className="space-y-3" resetOnSuccess={!defaults}>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" name="name" defaultValue={defaults?.name} required placeholder="e.g. NC + Mecklenburg" />
        <TextField label="Description" name="description" defaultValue={defaults?.description} />
      </div>
      <div className="flex gap-6">
        <CheckboxField name="isExempt" label="Exempt / out of scope (no tax)" defaultChecked={defaults?.isExempt} />
        {defaults && <CheckboxField name="isArchived" label="Archived" defaultChecked={defaults.isArchived} />}
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Jurisdictions, in order</legend>
        <ul className="mt-2 space-y-2">
          {comps.map((c, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <span className="w-5 text-right text-xs text-slate-500">{i + 1}.</span>
              <select name={`components.${i}.jurisdictionId`} value={c.jurisdictionId} onChange={(e) => setComps((cs) => cs.map((x, k) => (k === i ? { ...x, jurisdictionId: e.target.value } : x)))} className={`${inputClass} max-w-xs`} aria-label={`Jurisdiction ${i + 1}`}>
                <option value="">Choose…</option>
                {jurisdictions.map((j) => (
                  <option key={j.value} value={j.value}>
                    {j.label}
                  </option>
                ))}
              </select>
              {i > 0 && (
                <label className="flex items-center gap-1 text-sm text-slate-700">
                  <input type="checkbox" name={`components.${i}.isCompound`} checked={c.isCompound} onChange={(e) => setComps((cs) => cs.map((x, k) => (k === i ? { ...x, isCompound: e.target.checked } : x)))} /> compound (taxes the taxes above)
                </label>
              )}
              {comps.length > 1 && (
                <button type="button" className="text-slate-400 hover:text-danger-600" onClick={() => setComps((cs) => cs.filter((_, k) => k !== i))} aria-label={`Remove jurisdiction ${i + 1}`}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
        <button type="button" className={`${buttonClass("ghost", "sm")} mt-2`} onClick={() => setComps((cs) => [...cs, { jurisdictionId: "", isCompound: false }])}>
          + Add jurisdiction
        </button>
      </fieldset>
      <div className="flex justify-end">
        <SubmitButton variant="secondary">{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
