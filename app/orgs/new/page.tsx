import Link from "next/link";
import { requireUser } from "@/lib/web/session";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { CURRENCY_CODES, CURRENCIES } from "@/lib/money/currency";
import { COA_TEMPLATES } from "@/lib/ledger/coa-templates";
import { createOrgAction } from "../actions";

export const metadata = { title: "New organization" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ENTITY_TYPES = [
  ["sole_proprietorship", "Sole proprietorship"],
  ["llc", "LLC"],
  ["partnership", "Partnership"],
  ["s_corporation", "S corporation"],
  ["c_corporation", "C corporation"],
  ["nonprofit", "Nonprofit"],
  ["trust", "Trust"],
  ["estate", "Estate"],
  ["other", "Other"],
];
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "UTC"];

export default async function NewOrg() {
  await requireUser("/orgs/new");
  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <Link href="/orgs" className="text-sm text-slate-500 hover:text-brand-700">
          ← Organizations
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Set up your organization</h1>
        <p className="mt-1 text-sm text-slate-600">
          The basics the books depend on. The base currency and fiscal year are fixed once anything is posted, so take a moment over them.
        </p>
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <ActionForm action={createOrgAction} className="space-y-5">
            <TextField label="Organization name" name="name" required autoFocus hint="As you want it on invoices." />
            <TextField label="Legal name" name="legalName" hint="If different (for statements and tax exports)." />
            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField label="Base currency" name="baseCurrency" defaultValue="USD" options={CURRENCY_CODES.map((c) => ({ value: c, label: `${c} — ${CURRENCIES.get(c)!.name}` }))} required />
              <SelectField label="Entity type" name="entityType" defaultValue="llc" options={ENTITY_TYPES.map(([v, l]) => ({ value: v!, label: l! }))} />
              <SelectField label="Fiscal year starts" name="fiscalYearStartMonth" defaultValue="1" options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} />
              <SelectField label="Time zone" name="timezone" defaultValue="America/New_York" options={ZONES.map((z) => ({ value: z, label: z }))} />
              <TextField label="Country (ISO code)" name="country" defaultValue="US" maxLength={2} />
              <TextField label="Books start on" name="booksStartDate" type="date" hint="Opening balances are as of the day before." />
            </div>
            <fieldset>
              <legend className="text-sm font-medium text-slate-800">Starting chart of accounts</legend>
              <div className="mt-2 grid gap-3">
                {COA_TEMPLATES.map((t, i) => (
                  <label key={t.key} className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50">
                    <input type="radio" name="template" value={t.key} defaultChecked={i === 0} className="mt-1" />
                    <span>
                      <span className="block text-sm font-medium text-slate-900">{t.name}</span>
                      <span className="block text-xs text-slate-600">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="flex justify-end">
              <SubmitButton pendingText="Creating…">Create and continue</SubmitButton>
            </div>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
