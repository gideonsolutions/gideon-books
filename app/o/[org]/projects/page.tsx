import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listProjects } from "@/lib/projects/projects";
import { Decimal } from "@/lib/money/decimal";
import { intParam, readParams, type SearchParams } from "@/lib/web/params";
import { Badge, EmptyState, FilterBar, FilterField, LinkButton, Money, PageHeader, Pagination, SortTh, Table, Td, Th, inputClass } from "@/components/ui";

export const metadata = { title: "Projects" };

const STATUS: Record<string, string> = { active: "Active", on_hold: "On hold", completed: "Completed", cancelled: "Cancelled" };
const BILLING: Record<string, string> = { time_and_materials: "Time & materials", fixed_fee: "Fixed fee", non_billable: "Internal" };

export default async function Projects({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  const page = intParam(sp.page, 1);
  const status = sp.status && STATUS[sp.status] ? (sp.status as "active") : sp.status === "all" ? undefined : sp.status ? undefined : "active";
  const { rows, total, pageSize } = await listProjects(getDb(), ctx.orgId, { q: sp.q, status, page, sort: (sp.sort as never) ?? "name_asc" });
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  return (
    <>
      <PageHeader
        title="Projects"
        description="Jobs for customers and internal efforts: income and costs tagged to each, hours, budgets, and billing of time and expenses."
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/projects/time`}>
              Time
            </LinkButton>
            {can(ctx, "projects.manage") && <LinkButton href={`${base}/projects/new`}>New project</LinkButton>}
          </>
        }
      />
      <FilterBar>
        <FilterField label="Search">
          <input name="q" defaultValue={sp.q} placeholder="Name, code or customer" className={inputClass} />
        </FilterField>
        <FilterField label="Status">
          <select name="status" defaultValue={sp.status ?? "active"} className={inputClass}>
            <option value="all">All</option>
            {Object.entries(STATUS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </FilterField>
      </FilterBar>
      {rows.length === 0 ? (
        <EmptyState title={sp.q ? "No projects match" : "No projects yet"} action={can(ctx, "projects.manage") && <LinkButton href={`${base}/projects/new`}>New project</LinkButton>}>
          Tag invoice, bill and journal lines with a project to see its profitability here.
        </EmptyState>
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <SortTh label="Project" sortKey="name" current={sp.sort ?? "name_asc"} params={sp} />
                <Th className="hidden md:table-cell">Customer</Th>
                <Th className="hidden md:table-cell">Billing</Th>
                <Th align="right">Hours</Th>
                <Th align="right">Income</Th>
                <Th align="right">Costs</Th>
                <Th align="right">Profit</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ project: p, customerName, hours, income, costs }) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`${base}/projects/${p.id}`} className="font-medium text-brand-700 hover:underline">
                      {p.name}
                    </Link>
                    {p.code && <span className="ml-1 text-xs text-slate-500">{p.code}</span>}
                  </Td>
                  <Td className="hidden md:table-cell">{customerName ?? <span className="text-slate-400">—</span>}</Td>
                  <Td className="hidden text-slate-600 md:table-cell">{BILLING[p.billingMethod]}</Td>
                  <Td align="right" className="num">{Decimal.from(hours).normalize().toString()}</Td>
                  <Td align="right"><Money amount={income} currency={cur} /></Td>
                  <Td align="right"><Money amount={costs} currency={cur} /></Td>
                  <Td align="right"><Money amount={Decimal.from(income).sub(costs).toString()} currency={cur} /></Td>
                  <Td>
                    <Badge tone={p.status === "active" ? "green" : p.status === "on_hold" ? "amber" : "gray"}>{STATUS[p.status]}</Badge>
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
