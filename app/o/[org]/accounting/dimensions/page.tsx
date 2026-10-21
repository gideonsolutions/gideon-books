import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listDimensions, DIMENSION_LABELS, type DimensionKind } from "@/lib/ledger/dimensions";
import { can } from "@/lib/context";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ActionForm, CheckboxField, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { saveDimensionAction } from "../actions";
import Link from "next/link";

export const metadata = { title: "Dimensions & funds" };

const KINDS: { kind: DimensionKind; help: string }[] = [
  { kind: "class", help: "Any way you want to slice income and expense: product line, service type, channel." },
  { kind: "department", help: "Parts of the organization, for departmental profit and loss." },
  { kind: "location", help: "Places the business operates (stores, regions). Stock locations are separate, under Inventory." },
  { kind: "fund", help: "Nonprofit funds. Each carries its donor restriction, which drives net-asset classes in reports." },
];

const PLURALS: Record<DimensionKind, string> = { class: "Classes", department: "Departments", location: "Locations", fund: "Funds" };

const RESTRICTIONS = [
  { value: "without_donor_restrictions", label: "Without donor restrictions" },
  { value: "with_donor_restrictions_temporary", label: "With donor restrictions (purpose or time)" },
  { value: "with_donor_restrictions_perpetual", label: "With donor restrictions (perpetual)" },
];

export default async function Dimensions({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const all = await listDimensions(getDb(), ctx.orgId, undefined, { includeArchived: true });
  const editable = can(ctx, "accounts.manage");
  return (
    <>
      <PageHeader
        title="Dimensions & funds"
        description={
          <>
            Tags on each transaction line, for reports by class, department, location or fund. Projects have their own pages under{" "}
            <Link className="text-brand-700 hover:underline" href={`/o/${org}/projects`}>
              Projects
            </Link>
            ; trust principal/income and beneficiaries are set on each line of a trust&apos;s entries.
          </>
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        {KINDS.map(({ kind, help }) => {
          const values = all.filter((d) => d.kind === kind);
          return (
            <Card key={kind} title={PLURALS[kind]}>
              <p className="mb-3 text-sm text-slate-600">{help}</p>
              {values.length === 0 ? (
                <p className="mb-3 text-sm text-slate-500">None yet.</p>
              ) : (
                <ul className="mb-4 divide-y divide-slate-100">
                  {values.map((v) => (
                    <li key={v.id} className="py-2">
                      {editable ? (
                        <ActionForm action={saveDimensionAction.bind(null, org, v.id)} className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_auto]">
                          <input type="hidden" name="kind" value={kind} />
                          <TextField label="Name" name="name" defaultValue={v.name} />
                          <TextField label="Code" name="code" defaultValue={v.code ?? ""} />
                          <div className="flex items-center gap-3 pb-1">
                            <CheckboxField name="isArchived" label="Archived" defaultChecked={v.isArchived} />
                            <SubmitButton variant="secondary">Save</SubmitButton>
                          </div>
                          {kind === "fund" && <SelectField label="Restriction" name="restriction" defaultValue={v.restriction ?? undefined} options={RESTRICTIONS} className="sm:col-span-3" />}
                        </ActionForm>
                      ) : (
                        <span className="flex items-center gap-2 text-sm">
                          {v.name} {v.isArchived && <Badge tone="amber">archived</Badge>}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {editable && (
                <ActionForm action={saveDimensionAction.bind(null, org, null)} resetOnSuccess className="grid items-end gap-2 border-t border-slate-100 pt-3 sm:grid-cols-[minmax(0,1fr)_6rem_auto]">
                  <input type="hidden" name="kind" value={kind} />
                  <TextField label={`New ${DIMENSION_LABELS[kind].toLowerCase()}`} name="name" />
                  <TextField label="Code" name="code" />
                  <SubmitButton variant="secondary">Add</SubmitButton>
                  {kind === "fund" && <SelectField label="Restriction" name="restriction" defaultValue="without_donor_restrictions" options={RESTRICTIONS} className="sm:col-span-3" />}
                </ActionForm>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
