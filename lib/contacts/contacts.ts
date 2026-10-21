/**
 * Customers, vendors, employees and beneficiaries — one contact can be
 * several — with their people, terms, currency and tax exemption.
 */
import { and, asc, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { contactPersons, contacts, paymentTerms, type Address } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { isCurrency } from "@/lib/money/currency";
import { Decimal } from "@/lib/money/decimal";

export type Contact = typeof contacts.$inferSelect;
export type ContactPerson = typeof contactPersons.$inferSelect;
export type PaymentTerm = typeof paymentTerms.$inferSelect;

export interface ContactInput {
  displayName: string;
  companyName?: string | null;
  isCustomer?: boolean;
  isVendor?: boolean;
  isEmployee?: boolean;
  isBeneficiary?: boolean;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  currency?: string | null;
  paymentTermsId?: string | null;
  billingAddress?: Address | null;
  shippingAddress?: Address | null;
  taxExempt?: boolean;
  taxExemptionReason?: string | null;
  taxExemptionCertificate?: string | null;
  is1099?: boolean;
  defaultIncomeAccountId?: string | null;
  defaultExpenseAccountId?: string | null;
  notes?: string | null;
  persons?: { name: string; email?: string | null; phone?: string | null; role?: string | null; isPrimary?: boolean }[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(input: ContactInput, baseCurrency: string) {
  const fields: Record<string, string> = {};
  if (!input.displayName?.trim()) fields.displayName = "Enter a name.";
  if (input.displayName && input.displayName.length > 200) fields.displayName = "Keep it under 200 characters.";
  if (input.email && !EMAIL_RE.test(input.email.trim())) fields.email = "That is not an email address.";
  if (input.currency && !isCurrency(input.currency)) fields.currency = "Unknown currency.";
  if (!input.isCustomer && !input.isVendor && !input.isEmployee && !input.isBeneficiary) fields.roles = "Mark it as a customer, vendor, employee or beneficiary.";
  if (input.taxExempt && !input.taxExemptionReason?.trim()) fields.taxExemptionReason = "Record why the customer is exempt.";
  for (const [i, p] of (input.persons ?? []).entries()) {
    if (!p.name?.trim()) fields[`persons.${i}.name`] = "Enter a name.";
    if (p.email && !EMAIL_RE.test(p.email.trim())) fields[`persons.${i}.email`] = "That is not an email address.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the contact details.", fields);
  void baseCurrency;
}

function values(ctx: Ctx, input: ContactInput) {
  return {
    displayName: input.displayName.trim(),
    companyName: input.companyName?.trim() || null,
    isCustomer: input.isCustomer ?? false,
    isVendor: input.isVendor ?? false,
    isEmployee: input.isEmployee ?? false,
    isBeneficiary: input.isBeneficiary ?? false,
    email: input.email?.trim() || null,
    phone: input.phone?.trim() || null,
    website: input.website?.trim() || null,
    currency: input.currency && input.currency !== ctx.org.baseCurrency ? input.currency : null,
    paymentTermsId: input.paymentTermsId || null,
    billingAddress: input.billingAddress ?? null,
    shippingAddress: input.shippingAddress ?? null,
    taxExempt: input.taxExempt ?? false,
    taxExemptionReason: input.taxExempt ? input.taxExemptionReason?.trim() || null : null,
    taxExemptionCertificate: input.taxExempt ? input.taxExemptionCertificate?.trim() || null : null,
    is1099: input.is1099 ?? false,
    defaultIncomeAccountId: input.defaultIncomeAccountId || null,
    defaultExpenseAccountId: input.defaultExpenseAccountId || null,
    notes: input.notes?.trim() || null,
  };
}

export async function createContact(ctx: Ctx, input: ContactInput): Promise<Contact> {
  requirePermission(ctx, "contacts.manage");
  validate(input, ctx.org.baseCurrency);
  return withTransaction(async (tx) => {
    const [row] = await tx.insert(contacts).values({ orgId: ctx.orgId, ...values(ctx, input) }).returning();
    if (input.persons?.length) {
      await tx.insert(contactPersons).values(
        input.persons.map((p) => ({ orgId: ctx.orgId, contactId: row!.id, name: p.name.trim(), email: p.email?.trim() || null, phone: p.phone?.trim() || null, role: p.role?.trim() || null, isPrimary: p.isPrimary ?? false })),
      );
    }
    await audit(tx, ctx, { action: "contact.created", entityType: "contact", entityId: row!.id, after: row });
    return row!;
  });
}

export async function updateContact(ctx: Ctx, id: string, input: ContactInput): Promise<Contact> {
  requirePermission(ctx, "contacts.manage");
  validate(input, ctx.org.baseCurrency);
  return withTransaction(async (tx) => {
    const before = await getContact(tx, ctx.orgId, id);
    const newCurrency = input.currency && input.currency !== ctx.org.baseCurrency ? input.currency : null;
    if (newCurrency !== before.currency) {
      const [used] = await tx.execute<{ n: number }>(
        sql`select count(*)::int as n from documents where org_id = ${ctx.orgId} and contact_id = ${id} and status <> 'draft'`,
      ).then((r) => r.rows);
      if ((used?.n ?? 0) > 0) {
        throw new ValidationError("This contact has issued documents in its currency, so the currency cannot change.", { currency: "Documents exist." });
      }
    }
    const [row] = await tx
      .update(contacts)
      .set({ ...values(ctx, input), updatedAt: new Date() })
      .where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, id)))
      .returning();
    if (input.persons) {
      await tx.delete(contactPersons).where(and(eq(contactPersons.orgId, ctx.orgId), eq(contactPersons.contactId, id)));
      if (input.persons.length) {
        await tx.insert(contactPersons).values(
          input.persons.map((p) => ({ orgId: ctx.orgId, contactId: id, name: p.name.trim(), email: p.email?.trim() || null, phone: p.phone?.trim() || null, role: p.role?.trim() || null, isPrimary: p.isPrimary ?? false })),
        );
      }
    }
    await audit(tx, ctx, { action: "contact.updated", entityType: "contact", entityId: id, before, after: row });
    return row!;
  });
}

