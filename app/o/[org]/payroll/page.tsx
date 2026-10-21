import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listImports, listRuns } from "@/lib/payroll/imports";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, Card, DateText, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, Table, Td, Th, inputClass } from "@/components/ui";
import { PayrollTabs } from "@/components/payroll/tabs";

export const metadata = { title: "Payroll" };

export default async function PayrollRuns({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const db = getDb();
  const page = intParam(sp.page, 1);
  const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
  const { rows, total, pageSize } = await listRuns(db, ctx.orgId, { from: valid(sp.from), to: valid(sp.to), status: sp.status === "void" || sp.status === "posted" ? sp.status : undefined, page });
  const pending = (await listImports(db, ctx.orgId, 10)).filter((i) => i.status === "previewed");
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Payroll"
        description="Payroll your provider ran, imported and posted here: wages, withholdings, employer taxes and benefits, net pay and what is still owed. Gideon Books does not calculate payroll or file payroll returns."
        actions={can(ctx, "payroll.import") && <LinkButton href={`${base}/payroll/import`}>Import a payroll</LinkButton>}
      />
      <PayrollTabs org={org} current="runs" />
      {pending.length > 0 && (
        <Card title="Imports waiting to be posted" className="mb-6">
          <ul className="divide-y divide-slate-100 text-sm">
            {pending.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                <Link href={`${base}/payroll/imports/${i.id}`} className="text-brand-700 hover:underline">
                  {i.fileName}
                </Link>
                <span className="text-xs text-slate-500">{i.errors.length ? `${i.errors.length} problem${i.errors.length === 1 ? "" : "s"} reading the file` : "ready to review"}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <FilterBar>
        <FilterField label="Paid from">
          <input type="date" name="from" defaultValue={sp.from} className={inputClass} />
        </FilterField>
        <FilterField label="Paid to">
          <input type="date" name="to" defaultValue={sp.to} className={inputClass} />
        </FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? ""} className={inputClass}>
            <option value="">All</option>
            <option value="posted">Posted</option>
            <option value="void">Void</option>
          </select>
        </FilterField>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title="No payroll runs" action={can(ctx, "payroll.import") && <LinkButton href={`${base}/payroll/import`}>Import a payroll</LinkButton>}>
          Export the payroll register from your provider in the documented CSV or JSON format and import it.
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <Th>Pay date</Th>
                <Th>Run</Th>
                <Th className="hidden md:table-cell">Period</Th>
                <Th align="right">Gross</Th>
                <Th align="right" className="hidden lg:table-cell">Employer taxes</Th>
                <Th align="right">Net pay</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>
                    <DateText date={r.payDate} />
                  </Td>
                  <Td>
                    <Link href={`${base}/payroll/${r.id}`} className="font-medium text-brand-700 hover:underline">
                      {r.providerRunId}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {r.employeeCount ? `${r.employeeCount} employees · ` : ""}
                      {r.provider.replace("_", " ")}
                    </div>
                  </Td>
                  <Td className="hidden md:table-cell">
                    <DateText date={r.periodStart} /> – <DateText date={r.periodEnd} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.grossWages} currency={cur} />
                  </Td>
                  <Td align="right" className="hidden lg:table-cell">
                    <Money amount={r.employerTaxes} currency={cur} />
                  </Td>
                  <Td align="right">
                    <Money amount={r.netPay} currency={cur} />
                  </Td>
                  <Td>
                    <Badge tone={r.status === "posted" ? "green" : "red"}>{r.status}</Badge> {r.isAdjustment && <Badge>adjustment</Badge>}
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
