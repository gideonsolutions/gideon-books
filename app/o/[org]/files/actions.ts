"use server";

import { removeAttachment, uploadAttachment } from "@/lib/storage/attachments";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";

export async function uploadAttachmentAction(slug: string, _: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a file.", { file: "Required." });
    await uploadAttachment(ctx, {
      entityType: str(fd, "entityType") ?? "",
      entityId: str(fd, "entityId"),
      fileName: file.name,
      contentType: file.type,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
  }, "Attached.");
}

export async function removeAttachmentAction(slug: string, id: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    await removeAttachment(await orgCtx(slug), id);
  });
}
