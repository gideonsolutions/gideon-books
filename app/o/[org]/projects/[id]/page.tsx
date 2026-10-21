import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getProject, projectProfitability } from "@/lib/projects/projects";
import { listTimeEntries } from "@/lib/projects/time";
import { unbilledForProject } from "@/lib/projects/billing";
import { contactOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { projectBillingLinks } from "@/lib/db/schema/projects";
import { documents } from "@/lib/db/schema/commerce";
import { Decimal } from "@/lib/money/decimal";
import { Badge, Card, DateText, Grid, LinkButton, Money, PageHeader, Stat, Table, Td, Th, statusTone } from "@/components/ui";
import { ProjectForm } from "@/components/projects/project-form";
import { AuditTrail } from "@/components/audit-trail";
import { updateProjectAction } from "../actions";

export const metadata = { title: "Project" };

export default async function ProjectPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { project: p, customerName } = await getProject(db, ctx.orgId, id);
  const prof = await projectProfitability(db, ctx.orgId, id);
  const time = await listTimeEntries(db, ctx.orgId, { projectId: id, pageSize: 25 });
  const unbilled = await unbilledForProject(db, ctx.orgId, id);
  const invoices = await db
    .select({ invoiceId: projectBillingLinks.invoiceId, number: documents.number, status: documents.status, issueDate: documents.issueDate, total: documents.total, currency: documents.currency, billed: sql<string>`sum(${projectBillingLinks.amount})::text` })
    .from(projectBillingLinks)
    .innerJoin(documents, and(eq(documents.orgId, projectBillingLinks.orgId), eq(documents.id, projectBillingLinks.invoiceId)))
    .where(and(eq(projectBillingLinks.orgId, ctx.orgId), eq(projectBillingLinks.projectId, id), eq(projectBillingLinks.status, "active")))
    .groupBy(projectBillingLinks.invoiceId, documents.number, documents.status, documents.issueDate, documents.total, documents.currency)
    .orderBy(desc(documents.issueDate));
  const history = await listAudit(db, ctx.orgId, { entityType: "project", entityId: id });
  const cur = ctx.org.baseCurrency;
  const base = `/o/${org}`;
  const unbilledTime = Decimal.sum(unbilled.time.map((t) => t.amount ?? "0"));
  const unbilledExp = Decimal.sum(unbilled.expenses.map((e) => e.amount));
  const gl = (accountId: string) => `${base}/reports/general-ledger?account=${accountId}&project=${id}`;
  const canBill = can(ctx, "projects.manage") && can(ctx, "sales.manage") && p.billingMethod !== "non_billable" && !!p.customerId;
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {p.name}
            {p.code && <span className="text-lg text-slate-500">{p.code}</span>}
            <Badge tone={p.status === "active" ? "green" : "gray"}>{p.status.replace("_", " ")}</Badge>
          </span>
        }
        back={{ href: `${base}/projects`, label: "Projects" }}
        description={customerName ? `For ${customerName}` : "Internal project"}
        actions={
          <>
            <LinkButton variant="secondary" href={`${base}/projects/time?project=${id}`}>
              Time
            </LinkButton>
            {canBill && <LinkButton href={`${base}/projects/${id}/bill`}>Bill time and expenses</LinkButton>}
          </>
        }
      />
      <div className="mb-6">
        <Grid cols={4}>
          <Stat label="Income" value={<Money amount={prof.income.toString()} currency={cur} />} />
          <Stat label="Costs" value={<Money amount={prof.costs.toString()} currency={cur} />} hint={prof.budget ? <>Budget <Money amount={prof.budget.toString()} currency={cur} /></> : undefined} tone={prof.budgetRemaining?.isNegative() ? "danger" : "default"} />
          <Stat label="Profit" value={<Money amount={prof.profit.toString()} currency={cur} />} hint={prof.marginPercent ? `${prof.marginPercent}% margin` : undefined} tone={prof.profit.isNegative() ? "danger" : "good"} />
          <Stat
            label="Unbilled"
            value={<Money amount={unbilledTime.add(unbilledExp).toString()} currency={cur} />}
            hint={`${unbilled.time.length} time entr${unbilled.time.length === 1 ? "y" : "ies"}, ${unbilled.expenses.length} expense${unbilled.expenses.length === 1 ? "" : "s"}`}
            {...(canBill ? { href: `${base}/projects/${id}/bill` } : {})}
          />
        </Grid>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Income and costs by account (accrual)" padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Account</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {prof.byAccount.map((a) => (
                  <tr key={a.accountId}>
                    <Td>
                      {a.code} {a.name} <span className="text-xs text-slate-500">({a.type})</span>
                    </Td>
                    <Td align="right">
                      <Link className="hover:underline" href={gl(a.accountId)}>
                        <Money amount={a.amount.toString()} currency={cur} />
                      </Link>
                    </Td>
                  </tr>
                ))}
                {prof.byAccount.length === 0 && (
                  <tr>
                    <Td colSpan={2} className="text-slate-500">Nothing posted to this project yet.</Td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
          <Card title={`Recent time (${Decimal.from(time.totalHours).normalize().toString()} hours in all)`} padded={false}>
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Who</Th>
                  <Th>What</Th>
                  <Th align="right">Hours</Th>
                  <Th>Billing</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {time.rows.map(({ entry, billed }) => (
                  <tr key={entry.id}>
                    <Td><DateText date={entry.workDate} /></Td>
                    <Td>{entry.personLabel}</Td>
                    <Td className="max-w-xs truncate text-slate-600">{entry.description}</Td>
                    <Td align="right" className="num">{Decimal.from(entry.hours).normalize().toString()}</Td>
                    <Td>{!entry.billable ? <Badge>not billable</Badge> : billed ? <Badge tone="green">billed</Badge> : <Badge tone="amber">unbilled</Badge>}</Td>
                  </tr>
                ))}
                {time.rows.length === 0 && (
                  <tr>
                    <Td colSpan={5} className="text-slate-500">No time recorded.</Td>
                  </tr>
                )}
              </tbody>
            </Table>
          </Card>
          {can(ctx, "projects.manage") && (
            <Card title="Project details">
              <ProjectForm
                action={updateProjectAction.bind(null, org, id)}
                customers={await contactOptions(db, ctx.orgId, "customer")}
                defaults={{
                  name: p.name,
                  code: p.code ?? "",
                  customerId: p.customerId ?? "",
                  status: p.status,
                  billingMethod: p.billingMethod,
                  hourlyRate: p.hourlyRate ? Decimal.from(p.hourlyRate).normalize().toString() : "",
                  fixedFee: p.fixedFee ? Decimal.from(p.fixedFee).normalize().toString() : "",
                  budgetAmount: p.budgetAmount ? Decimal.from(p.budgetAmount).normalize().toString() : "",
                  startDate: p.startDate ?? "",
                  endDate: p.endDate ?? "",
                  description: p.description ?? "",
                }}
                submitLabel="Save project"
              />
            </Card>
          )}
        </div>
        <div className="space-y-6">
          <Card title="Invoices from this project">
            {invoices.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing billed yet.</p>
            ) : (
              <ul className="divide-y divide-slate-100 text-sm">
                {invoices.map((i) => (
                  <li key={i.invoiceId} className="flex items-center justify-between gap-2 py-2">
                    <span>
                      <Link className="text-brand-700 hover:underline" href={`${base}/documents/${i.invoiceId}`}>
                        {i.number ?? "Draft invoice"}
                      </Link>{" "}
                      <DateText date={i.issueDate} /> <Badge tone={statusTone(i.status)}>{i.status.replace("_", " ")}</Badge>
                    </span>
                    <Money amount={i.billed} currency={i.currency} />
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-xs text-slate-500">Deleting a draft or voiding an invoice releases its time and expenses to bill again.</p>
          </Card>
          <Card title="Budget">
            {prof.budget ? (
              <p className="text-sm text-slate-700">
                Costs <Money amount={prof.costs.toString()} currency={cur} /> of a <Money amount={prof.budget.toString()} currency={cur} /> budget —{" "}
                {prof.budgetRemaining!.isNegative() ? (
                  <strong className="text-danger-700">
                    <Money amount={prof.budgetRemaining!.neg().toString()} currency={cur} /> over
                  </strong>
                ) : (
                  <>
                    <Money amount={prof.budgetRemaining!.toString()} currency={cur} /> left
                  </>
                )}
                .
              </p>
            ) : (
              <p className="text-sm text-slate-500">No cost budget set. Add one in the project details, or plan by account under Budgets.</p>
            )}
          </Card>
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
