/**
 * The chart of accounts: creating, editing and archiving accounts, the
 * accounts the application posts to by role (system accounts), and
 * templates.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { accounts, journalLines, bankAccountDetails, ACCOUNT_SUBTYPES, type AccountSubtype, type AccountType } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { isCurrency } from "@/lib/money/currency";
import { Decimal } from "@/lib/money/decimal";
import {
  COA_TEMPLATES,
  SYSTEM_ACCOUNT_DEFAULTS,
  defaultCashFlowSection,
  type AccountSpec,
  type CashFlowSection,
  type ControlKind,
  type SystemKey,
} from "./coa-templates";

export type Account = typeof accounts.$inferSelect;

export const SUBTYPE_TYPE: Record<AccountSubtype, AccountType> = {
  bank: "asset",
  cash: "asset",
  clearing: "asset",
  accounts_receivable: "asset",
  inventory: "asset",
  other_current_asset: "asset",
  prepaid_expense: "asset",
  fixed_asset: "asset",
  accumulated_depreciation: "asset",
  other_asset: "asset",
  credit_card: "liability",
  accounts_payable: "liability",
  sales_tax_payable: "liability",
  payroll_liability: "liability",
  customer_deposits: "liability",
  other_current_liability: "liability",
  long_term_liability: "liability",
  owner_equity: "equity",
  owner_contributions: "equity",
  owner_draws: "equity",
  retained_earnings: "equity",
  opening_balance_equity: "equity",
  net_assets_unrestricted: "equity",
  net_assets_restricted: "equity",
  trust_principal: "equity",
  trust_income: "equity",
  operating_income: "income",
  other_income: "income",
  cost_of_goods_sold: "expense",
  operating_expense: "expense",
  payroll_expense: "expense",
  depreciation_expense: "expense",
  other_expense: "expense",
};

export const SUBTYPE_LABELS: Record<AccountSubtype, string> = {
  bank: "Bank",
  cash: "Cash on hand",
  clearing: "Clearing",
  accounts_receivable: "Accounts receivable",
  inventory: "Inventory",
  other_current_asset: "Other current asset",
  prepaid_expense: "Prepaid expense",
  fixed_asset: "Fixed asset",
  accumulated_depreciation: "Accumulated depreciation",
  other_asset: "Other asset",
  credit_card: "Credit card",
  accounts_payable: "Accounts payable",
  sales_tax_payable: "Sales tax payable",
  payroll_liability: "Payroll liability",
  customer_deposits: "Customer deposits",
  other_current_liability: "Other current liability",
  long_term_liability: "Long-term liability",
  owner_equity: "Owner's equity",
  owner_contributions: "Owner contributions",
  owner_draws: "Owner draws",
  retained_earnings: "Retained earnings",
  opening_balance_equity: "Opening balance equity",
  net_assets_unrestricted: "Net assets without donor restrictions",
  net_assets_restricted: "Net assets with donor restrictions",
  trust_principal: "Trust principal",
  trust_income: "Trust income",
  operating_income: "Income",
  other_income: "Other income",
  cost_of_goods_sold: "Cost of goods sold",
  operating_expense: "Expense",
  payroll_expense: "Payroll expense",
  depreciation_expense: "Depreciation expense",
  other_expense: "Other expense",
};

/** Subtypes that are money accounts (bank feeds, reconciliation, payments). */
export const MONEY_SUBTYPES: readonly AccountSubtype[] = ["bank", "cash", "clearing", "credit_card"];

export function isMoneyAccount(a: Pick<Account, "subtype">): boolean {
  return MONEY_SUBTYPES.includes(a.subtype);
}

const CONTROL_FOR_SUBTYPE: Partial<Record<AccountSubtype, ControlKind>> = {
  accounts_receivable: "receivables",
  accounts_payable: "payables",
  inventory: "inventory",
  customer_deposits: "customer_deposits",
};

export async function listAccounts(db: DbOrTx, orgId: string, opts: { includeArchived?: boolean } = {}): Promise<Account[]> {
  const conds = [eq(accounts.orgId, orgId)];
  if (!opts.includeArchived) conds.push(eq(accounts.isArchived, false));
  return db.select().from(accounts).where(and(...conds)).orderBy(asc(accounts.code));
}

