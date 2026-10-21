/** Recent bills as options (for copying into a recurring schedule). */
import { and, desc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { Decimal } from "@/lib/money/decimal";

export async function recentBillOptions(db: DbOrTx, orgId: string, limit = 200) {
  const rows = await db
    .select({ id: documents.id, number: documents.number, reference: documents.reference, date: documents.issueDate, total: documents.total, currency: documents.currency, vendor: contacts.displayName, status: documents.status })
    .from(documents)
    .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
    .where(and(eq(documents.orgId, orgId), eq(documents.kind, "bill")))
    .orderBy(desc(documents.issueDate))
    .limit(limit);
  return rows.map((r) => ({
    value: r.id,
    label: `${r.vendor ?? "—"} · ${r.number ?? "draft"}${r.reference ? ` (${r.reference})` : ""} · ${r.date} · ${Decimal.from(r.total).toFixed(2)} ${r.currency}${r.status === "draft" ? " · draft" : ""}`,
  }));
}
