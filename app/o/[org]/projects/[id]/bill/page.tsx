import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { getProject } from "@/lib/projects/projects";
import { unbilledForProject } from "@/lib/projects/billing";
import { accountOptions } from "@/lib/web/options";
import { getSystemAccountReadOnly } from "@/lib/ledger/accounts";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Card, PageHeader } from "@/components/ui";
import { BillForm } from "@/components/projects/bill-form";
import { billProjectAction } from "../../actions";

export const metadata = { title: "Bill project" };

export default async function BillProject({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "projects.manage", "sales.manage");
  const db = getDb();
  const { project: p, customerName, customerCurrency } = await getProject(db, ctx.orgId, id);
  const { time, expenses } = await unbilledForProject(db, ctx.orgId, id);
  const currency = customerCurrency ?? ctx.org.baseCurrency;
  const service = await getSystemAccountReadOnly(db, ctx.orgId, "service_income");
  return (
    <>
      <PageHeader title={`Bill ${p.name}`} back={{ href: `/o/${org}/projects/${id}`, label: p.name }} description={customerName ? `A draft invoice to ${customerName} in ${currency}.` : undefined} />
      {!p.customerId || p.billingMethod === "non_billable" ? (
        <Alert tone="warning">This project has no customer or is not billable. Set a customer and a billing method first.</Alert>
      ) : (
        <Card>
          <BillForm
            action={billProjectAction.bind(null, org, id)}
            time={time.map((t) => ({ id: t.id, workDate: t.workDate, person: t.personLabel, hours: t.hours, rate: t.effectiveRate, description: t.description }))}
            expenses={expenses.map((e) => ({
              lineId: e.lineId,
              date: e.date,
              label: `${e.vendorName ?? "Vendor"} ${e.documentNumber ?? ""} · ${e.description || "expense"}`,
              amount: Decimal.from(e.amount).toString(),
              currency: e.currency,
              eligible: e.currency === currency && e.billableCustomerId === p.customerId,
              reason: e.currency !== currency ? `in ${e.currency}` : "billable to another customer",
            }))}
            currency={currency}
            incomeAccounts={await accountOptions(db, ctx.orgId, { types: ["income"] })}
            defaultIncomeAccountId={service?.id ?? ""}
            today={todayIn(ctx.org.timezone)}
            fixedFee={p.billingMethod === "fixed_fee" && p.fixedFee ? Decimal.from(p.fixedFee).normalize().toString() : null}
          />
        </Card>
      )}
    </>
  );
}
