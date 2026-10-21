import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listPaymentTerms } from "@/lib/contacts/contacts";
import { numberSequences } from "@/lib/db/schema/core";
import { SEQUENCE_DEFAULTS } from "@/lib/ledger/sequences";
import { eq } from "drizzle-orm";
import { Alert, Card, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { saveOrgSettingsAction, saveSequenceAction, saveTermsAction } from "./actions";
import { CURRENCIES } from "@/lib/money/currency";
import { Decimal } from "@/lib/money/decimal";

export const metadata = { title: "Organization settings" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const ENTITY = { sole_proprietorship: "Sole proprietorship", partnership: "Partnership", llc: "LLC", s_corporation: "S corporation", c_corporation: "C corporation", nonprofit: "Nonprofit", trust: "Trust", estate: "Estate", other: "Other" };
const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "America/Toronto", "Europe/London", "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Singapore", "Australia/Sydney", "UTC"];
const SEQ_LABELS: Record<string, string> = {
  invoice: "Invoices",
  estimate: "Estimates",
  credit_note: "Credit notes",
  sales_receipt: "Sales receipts",
  purchase_order: "Purchase orders",
  bill: "Bills",
  expense: "Expenses",
  customer_payment: "Customer payments",
  vendor_payment: "Vendor payments",
};

export default async function Settings({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const o = ctx.org;
  const editable = can(ctx, "org.settings");
  const db = getDb();
  const terms = await listPaymentTerms(db, ctx.orgId);
  const seqRows = await db.select().from(numberSequences).where(eq(numberSequences.orgId, ctx.orgId));
  const seq = (k: string) => seqRows.find((r) => r.key === k) ?? { prefix: SEQUENCE_DEFAULTS[k]?.prefix ?? "", nextValue: 1, padding: SEQUENCE_DEFAULTS[k]?.padding ?? 4 };
  const a = o.profile.address ?? {};
  return (
    <>
      <PageHeader title="Organization settings" description="How these books are kept and what documents say about the business." />
      {!editable && (
        <div className="mb-4">
          <Alert tone="info">Only owners and administrators change these settings.</Alert>
        </div>
      )}
      <div className="space-y-6">
        <Card title="Organization">
          <ActionForm action={saveOrgSettingsAction.bind(null, org)} className="space-y-4">
            <fieldset disabled={!editable} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Name" name="name" defaultValue={o.name} required />
                <TextField label="Legal name" name="legalName" defaultValue={o.legalName ?? ""} />
                <SelectField label="Entity type" name="entityType" defaultValue={o.entityType} options={Object.entries(ENTITY).map(([value, label]) => ({ value, label }))} />
                <TextField label="Tax ID (shown on documents if set)" name="taxId" defaultValue={o.profile.taxId ?? ""} />
                <SelectField label="Time zone" name="timezone" defaultValue={o.timezone} options={(ZONES.includes(o.timezone) ? ZONES : [o.timezone, ...ZONES]).map((z) => ({ value: z, label: z }))} />
                <TextField label="Base currency" name="baseCurrencyShown" defaultValue={`${o.baseCurrency} — ${CURRENCIES.get(o.baseCurrency)?.name ?? ""}`} disabled hint="Fixed once anything is posted." />
                <SelectField label="Fiscal year starts" name="fiscalYearStartMonth" defaultValue={String(o.fiscalYearStartMonth)} options={MONTHS.map((m, i) => ({ value: String(i + 1), label: m }))} hint="Fixed once periods hold postings." />
                <TextField label="Books start on" name="booksStartDate" type="date" defaultValue={o.booksStartDate ?? ""} />
                <SelectField
                  label="Default report basis"
                  name="reportingBasis"
                  defaultValue={o.reportingBasis}
                  options={[
                    { value: "accrual", label: "Accrual" },
                    { value: "cash", label: "Cash" },
                  ]}
                  hint="Every report can switch; this is where they start."
                />
                <SelectField
                  label="Sales-tax rounding"
                  name="taxRounding"
                  defaultValue={o.taxRounding}
                  options={[
                    { value: "line", label: "Round each line" },
                    { value: "document", label: "Round once per document (per rate)" },
                  ]}
                  hint="Use what your taxing authority requires."
                />
              </div>
              <CheckboxField
                name="bankRulesAutoPost"
                defaultChecked={o.bankRulesAutoPost}
                label="Allow bank rules marked “auto-categorize” to post without review"
                hint="Off by default. Even when on, only rules created by someone with that permission post automatically, and every auto-posted transaction stays marked for review."
              />
              <h3 className="pt-2 text-sm font-semibold text-slate-900">Contact details on documents</h3>
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField label="Email" name="email" type="email" defaultValue={o.profile.email ?? ""} />
                <TextField label="Phone" name="phone" defaultValue={o.profile.phone ?? ""} />
                <TextField label="Website" name="website" defaultValue={o.profile.website ?? ""} />
                <TextField label="Address" name="line1" defaultValue={a.line1 ?? ""} className="sm:col-span-2" />
                <TextField label="Address line 2" name="line2" defaultValue={a.line2 ?? ""} />
                <TextField label="City" name="city" defaultValue={a.city ?? ""} />
                <TextField label="State / region" name="region" defaultValue={a.region ?? ""} />
                <TextField label="Postal code" name="postalCode" defaultValue={a.postalCode ?? ""} />
                <TextField label="Country" name="addrCountry" defaultValue={a.country ?? o.country} />
              </div>
              {editable && (
                <div className="flex justify-end">
                  <SubmitButton>Save settings</SubmitButton>
                </div>
              )}
            </fieldset>
          </ActionForm>
        </Card>

        <Card title="Document numbering" padded={false}>
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Prefix</Th>
                <Th>Next number</Th>
                <Th>Digits</Th>
                <Th>
                  <span className="sr-only">Save</span>
                </Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(SEQ_LABELS).map(([key, label]) => {
                const s = seq(key);
                return (
                  <tr key={key}>
                    <Td colSpan={5}>
                      <ActionForm action={saveSequenceAction.bind(null, org, key)} className="grid grid-cols-[10rem_8rem_8rem_6rem_auto] items-end gap-3">
                        <span className="pb-2 text-sm font-medium">{label}</span>
                        <TextField label="Prefix" name="prefix" defaultValue={s.prefix} disabled={!editable} />
                        <TextField label="Next" name="nextValue" defaultValue={String(s.nextValue)} inputMode="numeric" disabled={!editable} />
                        <TextField label="Digits" name="padding" defaultValue={String(s.padding)} inputMode="numeric" disabled={!editable} />
                        {editable && <SubmitButton variant="secondary">Save</SubmitButton>}
                      </ActionForm>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="px-4 py-3 text-xs text-slate-500">Numbers are assigned when a document is issued, in order and without gaps. A number already used cannot be issued twice.</p>
        </Card>

        <Card title="Payment terms">
          <ul className="mb-4 divide-y divide-slate-100">
            {terms.map((t) => (
              <li key={t.id} className="py-2">
                <ActionForm action={saveTermsAction.bind(null, org, t.id)} className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_8rem_8rem_auto]">
                  <TextField label="Name" name="name" defaultValue={t.name} disabled={!editable} />
                  <TextField label="Days due" name="daysDue" defaultValue={String(t.daysDue)} inputMode="numeric" disabled={!editable} />
                  <TextField label="Early-pay %" name="discountPercent" defaultValue={t.discountRate ? Decimal.from(t.discountRate).mul(100).normalize().toString() : ""} disabled={!editable} />
                  <TextField label="Within days" name="discountDays" defaultValue={t.discountDays ? String(t.discountDays) : ""} disabled={!editable} />
                  {editable && <SubmitButton variant="secondary">Save</SubmitButton>}
                </ActionForm>
              </li>
            ))}
          </ul>
          {editable && (
            <ActionForm action={saveTermsAction.bind(null, org, null)} resetOnSuccess className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_auto]">
              <TextField label="New terms" name="name" placeholder="Net 45" />
              <TextField label="Days due" name="daysDue" inputMode="numeric" />
              <SubmitButton variant="secondary">Add</SubmitButton>
            </ActionForm>
          )}
        </Card>
      </div>
    </>
  );
}