export async function getAccount(db: DbOrTx, orgId: string, id: string): Promise<Account> {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.id, id))).limit(1);
  if (!a) throw new NotFoundError("The account");
  return a;
}

export async function getAccountsByIds(db: DbOrTx, orgId: string, ids: string[]): Promise<Map<string, Account>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(accounts).where(and(eq(accounts.orgId, orgId), inArray(accounts.id, unique)));
  return new Map(rows.map((r) => [r.id, r]));
}

async function insertSpec(tx: Tx, orgId: string, spec: AccountSpec, parentId: string | null = null): Promise<Account> {
  // A template's code may already be taken by an account the person made; take the next free one.
  let code = spec.code;
  for (let i = 0; i < 50; i++) {
    const [clash] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.code, code))).limit(1);
    if (!clash) break;
    code = String(Number(code) + 1).padStart(spec.code.length, "0");
  }
  const [row] = await tx
    .insert(accounts)
    .values({
      orgId,
      code,
      name: spec.name,
      type: spec.type,
      subtype: spec.subtype,
      systemKey: spec.systemKey ?? null,
      control: spec.control ?? CONTROL_FOR_SUBTYPE[spec.subtype] ?? null,
      cashFlowSection: defaultCashFlowSection(spec.type, spec.subtype),
      description: spec.description ?? null,
      parentId,
    })
    .returning();
  return row!;
}

/**
 * The account that plays a role (accounts receivable, rounding, …),
 * created from the default if the chart has none. Safe under concurrency:
 * a second creator finds the first one's row.
 */
export async function systemAccount(tx: Tx, orgId: string, key: SystemKey): Promise<Account> {
  const [existing] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.systemKey, key)))
    .limit(1);
  if (existing) return existing;
  const spec = { ...SYSTEM_ACCOUNT_DEFAULTS[key], systemKey: key };
  try {
    return await tx.transaction(async (sp) => insertSpec(sp as unknown as Tx, orgId, spec));
  } catch {
    const [row] = await tx.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.systemKey, key))).limit(1);
    if (!row) throw new Error(`could not create system account ${key}`);
    return row;
  }
}

export async function systemAccountId(tx: Tx, orgId: string, key: SystemKey): Promise<string> {
  return (await systemAccount(tx, orgId, key)).id;
}

/** Create the accounts of a template (skipping system roles that already exist). */
export async function applyTemplate(tx: Tx, orgId: string, templateKey: string): Promise<number> {
  const template = COA_TEMPLATES.find((t) => t.key === templateKey);
  if (!template) throw new ValidationError(`Unknown chart of accounts template “${templateKey}”.`);
  let created = 0;
  for (const spec of template.accounts) {
    if (spec.systemKey) {
      const [has] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.orgId, orgId), eq(accounts.systemKey, spec.systemKey)))
        .limit(1);
      if (has) continue;
    } else {
      const [has] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.orgId, orgId), eq(accounts.name, spec.name)))
        .limit(1);
      if (has) continue;
    }
    const row = await insertSpec(tx, orgId, spec);
    if (["bank", "cash", "credit_card", "clearing"].includes(spec.subtype)) {
      await tx.insert(bankAccountDetails).values({
        orgId,
        accountId: row.id,
        accountKind:
          spec.subtype === "credit_card"
            ? "credit_card"
            : spec.subtype === "cash"
              ? "cash"
              : spec.subtype === "clearing"
                ? spec.systemKey === "payment_clearing"
                  ? "payment_processor"
                  : "clearing"
                : spec.name.toLowerCase().includes("saving")
                  ? "savings"
                  : "checking",
      });
    }
    created++;
  }
  return created;
}

export interface AccountInput {
  code: string;
  name: string;
  subtype: AccountSubtype;
  parentId?: string | null;
  description?: string | null;
  currency?: string | null;
  cashFlowSection?: CashFlowSection | null;
  intercompanyOrgId?: string | null;
  bank?: { institution?: string | null; mask?: string | null; accountKind?: (typeof bankAccountDetails.$inferInsert)["accountKind"] } | null;
}

