import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { allCategories, currentVersion, findSet, listVersions, mappingsOf } from "@/lib/taxexport/mappings";
import { reconcile } from "@/lib/taxexport/reconcile";
import { taxSelection } from "@/lib/taxexport/params";
import { loadChart, label } from "@/lib/reports/accounts";
import { dimensionOptions } from "@/lib/web/options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { formatDateTime } from "@/lib/money/format";
import { Decimal } from "@/lib/money/decimal";
import { Badge, Card, Money, PageHeader, cx, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { TaxHeader } from "@/components/taxexport/tax-header";
import { addCategoryAction, addDimensionMappingAction, confirmAllAction, saveMappingsAction, suggestAction } from "../actions";

export const metadata = { title: "Tax mappings" };

const KIND_LABEL: Record<string, string> = { income: "Income", cogs: "Cost of goods sold", deduction: "Deductions", nondeductible: "Gideon Books", nontaxable: "Gideon Books", separately_stated: "Gideon Books" };

export default async function TaxMappings({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const sel = taxSelection(ctx.org, sp);
  const db = getDb();
  const set = await findSet(db, ctx.orgId, sel.returnType);
  const version = set ? await currentVersion(db, ctx.orgId, set.id) : null;
  const versions = set ? await listVersions(db, ctx.orgId, set.id) : [];
  const mappings = version ? await mappingsOf(db, ctx.orgId, version.id) : [];
  const categories = await allCategories(db, ctx.orgId, sel.returnType);
  const chart = await loadChart(db, ctx.orgId);
  const rec = await reconcile(db, ctx.org, sel);
  const amountByAccount = new Map<string, Decimal>();
  for (const s of rec.sources) amountByAccount.set(s.accountId, (amountByAccount.get(s.accountId) ?? Decimal.ZERO).add(s.ledgerAmount));
  const accounts = chart.ordered.filter((a) => (a.type === "income" || a.type === "expense") && (!a.isArchived || amountByAccount.has(a.id)));
  const dims = await dimensionOptions(db, ctx.orgId);
  const dimNames = new Map([...dims.projects, ...dims.classes, ...dims.departments, ...dims.locations, ...dims.funds].map((o) => [o.value, o.label]));
  const manage = can(ctx, "tax_export.manage");
  const base = `/o/${org}`;
  const catOptions = categories.map((c) => ({ value: c.code, label: c.line ? `Line ${c.line} — ${c.description}` : c.description, group: c.origin === "custom" ? "Your categories" : KIND_LABEL[c.kind] }));
  const rows = accounts.flatMap((a) => {
    const own = mappings.filter((m) => m.accountId === a.id);
    const whole = own.find((m) => !m.dimensionKey);
    const specific = own.filter((m) => m.dimensionKey);
    return [{ a, key: "", m: whole, dimLabel: null as string | null }, ...specific.map((m) => ({ a, key: m.dimensionKey, m, dimLabel: `${m.dimensionKind}: ${dimNames.get(m.dimensionValueId ?? "") ?? m.dimensionValueId}` }))];
  });
  return (
    <>
      <PageHeader
        title="Account mappings"
        description="Which tax-return line each income and expense account (or account and project, class, department, location or fund) belongs on. Suggestions are made only where an account's type or name makes the line clear, and each must be confirmed. Once an export uses a version of the mappings, changes start a new version."
      />
      <TaxHeader base={base} sel={sel} current="mappings" />
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <span>
          Version <strong>{version?.version ?? "—"}</strong>
          {version?.lockedAt && <Badge tone="gray">locked by an export {formatDateTime(version.lockedAt)}</Badge>}
        </span>
        {manage && (
          <>
            <ActionButton action={suggestAction.bind(null, org, sel.returnType)} size="sm">
              Suggest for unmapped accounts
            </ActionButton>
            <ActionButton action={confirmAllAction.bind(null, org, sel.returnType)} size="sm">
              Confirm all suggestions
            </ActionButton>
          </>
        )}
      </div>
      <ActionForm action={saveMappingsAction.bind(null, org)} className="space-y-3">
        <input type="hidden" name="rt" value={sel.returnType} />
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-3 py-2 text-left">Account</th>
                <th className="px-3 py-2 text-right">{sel.years.find((y) => y.start === sel.taxYearStart)?.label ?? ""} ledger</th>
                <th className="px-3 py-2 text-left">Tax category</th>
                <th className="px-3 py-2 text-center">Confirmed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ a, key, m, dimLabel }) => {
                const name = `${a.id}|${key}`;
                const amt = key ? null : amountByAccount.get(a.id);
                return (
                  <tr key={name} className={cx(!m && amt && !amt.isZero() && "bg-amber-50")}>
                    <td className="px-3 py-1.5" style={{ paddingLeft: `${0.75 + a.depth}rem` }}>
                      {key ? <span className="text-slate-600">↳ {dimLabel}</span> : label(a)}
                    </td>
                    <td className="px-3 py-1.5 text-right">{amt ? <Money amount={amt.toString()} currency={ctx.org.baseCurrency} /> : null}</td>
                    <td className="px-3 py-1.5">
                      <input type="hidden" name={`orig|${name}`} value={m?.categoryCode ?? ""} />
                      <input type="hidden" name={`origok|${name}`} value={m?.confirmed ? "1" : "0"} />
                      <select name={`map|${name}`} defaultValue={m?.categoryCode ?? ""} disabled={!manage} className={cx(inputClass, "min-w-72")} aria-label={`Tax category for ${label(a)}${dimLabel ? ` (${dimLabel})` : ""}`}>
                        <option value="">Not mapped</option>
                        {[...new Set(catOptions.map((o) => o.group))].map((g) => (
                          <optgroup key={g} label={g}>
                            {catOptions
                              .filter((o) => o.group === g)
                              .map((o) => (
                                <option key={o.value} value={o.value}>
                                  {o.label}
                                </option>
                              ))}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <input type="checkbox" name={`ok|${name}`} defaultChecked={m?.confirmed ?? false} disabled={!manage} aria-label="Confirmed" />
                      {m && !m.confirmed && <span className="ml-1 text-xs text-amber-700">suggested</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {manage && (
          <div className="flex justify-end">
            <SubmitButton>Save mappings</SubmitButton>
          </div>
        )}
      </ActionForm>
      {manage && (
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <Card title="Map part of an account by dimension">
            <p className="mb-3 text-sm text-slate-600">For example, meals for a client project to a different line than other meals. Lines without that value follow the account&apos;s own mapping.</p>
            <ActionForm action={addDimensionMappingAction.bind(null, org)} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="rt" value={sel.returnType} />
              <SelectField label="Account" name="accountId" required placeholder="Choose…" options={accounts.map((a) => ({ value: a.id, label: label(a) }))} />
              <SelectField
                label="Dimension"
                name="dimensionKind"
                required
                placeholder="Choose…"
                options={[
                  { value: "project", label: "Project" },
                  { value: "class", label: "Class" },
                  { value: "department", label: "Department" },
                  { value: "location", label: "Location" },
                  { value: "fund", label: "Fund" },
                ]}
              />
              <SelectField
                label="Value"
                name="dimensionValueId"
                required
                placeholder="Choose…"
                options={[
                  ...dims.projects.map((o) => ({ ...o, group: "Projects" })),
                  ...dims.classes.map((o) => ({ ...o, group: "Classes" })),
                  ...dims.departments.map((o) => ({ ...o, group: "Departments" })),
                  ...dims.locations.map((o) => ({ ...o, group: "Locations" })),
                  ...dims.funds.map((o) => ({ ...o, group: "Funds" })),
                ]}
              />
              <SelectField label="Tax category" name="categoryCode" required placeholder="Choose…" options={catOptions} />
              <SubmitButton variant="secondary">Add mapping</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Your own categories">
            <p className="mb-3 text-sm text-slate-600">For lines this catalog does not list, or for a return type without a catalog. They are exported with your code and description.</p>
            <ActionForm action={addCategoryAction.bind(null, org)} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="rt" value={sel.returnType} />
              <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                <TextField label="Code" name="code" required />
                <TextField label="Description" name="description" required />
              </div>
              <SelectField
                label="Kind"
                name="kind"
                defaultValue="deduction"
                options={[
                  { value: "income", label: "Income" },
                  { value: "cogs", label: "Cost of goods sold" },
                  { value: "deduction", label: "Deduction" },
                  { value: "nondeductible", label: "Not deductible" },
                  { value: "nontaxable", label: "Not taxable" },
                  { value: "separately_stated", label: "Separately stated" },
                ]}
              />
              <SubmitButton variant="secondary">Add category</SubmitButton>
            </ActionForm>
          </Card>
        </div>
      )}
      {versions.length > 1 && (
        <Card title="Versions" className="mt-6">
          <ul className="text-sm">
            {versions.map((v) => (
              <li key={v.id} className="py-1">
                Version {v.version} · created {formatDateTime(v.createdAt)}
                {v.lockedAt ? ` · locked ${formatDateTime(v.lockedAt)}` : " · editable"}
                {v.note ? ` · ${v.note}` : ""}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
