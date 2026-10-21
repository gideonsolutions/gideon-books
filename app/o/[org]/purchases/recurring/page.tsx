import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { listRecurringBills } from "@/lib/purchases/recurring";
import { can } from "@/lib/context";
import { orgCtx } from "@/lib/web/session";
import { Badge, DateText, EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";

export const metadata = { title: "Recurring bills" };

export default async function Recurring({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const rows = await listRecurringBills(getDb(), ctx.orgId);
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Recurring bills"
        description="Bills that come every period (rent, subscriptions). Each scheduled date produces exactly one bill — as a draft to check, or posted automatically."
        actions={can(ctx, "purchases.manage") && <LinkButton href={`${base}/purchases/recurring/new`}>New schedule</LinkButton>}
      />
      {rows.length === 0 ? (
        <EmptyState title="No recurring bills" action={can(ctx, "purchases.manage") && <LinkButton href={`${base}/purchases/recurring/new`}>New schedule</LinkButton>}>
          Enter one bill, then make it recurring.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Vendor</Th>
              <Th>Repeats</Th>
              <Th>Next</Th>
              <Th align="right">Produced</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ t, vendor }) => (
              <tr key={t.id}>
                <Td>
                  <Link className="font-medium text-brand-700 hover:underline" href={`${base}/purchases/recurring/${t.id}`}>
                    {t.name}
                  </Link>
                </Td>
                <Td>{vendor}</Td>
                <Td>
                  {t.frequency}
                  {t.interval > 1 ? ` (every ${t.interval})` : ""}
                  {t.autoIssue ? " · posts automatically" : " · drafts"}
                </Td>
                <Td>{t.status === "active" ? <DateText date={t.nextRunDate} /> : "—"}</Td>
                <Td align="right">
                  {t.occurrences}
                  {t.maxOccurrences ? ` of ${t.maxOccurrences}` : ""}
                </Td>
                <Td>
                  <Badge tone={t.status === "active" ? "green" : t.status === "paused" ? "amber" : "gray"}>{t.status}</Badge>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
