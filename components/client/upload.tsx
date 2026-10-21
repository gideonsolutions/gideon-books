"use client";

import { ActionForm, SubmitButton } from "@/components/client/forms";
import { uploadAttachmentAction, removeAttachmentAction } from "@/app/o/[org]/files/actions";
import { inputClass } from "@/components/ui";

export function UploadForm({ org, entityType, entityId }: { org: string; entityType: string; entityId: string }) {
  return (
    <ActionForm action={uploadAttachmentAction.bind(null, org)} resetOnSuccess className="space-y-2">
      <input type="hidden" name="entityType" value={entityType} />
      <input type="hidden" name="entityId" value={entityId} />
      <label className="block text-xs font-medium text-slate-600">
        Add a file (PDF, image or CSV)
        <input type="file" name="file" required accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.heic,.csv,.txt" className={`${inputClass} mt-1`} />
      </label>
      <SubmitButton variant="secondary" pendingText="Uploading…">
        Attach
      </SubmitButton>
    </ActionForm>
  );
}

export function RemoveAttachmentButton({ org, id }: { org: string; id: string }) {
  return (
    <ActionForm action={removeAttachmentAction.bind(null, org, id)} className="inline">
      <button type="submit" className="text-slate-400 hover:text-danger-600" aria-label="Remove attachment">
        ✕
      </button>
    </ActionForm>
  );
}
