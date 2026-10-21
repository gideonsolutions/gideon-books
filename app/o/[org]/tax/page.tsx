import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { reconcile, sourceLabel } from "@/lib/taxexport/reconcile";
import { listExports } from "@/lib/taxexport/export";
import { catalogFor, RETURN_TYPE_LABELS } from "@/lib/taxexport/catalogs";
import { taxSelection, selectionQuery } from "@/lib/taxexport/params";
import { readParams, type SearchParams } from "@/lib/web/params";
import { formatDateTime } from "@/lib/money/format";
import { Alert, Badge, Card, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionForm, SubmitButton, TextField } from "@/components/client/forms";
import { SelectionFields, TaxHeader } from "@/components/taxexport/tax-header";
import { exportAction, reviewAction } from "./actions";

export const metadata = { title: "Gideon Tax export" };

export default async function TaxOverview({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const sp = await readParams(searchParams);
  const sel = taxSelection(ctx.org, sp);
  const db = getDb();
  const rec = await reconcile(db, ctx.org, sel);
  const exports = (await listExports(db, ctx.orgId, sel.returnType)).filter((e) => e.periodStart === sel.taxYearStart && e.basis === sel.basis);
  const cat = catalogFor(sel.returnType);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const manage = can(ctx, "tax_export.manage");
  return (
    <>
      <PageHeader
        title="Gideon Tax export"
        description={
          <>
            Map the books to the lines of {RETURN_TYPE_LABELS[sel.returnType]}, record book-to-tax adjustments, review the reconciliation and export a package for Gideon Tax. Adjustments never change the books. There is no live connection: the package is a documented file (see <code className="text-xs">docs/integrations/gideon-tax-export.md</code>) that Gideon Tax or a preparer imports.
          </>
        }
      />
      <TaxHeader base={base} sel={sel} current="overview" />
      {cat.source && (
        <p className="mb-4 text-xs text-slate-500">
          Lines from Gideon Tax&apos;s {cat.name} definition for tax year {cat.taxYear} ({cat.package}), {cat.source.path} at {cat.source.commit}.
        </p>
      )}
      {!rec.version && (
        <div className="mb-4">
          <Alert tone="info" title="No mappings yet">
            Start by mapping income and expense accounts to tax categories.{" "}
            <Link className="font-medium underline" href={`${base}/tax/mappings?${selectionQuery(sel)}`}>
              Map accounts
            </Link>
          </Alert>
        </div>
      )}
      {rec.unmapped.length > 0 && (
        <div className="mb-4">
          <Alert tone="warning" title={`${rec.unmapped.length} account${rec.unmapped.length === 1 ? " has" : "s have"} a balance and no tax category`}>
            {rec.unmapped.slice(0, 8).map(sourceLabel).join(", ")}
            {rec.unmapped.length > 8 ? "…" : ""}. An export lists them as unmapped, and the reconciliation cannot be approved until they are mapped.
          </Alert>
        </div>
      )}
      {rec.unconfirmed > 0 && (
        <div className="mb-4">
          <Alert tone="warning">{rec.unconfirmed} suggested mapping{rec.unconfirmed === 1 ? " is" : "s are"} not confirmed by a person yet.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Table>
            <thead>
              <tr>
                <Th>Line</Th>
                <Th>Category</Th>
                <Th align="right">Books</Th>
                <Th align="right">Adjustments</Th>
                <Th align="right">Tax</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rec.categories.length === 0 && (
                <tr>
                  <Td colSpan={5} className="py-8 text-center text-slate-500">
                    No mapped amounts for this tax year.
                  </Td>
                </tr>
              )}
              {rec.categories.map((c) => (
                <tr key={c.category.code}>
                  <Td className="whitespace-nowrap font-mono text-xs text-slate-600">{c.category.line ?? "—"}</Td>
                  <Td>
                    <div>{c.category.description}</div>
                    <div className="text-xs text-slate-500">{c.accounts.join(", ")}</div>
                  </Td>
                  <Td align="right">
                    <Money amount={c.bookAmount.toString()} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={c.adjustments.toString()} currency={cur} showZero={false} />
                  </Td>
                  <Td align="right" className="font-medium">
                    <Money amount={c.taxAmount.toString()} currency={cur} />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-medium">
              <tr>
                <Td colSpan={4}>Net income per books</Td>
                <Td align="right">
                  <Money amount={rec.bookNetIncome.toString()} currency={cur} />
                </Td>
              </tr>
              <tr>
                <Td colSpan={4}>Income less cost of goods sold and deductions, after adjustments (before items Gideon Tax computes)</Td>
                <Td align="right">
                  <Money amount={rec.taxableBeforeSpecialItems.toString()} currency={cur} />
                </Td>
              </tr>
            </tfoot>
          </Table>
          <Card title="Export packages for this year and basis">
            {exports.length === 0 ? (
              <p className="text-sm text-slate-500">None yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {exports.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {formatDateTime(e.createdAt)} by {e.generatedByLabel} · mapping v{e.version} · {e.entryCount} entries{" "}
                      {e.unmappedCount > 0 && <Badge tone="amber">{e.unmappedCount} unmapped</Badge>}
                      <span className="ml-2 font-mono text-xs text-slate-500">{e.contentHash.slice(0, 12)}</span>
                    </span>
                    <span className="flex gap-3">
                      {e.jsonAttachmentId && (
                        <a className="text-brand-700 hover:underline" href={`${base}/files/${e.jsonAttachmentId}?download=1`}>
                          JSON
                        </a>
                      )}
                      {e.csvAttachmentId && (
                        <a className="text-brand-700 hover:underline" href={`${base}/files/${e.csvAttachmentId}?download=1`}>
                          CSV
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Review">
            {rec.review ? (
              <p className="text-sm text-slate-700">
                <Badge tone={rec.review.status === "approved" ? "green" : "blue"}>{rec.review.status}</Badge> by {rec.review.reviewedByLabel}, {formatDateTime(rec.review.createdAt)}.{" "}
                {rec.reviewCurrent ? "Nothing has changed since." : <strong className="text-amber-800">The books, mappings or adjustments changed since; review again.</strong>}
              </p>
            ) : (
              <p className="text-sm text-slate-500">Not reviewed yet.</p>
            )}
            {manage && rec.version && (
              <ActionForm action={reviewAction.bind(null, org)} className="mt-3 space-y-2">
                <SelectionFields sel={sel} />
                <TextField label="Note" name="note" />
                <div className="flex gap-2">
                  <SubmitButton name="status" value="reviewed" variant="secondary">
                    Mark reviewed
                  </SubmitButton>
                  <SubmitButton name="status" value="approved">
                    Approve
                  </SubmitButton>
                </div>
              </ActionForm>
            )}
          </Card>
          {manage && rec.version && (
            <Card title="Export">
              <p className="mb-3 text-sm text-slate-600">
                Produces the JSON package and a CSV of the same figures, pinned to mapping version {rec.version.version}
                {rec.version.lockedAt ? " (already used by an export)" : "; the version is locked once exported"}. The same data always produces the same package.
              </p>
              <ActionForm action={exportAction.bind(null, org)}>
                <SelectionFields sel={sel} />
                <SubmitButton pendingText="Building…">Generate export</SubmitButton>
              </ActionForm>
            </Card>
          )}
          <Card title="Figures">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-600">Entries in the year</dt>
                <dd className="num">{rec.entryCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Last entry number</dt>
                <dd className="num">{rec.lastEntryNumber ?? "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Adjustments</dt>
                <dd className="num">{rec.adjustments.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-600">Data hash</dt>
                <dd className="font-mono text-xs">{rec.dataHash.slice(0, 12)}</dd>
              </div>
            </dl>
          </Card>
        </div>
      </div>
    </>
  );
}
