import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { listImportBatches, listMappings } from "@/lib/banking/imports";
import { moneyAccountSummaries } from "@/lib/banking/overview";
import { formatDateTime } from "@/lib/money/format";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { deleteMappingAction } from "../actions";

export const metadata = { title: "Imports" };

export default async function Imports({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const batches = await listImportBatches(db, ctx.orgId);
  const mappings = await listMappings(db, ctx.orgId);
  const accounts = new Map((await moneyAccountSummaries(db, ctx, { includeArchived: true })).map((a) => [a.id, a.name]));
  const base = `/o/${org}`;
  return (
    <>
      <PageHeader
        title="Imports"
        description="Every statement file imported and every feed sync, with what each brought in. An import can be undone until one of its transactions is matched or categorized."
        actions={can(ctx, "banking.import") && <LinkButton href={`${base}/banking/imports/new`}>Import a statement</LinkButton>}
      />
      {batches.length === 0 ? (
        <EmptyState title="No imports yet" action={can(ctx, "banking.import") && <LinkButton href={`${base}/banking/imports/new`}>Import a statement</LinkButton>}>
          Download a CSV from your bank&apos;s website and import it here, or connect a feed under Settings → Integrations.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>When</Th>
              <Th>Account</Th>
              <Th>Source</Th>
              <Th align="right">Rows</Th>
              <Th align="right">New</Th>
              <Th align="right">Duplicates</Th>
              <Th align="right">Problems</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {batches.map((b) => (
              <tr key={b.id} className="hover:bg-slate-50">
                <Td>
                  <Link href={`${base}/banking/imports/${b.id}`} className="text-brand-700 hover:underline">
                    {formatDateTime(b.createdAt, ctx.org.timezone)}
                  </Link>
                </Td>
                <Td>{accounts.get(b.accountId) ?? "—"}</Td>
                <Td className="max-w-xs truncate">{b.source === "feed" ? <Badge tone="blue">feed</Badge> : b.fileName}</Td>
                <Td align="right">{b.totalRows}</Td>
                <Td align="right">{b.importedCount}</Td>
                <Td align="right">{b.duplicateCount}</Td>
                <Td align="right">{b.errorCount}</Td>
                <Td>{b.status === "undone" ? <Badge tone="red">undone</Badge> : <Badge tone="green">imported</Badge>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {mappings.length > 0 && (
        <Card title="Saved column mappings" className="mt-8">
          <ul className="divide-y divide-slate-100">
            {mappings.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{m.name}</span>
                  {m.accountId && <span className="text-slate-500"> · made for {accounts.get(m.accountId) ?? "an account"}</span>}
                  <span className="text-slate-500"> · dates {m.config.dateFormat}</span>
                </span>
                {can(ctx, "banking.import") && (
                  <ConfirmButton action={deleteMappingAction.bind(null, org, m.id)} label="Delete" size="sm" title={`Delete the mapping “${m.name}”?`} body="Past imports keep a copy of the mapping they used." confirmLabel="Delete" variant="danger" />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
