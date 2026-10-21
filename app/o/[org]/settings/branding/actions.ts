"use server";

import { revalidatePath } from "next/cache";
import { updateOrgSettings } from "@/lib/orgs/orgs";
import { uploadAttachment } from "@/lib/storage/attachments";
import type { OrgProfile } from "@/lib/db/schema/core";
import { ValidationError } from "@/lib/errors";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

export async function saveBrandingAction(slug: string, _: ActionResult<unknown> | null, fd: FormData): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const org = ctx.org;
    const accent = str(fd, "accentColor");
    if (accent && !/^#[0-9a-fA-F]{6}$/.test(accent)) throw new ValidationError("Use a color like #013ea9.", { accentColor: "Six-digit hex color." });
    let logoAttachmentId = org.profile?.branding?.logoAttachmentId;
    const file = fd.get("logo");
    if (file instanceof File && file.size > 0) {
      if (!/^image\/(png|jpeg)$/.test(file.type)) throw new ValidationError("Upload the logo as a PNG or JPEG.", { logo: "PNG or JPEG." });
      if (file.size > 2 * 1024 * 1024) throw new ValidationError("Keep the logo under 2 MB.", { logo: "Too large." });
      const att = await uploadAttachment(ctx, { entityType: "organization", entityId: ctx.orgId, fileName: file.name, contentType: file.type, bytes: Buffer.from(await file.arrayBuffer()) });
      logoAttachmentId = att.id;
    }
    if (str(fd, "removeLogo") === "on") logoAttachmentId = undefined;
    const profile: OrgProfile = {
      ...org.profile,
      email: str(fd, "email") ?? undefined,
      phone: str(fd, "phone") ?? undefined,
      website: str(fd, "website") ?? undefined,
      taxId: str(fd, "taxId") ?? undefined,
      address: {
        line1: str(fd, "line1") ?? undefined,
        line2: str(fd, "line2") ?? undefined,
        city: str(fd, "city") ?? undefined,
        region: str(fd, "region") ?? undefined,
        postalCode: str(fd, "postalCode") ?? undefined,
        country: str(fd, "country") ?? undefined,
      },
      branding: {
        ...(logoAttachmentId ? { logoAttachmentId } : {}),
        ...(accent ? { accentColor: accent } : {}),
        ...(str(fd, "invoiceFooter") ? { invoiceFooter: str(fd, "invoiceFooter")! } : {}),
        ...(str(fd, "paymentInstructions") ? { paymentInstructions: str(fd, "paymentInstructions")! } : {}),
      },
    };
    await updateOrgSettings(ctx, {
      name: org.name,
      legalName: org.legalName,
      timezone: org.timezone,
      fiscalYearStartMonth: org.fiscalYearStartMonth,
      reportingBasis: org.reportingBasis,
      taxRounding: org.taxRounding,
      entityType: org.entityType,
      booksStartDate: org.booksStartDate,
      bankRulesAutoPost: org.bankRulesAutoPost,
      profile,
    });
    revalidatePath(`/o/${slug}/settings/branding`);
  }, "Saved. New documents use it; documents already issued keep the branding they were issued with.");
}
