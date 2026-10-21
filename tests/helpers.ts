/**
 * Shared test setup: a user, an organization with a chart of accounts, and
 * contexts for each role.
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { accounts, contacts, items } from "@/lib/db/schema/ledger";
import { memberships, type Role } from "@/lib/db/schema/core";
import { createUser } from "@/lib/auth/users";
import { createOrganization, type CreateOrgInput } from "@/lib/orgs/orgs";
import { loadOrg, userCtx, type Ctx } from "@/lib/context";
import { Decimal } from "@/lib/money/decimal";
import { createContact } from "@/lib/contacts/contacts";
import { createItem, type ItemInput } from "@/lib/items/items";

export async function newUser(name = "Test Person") {
  const email = `t-${randomBytes(5).toString("hex")}@example.test`;
  return createUser({ email, name, password: "correct horse battery staple" });
}

export interface TestOrg {
  ctx: Ctx;
  orgId: string;
  userId: string;
  email: string;
  /** Account id by code or system key. */
  acct: (codeOrKey: string) => Promise<string>;
  /** A context for another member with `role`. */
  as: (role: Role) => Promise<Ctx>;
}

export async function setupOrg(input: Partial<CreateOrgInput> = {}): Promise<TestOrg> {
  const user = await newUser();
  const org = await createOrganization(user.id, {
    name: input.name ?? "Test Co",
    baseCurrency: input.baseCurrency ?? "USD",
    template: input.template ?? "products",
    fiscalYearStartMonth: input.fiscalYearStartMonth ?? 1,
    ...input,
  });
  const ctx = userCtx(org, user.id, "owner", user.email);
  const cache = new Map<string, string>();
  const acct = async (codeOrKey: string) => {
    if (cache.has(codeOrKey)) return cache.get(codeOrKey)!;
    const [a] = await getDb()
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, org.id), sql`(${accounts.code} = ${codeOrKey} or ${accounts.systemKey} = ${codeOrKey})`));
    if (!a) throw new Error(`no account ${codeOrKey}`);
    cache.set(codeOrKey, a.id);
    return a.id;
  };
  const as = async (role: Role) => {
    const other = await newUser(`${role} person`);
    await getDb().insert(memberships).values({ orgId: org.id, userId: other.id, role });
    return userCtx(await loadOrg(getDb(), org.id), other.id, role, other.email);
  };
  return { ctx, orgId: org.id, userId: user.id, email: user.email, acct, as };
}

export async function refresh(ctx: Ctx): Promise<Ctx> {
  return { ...ctx, org: await loadOrg(getDb(), ctx.orgId) };
}

export async function customer(ctx: Ctx, name = "Acme Customer", extra: Record<string, unknown> = {}) {
  return createContact(ctx, { displayName: name, isCustomer: true, ...extra });
}

export async function vendor(ctx: Ctx, name = "Supply Vendor", extra: Record<string, unknown> = {}) {
  return createContact(ctx, { displayName: name, isVendor: true, ...extra });
}

export async function stockItem(ctx: Ctx, name = "Widget", extra: Partial<ItemInput> = {}) {
  return createItem(ctx, { kind: "stock", name, salePrice: "25", ...extra });
}

/** Balance of an account (signed, debit positive) as a canonical string at 2 places. */
export async function balance(orgId: string, accountId: string, asOf?: string): Promise<string> {
  const r = await getDb().execute<{ b: string }>(sql`
    select coalesce(sum(l.base_amount), 0)::text as b
    from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${orgId} and l.account_id = ${accountId} and e.status = 'posted'
    ${asOf ? sql`and e.entry_date <= ${asOf}` : sql``}
  `);
  return Decimal.from(r.rows[0]!.b).round(2, "half_up").toFixed(2);
}

export async function itemRow(orgId: string, id: string) {
  const [i] = await getDb().select().from(items).where(and(eq(items.orgId, orgId), eq(items.id, id)));
  return i!;
}

export async function contactRow(orgId: string, id: string) {
  const [c] = await getDb().select().from(contacts).where(and(eq(contacts.orgId, orgId), eq(contacts.id, id)));
  return c!;
}

/** Expect a promise to reject with an AppError of `code`. */
export async function rejectsWith(p: Promise<unknown>, code: string | RegExp) {
  try {
    await p;
  } catch (e) {
    const c = (e as { code?: string }).code ?? "";
    const m = (e as Error).message ?? "";
    if (typeof code === "string" ? c === code : code.test(m) || code.test(c)) return e;
    throw new Error(`expected rejection ${String(code)}, got ${c}: ${m}`);
  }
  throw new Error(`expected rejection ${String(code)}, but it resolved`);
}

/** Expect a database operation to be refused with a message matching `re` (looks through the driver wrapper). */
export async function rejectsDb(p: Promise<unknown>, re: RegExp) {
  try {
    await p;
  } catch (e) {
    let cur: unknown = e;
    const messages: string[] = [];
    for (let i = 0; i < 5 && cur; i++) {
      messages.push(String((cur as Error).message));
      cur = (cur as { cause?: unknown }).cause;
    }
    if (messages.some((m) => re.test(m))) return;
    throw new Error(`expected database refusal ${re}, got: ${messages.join(" | ")}`);
  }
  throw new Error(`expected database refusal ${re}, but it succeeded`);
}
