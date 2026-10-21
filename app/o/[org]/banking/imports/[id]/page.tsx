import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { getImportBatch } from "@/lib/banking/imports";
import { loadMoneyAccount } from "@/lib/banking/common";
import { formatDateTime } from "@/lib/money/format";
import { getUser } from "@/lib/auth/users";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { undoImportAction } from "../../actions";

export const metadata = { title: "Import" };

export default async function ImportBatch({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { batch, rows, transactions } = await getImportBatch(db, ctx.orgId, id);
  const account = await loadMoneyAccount(db, ctx, batch.accountId);
  const by = batch.createdBy ? await getUser(db, batch.createdBy).catch(() => null) : null;
  const txnByRaw = new Map(transactions.map((t) => [t.rawRowId, t]));
  const used = transactions.filter((t) => t.status === "matched" || t.status === "categorized").length;
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title={batch.source === "feed" ? "Feed sync" : batch.fileName ?? "Import"}
        back={{ href: `${base}/banking/imports`, label: "Imports" }}
        actions={
          can(ctx, "banking.import") &&
          batch.status === "completed" && (
            <ConfirmButton
              action={undoImportAction.bind(null, org, id)}
              label="Undo import"
              title="Undo this import?"
              body={
                used
                  ? `${used} of its transactions are matched or categorized; undo those first.`
                  : "Its transactions are removed from review. The file and every row stay on record, and the same file can be imported again."
              }
              reasonLabel="Why?"
              confirmLabel="Undo import"
              variant="danger"
            />
          )
        }
      />
      {batch.status === "undone" && (
        <div className="mb-4">
          <Alert tone="warning" title="Undone">
            {batch.undoReason} ({batch.undoneAt ? formatDateTime(batch.undoneAt, ctx.org.timezone) : ""})
          </Alert>
        </div>
      )}
      <Card title="Provenance" className="mb-6">
        <DescriptionList
          items={[
            { label: "Account", value: <Link className="text-brand-700 hover:underline" href={`${base}/banking/accounts/${account.id}`}>{account.name}</Link> },
            { label: "Imported", value: `${formatDateTime(batch.createdAt, ctx.org.timezone)}${by ? ` by ${by.name}` : ""}` },
            { label: "Source", value: batch.source === "feed" ? "Bank feed" : "CSV file" },
            { label: "File", value: batch.attachmentId ? <a className="text-brand-700 hover:underline" href={`${base}/files/${batch.attachmentId}?download=1`}>{batch.fileName}</a> : batch.fileName },
            { label: "SHA-256", value: batch.fileSha256 ? <code className="break-all text-xs">{batch.fileSha256}</code> : null },
            { label: "Rows", value: `${batch.totalRows} read · ${batch.importedCount} new · ${batch.duplicateCount} duplicates · ${batch.errorCount} with problems` },
          ]}
        />
      </Card>
      <Table>
        <thead>
          <tr>
            <Th>Row</Th>
            <Th>Original</Th>
            <Th>Outcome</Th>
            <Th>Transaction</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.slice(0, 2000).map((r) => {
            const t = txnByRaw.get(r.id);
            const cells = (r.raw as { cells?: string[] }).cells;
            return (
              <tr key={r.id}>
                <Td className="text-xs text-slate-500">{r.rowNumber}</Td>
                <Td className="max-w-md truncate font-mono text-xs">{cells ? cells.join(" | ") : JSON.stringify(r.raw)}</Td>
                <Td>
                  <Badge tone={r.outcome === "imported" ? "green" : r.outcome === "duplicate" ? "amber" : "red"}>{r.outcome}</Badge>
                  {r.message && <div className="text-xs text-slate-600">{r.message}</div>}
                </Td>
                <Td>
                  {t && (
                    <Link href={`${base}/banking/transactions/${t.id}`} className="text-sm hover:text-brand-700">
                      <DateText date={t.postedDate} /> · <Money amount={t.amount} currency={t.currency} /> <StatusBadge status={t.status} />
                    </Link>
                  )}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {rows.length > 2000 && <p className="mt-2 text-xs text-slate-500">Showing the first 2,000 of {rows.length} rows.</p>}
    </>
  );
}
