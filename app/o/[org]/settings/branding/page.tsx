import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { Alert, Card, PageHeader } from "@/components/ui";
import { ActionForm, CheckboxField, SubmitButton, TextAreaField, TextField } from "@/components/client/forms";
import { saveBrandingAction } from "./actions";

export const metadata = { title: "Branding" };

export default async function Branding({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "org.settings");
  const p = ctx.org.profile ?? {};
  const b = p.branding ?? {};
  return (
    <>
      <PageHeader title="Branding" description="How invoices, estimates, credit notes and statements look to customers: your logo, color, address and the words at the bottom." />
      <Card className="max-w-3xl">
        <ActionForm action={saveBrandingAction.bind(null, org)} className="space-y-6">
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">Logo and color</h3>
            {b.logoAttachmentId ? (
              <div className="flex items-center gap-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/o/${org}/files/${b.logoAttachmentId}`} alt="Current logo" className="h-12 max-w-[10rem] rounded border border-slate-200 object-contain p-1" />
                <CheckboxField label="Remove the logo" name="removeLogo" />
              </div>
            ) : (
              <Alert tone="info">No logo yet: documents show the organization&apos;s name.</Alert>
            )}
            <label className="block text-sm font-medium text-slate-800">
              {b.logoAttachmentId ? "Replace the logo" : "Logo"} (PNG or JPEG, under 2 MB)
              <input type="file" name="logo" accept="image/png,image/jpeg" className="mt-1 block text-sm" />
            </label>
            <TextField label="Accent color" name="accentColor" defaultValue={b.accentColor ?? "#013ea9"} hint="A band across the top of documents, e.g. #013ea9." />
          </section>
          <section className="grid gap-3 sm:grid-cols-2">
            <h3 className="text-sm font-semibold text-slate-900 sm:col-span-2">On every document</h3>
            <TextField label="Email" name="email" type="email" defaultValue={p.email ?? ""} hint="Customers reply here." />
            <TextField label="Phone" name="phone" defaultValue={p.phone ?? ""} />
            <TextField label="Website" name="website" defaultValue={p.website ?? ""} />
            <TextField label="Tax ID shown on invoices" name="taxId" defaultValue={p.taxId ?? ""} hint="Only if you want it printed." />
            <TextField label="Street" name="line1" defaultValue={p.address?.line1 ?? ""} className="sm:col-span-2" />
            <TextField label="Suite / unit" name="line2" defaultValue={p.address?.line2 ?? ""} />
            <TextField label="City" name="city" defaultValue={p.address?.city ?? ""} />
            <TextField label="State / region" name="region" defaultValue={p.address?.region ?? ""} />
            <TextField label="Postal code" name="postalCode" defaultValue={p.address?.postalCode ?? ""} />
            <TextField label="Country" name="country" defaultValue={p.address?.country ?? ""} />
          </section>
          <TextAreaField label="How to pay (printed on invoices and statements)" name="paymentInstructions" defaultValue={b.paymentInstructions ?? ""} rows={3} hint="Bank details, mailing address for checks." />
          <TextField label="Footer" name="invoiceFooter" defaultValue={b.invoiceFooter ?? ""} hint="A short line at the bottom of every page." />
          <div className="flex justify-end">
            <SubmitButton>Save branding</SubmitButton>
          </div>
        </ActionForm>
      </Card>
    </>
  );
}
