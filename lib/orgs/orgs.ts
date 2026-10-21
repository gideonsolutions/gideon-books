/**
 * Organizations: creating one (with its chart of accounts, terms and
 * defaults), its settings, membership and the organization switcher.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { memberships, organizations, users, type OrgProfile, type Role } from "@/lib/db/schema/core";
import { inventoryLocations, paymentTerms, journalLines } from "@/lib/db/schema/ledger";
import { audit, auditInstance } from "@/lib/audit";
import { loadOrg, requirePermission, userCtx, type Ctx, type Org } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { isCurrency } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import { applyTemplate } from "@/lib/ledger/accounts";
import { COA_TEMPLATES } from "@/lib/ledger/coa-templates";
import { ensureFiscalYear } from "@/lib/ledger/periods";
import { DEFAULT_PAYMENT_TERMS } from "@/lib/contacts/contacts";

export interface CreateOrgInput {
  name: string;
  slug?: string | null;
  legalName?: string | null;
  baseCurrency: string;
  country?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  entityType?: Org["entityType"];
  template?: string;
  booksStartDate?: string | null;
  reportingBasis?: "accrual" | "cash";
  isDemo?: boolean;
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s.length >= 2 ? s : `org-${s || "books"}`;
}

async function uniqueSlug(tx: Tx, wanted: string): Promise<string> {
  let slug = wanted;
  for (let i = 2; i < 200; i++) {
    const [taken] = await tx.select({ id: organizations.id }).from(organizations).where(eq(organizations.slug, slug));
    if (!taken) return slug;
    slug = `${wanted.slice(0, 44)}-${i}`;
  }
  return `${wanted.slice(0, 40)}-${Date.now().toString(36)}`;
}

/** Create an organization owned by `userId`. */
export async function createOrganization(userId: string, input: CreateOrgInput, opts: { ip?: string | null; tx?: Tx } = {}): Promise<Org> {
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the organization.";
  if (!isCurrency(input.baseCurrency)) fields.baseCurrency = "Pick the currency the books are kept in.";
  const fy = input.fiscalYearStartMonth ?? 1;
  if (!Number.isInteger(fy) || fy < 1 || fy > 12) fields.fiscalYearStartMonth = "Pick a month.";
  if (input.slug && !/^[a-z0-9][a-z0-9-]{1,62}$/.test(input.slug)) fields.slug = "Use lowercase letters, digits and dashes.";
  if (input.booksStartDate && !isIsoDate(input.booksStartDate)) fields.booksStartDate = "Enter a date.";
  const template = input.template ?? "services";
  if (!COA_TEMPLATES.some((t) => t.key === template)) fields.template = "Pick a starting chart of accounts.";
  if (input.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
    } catch {
      fields.timezone = "Unknown time zone.";
    }
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the organization details.", fields);

  const run = async (tx: Tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId));
    if (!user) throw new NotFoundError("The user");
    const slug = await uniqueSlug(tx, input.slug || slugify(input.name));
    const [org] = await tx
      .insert(organizations)
      .values({
        slug,
        name: input.name.trim(),
        legalName: input.legalName?.trim() || null,
        baseCurrency: input.baseCurrency,
        country: input.country ?? "US",
        timezone: input.timezone ?? "America/New_York",
        fiscalYearStartMonth: fy,
        entityType: input.entityType ?? (template === "nonprofit" ? "nonprofit" : template === "trust" ? "trust" : "llc"),
        reportingBasis: input.reportingBasis ?? "accrual",
        booksStartDate: input.booksStartDate ?? null,
        isDemo: input.isDemo ?? false,
      })
      .returning();
    await tx.insert(memberships).values({ orgId: org!.id, userId, role: "owner" });
    await applyTemplate(tx, org!.id, template);
    await tx.insert(paymentTerms).values(DEFAULT_PAYMENT_TERMS.map((t) => ({ orgId: org!.id, ...t })));
    await tx.insert(inventoryLocations).values({ orgId: org!.id, code: "MAIN", name: "Main", isDefault: true });
    if (input.booksStartDate) await ensureFiscalYear(tx, org!, input.booksStartDate);
    const ctx = userCtx(org!, userId, "owner", user.email, "ui", opts.ip);
    await audit(tx, ctx, { action: "organization.created", entityType: "organization", entityId: org!.id, after: { name: org!.name, baseCurrency: org!.baseCurrency, template, isDemo: org!.isDemo } });
    return org!;
  };
  return opts.tx ? run(opts.tx) : withTransaction(run);
}

