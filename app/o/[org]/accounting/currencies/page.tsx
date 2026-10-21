import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { listRates } from "@/lib/fx/rates";
import { previewRevaluation } from "@/lib/fx/revaluation";
import { configuredProvider, currenciesInUse } from "@/lib/fx/providers";
import { can } from "@/lib/context";
import { addDays, endOfMonth, todayIn, addMonths } from "@/lib/dates";
import { currencyOptions } from "@/lib/web/options";
import { readParams, type SearchParams, dateParam } from "@/lib/web/params";
import { Alert, Badge, Card, DateText, Money, PageHeader, Table, Td, Th, FilterBar, FilterField, inputClass } from "@/components/ui";
import { ActionForm, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { addRateAction, deleteRateAction, fetchRatesAction, revalueAction } from "../actions";
import { Decimal } from "@/lib/money/decimal";

export const metadata = { title: "Currencies" };

export default async function Currencies({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const rates = await listRates(db, ctx.orgId, { limit: 300 });
  const inUse = await currenciesInUse(ctx.orgId, ctx.org.baseCurrency);
  const provider = configuredProvider();
  const today = todayIn(ctx.org.timezone);
  const revalDate = dateParam(sp.reval) ?? endOfMonth(addMonths(today, -1));
  let preview: Awaited<ReturnType<typeof previewRevaluation>> | null = null;
  let previewError: string | null = null;
  try {
    preview = await previewRevaluation(db, ctx, revalDate);
  } catch (e) {
    previewError = (e as Error).message;
  }
  const manage = can(ctx, "fx.manage");
  const base = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Currencies"
        description={`The books are kept in ${base}. Foreign-currency customers, vendors, documents and bank accounts are converted at the rate stored for their date; each posting keeps the rate it used, so updating rates never changes history.`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Period-end revaluation">
            <p className="mb-3 text-sm text-slate-600">
              Restates open foreign-currency receivables, payables and foreign bank balances at a date&apos;s rate, booking unrealized gain or loss. The entry reverses the next day, so payments are always measured from the original rate.
            </p>
            <FilterBar>
              <FilterField label="Revalue as of">
                <input type="date" name="reval" defaultValue={revalDate} className={inputClass} />
              </FilterField>
            </FilterBar>
            {previewError ? (
              <Alert tone="warning">{previewError}</Alert>
            ) : preview && preview.length === 0 ? (
              <p className="text-sm text-slate-500">No foreign-currency balances on {revalDate}.</p>
            ) : (
              preview && (
                <>
                  <Table>
                    <thead>
                      <tr>
                        <Th>Item</Th>
                        <Th align="right">Balance</Th>
                        <Th align="right">Rate</Th>
                        <Th align="right">Carried</Th>
                        <Th align="right">Revalued</Th>
                        <Th align="right">Gain/(loss)</Th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.map((r, i) => (
                        <tr key={i}>
                          <Td>
                            {r.accountCode} {r.accountName}
                            {r.reference && <span className="text-slate-500"> · {r.reference}</span>}
                          </Td>
                          <Td align="right">
                            <Money amount={r.txnBalance} currency={r.currency} />
                          </Td>
                          <Td align="right" className="num">{Decimal.from(r.rate).normalize().toString()}</Td>
                          <Td align="right">
                            <Money amount={r.carriedBase} currency={base} />
                          </Td>
                          <Td align="right">
                            <Money amount={r.revaluedBase} currency={base} />
                          </Td>
                          <Td align="right">
                            {/* An increase in an asset is a gain; for credit balances the sign reads the other way. */}
                            <Money amount={r.adjustment} currency={base} />
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                  {manage && (
                    <ActionForm action={revalueAction.bind(null, org)} className="mt-3 flex justify-end">
                      <input type="hidden" name="date" value={revalDate} />
                      <SubmitButton>Post revaluation for {revalDate}</SubmitButton>
                    </ActionForm>
                  )}
                </>
              )
            )}
          </Card>
          <Card title="Stored rates" padded={false}>
            {rates.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No rates yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Currency</Th>
                    <Th align="right">{base} per unit</Th>
                    <Th>Source</Th>
                    <Th>
                      <span className="sr-only">Delete</span>
                    </Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rates.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <DateText date={r.rateDate} />
                      </Td>
                      <Td>{r.currency}</Td>
                      <Td align="right" className="num">
                        {Decimal.from(r.rate).normalize().toString()}
                      </Td>
                      <Td>
                        <Badge tone={r.source === "manual" ? "blue" : r.source === "transaction" ? "amber" : "gray"}>{r.source === "transaction" ? "typed on a transaction" : r.source}</Badge>
                        {r.sourceRef && <span className="ml-2 text-xs text-slate-500">{r.sourceRef.slice(0, 60)}</span>}
                      </Td>
                      <Td align="right">
                        {manage && r.source !== "transaction" && (
                          <ConfirmButton action={deleteRateAction.bind(null, org, r.id)} label="Delete" size="sm" variant="ghost" title="Delete this rate?" body="Refused if any posting used it." confirmLabel="Delete" />
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="In use">
            <p className="text-sm text-slate-700">{inUse.length ? inUse.join(", ") : "Only the base currency so far."}</p>
          </Card>
          {manage && (
            <Card title="Add a rate">
              <ActionForm action={addRateAction.bind(null, org)} resetOnSuccess className="space-y-3">
                <SelectField label="Currency" name="currency" options={currencyOptions().filter((c) => c.value !== base)} required />
                <TextField label="Date" name="rateDate" type="date" defaultValue={today} required />
                <TextField label={`${base} per one unit`} name="rate" inputMode="decimal" required hint="Up to 12 decimal places." />
                <TextField label="Source (optional)" name="note" />
                <SubmitButton variant="secondary">Save rate</SubmitButton>
              </ActionForm>
            </Card>
          )}
          {manage && (
            <Card title="Fetch rates">
              {provider ? (
                <ActionForm action={fetchRatesAction.bind(null, org)} className="space-y-3">
                  <p className="text-sm text-slate-600">From {provider.label}, for the currencies in use. Existing rates are never overwritten.</p>
                  <TextField label="From" name="from" type="date" defaultValue={addDays(today, -30)} />
                  <TextField label="To" name="to" type="date" defaultValue={today} />
                  <SubmitButton variant="secondary" pendingText="Fetching…">
                    Fetch
                  </SubmitButton>
                </ActionForm>
              ) : (
                <p className="text-sm text-slate-600">No provider configured on this server (FX_PROVIDER=none). Enter rates by hand.</p>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
