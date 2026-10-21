"use client";

/**
 * The editor for every sales and purchase document: header (contact, dates,
 * terms, currency), lines (item, description, quantity, price, discount,
 * account, tax code, dimensions), document discount and totals. Totals are
 * computed in the browser with the same code the server posts with
 * (lib/commerce/compute.ts); the server recomputes on save with the rates in
 * effect on the document date.
 */
import { useMemo, useState } from "react";
import { ActionForm, CheckboxField, Options, SelectField, SubmitButton, TextAreaField, TextField, type Option } from "@/components/client/forms";
import { buttonClass, cx, inputClass } from "@/components/ui";
import { computeDocument, ComputeError } from "@/lib/commerce/compute";
import { Decimal } from "@/lib/money/decimal";
import { formatMoney } from "@/lib/money/format";
import type { TaxComponent } from "@/lib/tax/calculate";
import type { ActionResult } from "@/lib/web/actions";

export interface ItemChoice {
  id: string;
  name: string;
  kind: "service" | "non_stock" | "stock";
  description: string | null;
  price: string | null;
  taxCodeId: string | null;
  accountId: string | null;
  unit: string;
}

export interface TaxCodeChoice {
  id: string;
  name: string;
  /** Components with the rate in effect on the document date (rate as a decimal string). */
  components: { jurisdictionId: string; taxRateId: string; rate: string; sequence: number; isCompound: boolean; isRecoverable: boolean }[];
}

export type { DocLineDraft, DocumentDraft } from "@/lib/commerce/draft";
import { blankLine, type DocLineDraft, type DocumentDraft } from "@/lib/commerce/draft";

export interface DocumentFormProps {
  action: (prev: ActionResult<unknown> | null, fd: FormData) => Promise<ActionResult<unknown>>;
  side: "sales" | "purchases";
  /** Labels and which header fields show. */
  kindLabel: string;
  contactLabel: string;
  contacts: (Option & { currency?: string | null; taxExempt?: boolean; termsId?: string | null })[];
  items: ItemChoice[];
  accounts: Option[];
  taxCodes: TaxCodeChoice[];
  terms: Option[];
  currencies: Option[];
  baseCurrency: string;
  dims: { classes: Option[]; departments: Option[]; locations: Option[]; funds: Option[]; projects: Option[] };
  stockLocations?: Option[];
  cashAccounts?: Option[];
  customers?: Option[];
  show: { dueDate?: boolean; expiryDate?: boolean; terms?: boolean; cashAccount?: boolean; reference?: string | false; notes?: boolean; shipping?: boolean; reimbursement?: boolean; billable?: boolean; postingDate?: boolean };
  defaults: DocumentDraft;
  /** Buttons: "draft" saves; "issue" saves and posts. */
  issueLabel?: string | false;
  draftLabel?: string;
  taxRounding: "line" | "document";
}

function n(v: string): Decimal {
  return Decimal.tryFrom(v.replace(/[,\s$]/g, "")) ?? Decimal.ZERO;
}

