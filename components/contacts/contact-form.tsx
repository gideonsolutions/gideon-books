"use client";

/** Create or edit a customer, vendor, employee or beneficiary. */
import { useRef, useState } from "react";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import { buttonClass, inputClass } from "@/components/ui";
import type { ActionResult } from "@/lib/web/actions";

export interface ContactDefaults {
  displayName?: string;
  companyName?: string | null;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
  isBeneficiary?: boolean;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  currency?: string | null;
  paymentTermsId?: string | null;
  billingAddress?: Record<string, string | undefined> | null;
  shippingAddress?: Record<string, string | undefined> | null;
  taxExempt?: boolean;
  taxExemptionReason?: string | null;
  taxExemptionCertificate?: string | null;
  is1099?: boolean;
  defaultIncomeAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  notes?: string | null;
  persons?: { name: string; email: string | null; phone: string | null; role: string | null; isPrimary: boolean }[];
}

const ADDRESS_FIELDS: [string, string][] = [
  ["line1", "Street"],
  ["line2", "Suite / unit"],
  ["city", "City"],
  ["region", "State / region"],
  ["postalCode", "Postal code"],
  ["country", "Country"],
];

function AddressFields({ prefix, values }: { prefix: string; values?: Record<string, string | undefined> | null }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {ADDRESS_FIELDS.map(([k, label]) => (
        <TextField key={k} label={label} name={`${prefix}.${k}`} defaultValue={values?.[k] ?? ""} className={k === "line1" ? "sm:col-span-2" : ""} />
      ))}
    </div>
  );
}

