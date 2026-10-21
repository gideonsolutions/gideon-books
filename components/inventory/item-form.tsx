"use client";

import { useState } from "react";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import type { ActionResult } from "@/lib/web/actions";

export interface ItemDefaults {
  kind: "service" | "non_stock" | "stock";
  sku: string;
  name: string;
  description: string;
  unit: string;
  salePrice: string;
  purchaseCost: string;
  incomeAccountId: string;
  expenseAccountId: string;
  inventoryAccountId: string;
  saleTaxCodeId: string;
  purchaseTaxCodeId: string;
  reorderLevel: string;
  reorderQuantity: string;
  preferredVendorId: string;
}

/** Create or edit a product or service. Stock items need an inventory and a cost-of-goods account. */
export function ItemForm({
  action,
  defaults,
  incomeAccounts,
  expenseAccounts,
  inventoryAccounts,
  taxCodes,
  vendors,
  kindLocked,
  submitLabel,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  defaults: ItemDefaults;
  incomeAccounts: Option[];
  expenseAccounts: Option[];
  inventoryAccounts: Option[];
  taxCodes: Option[];
  vendors: Option[];
  kindLocked?: boolean;
  submitLabel: string;
}) {
  const [kind, setKind] = useState(defaults.kind);
  return (
    <ActionForm action={action} className="space-y-5">
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Kind</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(
            [
              ["service", "Service", "Labor, fees, subscriptions — sold, not stocked."],
              ["non_stock", "Non-stock product", "Bought or sold, but not counted or costed."],
              ["stock", "Stock product", "Counted by location and costed at moving average."],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex cursor-pointer items-start gap-2 rounded-md border border-slate-200 p-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => setKind(value)} disabled={kindLocked && kind !== value} className="mt-1" />
              <span>
                <span className="block text-sm font-medium text-slate-900">{label}</span>
                <span className="block text-xs text-slate-600">{hint}</span>
              </span>
            </label>
          ))}
        </div>
        {kindLocked && <p className="mt-1 text-xs text-slate-500">This item has stock movements, so it stays a stock item.</p>}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem_8rem]">
        <TextField label="Name" name="name" required defaultValue={defaults.name} />
        <TextField label="SKU" name="sku" defaultValue={defaults.sku} />
        <TextField label="Unit" name="unit" defaultValue={defaults.unit || "ea"} hint="ea, hr, kg…" />
      </div>
      <TextAreaField label="Description (printed on documents)" name="description" defaultValue={defaults.description} rows={2} />
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-4 rounded-md border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Selling</h3>
          <TextField label="Sale price" name="salePrice" inputMode="decimal" defaultValue={defaults.salePrice} />
          <SelectField label="Income account" name="incomeAccountId" options={incomeAccounts} placeholder="Default (Sales / Service income)" defaultValue={defaults.incomeAccountId} />
          <SelectField label="Sales tax code" name="saleTaxCodeId" options={taxCodes} placeholder="No tax" defaultValue={defaults.saleTaxCodeId} />
        </div>
        <div className="space-y-4 rounded-md border border-slate-200 p-4">
          <h3 className="text-sm font-semibold text-slate-900">Buying</h3>
          <TextField label="Purchase cost" name="purchaseCost" inputMode="decimal" defaultValue={defaults.purchaseCost} />
          <SelectField
            label={kind === "stock" ? "Cost of goods sold account" : "Expense account"}
            name="expenseAccountId"
            options={expenseAccounts}
            placeholder={kind === "stock" ? "Default (Cost of Goods Sold)" : "None — chosen on each bill"}
            defaultValue={defaults.expenseAccountId}
          />
          <SelectField label="Purchase tax code" name="purchaseTaxCodeId" options={taxCodes} placeholder="No tax" defaultValue={defaults.purchaseTaxCodeId} />
          <SelectField label="Preferred vendor" name="preferredVendorId" options={vendors} placeholder="None" defaultValue={defaults.preferredVendorId} />
        </div>
      </div>
      {kind === "stock" && (
        <div className="grid gap-4 rounded-md border border-slate-200 bg-slate-50 p-4 sm:grid-cols-3">
          <SelectField
            label="Inventory account"
            name="inventoryAccountId"
            options={inventoryAccounts}
            placeholder="Default (Inventory)"
            defaultValue={defaults.inventoryAccountId}
            disabled={kindLocked}
            hint={kindLocked ? "Fixed while it holds stock value." : undefined}
          />
          {kindLocked && <input type="hidden" name="inventoryAccountId" value={defaults.inventoryAccountId} />}
          <TextField label="Reorder when at or below" name="reorderLevel" inputMode="decimal" defaultValue={defaults.reorderLevel} />
          <TextField label="Reorder quantity" name="reorderQuantity" inputMode="decimal" defaultValue={defaults.reorderQuantity} />
        </div>
      )}
      <div className="flex justify-end">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
