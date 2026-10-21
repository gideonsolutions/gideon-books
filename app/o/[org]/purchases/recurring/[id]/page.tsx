import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { contacts } from "@/lib/db/schema/ledger";
import { getRecurringBill } from "@/lib/purchases/recurring";
import { recentBillOptions } from "@/lib/purchases/bill-options";
import type { DocumentInput } from "@/lib/commerce/documents";
import { can } from "@/lib/context";
import { orgCtx } from "@/lib/web/session";
import { Badge, Card, DateText, Money, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionButton } from "@/components/client/forms";
import { RecurringForm } from "@/components/purchases/recurring-form";
import { recurringStatusAction, runRecurringNowAction, saveRecurringAction } from "../../actions";

export const metadata = { title: "Recurring bill" };

export default async function RecurringDetail({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  let data;
  try {
    data = await getRecurringBill(db, ctx.orgId, id);
  } catch {
    notFound();
  }
  const { template: t, runs } = data;
  const bill = t.template as DocumentInput;
  const [vendor] = bill.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, bill.contactId))) : [];
  const manage = can(ctx, "purchases.manage");
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {t.name} <Badge tone={t.status === "active" ? "green" : t.status === "paused" ? "amber" : "gray"}>{t.status}</Badge>
          </span>
        }
        back={{ href: `${base}/purchases/recurring`, label: "Recurring bills" }}
        actions={
          manage && (
            <>
              {t.status === "active" && <ActionButton action={runRecurringNowAction.bind(null, org, id)}>Produce due bills now</ActionButton>}
              {t.status === "active" && <ActionButton action={recurringStatusAction.bind(null, org, id, "paused")}>Pause</ActionButton>}
              {t.status === "paused" && <ActionButton action={recurringStatusAction.bind(null, org, id, "active")}>Resume</ActionButton>}
              {t.status !== "ended" && <ActionButton variant="danger" action={recurringStatusAction.bind(null, org, id, "ended")}>End</ActionButton>}
            </>
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Each bill">
          <p className="text-sm text-slate-700">
            To <strong>{vendor?.displayName ?? "—"}</strong>, {bill.lines.length} line{bill.lines.length === 1 ? "" : "s"}:
          </p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            {bill.lines.map((l, i) => (
              <li key={i}>
                {l.description || "Line"} — {l.quantity ?? "1"} × {l.unitPrice ?? "0"}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-slate-600">
            Next: {t.status === "active" ? <DateText date={t.nextRunDate} /> : "—"} · produced {t.occurrences}
            {t.maxOccurrences ? ` of ${t.maxOccurrences}` : ""}
            {t.endDate ? (
              <>
                {" "}
                · until <DateText date={t.endDate} />
              </>
            ) : null}
          </p>
        </Card>
        {manage && (
          <Card title="Schedule">
            <RecurringForm
              action={saveRecurringAction.bind(null, org, id)}
              bills={await recentBillOptions(db, ctx.orgId)}
              editing
              defaults={{
                name: t.name,
                frequency: t.frequency,
                interval: String(t.interval),
                startDate: t.startDate,
                endDate: t.endDate ?? "",
                maxOccurrences: t.maxOccurrences ? String(t.maxOccurrences) : "",
                autoIssue: t.autoIssue,
                sourceBillId: "",
              }}
            />
          </Card>
        )}
      </div>
      <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Bills produced</h2>
      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">None yet.</p>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Date</Th>
              <Th>Bill</Th>
              <Th>Status</Th>
              <Th align="right">Total</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {runs.map(({ run, number, status, total, currency }) => (
              <tr key={run.id}>
                <Td>
                  <DateText date={run.occurrenceDate} />
                </Td>
                <Td>
                  {run.documentId ? (
                    <Link className="text-brand-700 hover:underline" href={`${base}/purchases/bills/${run.documentId}`}>
                      {number ?? "Draft"}
                    </Link>
                  ) : (
                    <span className="text-danger-700">Failed: {run.error}</span>
                  )}
                </Td>
                <Td>{status ? <StatusBadge status={status} /> : <StatusBadge status={run.status} />}</Td>
                <Td align="right">{total && currency ? <Money amount={total} currency={currency} /> : "—"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}
