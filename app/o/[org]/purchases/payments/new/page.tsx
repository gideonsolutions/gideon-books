import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema/ledger";
import { openItemsForContact } from "@/lib/commerce/open-items";
import { PAYMENT_KIND_LABELS } from "@/lib/commerce/payments";
import { KIND_LABELS } from "@/lib/commerce/states";
import { requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { contactOptions, moneyAccountOptions } from "@/lib/web/options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import type { DocumentKind, PaymentKind } from "@/lib/db/schema/commerce";
import { Alert, Card, FilterBar, FilterField, PageHeader, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { PayAllocations, type AllocationCandidate } from "@/components/purchases/pay-allocations";
import { recordPaymentAction } from "../../actions";

export const metadata = { title: "Pay bills" };

const KINDS = ["vendor_payment", "vendor_prepayment", "vendor_refund"] as const;

export default async function PayBills({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "payments.record");
  const db = getDb();
  const kind: (typeof KINDS)[number] = KINDS.includes(sp.kind as never) ? (sp.kind as (typeof KINDS)[number]) : "vendor_payment";
  const vendorOpts = [...(await contactOptions(db, ctx.orgId, "vendor")), ...(await contactOptions(db, ctx.orgId, "employee"))];
  const [vendor] = sp.vendor ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, sp.vendor))) : [];
  const today = todayIn(ctx.org.timezone);
  const currency = sp.currency || vendor?.currency || ctx.org.baseCurrency;
  let candidates: AllocationCandidate[] = [];
  if (vendor && kind !== "vendor_prepayment") {
    const open = await openItemsForContact(db, ctx.orgId, "payables", vendor.id);
    // A payment settles credit items (bills); a refund from the vendor settles debit items (credits, prepayments, overpayments).
    const want = kind === "vendor_payment" ? "credit" : "debit";
    candidates = open
      .filter((o) => o.nature === want && o.currency === currency)
      .map((o) => ({
        type: o.type,
        id: o.id,
        label: `${o.type === "document" ? KIND_LABELS[o.kind as DocumentKind] : PAYMENT_KIND_LABELS[o.kind as PaymentKind]} ${o.number ?? ""}`,
        date: o.date,
        dueDate: o.dueDate,
        open: o.openTxn,
        overdue: !!o.dueDate && o.dueDate < today,
      }));
  }
  const title = kind === "vendor_payment" ? "Pay bills" : PAYMENT_KIND_LABELS[kind];
  return (
    <>
      <PageHeader
        title={title}
        back={{ href: `/o/${org}/purchases/payments`, label: "Payments made" }}
        description={
          kind === "vendor_payment"
            ? "Record a payment you made to a vendor and the bills it pays. Any amount not applied stays as a credit with the vendor."
            : kind === "vendor_prepayment"
              ? "Money paid to a vendor before their bill. It waits as a prepayment and is applied when the bill arrives."
              : "Money a vendor sent back: apply it to their credits, prepayments or overpayments."
        }
      />
      <div className="mb-4">
        <Alert tone="info">This records a payment; it does not send money. Pay through your bank, then record it here.</Alert>
      </div>
      <FilterBar>
        <FilterField label="What">
          <select name="kind" defaultValue={kind} className={inputClass}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {PAYMENT_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </FilterField>
        <FilterField label="Vendor">
          <select name="vendor" defaultValue={vendor?.id ?? ""} className={inputClass} required>
            <option value="">Choose…</option>
            {vendorOpts.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </FilterField>
        {vendor && (
          <FilterField label="Currency">
            <select name="currency" defaultValue={currency} className={inputClass}>
              <option value={ctx.org.baseCurrency}>{ctx.org.baseCurrency}</option>
              {vendor.currency && vendor.currency !== ctx.org.baseCurrency && <option value={vendor.currency}>{vendor.currency}</option>}
            </select>
          </FilterField>
        )}
      </FilterBar>
      {!vendor ? (
        <p className="text-sm text-slate-600">Choose the vendor to see what is open.</p>
      ) : (
        <Card>
          <ActionForm action={recordPaymentAction.bind(null, org)} className="space-y-5">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="contactId" value={vendor.id} />
            <input type="hidden" name="currency" value={currency} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField label="Payment date" name="paymentDate" type="date" required defaultValue={today} />
              <SelectField label={kind === "vendor_refund" ? "Deposited to" : "Paid from"} name="accountId" required placeholder="Choose…" options={await moneyAccountOptions(db, ctx.orgId)} />
              <SelectField
                label="Method"
                name="method"
                defaultValue="check"
                options={[
                  { value: "check", label: "Check" },
                  { value: "ach", label: "ACH / bank transfer" },
                  { value: "wire", label: "Wire" },
                  { value: "card", label: "Card" },
                  { value: "cash", label: "Cash" },
                  { value: "other", label: "Other" },
                ]}
              />
              <TextField label="Check or reference number" name="reference" />
              {currency !== ctx.org.baseCurrency && (
                <>
                  <TextField label={`Rate (${ctx.org.baseCurrency} per ${currency})`} name="fxRate" inputMode="decimal" hint="Blank: the stored rate for the date." />
                  <TextField label={`Amount that left the account in ${ctx.org.baseCurrency}`} name="accountAmount" inputMode="decimal" hint="If paid from a base-currency account; sets the rate." />
                </>
              )}
              <TextField label="Memo" name="memo" className="sm:col-span-3" />
            </div>
            {kind !== "vendor_prepayment" && candidates.length === 0 && (
              <Alert tone="warning">{kind === "vendor_payment" ? "This vendor has no open bills in this currency. The whole payment will stay as a credit." : "Nothing of this vendor's is waiting for a refund."}</Alert>
            )}
            <PayAllocations candidates={candidates} currency={currency} preselect={sp.apply ?? null} />
            <div className="flex justify-end">
              <SubmitButton pendingText="Recording…">Record payment</SubmitButton>
            </div>
          </ActionForm>
        </Card>
      )}
    </>
  );
}
