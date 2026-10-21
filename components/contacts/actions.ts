"use server";

import { createContact, setContactArchived, updateContact, type ContactInput } from "@/lib/contacts/contacts";
import type { Address } from "@/lib/db/schema/ledger";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

function address(fd: FormData, prefix: string): Address | null {
  const a: Address = {};
  for (const k of ["line1", "line2", "city", "region", "postalCode", "country"] as const) {
    const v = str(fd, `${prefix}.${k}`);
    if (v) a[k] = v;
  }
  return Object.keys(a).length ? a : null;
}

function contactInput(fd: FormData): ContactInput {
  const persons: NonNullable<ContactInput["persons"]> = [];
  const count = Number(fd.get("personCount") ?? 0);
  for (let i = 0; i < Math.min(count, 50); i++) {
    const name = str(fd, `persons.${i}.name`);
    const email = str(fd, `persons.${i}.email`);
    const phone = str(fd, `persons.${i}.phone`);
    const role = str(fd, `persons.${i}.role`);
    if (!name && !email && !phone && !role) continue;
    persons.push({ name: name ?? "", email, phone, role, isPrimary: str(fd, "primaryPerson") === String(i) });
  }
  const billing = address(fd, "billing");
  return {
    displayName: str(fd, "displayName") ?? "",
    companyName: str(fd, "companyName"),
    isCustomer: bool(fd, "isCustomer"),
    isVendor: bool(fd, "isVendor"),
    isEmployee: bool(fd, "isEmployee"),
    isBeneficiary: bool(fd, "isBeneficiary"),
    email: str(fd, "email"),
    phone: str(fd, "phone"),
    website: str(fd, "website"),
    currency: str(fd, "currency"),
    paymentTermsId: str(fd, "paymentTermsId"),
    billingAddress: billing,
    shippingAddress: bool(fd, "shippingSame") ? billing : address(fd, "shipping"),
    taxExempt: bool(fd, "taxExempt"),
    taxExemptionReason: str(fd, "taxExemptionReason"),
    taxExemptionCertificate: str(fd, "taxExemptionCertificate"),
    is1099: bool(fd, "is1099"),
    defaultIncomeAccountId: str(fd, "defaultIncomeAccountId"),
    defaultExpenseAccountId: str(fd, "defaultExpenseAccountId"),
    notes: str(fd, "notes"),
    persons,
  };
}

/** `basePath` is where the contact lives (/sales/customers or /purchases/vendors). */
export async function createContactAction(slug: string, basePath: string, _: unknown, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    const c = await createContact(await orgCtx(slug), contactInput(fd));
    return { href: `/o/${slug}${basePath}/${c.id}` };
  });
}

export async function updateContactAction(slug: string, basePath: string, id: string, _: unknown, fd: FormData): Promise<ActionResult<{ href: string }>> {
  return runAction(async () => {
    await updateContact(await orgCtx(slug), id, contactInput(fd));
    return { href: `/o/${slug}${basePath}/${id}` };
  });
}

export async function archiveContactAction(slug: string, id: string, archived: boolean): Promise<ActionResult<unknown>> {
  return runAction(async () => {
    await setContactArchived(await orgCtx(slug), id, archived);
  }, archived ? "Archived. Its history stays; it is no longer offered on new documents." : "Restored.");
}
