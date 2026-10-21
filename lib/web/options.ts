/** Option lists for selects, built on the server. */
import { and, asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts, contacts, dimensionValues, projects, taxCodes, items, inventoryLocations } from "@/lib/db/schema/ledger";
import { ACCOUNT_SUBTYPES, type AccountType } from "@/lib/db/schema/ledger";
import { SUBTYPE_LABELS, SUBTYPE_TYPE } from "@/lib/ledger/accounts";
import { CURRENCY_CODES, CURRENCIES } from "@/lib/money/currency";
import type { Option } from "@/components/client/forms";

const TYPE_LABELS: Record<AccountType, string> = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };

export function subtypeOptions(): Option[] {
  return ACCOUNT_SUBTYPES.map((s) => ({ value: s, label: SUBTYPE_LABELS[s], group: TYPE_LABELS[SUBTYPE_TYPE[s]] }));
}

export function currencyOptions(): Option[] {
  return CURRENCY_CODES.map((c) => ({ value: c, label: `${c} — ${CURRENCIES.get(c)!.name}` }));
}

export async function accountOptions(
  db: DbOrTx,
  orgId: string,
  filter: { types?: AccountType[]; subtypes?: string[]; excludeControl?: boolean; includeArchived?: boolean } = {},
): Promise<Option[]> {
  const rows = await db.select().from(accounts).where(eq(accounts.orgId, orgId)).orderBy(asc(accounts.code));
  return rows
    .filter((a) => (filter.includeArchived || !a.isArchived) && (!filter.types || filter.types.includes(a.type)) && (!filter.subtypes || filter.subtypes.includes(a.subtype)) && (!filter.excludeControl || !a.control))
    .map((a) => ({ value: a.id, label: `${a.code} · ${a.name}${a.currency ? ` (${a.currency})` : ""}`, group: TYPE_LABELS[a.type] }));
}

export async function moneyAccountOptions(db: DbOrTx, orgId: string): Promise<Option[]> {
  return accountOptions(db, orgId, { subtypes: ["bank", "cash", "clearing", "credit_card"] });
}

export async function contactOptions(db: DbOrTx, orgId: string, role?: "customer" | "vendor" | "employee" | "beneficiary"): Promise<Option[]> {
  const conds = [eq(contacts.orgId, orgId), eq(contacts.isArchived, false)];
  if (role === "customer") conds.push(eq(contacts.isCustomer, true));
  if (role === "vendor") conds.push(eq(contacts.isVendor, true));
  if (role === "employee") conds.push(eq(contacts.isEmployee, true));
  if (role === "beneficiary") conds.push(eq(contacts.isBeneficiary, true));
  const rows = await db.select({ id: contacts.id, name: contacts.displayName, currency: contacts.currency }).from(contacts).where(and(...conds)).orderBy(asc(contacts.displayName));
  return rows.map((r) => ({ value: r.id, label: r.currency ? `${r.name} (${r.currency})` : r.name }));
}

export async function dimensionOptions(db: DbOrTx, orgId: string) {
  const rows = await db.select().from(dimensionValues).where(and(eq(dimensionValues.orgId, orgId), eq(dimensionValues.isArchived, false))).orderBy(asc(dimensionValues.name));
  const projRows = await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), eq(projects.status, "active"))).orderBy(asc(projects.name));
  const by = (k: string) => rows.filter((r) => r.kind === k).map((r) => ({ value: r.id, label: r.name }));
  return { classes: by("class"), departments: by("department"), locations: by("location"), funds: by("fund"), projects: projRows.map((p) => ({ value: p.id, label: p.name })) };
}

export async function taxCodeOptions(db: DbOrTx, orgId: string): Promise<Option[]> {
  const rows = await db.select().from(taxCodes).where(and(eq(taxCodes.orgId, orgId), eq(taxCodes.isArchived, false))).orderBy(asc(taxCodes.name));
  return rows.map((r) => ({ value: r.id, label: r.name }));
}

export async function itemOptions(db: DbOrTx, orgId: string) {
  return db.select().from(items).where(and(eq(items.orgId, orgId), eq(items.isArchived, false))).orderBy(asc(items.name));
}

export async function locationOptions(db: DbOrTx, orgId: string): Promise<Option[]> {
  const rows = await db.select().from(inventoryLocations).where(and(eq(inventoryLocations.orgId, orgId), eq(inventoryLocations.isArchived, false))).orderBy(asc(inventoryLocations.name));
  return rows.map((r) => ({ value: r.id, label: r.isDefault ? `${r.name} (default)` : r.name }));
}
