import Link from "next/link";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { listDataJobs } from "@/lib/ops/export";
import { hasCompletedExport } from "@/lib/ops/delete-org";
import { formatDateTime } from "@/lib/money/format";
import { Alert, Badge, Card, PageHeader, Table, Td, Th, statusTone } from "@/components/ui";
import { ActionButton, ActionForm, CheckboxField, SubmitButton, TextField } from "@/components/client/forms";
import { deleteOrgAction, exportAction, importAction } from "./actions";

export const metadata = { title: "Data export and backup" };

function size(n: number | null) {
  if (!n) return "—";
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export default async function DataPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "org.read");
  const jobs = await listDataJobs(ctx.orgId);
  const exportsList = jobs.filter((j) => j.kind === "export");
  const imports = jobs.filter((j) => j.kind === "import");
  const exported = await hasCompletedExport(ctx.orgId);
  return (
    <>
      <PageHeader
        title="Data export and backup"
        description="A complete export holds every record of this organization — the ledger, documents, payments, bank data, inventory, assets, the audit trail — and every attached file, in an open, documented format. It never depends on a subscription."
      />
      <div className="space-y-6">
        <Card title="Complete export" actions={can(ctx, "data.export") && <ActionButton action={exportAction.bind(null, org)} variant="primary">Export everything</ActionButton>} padded={false}>
          {!can(ctx, "data.export") && <p className="p-4 text-sm text-slate-600">Exports need the accountant role or higher.</p>}
          {exportsList.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">No exports yet.</p>
          ) : (
            <Table className="rounded-none border-0 shadow-none">
              <thead>
                <tr>
                  <Th>Requested</Th>
                  <Th>Status</Th>
                  <Th align="right">Size</Th>
                  <Th>SHA-256</Th>
                  <Th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {exportsList.map((e) => (
                  <tr key={e.id}>
                    <Td>{formatDateTime(e.createdAt)}</Td>
                    <Td>
                      <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      {e.error && <div className="text-xs text-danger-700">{e.error}</div>}
                    </Td>
                    <Td align="right" className="num">
                      {size(e.sizeBytes)}
                    </Td>
                    <Td className="max-w-[10rem] truncate font-mono text-xs text-slate-500">{e.sha256}</Td>
                    <Td align="right">
                      {e.status === "completed" && can(ctx, "data.export") && (
                        <a className="text-brand-700 hover:underline" href={`/o/${org}/settings/data/exports/${e.id}`}>
                          Download
                        </a>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">
            Format: docs/data-export-format.md. Provider secrets and access grants are not included; connections come out disconnected. Server-wide backups (the whole database and file store) are the operator&apos;s: see docs/backup-restore.md.
          </p>
        </Card>

        {can(ctx, "data.import") && (
          <Card title="Import an export as a new organization">
            <p className="mb-3 text-sm text-slate-600">Creates a new organization from a Gideon Books export (from this server or another) and makes you its owner. Every file is checked against its checksum, and every posting passes the same checks as when it was first made. Nothing in this organization changes.</p>
            <ActionForm action={importAction.bind(null, org)} className="grid gap-3 md:grid-cols-[minmax(0,1fr)_1fr_auto] md:items-end" resetOnSuccess>
              <label className="text-sm font-medium text-slate-800">
                Export file (.zip)
                <input type="file" name="file" accept=".zip,application/zip" required className="mt-1 block w-full text-sm" />
              </label>
              <TextField label="Name for the new organization" name="name" placeholder="Leave blank: original name (imported)" />
              <SubmitButton pendingText="Uploading…">Import</SubmitButton>
            </ActionForm>
            {imports.length > 0 && (
              <ul className="mt-4 divide-y divide-slate-100 text-sm">
                {imports.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      {formatDateTime(i.createdAt)} · <Badge tone={statusTone(i.status)}>{i.status}</Badge>
                      {i.error && <span className="ml-2 text-xs text-danger-700">{i.error}</span>}
                    </span>
                    {i.resultOrgId && <Link href={`/orgs`} className="text-brand-700 hover:underline">Open from your organizations</Link>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {can(ctx, "org.delete") && (
          <Card title="Delete this organization">
            {ctx.org.isDemo ? (
              <p className="mb-3 text-sm text-slate-600">This is a demonstration company; deleting it removes its synthetic data at once.</p>
            ) : (
              <div className="mb-3 space-y-2">
                <Alert tone="danger">Deleting removes every record and file of {ctx.org.name} permanently, for every member. It cannot be undone.</Alert>
                {!exported && <p className="text-sm text-slate-700">There is no completed export yet. Export first, or tick the box to confirm you do not want one.</p>}
              </div>
            )}
            <ActionForm action={deleteOrgAction.bind(null, org)} className="space-y-3">
              {!ctx.org.isDemo && <TextField label={`Type “${ctx.org.name}” to confirm`} name="confirmName" required autoComplete="off" />}
              {!ctx.org.isDemo && !exported && <CheckboxField label="I do not want an export; delete without one." name="skipExport" />}
              <TextField label="Reason (kept in the server's audit log)" name="reason" />
              <SubmitButton variant="danger" pendingText="Deleting…">
                Delete {ctx.org.isDemo ? "demonstration company" : "organization"}
              </SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