function validateAccountInput(input: AccountInput, baseCurrency: string): void {
  const fields: Record<string, string> = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-]{0,19}$/.test(input.code.trim())) fields.code = "Use 1–20 letters, digits, dots or dashes.";
  if (!input.name.trim()) fields.name = "Give the account a name.";
  if (input.name.length > 120) fields.name = "Keep the name under 120 characters.";
  if (!ACCOUNT_SUBTYPES.includes(input.subtype)) fields.subtype = "Choose an account type.";
  if (input.currency && !isCurrency(input.currency)) fields.currency = "Unknown currency.";
  if (input.currency && input.currency !== baseCurrency && !["bank", "cash", "credit_card", "clearing"].includes(input.subtype)) {
    fields.currency = "Only bank, cash, clearing and credit-card accounts can be held in a foreign currency.";
  }
  if (input.bank?.mask && !/^\d{2,4}$/.test(input.bank.mask)) fields.mask = "Enter only the last 2–4 digits.";
  if (Object.keys(fields).length) throw new ValidationError("Check the account details.", fields);
}

async function checkParent(tx: Tx, orgId: string, parentId: string | null | undefined, type: AccountType, selfId?: string) {
  if (!parentId) return;
  const parent = await getAccount(tx, orgId, parentId);
  if (parent.type !== type) throw new ValidationError("A subaccount must be the same kind as its parent.", { parentId: "Pick a parent of the same type." });
  // Refuse cycles.
  let cursor: string | null = parent.id;
  for (let i = 0; cursor && i < 20; i++) {
    if (cursor === selfId) throw new ValidationError("An account cannot be its own ancestor.", { parentId: "That would make a loop." });
    const [row]: { parentId: string | null }[] = await tx
      .select({ parentId: accounts.parentId })
      .from(accounts)
      .where(and(eq(accounts.orgId, orgId), eq(accounts.id, cursor)));
    cursor = row?.parentId ?? null;
  }
}

export async function createAccount(ctx: Ctx, input: AccountInput): Promise<Account> {
  requirePermission(ctx, "accounts.manage");
  validateAccountInput(input, ctx.org.baseCurrency);
  const type = SUBTYPE_TYPE[input.subtype];
  return withTransaction(async (tx) => {
    await checkParent(tx, ctx.orgId, input.parentId, type);
    const [clash] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.code, input.code.trim())));
    if (clash) throw new ValidationError("That account code is taken.", { code: "Another account uses this code." });
    const [row] = await tx
      .insert(accounts)
      .values({
        orgId: ctx.orgId,
        code: input.code.trim(),
        name: input.name.trim(),
        type,
        subtype: input.subtype,
        parentId: input.parentId ?? null,
        description: input.description?.trim() || null,
        currency: input.currency && input.currency !== ctx.org.baseCurrency ? input.currency : null,
        control: CONTROL_FOR_SUBTYPE[input.subtype] ?? null,
        cashFlowSection: input.cashFlowSection ?? defaultCashFlowSection(type, input.subtype),
        intercompanyOrgId: input.intercompanyOrgId ?? null,
      })
      .returning();
    if (MONEY_SUBTYPES.includes(input.subtype)) {
      await tx.insert(bankAccountDetails).values({
        orgId: ctx.orgId,
        accountId: row!.id,
        institution: input.bank?.institution ?? null,
        mask: input.bank?.mask ?? null,
        accountKind:
          input.bank?.accountKind ??
          (input.subtype === "credit_card" ? "credit_card" : input.subtype === "cash" ? "cash" : input.subtype === "clearing" ? "clearing" : "checking"),
      });
    }
    await audit(tx, ctx, { action: "account.created", entityType: "account", entityId: row!.id, after: row });
    return row!;
  });
}

async function hasPostings(db: DbOrTx, orgId: string, accountId: string): Promise<boolean> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalLines)
    .where(and(eq(journalLines.orgId, orgId), eq(journalLines.accountId, accountId)));
  return (r?.n ?? 0) > 0;
}

