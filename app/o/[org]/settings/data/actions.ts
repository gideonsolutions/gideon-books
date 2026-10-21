"use server";

import { requestExport } from "@/lib/ops/export";
import { requestImport } from "@/lib/ops/import";
import { deleteOrganization } from "@/lib/ops/delete-org";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";

export async function exportAction(slug: string): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    await requestExport(await orgCtx(slug));
  }, "The export is being built. It appears below when it is ready (refresh in a minute).");
}

export async function importAction(slug: string, _: unknown, fd: FormData): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose an export ZIP.", { file: "Required." });
    await requestImport(await orgCtx(slug), Buffer.from(await file.arrayBuffer()), str(fd, "name"));
  }, "The import is running. The new organization appears below and in your organization list when it is done.");
}

export async function deleteOrgAction(slug: string, _: unknown, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    await deleteOrganization(await orgCtx(slug), { confirmName: str(fd, "confirmName"), skipExport: bool(fd, "skipExport"), reason: str(fd, "reason") });
    return { href: "/orgs" };
  });
}
