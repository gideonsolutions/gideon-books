import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listJurisdictions, listTaxCodes } from "@/lib/tax/config";
import { accountOptions, contactOptions, moneyAccountOptions } from "@/lib/web/options";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { formatRatePercent } from "@/lib/money/format";
import { Alert, Badge, Card, DateText, PageHeader } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { TaxCodeForm } from "@/components/accounting/tax-code-form";
import { addTaxRateAction, adjustTaxAction, createJurisdictionAction, deleteTaxRateAction, remitTaxAction, saveTaxCodeAction, updateJurisdictionAction } from "../actions";

export const metadata = { title: "Sales tax" };

export default async function SalesTax({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const jurisdictions = await listJurisdictions(db, ctx.orgId);
  const codes = await listTaxCodes(db, ctx.orgId, { includeArchived: true });
  const manage = can(ctx, "sales_tax.manage");
  const liabilities = await accountOptions(db, ctx.orgId, { types: ["liability"], excludeControl: true });
  const assets = await accountOptions(db, ctx.orgId, { types: ["asset"], excludeControl: true });
  const allAccounts = await accountOptions(db, ctx.orgId, { excludeControl: true });
  const vendors = await contactOptions(db, ctx.orgId, "vendor");
  const money = await moneyAccountOptions(db, ctx.orgId);
  const today = todayIn(ctx.org.timezone);
  const jOptions = jurisdictions.filter((j) => !j.isArchived).map((j) => ({ value: j.id, label: j.name }));
  const freq = [
    { value: "monthly", label: "Monthly" },
    { value: "quarterly", label: "Quarterly" },
    { value: "semiannual", label: "Semiannual" },
    { value: "annual", label: "Annual" },
  ];
  return (
    <>
      <PageHeader
        title="Sales tax"
        description={
          <>
            Configure the taxes you collect. Gideon Books ships no rates: enter what each authority publishes, with the dates it applies. Documents use the rate in effect on their date and keep their own copy. The{" "}
            <Link href={`/o/${org}/reports/sales-tax`} className="text-brand-700 hover:underline">
              sales-tax liability report
            </Link>{" "}
            shows what you owe; filing the return is done with the authority (Gideon Books does not file sales-tax returns).
          </>
        }
      />
      <Alert tone="info">Taxability rules (which products and customers are taxable where) vary by jurisdiction and change. Gideon Books applies the codes you choose; it does not determine taxability or guarantee compliance.</Alert>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="space-y-6">
          {jurisdictions.map((j) => (
            <Card key={j.id} title={<span className="flex items-center gap-2">{j.name} {j.isArchived && <Badge tone="amber">archived</Badge>}</span>}>
              <ul className="mb-3 divide-y divide-slate-100 text-sm">
                {j.rates.length === 0 && <li className="py-2 text-slate-500">No rates yet — documents using it will be refused until a rate covers their date.</li>}
                {j.rates.map((r) => {
                  const current = r.effectiveFrom <= today && (!r.effectiveTo || r.effectiveTo >= today);
                  return (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>
                        <span className="num font-medium">{formatRatePercent(r.rate)}</span> {r.name} · <DateText date={r.effectiveFrom} /> – {r.effectiveTo ? <DateText date={r.effectiveTo} /> : "until changed"} {current && <Badge tone="green">in effect</Badge>}
                        {r.sourceNote && <span className="block text-xs text-slate-500">{r.sourceNote}</span>}
                      </span>
                      {manage && <ConfirmButton action={deleteTaxRateAction.bind(null, org, r.id)} label="Delete" size="sm" variant="ghost" title="Delete this rate?" body="Refused if any document was taxed at it. To change a rate, add a new one from the date it changes." confirmLabel="Delete" />}
                    </li>
                  );
                })}
              </ul>
              {manage && (
                <>
                  <ActionForm action={addTaxRateAction.bind(null, org, j.id)} resetOnSuccess className="grid items-end gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2 2xl:grid-cols-[6rem_1fr_10rem_10rem_auto]">
                    <TextField label="Rate %" name="rate" inputMode="decimal" required />
                    <TextField label="Label" name="name" defaultValue={j.name} />
                    <TextField label="From" name="effectiveFrom" type="date" required />
                    <TextField label="To (optional)" name="effectiveTo" type="date" />
                    <SubmitButton variant="secondary">Add rate</SubmitButton>
                    <TextField label="Source (notice, URL)" name="sourceNote" className="sm:col-span-2 2xl:col-span-5" />
                  </ActionForm>
                  <details className="mt-3">
                    <summary className="cursor-pointer text-sm text-brand-700">Edit jurisdiction</summary>
                    <ActionForm action={updateJurisdictionAction.bind(null, org, j.id)} className="mt-3 grid gap-3 sm:grid-cols-2">
                      <TextField label="Name" name="name" defaultValue={j.name} required />
                      <TextField label="Code" name="code" defaultValue={j.code ?? ""} />
                      <SelectField label="Tax owed to (liability account)" name="liabilityAccountId" defaultValue={j.liabilityAccountId} options={liabilities} required />
                      <SelectField label="Recoverable purchase tax account" name="recoverableAccountId" defaultValue={j.recoverableAccountId ?? ""} options={assets} placeholder="Not recoverable (added to cost)" />
                      <SelectField label="Authority (vendor)" name="authorityContactId" defaultValue={j.authorityContactId ?? ""} options={vendors} placeholder="—" />
                      <SelectField label="Filing frequency" name="filingFrequency" defaultValue={j.filingFrequency ?? ""} options={freq} placeholder="—" />
                      <label className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="isArchived" defaultChecked={j.isArchived} /> Archived
                      </label>
                      <div className="flex justify-end">
                        <SubmitButton variant="secondary">Save</SubmitButton>
                      </div>
                    </ActionForm>
                  </details>
                </>
              )}
            </Card>
          ))}
          {manage && (
            <Card title="Add a jurisdiction">
              <ActionForm action={createJurisdictionAction.bind(null, org)} resetOnSuccess className="grid gap-3 sm:grid-cols-2">
                <TextField label="Name" name="name" required placeholder="e.g. North Carolina" />
                <TextField label="Code" name="code" />
                <SelectField label="Tax owed to" name="liabilityAccountId" options={liabilities} placeholder="Sales Tax Payable" />
                <SelectField label="Recoverable purchase tax account" name="recoverableAccountId" options={assets} placeholder="Not recoverable (added to cost)" />
                <SelectField label="Filing frequency" name="filingFrequency" options={freq} placeholder="—" />
                <div className="flex items-end justify-end">
                  <SubmitButton variant="secondary">Add jurisdiction</SubmitButton>
                </div>
              </ActionForm>
            </Card>
          )}
          <Card title="Tax codes">
            <p className="mb-3 text-sm text-slate-600">What a line is taxed with: one or more jurisdictions, applied in order. Items and lines choose a code.</p>
            <div className="space-y-4">
              {codes.map((c) => (
                <details key={c.id} className="rounded-md border border-slate-200 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    {c.name} {c.isExempt && <Badge>exempt</Badge>} {c.isArchived && <Badge tone="amber">archived</Badge>}{" "}
                    <span className="font-normal text-slate-500">{c.components.map((x) => jurisdictions.find((j) => j.id === x.jurisdictionId)?.name).join(" + ")}</span>
                  </summary>
                  {manage && (
                    <div className="mt-3">
                      <TaxCodeForm
                        action={saveTaxCodeAction.bind(null, org, c.id)}
                        jurisdictions={jOptions}
                        defaults={{ name: c.name, description: c.description ?? "", isExempt: c.isExempt, isArchived: c.isArchived, components: c.components.map((x) => ({ jurisdictionId: x.jurisdictionId, isCompound: x.isCompound })) }}
                        submitLabel="Save code"
                      />
                    </div>
                  )}
                </details>
              ))}
              {manage && (
                <div className="border-t border-slate-100 pt-3">
                  <h3 className="mb-2 text-sm font-semibold">New tax code</h3>
                  <TaxCodeForm action={saveTaxCodeAction.bind(null, org, null)} jurisdictions={jOptions} submitLabel="Create code" />
                </div>
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-6">
          {manage && jOptions.length > 0 && (
            <Card title="Record a remittance">
              <p className="mb-3 text-xs text-slate-600">Records a payment you made to the authority. Gideon Books does not send money or file the return.</p>
              <ActionForm action={remitTaxAction.bind(null, org)} resetOnSuccess className="space-y-3">
                <SelectField label="Jurisdiction" name="jurisdictionId" options={jOptions} required />
                <TextField label="Payment date" name="date" type="date" defaultValue={today} required />
                <TextField label="Amount" name="amount" inputMode="decimal" required />
                <SelectField label="Paid from" name="paidFromAccountId" options={money} required placeholder="Choose…" />
                <div className="grid grid-cols-2 gap-2">
                  <TextField label="Period from" name="periodStart" type="date" />
                  <TextField label="to" name="periodEnd" type="date" />
                </div>
                <TextField label="Confirmation / reference" name="reference" />
                <SubmitButton>Record remittance</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {manage && jOptions.length > 0 && (
            <Card title="Adjust tax owed">
              <p className="mb-3 text-xs text-slate-600">A discount for filing on time, a correction, or a penalty. Positive increases what is owed.</p>
              <ActionForm action={adjustTaxAction.bind(null, org)} resetOnSuccess className="space-y-3">
                <SelectField label="Jurisdiction" name="jurisdictionId" options={jOptions} required />
                <TextField label="Date" name="date" type="date" defaultValue={today} required />
                <TextField label="Amount" name="amount" inputMode="decimal" required />
                <SelectField label="Offsetting account" name="offsetAccountId" options={allAccounts} required placeholder="Choose…" />
                <TextField label="Reason" name="reason" required />
                <SubmitButton variant="secondary">Post adjustment</SubmitButton>
              </ActionForm>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
