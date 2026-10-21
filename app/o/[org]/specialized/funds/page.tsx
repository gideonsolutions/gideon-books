import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { dateParam, readParams, type SearchParams } from "@/lib/web/params";
import { financialPositionByRestriction, fundBalances, statementOfActivities, type RestrictionClass } from "@/lib/specialized/funds";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, FilterBar, FilterField, Money, PageHeader, Table, Td, Th, inputClass } from "@/components/ui";
import { ActionForm, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/client/forms";
import { releaseAction } from "../actions";

export const metadata = { title: "Funds" };

const RESTRICTION_LABEL = {
  without_donor_restrictions: "Without donor restrictions",
  with_donor_restrictions_temporary: "With donor restrictions (purpose or time)",
  with_donor_restrictions_perpetual: "With donor restrictions (perpetual)",
} as const;
const CLASS_LABEL: Record<RestrictionClass, string> = { without: "Without donor restrictions", with: "With donor restrictions" };

export default async function Funds({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "reports.read");
  const db = getDb();
  const to = dateParam(sp.to) ?? todayIn(ctx.org.timezone);
  const from = dateParam(sp.from) ?? `${to.slice(0, 4)}-01-01`;
  const cur = ctx.org.baseCurrency;
  const act = await statementOfActivities(db, ctx.orgId, from, to);
  const pos = await financialPositionByRestriction(db, ctx.orgId, to);
  const balances = await fundBalances(db, ctx.orgId, from, to);
  const funds = act.funds;
  const k = (id: string | null) => id ?? "none";
  const restricted = funds.filter((f) => f.restriction === "with_donor_restrictions_temporary");
  const unrestricted = funds.filter((f) => f.id && f.restriction === "without_donor_restrictions");
  const gl = (fundId: string | null, accountId?: string) => `/o/${org}/reports/general-ledger?from=${from}&to=${to}${accountId ? `&account=${accountId}` : ""}${fundId ? `&fund=${fundId}` : ""}`;
  return (
    <>
      <PageHeader
        title="Funds and net assets"
        description="Activities and net assets by fund and by donor restriction. These reports support the nonprofit presentation; they do not certify compliance with GAAP (ASC 958) or any filing requirement."
      />
      {funds.length === 1 && (
        <div className="mb-4">
          <Alert tone="info">
            No funds yet. Create funds (with their donor restriction) under{" "}
            <Link className="underline" href={`/o/${org}/accounting/dimensions`}>
              Dimensions & funds
            </Link>{" "}
            and tag contributions and expenses with them.
          </Alert>
        </div>
      )}
      <FilterBar>
        <FilterField label="From">
          <input type="date" name="from" defaultValue={from} className={inputClass} />
        </FilterField>
        <FilterField label="To">
          <input type="date" name="to" defaultValue={to} className={inputClass} />
        </FilterField>
      </FilterBar>
      <div className="space-y-6">
        <Card title={`Statement of activities, ${from} to ${to}`} padded={false}>
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Account</Th>
                <Th align="right">{CLASS_LABEL.without}</Th>
                <Th align="right">{CLASS_LABEL.with}</Th>
                <Th align="right">Total</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              <tr>
                <Td className="font-semibold" colSpan={4}>
                  Revenue and support
                </Td>
              </tr>
              {act.revenue.map((r) => (
                <tr key={r.accountId}>
                  <Td>
                    <Link href={gl(null, r.accountId)} className="hover:underline">
                      {r.code} {r.name}
                    </Link>
                  </Td>
                  <Td align="right">
                    <Money amount={r.without} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.with} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.total} currency={cur} />
                  </Td>
                </tr>
              ))}
              <tr>
                <Td>Net assets released from restriction</Td>
                <Td align="right">
                  <Money amount={act.totals.byClass.without.releases} currency={cur} />
                </Td>
                <Td align="right">
                  <Money amount={act.totals.byClass.with.releases} currency={cur} />
                </Td>
                <Td align="right">
                  <Money amount={Decimal.from(act.totals.byClass.without.releases).add(act.totals.byClass.with.releases).toString()} currency={cur} />
                </Td>
              </tr>
              <tr>
                <Td className="font-semibold" colSpan={4}>
                  Expenses
                </Td>
              </tr>
              {act.expenses.map((r) => (
                <tr key={r.accountId}>
                  <Td>
                    <Link href={gl(null, r.accountId)} className="hover:underline">
                      {r.code} {r.name}
                    </Link>
                  </Td>
                  <Td align="right">
                    <Money amount={r.without} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.with} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.total} currency={cur} />
                  </Td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <Td>Change in net assets</Td>
                <Td align="right">
                  <Money amount={act.totals.byClass.without.change} currency={cur} />
                </Td>
                <Td align="right">
                  <Money amount={act.totals.byClass.with.change} currency={cur} />
                </Td>
                <Td align="right">
                  <Money amount={Decimal.from(act.totals.byClass.without.change).add(act.totals.byClass.with.change).toString()} currency={cur} />
                </Td>
              </tr>
            </tfoot>
          </Table>
          <p className="px-4 py-3 text-xs text-slate-500">Expenses tagged with a restricted fund appear in that fund&apos;s class. The usual presentation reports expenses without donor restrictions and shows releases: tag expenses accordingly and record releases below.</p>
        </Card>

        <Card title={`Fund balances, ${from} to ${to}`} padded={false}>
          <Table className="rounded-none border-0 shadow-none">
            <thead>
              <tr>
                <Th>Fund</Th>
                <Th align="right">Opening</Th>
                <Th align="right">Revenue</Th>
                <Th align="right">Expenses</Th>
                <Th align="right">Releases</Th>
                <Th align="right">Closing</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {balances.map((b) => (
                <tr key={k(b.id)}>
                  <Td>
                    {b.name} <Badge tone={b.class === "with" ? "amber" : "gray"}>{RESTRICTION_LABEL[b.restriction]}</Badge>
                  </Td>
                  <Td align="right">
                    <Money amount={b.opening} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={b.revenue} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={b.expenses} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={b.releases} currency={cur} />
                  </Td>
                  <Td align="right" className="font-medium">
                    <Link href={gl(b.id)} className="hover:underline">
                      <Money amount={b.closing} currency={cur} />
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>

        <Card title={`Net assets by restriction at ${to}`}>
          <dl className="grid gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Total assets</dt>
              <dd className="num font-semibold">
                <Money amount={pos.assets} currency={cur} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Total liabilities</dt>
              <dd className="num font-semibold">
                <Money amount={pos.liabilities} currency={cur} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">{CLASS_LABEL.without}</dt>
              <dd className="num font-semibold">
                <Money amount={pos.byClass.without} currency={cur} />
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">{CLASS_LABEL.with}</dt>
              <dd className="num font-semibold">
                <Money amount={pos.byClass.with} currency={cur} />
              </dd>
            </div>
          </dl>
          <p className={`mt-3 text-sm ${Decimal.from(pos.difference).isZero() ? "text-emerald-700" : "text-danger-700"}`}>
            {Decimal.from(pos.difference).isZero() ? "Assets less liabilities equal total net assets." : `Assets less liabilities differ from net assets by ${pos.difference}.`}
          </p>
        </Card>

        {can(ctx, "ledger.post") && (
          <Card title="Release net assets from restriction">
            {restricted.length === 0 ? (
              <p className="text-sm text-slate-500">There are no purpose- or time-restricted funds to release from.</p>
            ) : (
              <ActionForm action={releaseAction.bind(null, org)} className="grid gap-3 md:grid-cols-2" resetOnSuccess>
                <SelectField label="From restricted fund" name="fundId" required placeholder="Choose…" options={restricted.map((f) => ({ value: f.id!, label: f.name }))} />
                <SelectField label="To fund (without restrictions)" name="toFundId" placeholder="General (no fund)" options={unrestricted.map((f) => ({ value: f.id!, label: f.name }))} />
                <TextField label="Amount" name="amount" inputMode="decimal" required />
                <TextField label="Date" name="date" type="date" defaultValue={to} required />
                <TextAreaField label="What satisfied the restriction" name="reason" required className="md:col-span-2" rows={2} />
                <div className="md:col-span-2">
                  <SubmitButton>Post the release</SubmitButton>
                  <p className="mt-2 text-xs text-slate-500">Posts Dr Net Assets With Donor Restrictions (restricted fund) / Cr Net Assets Without Donor Restrictions. Perpetual restrictions are not released.</p>
                </div>
              </ActionForm>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