export function ContactForm({
  action,
  defaults,
  primaryRole,
  currencies,
  terms,
  incomeAccounts,
  expenseAccounts,
  baseCurrency,
  submitLabel,
}: {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  defaults: ContactDefaults;
  primaryRole: "customer" | "vendor";
  currencies: Option[];
  terms: Option[];
  incomeAccounts: Option[];
  expenseAccounts: Option[];
  baseCurrency: string;
  submitLabel: string;
}) {
  // Stable row keys: existing people get 0…n-1, added rows count up from there.
  const nextKey = useRef(defaults.persons?.length ?? 0);
  const [persons, setPersons] = useState(() => (defaults.persons ?? []).map((p, i) => ({ ...p, k: i })));
  const [exempt, setExempt] = useState(!!defaults.taxExempt);
  const [shippingSame, setShippingSame] = useState(!defaults.shippingAddress || JSON.stringify(defaults.shippingAddress) === JSON.stringify(defaults.billingAddress));
  const [isCustomer, setIsCustomer] = useState(defaults.isCustomer ?? primaryRole === "customer");
  const [isVendor, setIsVendor] = useState(defaults.isVendor ?? primaryRole === "vendor");
  return (
    <ActionForm action={action} className="space-y-6">
      <input type="hidden" name="personCount" value={persons.length} />
      <section className="grid gap-4 sm:grid-cols-2">
        <TextField label="Display name" name="displayName" required defaultValue={defaults.displayName ?? ""} hint="As it appears on documents and lists." />
        <TextField label="Company" name="companyName" defaultValue={defaults.companyName ?? ""} />
        <TextField label="Email" name="email" type="email" defaultValue={defaults.email ?? ""} hint="Invoices and statements are sent here." />
        <TextField label="Phone" name="phone" type="tel" defaultValue={defaults.phone ?? ""} />
        <TextField label="Website" name="website" defaultValue={defaults.website ?? ""} />
        <SelectField label="Currency" name="currency" options={[{ value: "", label: `${baseCurrency} (base)` }, ...currencies]} defaultValue={defaults.currency ?? ""} hint="Documents for this contact are in this currency." />
        <SelectField label="Payment terms" name="paymentTermsId" placeholder="None" options={terms} defaultValue={defaults.paymentTermsId ?? ""} />
      </section>

      <fieldset className="rounded-md border border-slate-200 p-4">
        <legend className="px-1 text-sm font-medium text-slate-800">This contact is a…</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isCustomer" checked={isCustomer} onChange={(e) => setIsCustomer(e.target.checked)} /> Customer
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isVendor" checked={isVendor} onChange={(e) => setIsVendor(e.target.checked)} /> Vendor
          </label>
          <CheckboxField label="Employee" name="isEmployee" defaultChecked={defaults.isEmployee} />
          <CheckboxField label="Trust or estate beneficiary" name="isBeneficiary" defaultChecked={defaults.isBeneficiary} />
        </div>
      </fieldset>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Billing address</h3>
        <AddressFields prefix="billing" values={defaults.billingAddress} />
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="shippingSame" checked={shippingSame} onChange={(e) => setShippingSame(e.target.checked)} /> Ships to the billing address
        </label>
        {!shippingSame && (
          <>
            <h3 className="text-sm font-semibold text-slate-900">Shipping address</h3>
            <AddressFields prefix="shipping" values={defaults.shippingAddress} />
          </>
        )}
      </section>

      {isCustomer && (
        <section className="space-y-3 rounded-md border border-slate-200 p-4">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-800">
            <input type="checkbox" name="taxExempt" checked={exempt} onChange={(e) => setExempt(e.target.checked)} /> Exempt from sales tax
          </label>
          {exempt && (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Reason" name="taxExemptionReason" required defaultValue={defaults.taxExemptionReason ?? ""} hint="e.g. resale, nonprofit, government" />
              <TextField label="Certificate number" name="taxExemptionCertificate" defaultValue={defaults.taxExemptionCertificate ?? ""} hint="Attach the certificate on the contact page." />
            </div>
          )}
          <SelectField label="Default income account" name="defaultIncomeAccountId" placeholder="Item's or the organization's default" options={incomeAccounts} defaultValue={defaults.defaultIncomeAccountId ?? ""} />
        </section>
      )}
      {isVendor && (
        <section className="space-y-3 rounded-md border border-slate-200 p-4">
          <CheckboxField label="Receives a Form 1099 (tracked for the Gideon Tax export)" name="is1099" defaultChecked={defaults.is1099} />
          <SelectField label="Default expense account" name="defaultExpenseAccountId" placeholder="Item's or the organization's default" options={expenseAccounts} defaultValue={defaults.defaultExpenseAccountId ?? ""} />
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">People</h3>
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setPersons((p) => [...p, { name: "", email: null, phone: null, role: null, isPrimary: p.length === 0, k: nextKey.current++ }])}>
            + Add person
          </button>
        </div>
        {persons.length === 0 && <p className="text-sm text-slate-500">No individual contacts yet.</p>}
        {persons.map((p, i) => (
          <div key={p.k} className="grid items-end gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-[minmax(0,1fr)_1fr_1fr_1fr_auto_auto]">
            <input aria-label={`Person ${i + 1} name`} name={`persons.${i}.name`} defaultValue={p.name} placeholder="Name" className={inputClass} />
            <input aria-label={`Person ${i + 1} email`} name={`persons.${i}.email`} defaultValue={p.email ?? ""} placeholder="Email" className={inputClass} />
            <input aria-label={`Person ${i + 1} phone`} name={`persons.${i}.phone`} defaultValue={p.phone ?? ""} placeholder="Phone" className={inputClass} />
            <input aria-label={`Person ${i + 1} role`} name={`persons.${i}.role`} defaultValue={p.role ?? ""} placeholder="Role (e.g. Accounts payable)" className={inputClass} />
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="radio" name="primaryPerson" value={String(i)} defaultChecked={p.isPrimary} /> Primary
            </label>
            <button type="button" className="text-sm text-slate-400 hover:text-danger-600" onClick={() => setPersons((ps) => ps.filter((_, k) => k !== i))} aria-label={`Remove person ${i + 1}`}>
              ✕
            </button>
          </div>
        ))}
      </section>

      <TextAreaField label="Notes" name="notes" defaultValue={defaults.notes ?? ""} rows={3} />
      <div className="flex justify-end">
        <SubmitButton>{submitLabel}</SubmitButton>
      </div>
    </ActionForm>
  );
}
