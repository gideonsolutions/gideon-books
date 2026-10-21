import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { payablesDue, type DueRow } from "@/lib/purchases/queries";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { orgCtx } from "@/lib/web/session";
import { Badge, Card, DateText, EmptyState, LinkButton, Money, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Bills due" };

const GROUPS = [
  { key: "overdue", title: "Overdue" },
  { key: "week", title: "Due in the next 7 days" },
  { key: "later", title: "Due later" },
] as const;

export default async function Due({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const today = todayIn(ctx.org.timezone);
  const { groups, totals } = await payablesDue(getDb(), ctx.orgId, today);
  const base = `/o/${org}`;
  const any = GROUPS.some((g) => groups[g.key].length > 0);
  return (
    <>
      <PageHeader
        title="Bills due"
        back={{ href: `${base}/purchases/bills`, label: "Bills" }}
        description={`Open bills by due date, as of ${today}. Amounts are what is still owed, in each bill's currency. Recording a payment does not send money.`}
      />
      {!any ? (
        <EmptyState title="Nothing is owed">Every posted bill is paid or credited.</EmptyState>
      ) : (
        <div className="space-y-6">
          {GROUPS.map((g) => (
            <Card
              key={g.key}
              title={
                <span className="flex flex-wrap items-center gap-2">
                  {g.title}
                  {totals[g.key].map((t) => (
                    <Badge key={t.currency} tone={g.key === "overdue" ? "red" : "gray"}>
                      <Money amount={t.amount} currency={t.currency} />
                    </Badge>
                  ))}
                </span>
              }
              padded={false}
            >
              {groups[g.key].length === 0 ? (
                <p className="p-4 text-sm text-slate-500">None.</p>
              ) : (
                <DueTable rows={groups[g.key]} base={base} canPay={can(ctx, "payments.record")} />
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function DueTable({ rows, base, canPay }: { rows: DueRow[]; base: string; canPay: boolean }) {
  return (
    <Table className="rounded-none border-0 shadow-none">
      <thead>
        <tr>
          <Th>Due</Th>
          <Th>Bill</Th>
          <Th>Vendor</Th>
          <Th align="right">Owed</Th>
          <Th />
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((r) => (
          <tr key={r.id}>
            <Td>
              <DateText date={r.dueDate} />
            </Td>
            <Td>
              <Link className="text-brand-700 hover:underline" href={`${base}/purchases/bills/${r.id}`}>
                {r.number}
              </Link>
              {r.reference && <span className="ml-2 text-xs text-slate-500">{r.reference}</span>}
              {r.isReimbursement && (
                <span className="ml-2">
                  <Badge tone="blue">reimbursement</Badge>
                </span>
              )}
            </Td>
            <Td>{r.vendor}</Td>
            <Td align="right">
              <Money amount={r.open} currency={r.currency} />
            </Td>
            <Td align="right">
              {canPay && (
                <LinkButton size="sm" variant="secondary" href={`${base}/purchases/payments/new?vendor=${r.contactId}&apply=${r.id}`}>
                  Pay
                </LinkButton>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
