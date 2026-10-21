import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { settlements } from "@/lib/db/schema/commerce";
import { orgCtx } from "@/lib/web/session";
import { loadOpenItem } from "@/lib/commerce/open-items";
import { Badge, Card, DateText, DescriptionList, Money, PageHeader } from "@/components/ui";

export const metadata = { title: "Application" };

/** One application of a payment or credit to a document. */
export default async function SettlementPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const [s] = await db.select().from(settlements).where(and(eq(settlements.orgId, ctx.orgId), eq(settlements.id, id)));
  if (!s) notFound();
  const debit = await loadOpenItem(db, ctx.orgId, { type: s.debitItemType, id: s.debitItemId });
  const credit = await loadOpenItem(db, ctx.orgId, { type: s.creditItemType, id: s.creditItemId });
  const base = `/o/${org}`;
  const link = (i: typeof debit) => (
    <Link className="text-brand-700 hover:underline" href={`${base}/${i.ref.type === "document" ? "documents" : "payments"}/${i.ref.id}`}>
      {i.kind.replace(/_/g, " ")} {i.number}
    </Link>
  );
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2">Application <Badge tone={s.status === "active" ? "green" : "red"}>{s.status}</Badge></span>} />
      <Card className="max-w-2xl">
        <DescriptionList
          items={[
            { label: "Applied", value: link(credit) },
            { label: "To", value: link(debit) },
            { label: "Amount", value: <Money amount={s.amount} currency={s.currency} /> },
            { label: "Date", value: <DateText date={s.settlementDate} /> },
            { label: "Realized exchange difference", value: <Money amount={s.fxDifferenceBase} currency={ctx.org.baseCurrency} /> },
            { label: "Entry", value: s.journalEntryId ? <Link className="text-brand-700 hover:underline" href={`${base}/accounting/journal/${s.journalEntryId}`}>View entry</Link> : "—" },
            ...(s.status === "reversed" ? [{ label: "Removed because", value: s.reversalReason }] : []),
          ]}
        />
      </Card>
    </>
  );
}
