import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { assetCategories, listAssets } from "@/lib/assets/assets";
import { Decimal } from "@/lib/money/decimal";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, DateText, EmptyState, FilterBar, FilterField, Grid, LinkButton, Money, PageHeader, Pagination, Stat, Table, Td, Th, inputClass, statusTone } from "@/components/ui";
import { AssetTabs } from "@/components/assets/tabs";

export const metadata = { title: "Fixed assets" };

const STATUS: Record<string, string> = { draft: "Draft", active: "Active", fully_depreciated: "Fully depreciated", disposed: "Disposed" };
const METHOD: Record<string, string> = { straight_line: "Straight line", declining_balance: "Declining balance", none: "Not depreciated" };

export default async function Assets({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const page = intParam(sp.page, 1);
  const status = sp.status && STATUS[sp.status] ? (sp.status as "draft") : undefined;
  const { rows, total, pageSize, totals } = await listAssets(db, ctx.orgId, { q: sp.q, status, category: sp.category, page });
  const categories = await assetCategories(db, ctx.orgId);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Fixed assets"
        description="Equipment, vehicles, buildings and other long-lived assets: their cost, depreciation and net book value. The register reconciles to the ledger on the rollforward."
        actions={can(ctx, "assets.manage") && <LinkButton href={`${base}/assets/new`}>New asset</LinkButton>}
      />
      <AssetTabs org={org} current="register" />
      <div className="mb-6">
        <Grid cols={3}>
          <Stat label="Cost (in service)" value={<Money amount={totals.cost} currency={cur} />} />
          <Stat label="Accumulated depreciation" value={<Money amount={totals.accumulated} currency={cur} />} />
          <Stat label="Net book value" value={<Money amount={Decimal.from(totals.cost).sub(totals.accumulated).toString()} currency={cur} />} href={`${base}/assets/rollforward`} hint="See the rollforward" />
        </Grid>
      </div>
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Number, name or category" className={inputClass} />
        </FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            {Object.entries(STATUS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </FilterField>
        {categories.length > 0 && (
          <FilterField label="Category">
            <select name="category" defaultValue={sp.category ?? ""} className={inputClass}>
              <option value="">All</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </FilterField>
        )}
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={sp.q || sp.status ? "No assets match" : "No fixed assets yet"} action={can(ctx, "assets.manage") && <LinkButton href={`${base}/assets/new`}>Add an asset</LinkButton>}>
          {sp.q || sp.status ? "Clear the filters to see the whole register." : "Add assets you buy, or capitalize a bill line that was posted to a fixed-asset account."}
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Asset</Th>
                <Th className="hidden md:table-cell">In service</Th>
                <Th className="hidden lg:table-cell">Method</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Accumulated</Th>
                <Th align="right">Net book value</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ asset: a, accumulated }) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`${base}/assets/${a.id}`} className="font-medium text-brand-700 hover:underline">
                      {a.number}
                    </Link>{" "}
                    <span className="text-slate-800">{a.name}</span>
                    {a.category && <div className="text-xs text-slate-500">{a.category}</div>}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <DateText date={a.inServiceDate} />
                  </Td>
                  <Td className="hidden text-slate-600 lg:table-cell">
                    {METHOD[a.method]}, {a.usefulLifeMonths} mo
                  </Td>
                  <Td align="right">
                    <Money amount={a.cost} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={accumulated} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={a.status === "disposed" ? "0" : Decimal.from(a.cost).sub(accumulated).toString()} currency={cur} />
                  </Td>
                  <Td>
                    <Badge tone={a.status === "draft" ? "amber" : a.status === "disposed" ? "gray" : statusTone(a.status)}>{STATUS[a.status]}</Badge>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Pagination page={page} pageSize={pageSize} total={total} params={sp} />
        </>
      )}
    </>
  );
}
