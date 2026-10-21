"use server";

import { revalidatePath } from "next/cache";
import { updateOrgSettings, type OrgSettingsInput } from "@/lib/orgs/orgs";
import { changeMemberRole, createApiToken, inviteMember, removeMember, revokeApiToken, revokeInvitation } from "@/lib/auth/users";
import { configureSequence } from "@/lib/ledger/sequences";
import { savePaymentTerm } from "@/lib/contacts/contacts";
import { queueEmail } from "@/lib/email/send";
import { getDb, withTransaction } from "@/lib/db/client";
import { audit } from "@/lib/audit";
import { requirePermission } from "@/lib/context";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";
import type { Role } from "@/lib/db/schema/core";
import { ROLE_LABELS } from "@/lib/authz/permissions";

type R<T = unknown> = Promise<ActionResult<T>>;

export async function saveOrgSettingsAction(slug: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const profile = {
      ...ctx.org.profile,
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
        country: str(fd, "addrCountry") ?? undefined,
      },
    };
    const input: OrgSettingsInput = {
      name: str(fd, "name") ?? "",
      legalName: str(fd, "legalName"),
      timezone: str(fd, "timezone") ?? ctx.org.timezone,
      fiscalYearStartMonth: Number(str(fd, "fiscalYearStartMonth") ?? ctx.org.fiscalYearStartMonth),
      reportingBasis: (str(fd, "reportingBasis") ?? "accrual") as "accrual" | "cash",
      taxRounding: (str(fd, "taxRounding") ?? "line") as "line" | "document",
      entityType: (str(fd, "entityType") ?? ctx.org.entityType) as OrgSettingsInput["entityType"],
      booksStartDate: str(fd, "booksStartDate"),
      bankRulesAutoPost: bool(fd, "bankRulesAutoPost"),
      profile,
    };
    await updateOrgSettings(ctx, input);
    revalidatePath(`/o/${slug}`, "layout");
  }, "Settings saved.");
}

export async function saveSequenceAction(slug: string, key: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    requirePermission(ctx, "org.settings");
    const prefix = str(fd, "prefix") ?? "";
    const next = Number(str(fd, "nextValue") ?? "");
    const padding = Number(str(fd, "padding") ?? "4");
    if (!/^[A-Za-z0-9\-_/.]{0,12}$/.test(prefix)) throw new ValidationError("Use up to 12 letters, digits, dashes or slashes.", { prefix: "Invalid prefix." });
    if (!Number.isInteger(next) || next < 1) throw new ValidationError("The next number must be a positive whole number.", { nextValue: "Invalid." });
    if (!Number.isInteger(padding) || padding < 1 || padding > 10) throw new ValidationError("Padding is 1–10 digits.", { padding: "Invalid." });
    await withTransaction(async (tx) => {
      await configureSequence(tx, ctx.orgId, key, { prefix, nextValue: next, padding });
      await audit(tx, ctx, { action: "numbering.updated", entityType: "number_sequence", entityId: key, after: { prefix, next, padding } });
    });
  }, "Numbering saved.");
}

export async function saveTermsAction(slug: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await savePaymentTerm(await orgCtx(slug), {
      ...(id ? { id } : {}),
      name: str(fd, "name") ?? "",
      daysDue: Number(str(fd, "daysDue") ?? "-1"),
      discountPercent: str(fd, "discountPercent"),
      discountDays: str(fd, "discountDays") ? Number(str(fd, "discountDays")) : null,
    });
  }, "Terms saved.");
}

export async function inviteAction(slug: string, _: unknown, fd: FormData): R<{ link: string }> {
  return runAction(async () => {
    const ctx = await orgCtx(slug);
    const role = (str(fd, "role") ?? "staff") as Role;
    const email = str(fd, "email") ?? "";
    const { token } = await inviteMember(ctx, email, role);
    const link = `${process.env.APP_URL ?? "http://localhost:3200"}/invite/${token}`;
    await queueEmail(getDb(), ctx, {
      to: email,
      subject: `You're invited to ${ctx.org.name} on Gideon Books`,
      text: `${ctx.actor.label} invited you to ${ctx.org.name} as ${ROLE_LABELS[role]}.\n\nAccept within 7 days:\n${link}\n`,
      entityType: "invitation",
    });
    return { link };
  });
}

export async function revokeInvitationAction(slug: string, id: string): R {
  return runAction(async () => {
    await revokeInvitation(await orgCtx(slug), id);
  }, "Invitation withdrawn.");
}

export async function changeRoleAction(slug: string, userId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await changeMemberRole(await orgCtx(slug), userId, (str(fd, "role") ?? "staff") as Role);
  }, "Role changed.");
}

export async function removeMemberAction(slug: string, userId: string): R {
  return runAction(async () => {
    await removeMember(await orgCtx(slug), userId);
  }, "Member removed.");
}

export async function createTokenAction(slug: string, _: unknown, fd: FormData): R<{ token: string }> {
  return runAction(async () => {
    const days = str(fd, "expiresInDays");
    const { token } = await createApiToken(await orgCtx(slug), {
      name: str(fd, "name") ?? "",
      role: (str(fd, "role") ?? "read_only") as Role,
      expiresInDays: days ? Number(days) : null,
    });
    return { token };
  });
}

export async function revokeTokenAction(slug: string, id: string): R {
  return runAction(async () => {
    await revokeApiToken(await orgCtx(slug), id);
  }, "Token revoked.");
}
