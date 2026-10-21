"use client";

/** The fixed-asset form: details, accounts, how it was acquired, and how it depreciates. */
import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

export interface CapitalizableLine {
  lineId: string;
  label: string;
  amount: string;
  accountId: string;
  date: string;
  description: string;
}

export interface AssetFormDefaults {
  name: string;
  category: string;
  description: string;
  assetAccountId: string;
  accumulatedDepreciationAccountId: string;
  depreciationExpenseAccountId: string;
  acquisitionDate: string;
  inServiceDate: string;
  cost: string;
  residualValue: string;
  usefulLifeMonths: string;
  method: "straight_line" | "declining_balance" | "none";
  decliningFactor: string;
  acquisitionType: "document_line" | "direct" | "opening";
  sourceDocumentLineId: string;
  fundingAccountId: string;
  openingAccumulatedDepreciation: string;
  openingDepreciationThrough: string;
  classId: string;
  departmentId: string;
  locationId: string;
  projectId: string;
  notes: string;
}

export function AssetForm({
  action,
  defaults,
  assetAccounts,
  accumulatedAccounts,
  expenseAccounts,
  fundingAccounts,
  lines,
  dims,
  categories,
  capitalized,
  canCapitalize,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  defaults: AssetFormDefaults;
  assetAccounts: Option[];
  accumulatedAccounts: Option[];
  expenseAccounts: Option[];
  fundingAccounts: Option[];
  lines: CapitalizableLine[];
  dims: { classes: Option[]; departments: Option[]; locations: Option[]; projects: Option[] };
  categories: string[];
  /** The asset is already on the books: cost, accounts and acquisition are fixed. */
  capitalized: boolean;
  canCapitalize: boolean;
}) {
  const [type, setType] = useState(defaults.acquisitionType);
  const [method, setMethod] = useState(defaults.method);
  const [lineId, setLineId] = useState(defaults.sourceDocumentLineId);
  const [cost, setCost] = useState(defaults.cost);
  const [acquired, setAcquired] = useState(defaults.acquisitionDate);
  const [assetAccount, setAssetAccount] = useState(defaults.assetAccountId);
  const pickLine = (id: string) => {
    setLineId(id);
    const l = lines.find((x) => x.lineId === id);
    if (l) {
      setCost(l.amount);
      setAcquired(l.date);
      setAssetAccount(l.accountId);
    }
  };
  const locked = capitalized;
  return (
    <ActionForm action={action} className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Name" name="name" required defaultValue={defaults.name} />
        <div>
          <TextField label="Category" name="category" defaultValue={defaults.category} list="asset-categories" hint="Vehicles, Computers, Furniture…" />
          <datalist id="asset-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>
      </div>
      <TextAreaField label="Description" name="description" defaultValue={defaults.description} rows={2} />

      <fieldset disabled={locked} className="space-y-4 rounded-md border border-slate-200 p-4 disabled:bg-slate-50">
        <legend className="px-1 text-sm font-medium text-slate-800">How it came onto the books{locked ? " (fixed once capitalized)" : ""}</legend>
        <div className="flex flex-wrap gap-4 text-sm">
          {(
            [
              ["direct", "Bought directly", "Posts the cost against the account that paid for it (bank, card, loan)."],
              ["document_line", "From a bill or expense", "The bill already put the cost in a fixed-asset account; link the asset to that line."],
              ["opening", "Opening balance", "An asset you owned before these books, with the depreciation already taken."],
            ] as const
          ).map(([v, label, hint]) => (
            <label key={v} className="flex max-w-xs cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-2 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
              <input type="radio" name="acquisitionType" value={v} checked={type === v} onChange={() => setType(v)} className="mt-1" />
              <span>
                <span className="block font-medium text-slate-900">{label}</span>
                <span className="block text-xs text-slate-600">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {type === "document_line" && (
          <SelectField
            label="Bill or expense line"
            name="sourceDocumentLineId"
            required
            placeholder={lines.length ? "Choose the line…" : "No uncapitalized fixed-asset lines on posted bills"}
            options={lines.map((l) => ({ value: l.lineId, label: l.label }))}
            value={lineId}
            onChange={(e) => pickLine(e.target.value)}
            hint="Only posted bills and expenses with a line to a fixed-asset account are listed."
          />
        )}
        {type === "direct" && <SelectField label="Paid from" name="fundingAccountId" required placeholder="Choose…" options={fundingAccounts} defaultValue={defaults.fundingAccountId} hint="A bank, card, cash or loan account." />}
        <div className="grid gap-4 md:grid-cols-3">
          <TextField label="Cost" name="cost" required inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} readOnly={type === "document_line" && !!lineId} />
          <TextField label="Acquired on" name="acquisitionDate" type="date" required value={acquired} onChange={(e) => setAcquired(e.target.value)} />
          <TextField label="Placed in service" name="inServiceDate" type="date" defaultValue={defaults.inServiceDate} hint="Blank: the acquisition date. Depreciation starts that month." />
        </div>
        {type === "opening" && (
          <div className="grid gap-4 md:grid-cols-2">
            <TextField label="Depreciation already taken" name="openingAccumulatedDepreciation" inputMode="decimal" defaultValue={defaults.openingAccumulatedDepreciation} />
            <TextField label="…through (a month-end)" name="openingDepreciationThrough" type="date" required defaultValue={defaults.openingDepreciationThrough} hint="Usually the day before these books start. The opening entry is dated this day." />
          </div>
        )}
        <div className="grid gap-4 md:grid-cols-3">
          <SelectField label="Asset account" name="assetAccountId" options={assetAccounts} value={assetAccount} onChange={(e) => setAssetAccount(e.target.value)} />
          <SelectField label="Accumulated depreciation" name="accumulatedDepreciationAccountId" options={accumulatedAccounts} defaultValue={defaults.accumulatedDepreciationAccountId} />
          <SelectField label="Depreciation expense" name="depreciationExpenseAccountId" options={expenseAccounts} defaultValue={defaults.depreciationExpenseAccountId} />
        </div>
      </fieldset>
      {locked && (
        <>
          <input type="hidden" name="acquisitionType" value={type} />
          <input type="hidden" name="cost" value={cost} />
          <input type="hidden" name="acquisitionDate" value={acquired} />
          <input type="hidden" name="inServiceDate" value={defaults.inServiceDate} />
          <input type="hidden" name="assetAccountId" value={assetAccount} />
          <input type="hidden" name="accumulatedDepreciationAccountId" value={defaults.accumulatedDepreciationAccountId} />
          <input type="hidden" name="sourceDocumentLineId" value={lineId} />
          <input type="hidden" name="fundingAccountId" value={defaults.fundingAccountId} />
          <input type="hidden" name="openingAccumulatedDepreciation" value={defaults.openingAccumulatedDepreciation} />
          <input type="hidden" name="openingDepreciationThrough" value={defaults.openingDepreciationThrough} />
        </>
      )}
      {locked && <input type="hidden" name="depreciationExpenseAccountId" value={defaults.depreciationExpenseAccountId} />}

      <fieldset className="space-y-4 rounded-md border border-slate-200 p-4">
        <legend className="px-1 text-sm font-medium text-slate-800">Depreciation{locked ? " (changes apply from the next unposted month)" : ""}</legend>
        <div className="grid gap-4 md:grid-cols-4">
          <SelectField
            label="Method"
            name="method"
            value={method}
            onChange={(e) => setMethod(e.target.value as AssetFormDefaults["method"])}
            options={[
              { value: "straight_line", label: "Straight line" },
              { value: "declining_balance", label: "Declining balance" },
              { value: "none", label: "None (land, art)" },
            ]}
          />
          <TextField label="Useful life (months)" name="usefulLifeMonths" required inputMode="numeric" defaultValue={defaults.usefulLifeMonths} hint="60 = five years." />
          <TextField label="Residual value" name="residualValue" inputMode="decimal" defaultValue={defaults.residualValue} />
          {method === "declining_balance" && <TextField label="Factor" name="decliningFactor" inputMode="decimal" defaultValue={defaults.decliningFactor || "2"} hint="2 = double declining." />}
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-4">
        {dims.projects.length > 0 && <SelectField label="Project" name="projectId" placeholder="—" options={dims.projects} defaultValue={defaults.projectId} />}
        {dims.classes.length > 0 && <SelectField label="Class" name="classId" placeholder="—" options={dims.classes} defaultValue={defaults.classId} />}
        {dims.departments.length > 0 && <SelectField label="Department" name="departmentId" placeholder="—" options={dims.departments} defaultValue={defaults.departmentId} />}
        {dims.locations.length > 0 && <SelectField label="Location" name="locationId" placeholder="—" options={dims.locations} defaultValue={defaults.locationId} />}
      </div>
      <TextAreaField label="Notes" name="notes" defaultValue={defaults.notes} rows={2} />
      <div className="flex justify-end gap-2">
        <SubmitButton name="intent" value="save" variant={capitalized ? "primary" : "secondary"}>
          {capitalized ? "Save changes" : "Save draft"}
        </SubmitButton>
        {!capitalized && canCapitalize && (
          <SubmitButton name="intent" value="capitalize" pendingText="Posting…">
            Save and put on the books
          </SubmitButton>
        )}
      </div>
    </ActionForm>
  );
}
