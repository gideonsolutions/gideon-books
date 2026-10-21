import { getDb } from "@/lib/db/client";
import { listLocations } from "@/lib/inventory/locations";
import { can } from "@/lib/context";
import { orgCtx } from "@/lib/web/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, CheckboxField, SubmitButton, TextField } from "@/components/client/forms";
import { saveLocationAction } from "../actions";

export const metadata = { title: "Stock locations" };

export default async function Locations({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const rows = await listLocations(getDb(), ctx.orgId, { includeArchived: true });
  const manage = can(ctx, "inventory.manage");
  return (
    <>
      <PageHeader title="Stock locations" description="Warehouses, stores, vans — anywhere stock is counted. One is the default for documents that do not say. A location holding stock cannot be archived." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-3">
          {rows.map((l) => (
            <Card
              key={l.id}
              title={
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-slate-500">{l.code}</span> {l.name}
                  {l.isDefault && <Badge tone="blue">default</Badge>}
                  {l.isArchived && <Badge tone="amber">archived</Badge>}
                </span>
              }
              actions={<span className="text-xs text-slate-500">{l.itemsInStock} item{l.itemsInStock === 1 ? "" : "s"} in stock</span>}
            >
              {manage ? (
                <ActionForm action={saveLocationAction.bind(null, org, l.id)} className="grid gap-3 sm:grid-cols-[8rem_1fr_auto] sm:items-end">
                  <TextField label="Code" name="code" defaultValue={l.code} required />
                  <TextField label="Name" name="name" defaultValue={l.name} required />
                  <SubmitButton variant="secondary">Save</SubmitButton>
                  <div className="flex flex-wrap gap-4 sm:col-span-3">
                    {l.isDefault ? <input type="hidden" name="isDefault" value="on" /> : <CheckboxField label="Make this the default" name="isDefault" />}
                    {!l.isDefault && <CheckboxField label="Archived" name="isArchived" defaultChecked={l.isArchived} />}
                  </div>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">{l.name}</p>
              )}
            </Card>
          ))}
        </div>
        {manage && (
          <Card title="New location">
            <ActionForm action={saveLocationAction.bind(null, org, null)} className="space-y-3" resetOnSuccess>
              <TextField label="Code" name="code" required hint="Short, e.g. WH2." />
              <TextField label="Name" name="name" required />
              <CheckboxField label="Make this the default" name="isDefault" />
              <SubmitButton>Add location</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
