import { getDb } from "@/lib/db/client";
import { requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { recentBillOptions } from "@/lib/purchases/bill-options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { RecurringForm } from "@/components/purchases/recurring-form";
import { saveRecurringAction } from "../../actions";

export const metadata = { title: "New recurring bill" };

export default async function NewRecurring({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "purchases.manage");
  const bills = await recentBillOptions(getDb(), ctx.orgId);
  return (
    <>
      <PageHeader title="New recurring bill" back={{ href: `/o/${org}/purchases/recurring`, label: "Recurring bills" }} />
      {bills.length === 0 ? (
        <EmptyState title="Enter the bill first" action={<LinkButton href={`/o/${org}/purchases/bills/new`}>New bill</LinkButton>}>
          A schedule copies a bill you have entered (a draft is fine).
        </EmptyState>
      ) : (
        <Card className="max-w-3xl">
          <RecurringForm
            action={saveRecurringAction.bind(null, org, null)}
            bills={bills}
            editing={false}
            defaults={{ name: "", frequency: "monthly", interval: "1", startDate: todayIn(ctx.org.timezone), endDate: "", maxOccurrences: "", autoIssue: false, sourceBillId: sp.from ?? "" }}
          />
        </Card>
      )}
    </>
  );
}
