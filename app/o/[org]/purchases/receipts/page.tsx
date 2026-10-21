import Link from "next/link";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { listInbox } from "@/lib/purchases/receipts";
import { KIND_LABELS } from "@/lib/commerce/states";
import { can } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { orgCtx } from "@/lib/web/session";
import { Card, EmptyState, LinkButton, PageHeader, inputClass } from "@/components/ui";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client/forms";
import { matchReceiptAction, unmatchReceiptAction, uploadReceiptAction } from "../actions";

export const metadata = { title: "Receipt inbox" };

export default async function Receipts({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const unmatched = await listInbox(db, ctx.orgId, "unmatched");
  const matched = await listInbox(db, ctx.orgId, "matched");
  const recent = await db
    .select({ id: documents.id, kind: documents.kind, number: documents.number, reference: documents.reference, date: documents.issueDate, total: documents.total, currency: documents.currency, vendor: contacts.displayName })
    .from(documents)
    .leftJoin(contacts, and(eq(contacts.orgId, documents.orgId), eq(contacts.id, documents.contactId)))
    .where(and(eq(documents.orgId, ctx.orgId), inArray(documents.kind, ["bill", "expense"])))
    .orderBy(desc(documents.issueDate))
    .limit(200);
  const manage = can(ctx, "purchases.manage");
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Receipt inbox"
        back={{ href: `${base}/purchases/expenses`, label: "Expenses" }}
        description="Drop receipts here as they come in, then match each to the bill or expense it supports — or turn it into a new expense. Matched receipts appear among the document's attachments."
      />
      {manage && (
        <Card title="Add receipts" className="mb-6">
          <ActionForm action={uploadReceiptAction.bind(null, org)} resetOnSuccess className="flex flex-wrap items-end gap-3">
            <label className="flex-1 text-sm font-medium text-slate-800">
              PDFs or photos (several at once is fine)
              <input type="file" name="files" multiple required accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic" className={`${inputClass} mt-1`} />
            </label>
            <SubmitButton pendingText="Uploading…">Upload</SubmitButton>
          </ActionForm>
        </Card>
      )}
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Waiting to be matched ({unmatched.length})</h2>
      {unmatched.length === 0 ? (
        <EmptyState title="The inbox is empty">Receipts you upload wait here until they are matched.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {unmatched.map(({ attachment: a }) => (
            <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <a href={`${base}/files/${a.id}`} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                    {a.fileName}
                  </a>
                  <div className="text-xs text-slate-500">Uploaded {a.createdAt.toISOString().slice(0, 10)}</div>
                </div>
                {manage && (
                  <div className="flex flex-wrap gap-2">
                    <LinkButton size="sm" variant="secondary" href={`${base}/purchases/expenses/new?receipt=${a.id}`}>
                      New expense
                    </LinkButton>
                    <LinkButton size="sm" variant="secondary" href={`${base}/purchases/bills/new?receipt=${a.id}`}>
                      New bill
                    </LinkButton>
                  </div>
                )}
              </div>
              {manage && recent.length > 0 && (
                <ActionForm action={matchReceiptAction.bind(null, org, a.id)} className="mt-3 flex flex-wrap items-end gap-2">
                  <label className="min-w-0 flex-1 text-xs font-medium text-slate-600">
                    Or match to an existing bill or expense
                    <select name="documentId" className={`${inputClass} mt-1`} defaultValue="">
                      <option value="">Choose…</option>
                      {recent.map((d) => (
                        <option key={d.id} value={d.id}>
                          {KIND_LABELS[d.kind]} {d.number ?? "draft"} · {d.vendor ?? "—"} · {d.date} · {Decimal.from(d.total).toFixed(2)} {d.currency}
                          {d.reference ? ` · ${d.reference}` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton variant="secondary">Match</SubmitButton>
                </ActionForm>
              )}
            </li>
          ))}
        </ul>
      )}
      {matched.length > 0 && (
        <>
          <h2 className="mb-2 mt-8 text-sm font-semibold uppercase tracking-wide text-slate-500">Matched</h2>
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {matched.map((m) => (
              <li key={m.attachment.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <a href={`${base}/files/${m.attachment.id}`} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
                    {m.attachment.fileName}
                  </a>{" "}
                  →{" "}
                  <Link className="text-brand-700 hover:underline" href={`${base}/documents/${m.documentId}`}>
                    {m.docKind ? KIND_LABELS[m.docKind] : ""} {m.docNumber ?? m.docReference ?? ""}
                  </Link>
                </span>
                {manage && m.matchId && <ActionButton size="sm" action={unmatchReceiptAction.bind(null, org, m.matchId)}>Unmatch</ActionButton>}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-8 text-xs text-slate-500">
        Gideon Keep keeps supporting documents for its own accounts but publishes no interface for Books to read them, so receipts come in here by upload.
      </p>
    </>
  );
}