export function DocumentForm(p: DocumentFormProps) {
  const [d, setD] = useState<DocumentDraft>(p.defaults.lines.length ? p.defaults : { ...p.defaults, lines: [blankLine()] });
  const [showDims, setShowDims] = useState(p.defaults.lines.some((l) => l.projectId || l.classId || l.departmentId || l.locationId || l.fundId));
  const hasDims = p.dims.projects.length + p.dims.classes.length + p.dims.departments.length + p.dims.locations.length + p.dims.funds.length > 0;
  const contact = p.contacts.find((c) => c.value === d.contactId);
  const currency = d.currency || contact?.currency || p.baseCurrency;
  const exempt = p.side === "sales" && !!contact?.taxExempt;
  const itemMap = useMemo(() => new Map(p.items.map((i) => [i.id, i])), [p.items]);
  const taxMap = useMemo(() => new Map(p.taxCodes.map((t) => [t.id, t])), [p.taxCodes]);

  const setLine = (i: number, patch: Partial<DocLineDraft>) => setD((s) => ({ ...s, lines: s.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) }));

  const pickItem = (i: number, itemId: string) => {
    const it = itemMap.get(itemId);
    setLine(i, {
      itemId,
      ...(it
        ? {
            description: it.description ?? it.name,
            unitPrice: it.price ? Decimal.from(it.price).normalize().toString() : "",
            taxCodeId: it.taxCodeId ?? "",
            accountId: it.accountId ?? "",
          }
        : {}),
    });
  };

  const computed = useMemo(() => {
    try {
      const doc = computeDocument({
        currency,
        taxInclusive: d.taxInclusive,
        rounding: p.taxRounding,
        discountType: d.discountType || null,
        discountValue: d.discountValue.replace(/[,\s$%]/g, "") || null,
        lines: d.lines.map((l, i) => ({
          key: String(i),
          lineType: l.lineType,
          quantity: n(l.quantity || "0").toString(),
          unitPrice: n(l.unitPrice || "0").toString(),
          discountRate: l.discountPercent ? n(l.discountPercent).div(100, 8, "half_up").toString() : null,
          taxComponents: (taxMap.get(l.taxCodeId)?.components ?? []).map(
            (c): TaxComponent => ({ jurisdictionId: c.jurisdictionId, taxRateId: c.taxRateId, rate: Decimal.from(c.rate), sequence: c.sequence, isCompound: c.isCompound, accountId: null, isRecoverable: c.isRecoverable }),
          ),
          exempt,
        })),
      });
      return { doc, error: null as string | null };
    } catch (e) {
      return { doc: null, error: e instanceof ComputeError || e instanceof Error ? e.message : "Cannot compute" };
    }
  }, [d, currency, exempt, p.taxRounding, taxMap]);

  const fmt = (v: Decimal | undefined) => (v ? formatMoney(v.toString(), currency) : "—");
  const showFx = currency !== p.baseCurrency;

  return (
    <ActionForm action={p.action} className="space-y-6">
      <input type="hidden" name="lineCount" value={d.lines.length} />
      <div className="grid gap-4 md:grid-cols-3">
        <SelectField
          label={p.contactLabel}
          name="contactId"
          required
          placeholder="Choose…"
          options={p.contacts}
          value={d.contactId}
          onChange={(e) => {
            const c = p.contacts.find((x) => x.value === e.target.value);
            setD((s) => ({ ...s, contactId: e.target.value, currency: c?.currency ?? "", paymentTermsId: c?.termsId ?? s.paymentTermsId }));
          }}
          className="md:col-span-1"
        />
        <TextField label={`${p.kindLabel} date`} name="issueDate" type="date" required value={d.issueDate} onChange={(e) => setD((s) => ({ ...s, issueDate: e.target.value }))} />
        {p.show.dueDate && <TextField label="Due date" name="dueDate" type="date" value={d.dueDate} onChange={(e) => setD((s) => ({ ...s, dueDate: e.target.value }))} hint="Blank: from the payment terms." />}
        {p.show.expiryDate && <TextField label={p.side === "sales" ? "Valid until" : "Expected by"} name="expiryDate" type="date" value={d.expiryDate} onChange={(e) => setD((s) => ({ ...s, expiryDate: e.target.value }))} />}
        {p.show.terms && <SelectField label="Payment terms" name="paymentTermsId" placeholder="Contact's terms" options={p.terms} value={d.paymentTermsId} onChange={(e) => setD((s) => ({ ...s, paymentTermsId: e.target.value }))} />}
        {p.show.cashAccount && p.cashAccounts && (
          <SelectField
            label={p.side === "sales" ? "Deposit to" : "Paid from"}
            name="cashAccountId"
            required
            placeholder="Choose…"
            options={p.cashAccounts}
            value={d.cashAccountId}
            onChange={(e) => setD((s) => ({ ...s, cashAccountId: e.target.value }))}
          />
        )}
        {p.show.reference !== false && (
          <TextField label={p.show.reference ?? "Reference"} name="reference" value={d.reference} onChange={(e) => setD((s) => ({ ...s, reference: e.target.value }))} />
        )}
        <SelectField
          label="Currency"
          name="currency"
          options={[{ value: "", label: contact?.currency ? `${contact.currency} (contact's)` : `${p.baseCurrency} (base)` }, ...p.currencies]}
          value={d.currency}
          onChange={(e) => setD((s) => ({ ...s, currency: e.target.value }))}
        />
        {showFx && (
          <TextField
            label={`Rate (${p.baseCurrency} per ${currency})`}
            name="fxRate"
            inputMode="decimal"
            value={d.fxRate}
            onChange={(e) => setD((s) => ({ ...s, fxRate: e.target.value }))}
            hint="Blank: the stored rate for the posting date."
          />
        )}
        {p.show.postingDate && (
          <TextField label="Posting date" name="postingDate" type="date" value={d.postingDate} onChange={(e) => setD((s) => ({ ...s, postingDate: e.target.value }))} hint="Blank: the document date." />
        )}
        {p.stockLocations && p.stockLocations.length > 1 && (
          <SelectField label="Stock location" name="inventoryLocationId" placeholder="Default" options={p.stockLocations} value={d.inventoryLocationId} onChange={(e) => setD((s) => ({ ...s, inventoryLocationId: e.target.value }))} />
        )}
      </div>
      {exempt && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">This customer is tax-exempt: lines record the base as exempt sales and charge no tax.</p>}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="taxInclusive" checked={d.taxInclusive} onChange={(e) => setD((s) => ({ ...s, taxInclusive: e.target.checked }))} /> Prices include tax
        </label>
        {p.show.reimbursement && <CheckboxField label="Employee expense to reimburse" name="isReimbursement" defaultChecked={d.isReimbursement} />}
        {hasDims && (
          <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setShowDims((s) => !s)}>
            {showDims ? "Hide dimensions" : "Projects, classes and other dimensions"}
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
            <tr>
              <th className="px-2 py-2 text-left">Item / description</th>
              <th className="w-24 px-2 py-2 text-right">Qty</th>
              <th className="w-28 px-2 py-2 text-right">Price</th>
              <th className="w-20 px-2 py-2 text-right">Disc %</th>
              <th className="px-2 py-2 text-left">Account</th>
              <th className="px-2 py-2 text-left">Tax</th>
              <th className="w-28 px-2 py-2 text-right">Amount</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {d.lines.map((l, i) => {
              const c = computed.doc?.lines[i];
              const it = itemMap.get(l.itemId);
              return (
                <tr key={i} className="align-top">
                  <td className="px-2 py-1.5">
                    <input type="hidden" name={`lines.${i}.lineType`} value={l.lineType} />
                    <input type="hidden" name={`lines.${i}.sourceLineId`} value={l.sourceLineId} />
                    <input type="hidden" name={`lines.${i}.returnOfLineId`} value={l.returnOfLineId} />
                    {l.lineType === "shipping" ? (
                      <div className="py-1.5 text-xs font-medium uppercase text-slate-500">Shipping</div>
                    ) : (
                      <select name={`lines.${i}.itemId`} value={l.itemId} onChange={(e) => pickItem(i, e.target.value)} className={cx(inputClass, "mb-1 min-w-48")} aria-label={`Line ${i + 1} item`}>
                        <option value="">No item</option>
                        {p.items.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                            {x.kind === "stock" ? " (stock)" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    <input name={`lines.${i}.description`} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} placeholder="Description" className={inputClass} aria-label={`Line ${i + 1} description`} />
                    {showDims && (
                      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                        <input type="date" name={`lines.${i}.serviceDate`} value={l.serviceDate} onChange={(e) => setLine(i, { serviceDate: e.target.value })} className={cx(inputClass, "text-xs")} aria-label="Service date" title="Service date" />
                        {p.dims.projects.length > 0 && <Dim name={`lines.${i}.projectId`} label="Project" value={l.projectId} options={p.dims.projects} onChange={(v) => setLine(i, { projectId: v })} />}
                        {p.dims.classes.length > 0 && <Dim name={`lines.${i}.classId`} label="Class" value={l.classId} options={p.dims.classes} onChange={(v) => setLine(i, { classId: v })} />}
                        {p.dims.departments.length > 0 && <Dim name={`lines.${i}.departmentId`} label="Department" value={l.departmentId} options={p.dims.departments} onChange={(v) => setLine(i, { departmentId: v })} />}
                        {p.dims.locations.length > 0 && <Dim name={`lines.${i}.locationId`} label="Location" value={l.locationId} options={p.dims.locations} onChange={(v) => setLine(i, { locationId: v })} />}
                        {p.dims.funds.length > 0 && <Dim name={`lines.${i}.fundId`} label="Fund" value={l.fundId} options={p.dims.funds} onChange={(v) => setLine(i, { fundId: v })} />}
                        {p.show.billable && p.customers && <Dim name={`lines.${i}.billableCustomerId`} label="Billable to" value={l.billableCustomerId} options={p.customers} onChange={(v) => setLine(i, { billableCustomerId: v })} />}
                        {it?.kind === "stock" && p.stockLocations && p.stockLocations.length > 1 && (
                          <Dim name={`lines.${i}.inventoryLocationId`} label="Stock location" value={l.inventoryLocationId} options={p.stockLocations} onChange={(v) => setLine(i, { inventoryLocationId: v })} />
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <input name={`lines.${i}.quantity`} value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} quantity`} />
                    {it && <div className="mt-0.5 text-right text-xs text-slate-500">{it.unit}</div>}
                  </td>
                  <td className="px-2 py-1.5">
                    <input name={`lines.${i}.unitPrice`} value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} price`} />
                  </td>
                  <td className="px-2 py-1.5">
                    <input name={`lines.${i}.discountPercent`} value={l.discountPercent} onChange={(e) => setLine(i, { discountPercent: e.target.value })} className={cx(inputClass, "num text-right")} inputMode="decimal" aria-label={`Line ${i + 1} discount percent`} />
                  </td>
                  <td className="px-2 py-1.5">
                    <select name={`lines.${i}.accountId`} value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })} className={cx(inputClass, "min-w-40")} aria-label={`Line ${i + 1} account`} disabled={it?.kind === "stock" && p.side === "purchases"}>
                      <option value="">{it ? "Item's account" : "Default"}</option>
                      <Options options={p.accounts} />
                    </select>
                  </td>
                  <td className="px-2 py-1.5">
                    <select name={`lines.${i}.taxCodeId`} value={l.taxCodeId} onChange={(e) => setLine(i, { taxCodeId: e.target.value })} className={cx(inputClass, "min-w-28")} aria-label={`Line ${i + 1} tax code`}>
                      <option value="">No tax</option>
                      {p.taxCodes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="num px-2 py-2 text-right">{c ? fmt(c.amount) : "—"}</td>
                  <td className="px-1 py-1.5 text-center">
                    <button type="button" onClick={() => setD((s) => ({ ...s, lines: s.lines.filter((_, k) => k !== i) }))} disabled={d.lines.length <= 1} className="rounded p-1 text-slate-400 hover:text-danger-600 disabled:opacity-30" aria-label={`Remove line ${i + 1}`}>
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="flex gap-2 border-t border-slate-100 bg-slate-50 px-2 py-2">
          <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setD((s) => ({ ...s, lines: [...s.lines, blankLine()] }))}>
            + Add line
          </button>
          {p.show.shipping && !d.lines.some((l) => l.lineType === "shipping") && (
            <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setD((s) => ({ ...s, lines: [...s.lines, { ...blankLine(), lineType: "shipping", description: "Shipping" }] }))}>
              + Shipping
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {p.show.notes && <TextAreaField label="Notes printed on the document" name="notes" value={d.notes} onChange={(e) => setD((s) => ({ ...s, notes: e.target.value }))} />}
          <TextAreaField label="Internal memo" name="memo" value={d.memo} onChange={(e) => setD((s) => ({ ...s, memo: e.target.value }))} rows={2} />
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
          <div className="mb-3 flex items-end gap-2">
            <label className="flex-1 text-xs font-medium text-slate-600">
              Document discount
              <select name="discountType" value={d.discountType} onChange={(e) => setD((s) => ({ ...s, discountType: e.target.value as DocumentDraft["discountType"] }))} className={cx(inputClass, "mt-1")}>
                <option value="">None</option>
                <option value="percent">Percent</option>
                <option value="amount">Amount</option>
              </select>
            </label>
            {d.discountType && (
              <input name="discountValue" value={d.discountValue} onChange={(e) => setD((s) => ({ ...s, discountValue: e.target.value }))} className={cx(inputClass, "num w-24 text-right")} inputMode="decimal" aria-label="Discount value" />
            )}
          </div>
          <dl className="space-y-1.5">
            <Row label="Subtotal" value={fmt(computed.doc?.subtotal)} />
            {computed.doc && !computed.doc.discountTotal.isZero() && <Row label="Discount" value={`−${fmt(computed.doc.discountTotal)}`} />}
            <Row label={d.taxInclusive ? "Tax (included)" : "Tax"} value={fmt(computed.doc?.taxTotal)} />
            <div className="border-t border-slate-300 pt-1.5">
              <Row label="Total" value={fmt(computed.doc?.total)} strong />
            </div>
          </dl>
          {computed.error && <p className="mt-2 text-xs text-danger-700">{computed.error}</p>}
          <p className="mt-2 text-xs text-slate-500">Tax shown at the rates in effect on the document date when this page loaded; saved documents use the rates in effect on their date.</p>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <SubmitButton name="intent" value="draft" variant="secondary">
          {p.draftLabel ?? "Save draft"}
        </SubmitButton>
        {p.issueLabel !== false && (
          <SubmitButton name="intent" value="issue" pendingText="Posting…">
            {p.issueLabel ?? "Save and issue"}
          </SubmitButton>
        )}
      </div>
    </ActionForm>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cx("flex justify-between gap-4", strong && "text-base font-semibold")}>
      <dt className="text-slate-600">{label}</dt>
      <dd className="num">{value}</dd>
    </div>
  );
}

function Dim({ name, label, value, options, onChange }: { name: string; label: string; value: string; options: Option[]; onChange: (v: string) => void }) {
  return (
    <select name={name} value={value} onChange={(e) => onChange(e.target.value)} className={cx(inputClass, "text-xs")} aria-label={label} title={label}>
      <option value="">{label}…</option>
      <Options options={options} />
    </select>
  );
}
