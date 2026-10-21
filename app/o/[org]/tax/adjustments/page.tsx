import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { allCategories } from "@/lib/taxexport/mappings";
import { depreciationDifferences, listAdjustments } from "@/lib/taxexport/adjustments";
import { taxSelection } from "@/lib/taxexport/params";
import { readParams, type SearchParams } from "@/lib/web/params";
import { formatDateTime } from "@/lib/money/format";
import { Alert, Badge, Card, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { SelectionFields, TaxHeader } from "@/components/taxexport/tax-header";
import { addAdjustmentAction, importDepreciationAction, voidAdjustmentAction } from "../actions";

export const metadata = { title: "Book-to-tax adjustments" };

export default async function TaxAdjustments({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const sel = taxSelection(ctx.org, sp);
  const db = getDb();
  const adjustments = await listAdjustments(db, ctx.orgId, sel.returnType, sel.taxYearStart, sel.taxYearEnd, { includeVoided: true });
  const categories = await allCategories(db, ctx.orgId, sel.returnType);
  const catName = new Map(categories.map((c) => [c.code, c.line ? `Line ${c.line} — ${c.description}` : c.description]));
  const dep = await depreciationDifferences(db, ctx.orgId, sel.taxYearStart, sel.taxYearEnd);
  const manage = can(ctx, "tax_export.manage");
  const base = `/o/${org}`;
  const depCategory = categories.find((c) => /depreciation/i.test(c.description))?.code ?? "";
  return (
    <>
      <PageHeader
        title="Book-to-tax adjustments"
        description="Differences between the books and the return — the nondeductible half of meals, tax depreciation in place of book depreciation, income taxed in a different year. They change the tax figures in the reconciliation and the export; they never post to the ledger."
      />
      <TaxHeader base={base} sel={sel} current="adjustments" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Table>
          <thead>
            <tr>
              <Th>Category</Th>
              <Th>Description</Th>
              <Th>Kind</Th>
              <Th align="right">Amount</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {adjustments.length === 0 && (
              <tr>
                <Td colSpan={5} className="py-8 text-center text-slate-500">
                  No adjustments for this tax year.
                </Td>
              </tr>
            )}
            {adjustments.map((a) => (
              <tr key={a.id} className={a.voidedAt ? "opacity-50" : ""}>
                <Td>{catName.get(a.categoryCode) ?? a.categoryCode}</Td>
                <Td>
                  {a.description}
                  <div className="text-xs text-slate-500">
                    {a.source.replace(/_/g, " ")} · {formatDateTime(a.createdAt)}
                    {a.voidedAt ? ` · removed: ${a.voidReason}` : ""}
                  </div>
                </Td>
                <Td>
                  <Badge tone={a.kind === "permanent" ? "blue" : "gray"}>{a.kind}</Badge>
                </Td>
                <Td align="right">
                  <Money amount={a.amount} currency={ctx.org.baseCurrency} />
                </Td>
                <Td align="right">
                  {manage && !a.voidedAt && (
                    <ConfirmButton action={voidAdjustmentAction.bind(null, org, a.id)} label="Remove" size="sm" title="Remove this adjustment?" reasonLabel="Why?" confirmLabel="Remove" variant="danger" />
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="space-y-6">
          {manage && (
            <Card title="Add an adjustment">
              <ActionForm action={addAdjustmentAction.bind(null, org)} className="space-y-3" resetOnSuccess>
                <SelectionFields sel={sel} />
                <SelectField label="Category" name="categoryCode" required placeholder="Choose…" options={categories.map((c) => ({ value: c.code, label: catName.get(c.code)! }))} />
                <TextField label="Amount" name="amount" required inputMode="decimal" hint="Added to the category's book amount; negative reduces it (e.g. −500 to disallow half of 1,000 of meals)." />
                <SelectField
                  label="Kind"
                  name="kind"
                  defaultValue="permanent"
                  options={[
                    { value: "permanent", label: "Permanent (never reverses)" },
                    { value: "temporary", label: "Temporary (timing; reverses in later years)" },
                  ]}
                />
                <SelectField
                  label="Source"
                  name="source"
                  defaultValue="manual"
                  options={[
                    { value: "manual", label: "Entered by hand" },
                    { value: "meals_limitation", label: "Meals limitation" },
                    { value: "other", label: "Other" },
                  ]}
                />
                <TextField label="Description" name="description" required />
                <SubmitButton variant="secondary">Add adjustment</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card title="Tax depreciation">
            {dep === null ? (
              <Alert tone="info">The fixed-asset register does not provide tax depreciation yet, so it cannot be imported here.</Alert>
            ) : dep.length === 0 ? (
              <p className="text-sm text-slate-600">No asset has a tax book for this year. Set one on the asset (Fixed assets → asset → tax book).</p>
            ) : (
              <>
                <ul className="mb-3 space-y-1 text-sm">
                  {dep.map((d) => (
                    <li key={d.assetId} className="flex justify-between gap-2">
                      <span className="truncate">{d.assetName}</span>
                      <span className="num">
                        <Money amount={d.difference} currency={ctx.org.baseCurrency} />
                      </span>
                    </li>
                  ))}
                </ul>
                {manage && (
                  <ActionForm action={importDepreciationAction.bind(null, org)} className="space-y-2">
                    <SelectionFields sel={sel} />
                    <SelectField label="Depreciation category" name="categoryCode" defaultValue={depCategory} options={categories.map((c) => ({ value: c.code, label: catName.get(c.code)! }))} />
                    <SubmitButton variant="secondary">Import tax-minus-book differences</SubmitButton>
                  </ActionForm>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