export async function setContactArchived(ctx: Ctx, id: string, archived: boolean): Promise<void> {
  requirePermission(ctx, "contacts.manage");
  await withTransaction(async (tx) => {
    await getContact(tx, ctx.orgId, id);
    await tx.update(contacts).set({ isArchived: archived, updatedAt: new Date() }).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, id)));
    await audit(tx, ctx, { action: archived ? "contact.archived" : "contact.restored", entityType: "contact", entityId: id });
  });
}

export async function getContact(db: DbOrTx, orgId: string, id: string): Promise<Contact> {
  const [c] = await db.select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, id))).limit(1);
  if (!c) throw new NotFoundError("The contact");
  return c;
}

export async function getContactPersons(db: DbOrTx, orgId: string, contactId: string): Promise<ContactPerson[]> {
  return db
    .select()
    .from(contactPersons)
    .where(and(eq(contactPersons.orgId, orgId), eq(contactPersons.contactId, contactId)))
    .orderBy(desc(contactPersons.isPrimary), asc(contactPersons.name));
}

export interface ContactFilters {
  role?: "customer" | "vendor" | "employee" | "beneficiary";
  q?: string;
  includeArchived?: boolean;
  page?: number;
  pageSize?: number;
  sort?: "name_asc" | "name_desc" | "created_desc";
}

export async function listContacts(db: DbOrTx, orgId: string, f: ContactFilters = {}) {
  const conds: SQL[] = [eq(contacts.orgId, orgId)];
  if (!f.includeArchived) conds.push(eq(contacts.isArchived, false));
  if (f.role === "customer") conds.push(eq(contacts.isCustomer, true));
  if (f.role === "vendor") conds.push(eq(contacts.isVendor, true));
  if (f.role === "employee") conds.push(eq(contacts.isEmployee, true));
  if (f.role === "beneficiary") conds.push(eq(contacts.isBeneficiary, true));
  if (f.q) {
    const like = `%${f.q.replace(/[%_]/g, "\\$&")}%`;
    conds.push(or(ilike(contacts.displayName, like), ilike(contacts.companyName, like), ilike(contacts.email, like))!);
  }
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const order = f.sort === "name_desc" ? desc(contacts.displayName) : f.sort === "created_desc" ? desc(contacts.createdAt) : asc(contacts.displayName);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db.select().from(contacts).where(where).orderBy(order).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

// ── Payment terms ───────────────────────────────────────────────────────────

export async function listPaymentTerms(db: DbOrTx, orgId: string): Promise<PaymentTerm[]> {
  return db.select().from(paymentTerms).where(and(eq(paymentTerms.orgId, orgId), eq(paymentTerms.isArchived, false))).orderBy(asc(paymentTerms.daysDue));
}

export async function savePaymentTerm(ctx: Ctx, input: { id?: string; name: string; daysDue: number; discountPercent?: string | null; discountDays?: number | null }) {
  requirePermission(ctx, "org.settings");
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Enter a name.";
  if (!Number.isInteger(input.daysDue) || input.daysDue < 0 || input.daysDue > 3650) fields.daysDue = "Days due must be 0–3650.";
  let discountRate: string | null = null;
  if (input.discountPercent) {
    const d = Decimal.tryFrom(input.discountPercent);
    if (!d || d.isNegative() || d.gte(100)) fields.discountPercent = "Enter a percent under 100.";
    else discountRate = d.div(100, 8, "half_up").toString();
    if (!input.discountDays || input.discountDays < 0) fields.discountDays = "Enter the discount days.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the terms.", fields);
  return withTransaction(async (tx) => {
    const vals = { name: input.name.trim(), daysDue: input.daysDue, discountRate, discountDays: discountRate ? (input.discountDays ?? null) : null };
    const [row] = input.id
      ? await tx.update(paymentTerms).set(vals).where(and(eq(paymentTerms.orgId, ctx.orgId), eq(paymentTerms.id, input.id))).returning()
      : await tx.insert(paymentTerms).values({ orgId: ctx.orgId, ...vals }).returning();
    if (!row) throw new NotFoundError("The payment terms");
    await audit(tx, ctx, { action: input.id ? "terms.updated" : "terms.created", entityType: "payment_terms", entityId: row.id, after: row });
    return row;
  });
}

export const DEFAULT_PAYMENT_TERMS = [
  { name: "Due on receipt", daysDue: 0 },
  { name: "Net 15", daysDue: 15 },
  { name: "Net 30", daysDue: 30 },
  { name: "Net 60", daysDue: 60 },
];