export async function updateAccount(ctx: Ctx, id: string, input: AccountInput): Promise<Account> {
  requirePermission(ctx, "accounts.manage");
  validateAccountInput(input, ctx.org.baseCurrency);
  return withTransaction(async (tx) => {
    const before = await getAccount(tx, ctx.orgId, id);
    const type = SUBTYPE_TYPE[input.subtype];
    const used = await hasPostings(tx, ctx.orgId, id);
    if (used && type !== before.type) {
      throw new ValidationError("This account has postings, so its type (asset, liability, …) cannot change. Create a new account and move the balance with a journal entry.", {
        subtype: "Postings exist; the type is fixed.",
      });
    }
    const newCurrency = input.currency && input.currency !== ctx.org.baseCurrency ? input.currency : null;
    if (used && newCurrency !== before.currency) {
      throw new ValidationError("This account has postings, so its currency cannot change.", { currency: "Postings exist; the currency is fixed." });
    }
    if (before.systemKey && CONTROL_FOR_SUBTYPE[before.subtype] && input.subtype !== before.subtype) {
      throw new ValidationError("The application posts to this account by its role; its type cannot change.", { subtype: "System account." });
    }
    await checkParent(tx, ctx.orgId, input.parentId, type, id);
    const [clash] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.code, input.code.trim())));
    if (clash && clash.id !== id) throw new ValidationError("That account code is taken.", { code: "Another account uses this code." });
    const [row] = await tx
      .update(accounts)
      .set({
        code: input.code.trim(),
        name: input.name.trim(),
        type,
        subtype: input.subtype,
        parentId: input.parentId ?? null,
        description: input.description?.trim() || null,
        currency: newCurrency,
        control: before.control ?? CONTROL_FOR_SUBTYPE[input.subtype] ?? null,
        cashFlowSection: input.cashFlowSection ?? before.cashFlowSection ?? defaultCashFlowSection(type, input.subtype),
        intercompanyOrgId: input.intercompanyOrgId ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, id)))
      .returning();
    if (MONEY_SUBTYPES.includes(input.subtype) && input.bank) {
      await tx
        .insert(bankAccountDetails)
        .values({
          orgId: ctx.orgId,
          accountId: id,
          institution: input.bank.institution ?? null,
          mask: input.bank.mask ?? null,
          accountKind: input.bank.accountKind ?? "checking",
        })
        .onConflictDoUpdate({
          target: bankAccountDetails.accountId,
          set: { institution: input.bank.institution ?? null, mask: input.bank.mask ?? null, ...(input.bank.accountKind ? { accountKind: input.bank.accountKind } : {}) },
        });
    }
    await audit(tx, ctx, { action: "account.updated", entityType: "account", entityId: id, before, after: row });
    return row!;
  });
}

/**
 * Archive: the account keeps its history and still appears in reports for
 * periods it has balances in, but nothing new can be posted to it.
 */
export async function setAccountArchived(ctx: Ctx, id: string, archived: boolean): Promise<Account> {
  requirePermission(ctx, "accounts.manage");
  return withTransaction(async (tx) => {
    const before = await getAccount(tx, ctx.orgId, id);
    if (archived && before.systemKey) {
      throw new ConflictError("The application posts to this account by its role, so it cannot be archived.", "system_account");
    }
    if (archived) {
      const [bal] = await tx
        .select({ total: sql<string>`coalesce(sum(${journalLines.baseAmount}), 0)::text` })
        .from(journalLines)
        .where(and(eq(journalLines.orgId, ctx.orgId), eq(journalLines.accountId, id)));
      if (bal && !Decimal.from(bal.total).isZero()) {
        throw new ConflictError("Move this account's balance to another account before archiving it.", "account_has_balance", { balance: bal.total });
      }
      const [child] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.parentId, id), eq(accounts.isArchived, false)))
        .limit(1);
      if (child) throw new ConflictError("Archive or move its subaccounts first.", "account_has_children");
    }
    const [row] = await tx
      .update(accounts)
      .set({ isArchived: archived, updatedAt: new Date() })
      .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, id)))
      .returning();
    await audit(tx, ctx, { action: archived ? "account.archived" : "account.restored", entityType: "account", entityId: id });
    return row!;
  });
}

export async function getSystemAccountReadOnly(db: DbOrTx, orgId: string, key: SystemKey): Promise<Account | null> {
  const [a] = await (db ?? getDb())
    .select()
    .from(accounts)
    .where(and(eq(accounts.orgId, orgId), eq(accounts.systemKey, key)))
    .limit(1);
  return a ?? null;
}
