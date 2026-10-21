import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { assetDisposalsFor, assetEntries, assetSchedule, getAsset } from "@/lib/assets/assets";
import { getTaxBook, taxDepreciationFor } from "@/lib/assets/tax-book";
import { assetFormOptions, defaultsFromAsset } from "@/lib/assets/form-options";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { todayIn, fromParts, parts } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { listAccounts } from "@/lib/ledger/accounts";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionButton, ActionForm, ConfirmButton, SelectField, SubmitButton, TextField, TextAreaField } from "@/components/client/forms";
import { AssetForm } from "@/components/assets/asset-form";
import { DisposeButton } from "@/components/assets/dispose-button";
import { AssetTabs } from "@/components/assets/tabs";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { capitalizeAssetAction, deleteAssetAction, disposeAssetAction, enterTaxDepreciationAction, reverseDisposalAction, saveTaxBookAction, updateAssetAction } from "../actions";

export const metadata = { title: "Fixed asset" };

const STATUS: Record<string, string> = { draft: "Draft", active: "Active", fully_depreciated: "Fully depreciated", disposed: "Disposed" };

export default async function AssetPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const asset = await getAsset(db, ctx.orgId, id);
  const cur = ctx.org.baseCurrency;
  const { state, taken, projected } = await assetSchedule(db, ctx.orgId, asset, cur);
  const disposals = await assetDisposalsFor(db, ctx.orgId, id);
  const entries = await assetEntries(db, ctx.orgId, asset);
  const { book, entered } = await getTaxBook(db, ctx.orgId, id);
  const history = await listAudit(db, ctx.orgId, { entityType: "asset", entityId: id });
  const files = await listAttachments(db, ctx.orgId, "asset", id);
  const opts = await assetFormOptions(db, ctx);
  if (asset.sourceDocumentLineId && !opts.lines.some((l) => l.lineId === asset.sourceDocumentLineId)) {
    opts.lines.unshift({ lineId: asset.sourceDocumentLineId, label: "The linked bill line", amount: Decimal.from(asset.cost).normalize().toString(), accountId: asset.assetAccountId, date: asset.acquisitionDate, description: asset.name });
  }
  const today = todayIn(ctx.org.timezone);
  const base = `/o/${org}`;
  const manage = can(ctx, "assets.manage");
  const nbv = Decimal.from(asset.cost).sub(state.postedAccumulated);
  const activeDisposal = disposals.find((d) => d.status === "posted");
  const proceedsAccounts = (await listAccounts(db, ctx.orgId))
    .filter((a) => a.type === "asset" && !a.control && !["fixed_asset", "accumulated_depreciation", "inventory"].includes(a.subtype))
    .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}` }));

  // Tax depreciation by calendar year across the asset's life (from the tax book).
  const taxYears: { year: number; amount: Decimal }[] = [];
  if (book) {
    const [startY] = parts(book.placedInService);
    for (let y = startY; y < startY + Math.min(40, Math.ceil((book.usefulLifeMonths ?? 12) / 12) + 1); y++) {
      const a = taxDepreciationFor(book, entered, fromParts(y, 1, 1), fromParts(y, 12, 31), cur);
      if (!a.isZero() || book.method !== "entered") taxYears.push({ year: y, amount: a });
    }
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg text-slate-500">{asset.number}</span> {asset.name}
            <Badge tone={asset.status === "draft" ? "amber" : asset.status === "disposed" ? "gray" : "green"}>{STATUS[asset.status]}</Badge>
          </span>
        }
        back={{ href: `${base}/assets`, label: "Fixed assets" }}
        actions={
          manage && (
            <>
              {asset.status === "draft" && (
                <>
                  <ActionButton action={capitalizeAssetAction.bind(null, org, id)} variant="primary">
                    Put on the books
                  </ActionButton>
                  <ConfirmButton action={deleteAssetAction.bind(null, org, id)} label="Delete draft" variant="danger" title="Delete this draft asset?" body="Nothing was posted for it, so nothing in the books changes." confirmLabel="Delete" />
                </>
              )}
              {(asset.status === "active" || asset.status === "fully_depreciated") && (
                <DisposeButton action={disposeAssetAction.bind(null, org, id)} accounts={proceedsAccounts} defaultDate={today} nbv={nbv.toString()} />
              )}
              {asset.status === "disposed" && activeDisposal && (
                <ConfirmButton
                  action={reverseDisposalAction.bind(null, org, id)}
                  label="Undo disposal"
                  title="Undo this disposal?"
                  body="The disposal entry is reversed on the date you choose and the asset is active again."
                  dateLabel="Reversal date"
                  defaultDate={today < activeDisposal.disposalDate ? activeDisposal.disposalDate : today}
                  reasonLabel="Why?"
                  confirmLabel="Reverse disposal"
                />
              )}
            </>
          )
        }
      />
      <AssetTabs org={org} current="register" />
      {asset.status === "draft" && (
        <div className="mb-4">
          <Alert tone="warning">This asset is a draft: it is not on the books and is not depreciated until it is put on the books.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Summary">
            <DescriptionList
              items={[
                { label: "Cost", value: <Money amount={asset.cost} currency={cur} /> },
                { label: "Accumulated depreciation", value: <Money amount={state.postedAccumulated.toString()} currency={cur} /> },
                { label: "Net book value", value: <Money amount={asset.status === "disposed" ? "0" : nbv.toString()} currency={cur} /> },
                { label: "Residual value", value: <Money amount={asset.residualValue} currency={cur} /> },
                { label: "Method", value: asset.method === "none" ? "Not depreciated" : `${asset.method === "straight_line" ? "Straight line" : `Declining balance × ${Decimal.from(asset.decliningFactor ?? "2").normalize().toString()}`} over ${asset.usefulLifeMonths} months` },
                { label: "Placed in service", value: <DateText date={asset.inServiceDate} /> },
                {
                  label: "On the books",
                  value: asset.capitalizedOn ? (
                    <>
                      <DateText date={asset.capitalizedOn} />{" "}
                      {asset.sourceDocumentId ? (
                        <Link className="text-brand-700 hover:underline" href={`${base}/documents/${asset.sourceDocumentId}`}>
                          (from the bill)
                        </Link>
                      ) : asset.acquisitionEntryId ? (
                        <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${asset.acquisitionEntryId}`}>
                          (entry)
                        </Link>
                      ) : null}
                    </>
                  ) : (
                    "Not yet"
                  ),
                },
                { label: "Category", value: asset.category },
              ]}
            />
            {asset.description && <p className="mt-3 text-sm text-slate-700">{asset.description}</p>}
          </Card>

          {asset.method !== "none" && (
            <Card title="Depreciation schedule" padded={false}>
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Month</Th>
                    <Th align="right">Depreciation</Th>
                    <Th align="right">Accumulated</Th>
                    <Th align="right">Net book value</Th>
                    <Th>Status</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {asset.openingAccumulatedDepreciation !== "0.0000" && asset.acquisitionType === "opening" && (
                    <tr>
                      <Td>Through <DateText date={asset.openingDepreciationThrough} /></Td>
                      <Td align="right"><Money amount={asset.openingAccumulatedDepreciation} currency={cur} /></Td>
                      <Td align="right"><Money amount={asset.openingAccumulatedDepreciation} currency={cur} /></Td>
                      <Td align="right"><Money amount={Decimal.from(asset.cost).sub(asset.openingAccumulatedDepreciation).toString()} currency={cur} /></Td>
                      <Td><Badge>opening balance</Badge></Td>
                    </tr>
                  )}
                  {taken.map((r) => (
                    <tr key={`p${r.periodEnd}`}>
                      <Td><DateText date={r.periodEnd} /></Td>
                      <Td align="right"><Money amount={r.amount.toString()} currency={cur} /></Td>
                      <Td align="right"><Money amount={r.accumulated.toString()} currency={cur} /></Td>
                      <Td align="right"><Money amount={r.netBookValue.toString()} currency={cur} /></Td>
                      <Td><Badge tone="green">posted</Badge></Td>
                    </tr>
                  ))}
                  {projected.slice(0, 120).map((r) => (
                    <tr key={`f${r.periodEnd}`} className="text-slate-500">
                      <Td><DateText date={r.periodEnd} /></Td>
                      <Td align="right"><Money amount={r.amount.toString()} currency={cur} /></Td>
                      <Td align="right"><Money amount={r.accumulated.toString()} currency={cur} /></Td>
                      <Td align="right"><Money amount={r.netBookValue.toString()} currency={cur} /></Td>
                      <Td>{r.inDraft ? <Badge tone="amber">in a draft run</Badge> : <span className="text-xs">projected</span>}</Td>
                    </tr>
                  ))}
                  {taken.length === 0 && projected.length === 0 && (
                    <tr>
                      <Td colSpan={5} className="text-slate-500">Nothing left to depreciate.</Td>
                    </tr>
                  )}
                </tbody>
              </Table>
              {projected.length > 120 && <p className="px-4 py-2 text-xs text-slate-500">Showing the next 120 months of {projected.length}.</p>}
            </Card>
          )}

          <Card title={asset.status === "draft" ? "Edit draft" : "Details and estimates"}>
            {manage && asset.status !== "disposed" ? (
              <AssetForm
                action={updateAssetAction.bind(null, org, id)}
                defaults={defaultsFromAsset(asset)}
                {...opts}
                capitalized={asset.status !== "draft"}
                canCapitalize={manage}
              />
            ) : (
              <p className="text-sm text-slate-600">{asset.status === "disposed" ? "A disposed asset cannot be edited; undo the disposal first." : "You can view this asset but not change it."}</p>
            )}
          </Card>

          <Card title="Tax book (separate from the books)">
            <p className="mb-4 text-sm text-slate-600">
              How this asset is depreciated for income tax. It never posts to the ledger; the difference from book depreciation goes to the Gideon Tax export as a book-to-tax adjustment. The method label is your record (for
              example “MACRS 5-year, half-year”); Gideon Books does not apply MACRS tables — amounts are computed by simple straight-line or declining balance on the tax basis, or entered from your preparer&apos;s figures.
            </p>
            {manage && (
              <ActionForm action={saveTaxBookAction.bind(null, org, id)} className="grid gap-4 md:grid-cols-3">
                <SelectField
                  label="Tax method"
                  name="method"
                  defaultValue={book?.method ?? "straight_line"}
                  options={[
                    { value: "straight_line", label: "Straight line" },
                    { value: "declining_balance", label: "Declining balance" },
                    { value: "entered", label: "Entered by year" },
                  ]}
                />
                <TextField label="Method label" name="methodLabel" defaultValue={book?.methodLabel ?? ""} placeholder="e.g. MACRS 7-year, HY" />
                <TextField label="Tax basis" name="taxBasis" inputMode="decimal" required defaultValue={book ? Decimal.from(book.taxBasis).normalize().toString() : Decimal.from(asset.cost).normalize().toString()} />
                <TextField label="Tax life (years)" name="taxLifeYears" inputMode="decimal" defaultValue={book?.usefulLifeMonths ? String(book.usefulLifeMonths / 12) : String(asset.usefulLifeMonths / 12)} />
                <TextField label="Factor (declining)" name="decliningFactor" inputMode="decimal" defaultValue={book?.decliningFactor ? Decimal.from(book.decliningFactor).normalize().toString() : "2"} />
                <TextField label="Placed in service (tax)" name="placedInService" type="date" required defaultValue={book?.placedInService ?? asset.inServiceDate} />
                <TextAreaField label="Notes" name="notes" defaultValue={book?.notes ?? ""} rows={2} className="md:col-span-3" />
                <div className="md:col-span-3 flex justify-end">
                  <SubmitButton variant="secondary">Save tax book</SubmitButton>
                </div>
              </ActionForm>
            )}
            {book?.method === "entered" && manage && (
              <ActionForm action={enterTaxDepreciationAction.bind(null, org, id)} className="mt-4 grid gap-4 border-t border-slate-200 pt-4 md:grid-cols-4" resetOnSuccess>
                <TextField label="Tax year starts" name="taxYearStart" type="date" required />
                <TextField label="Tax year ends" name="taxYearEnd" type="date" required />
                <TextField label="Tax depreciation" name="amount" inputMode="decimal" required />
                <div className="flex items-end">
                  <SubmitButton variant="secondary">Record year</SubmitButton>
                </div>
              </ActionForm>
            )}
            {book && (
              <div className="mt-4">
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Tax depreciation by calendar year</h3>
                {taxYears.length === 0 ? (
                  <p className="text-sm text-slate-500">No tax depreciation recorded yet.</p>
                ) : (
                  <ul className="grid gap-1 text-sm sm:grid-cols-3">
                    {taxYears.map((y) => (
                      <li key={y.year} className="flex justify-between gap-2 rounded bg-slate-50 px-2 py-1">
                        <span>{y.year}</span>
                        <Money amount={y.amount.toString()} currency={cur} />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Entries">
            {entries.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing posted yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {entries.map((e) => (
                  <li key={e.id} className="py-2">
                    <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${e.id}`}>
                      #{e.entryNumber}
                    </Link>{" "}
                    <DateText date={e.entryDate} />
                    <div className="text-xs text-slate-600">{e.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {disposals.length > 0 && (
            <Card title="Disposals">
              <ul className="space-y-2 text-sm">
                {disposals.map((d) => (
                  <li key={d.id}>
                    <DateText date={d.disposalDate} /> · proceeds <Money amount={d.proceeds} currency={cur} /> · {Decimal.from(d.gainLoss).isNegative() ? "loss" : "gain"}{" "}
                    <Money amount={Decimal.from(d.gainLoss).abs().toString()} currency={cur} /> {d.status === "reversed" && <Badge tone="red">reversed</Badge>}
                    <div className="text-xs text-slate-600">{d.reason}</div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Attachments org={org} entityType="asset" entityId={id} files={files} canUpload={manage} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
