"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

const MONEY = ["bank", "cash", "clearing", "credit_card"];

export function AccountForm({
  action,
  subtypes,
  parents,
  currencies,
  defaults,
  submitLabel,
  locked,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  subtypes: Option[];
  parents: Option[];
  currencies: Option[];
  defaults?: Partial<Record<"code" | "name" | "subtype" | "parentId" | "description" | "currency" | "cashFlowSection" | "institution" | "mask", string | null>>;
  submitLabel: string;
  locked?: { type?: boolean; currency?: boolean };
}) {
  const [subtype, setSubtype] = useState(defaults?.subtype ?? "operating_expense");
  const isMoney = MONEY.includes(subtype);
  return (
    <ActionForm action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <TextField label="Code" name="code" required defaultValue={defaults?.code ?? ""} hint="Sorts the chart." />
        <TextField label="Name" name="name" required defaultValue={defaults?.name ?? ""} />
      </div>
      <SelectField
        label="Type"
        name="subtype"
        required
        options={subtypes}
        value={subtype}
        onChange={(e) => setSubtype(e.target.value)}
        disabled={locked?.type}
        hint={locked?.type ? "Fixed: the account has postings." : undefined}
      />
      {locked?.type && <input type="hidden" name="subtype" value={subtype} />}
      <SelectField label="Subaccount of" name="parentId" options={parents} placeholder="— None —" defaultValue={defaults?.parentId ?? ""} />
      {isMoney && (
        <div className="grid gap-4 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
          <SelectField
            label="Currency"
            name="currency"
            options={currencies}
            defaultValue={defaults?.currency ?? ""}
            disabled={locked?.currency}
            hint="A foreign-currency account is kept in that currency."
          />
          {locked?.currency && <input type="hidden" name="currency" value={defaults?.currency ?? ""} />}
          <TextField label="Bank" name="institution" defaultValue={defaults?.institution ?? ""} />
          <TextField label="Last digits" name="mask" defaultValue={defaults?.mask ?? ""} maxLength={4} inputMode="numeric" />
        </div>
      )}
      <SelectField
        label="Cash-flow statement section"
        name="cashFlowSection"
        placeholder="Default for the type"
        defaultValue={defaults?.cashFlowSection ?? ""}
        options={[
          { value: "operating", label: "Operating activities" },
          { value: "investing", label: "Investing activities" },
          { value: "financing", label: "Financing activities" },
          { value: "cash", label: "Cash and cash equivalents" },
          { value: "none", label: "Not shown (retained earnings, opening balance equity)" },
        ]}
      />
      <TextAreaField label="Description" name="description" defaultValue={defaults?.description ?? ""} rows={2} />
      <div className="flex justify-end">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
