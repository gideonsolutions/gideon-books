import type { Attachment } from "@/lib/storage/attachments";
import { Card } from "@/components/ui";
import { UploadForm, RemoveAttachmentButton } from "@/components/client/upload";

function size(n: number) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Files on a record: list, download, add, remove. */
export function Attachments({ org, entityType, entityId, files, canUpload }: { org: string; entityType: string; entityId: string; files: Attachment[]; canUpload: boolean }) {
  return (
    <Card title={`Attachments${files.length ? ` (${files.length})` : ""}`}>
      {files.length === 0 && <p className="mb-3 text-sm text-slate-500">No files attached.</p>}
      {files.length > 0 && (
        <ul className="mb-3 divide-y divide-slate-100">
          {files.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <a href={`/o/${org}/files/${f.id}`} className="min-w-0 truncate text-brand-700 hover:underline">
                {f.fileName}
              </a>
              <span className="flex shrink-0 items-center gap-2 text-xs text-slate-500">
                {size(f.sizeBytes)}
                {canUpload && <RemoveAttachmentButton org={org} id={f.id} />}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canUpload && <UploadForm org={org} entityType={entityType} entityId={entityId} />}
    </Card>
  );
}