export interface OrgSettingsInput {
  name: string;
  legalName?: string | null;
  timezone: string;
  fiscalYearStartMonth: number;
  reportingBasis: "accrual" | "cash";
  taxRounding: "line" | "document";
  entityType: Org["entityType"];
  baseCurrency?: string;
  booksStartDate?: string | null;
  bankRulesAutoPost?: boolean;
  profile?: OrgProfile;
}

export async function updateOrgSettings(ctx: Ctx, input: OrgSettingsInput): Promise<Org> {
  requirePermission(ctx, "org.settings");
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the organization.";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input.timezone });
  } catch {
    fields.timezone = "Unknown time zone.";
  }
  if (!Number.isInteger(input.fiscalYearStartMonth) || input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12) fields.fiscalYearStartMonth = "Pick a month.";
  if (input.baseCurrency && !isCurrency(input.baseCurrency)) fields.baseCurrency = "Unknown currency.";
  if (input.booksStartDate && !isIsoDate(input.booksStartDate)) fields.booksStartDate = "Enter a date.";
  if (Object.keys(fields).length) throw new ValidationError("Check the settings.", fields);
  return withTransaction(async (tx) => {
    const before = await loadOrg(tx, ctx.orgId);
    const [posted] = await tx.select({ n: sql<number>`count(*)::int` }).from(journalLines).where(eq(journalLines.orgId, ctx.orgId));
    const hasPostings = (posted?.n ?? 0) > 0;
    if (hasPostings && input.baseCurrency && input.baseCurrency !== before.baseCurrency) {
      throw new ConflictError("The base currency cannot change once anything is posted.", "base_currency_fixed");
    }
    if (hasPostings && input.fiscalYearStartMonth !== before.fiscalYearStartMonth) {
      const [fys] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from fiscal_years where org_id = ${ctx.orgId}`).then((r) => r.rows);
      if ((fys?.n ?? 0) > 0) throw new ConflictError("The fiscal year cannot move once periods exist with postings in them.", "fiscal_year_fixed");
    }
    if (input.bankRulesAutoPost && !before.bankRulesAutoPost) requirePermission(ctx, "banking.rules.autopost");
    const [row] = await tx
      .update(organizations)
      .set({
        name: input.name.trim(),
        legalName: input.legalName?.trim() || null,
        timezone: input.timezone,
        fiscalYearStartMonth: input.fiscalYearStartMonth,
        reportingBasis: input.reportingBasis,
        taxRounding: input.taxRounding,
        entityType: input.entityType,
        ...(input.baseCurrency ? { baseCurrency: input.baseCurrency } : {}),
        booksStartDate: input.booksStartDate ?? before.booksStartDate,
        bankRulesAutoPost: input.bankRulesAutoPost ?? before.bankRulesAutoPost,
        profile: input.profile ?? before.profile,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, ctx.orgId))
      .returning();
    await audit(tx, ctx, { action: "organization.settings_updated", entityType: "organization", entityId: ctx.orgId, before, after: row });
    return row!;
  });
}

export async function completeOnboarding(ctx: Ctx): Promise<void> {
  requirePermission(ctx, "org.settings");
  await withTransaction(async (tx) => {
    await tx.update(organizations).set({ onboardingCompletedAt: new Date() }).where(eq(organizations.id, ctx.orgId));
    await audit(tx, ctx, { action: "organization.onboarding_completed", entityType: "organization", entityId: ctx.orgId });
  });
}

/** The organizations a person belongs to, with their role. */
export async function orgsForUser(db: DbOrTx, userId: string) {
  return db
    .select({ org: organizations, role: memberships.role })
    .from(memberships)
    .innerJoin(organizations, eq(organizations.id, memberships.orgId))
    .where(and(eq(memberships.userId, userId), sql`${organizations.archivedAt} is null`))
    .orderBy(asc(organizations.isDemo), asc(organizations.name));
}

export async function membershipFor(db: DbOrTx, orgId: string, userId: string): Promise<Role | null> {
  const [m] = await db.select({ role: memberships.role }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return m?.role ?? null;
}

export async function orgBySlug(db: DbOrTx, slug: string): Promise<Org | null> {
  const [o] = await db.select().from(organizations).where(eq(organizations.slug, slug));
  return o ?? null;
}

/** Log of instance-level creation for orgs created from scripts. */
export async function noteOrgCreatedFromCli(orgId: string, label: string) {
  await auditInstance(getDb(), { action: "organization.created_cli", actorLabel: label, entityType: "organization", entityId: orgId, source: "cli" });
}
