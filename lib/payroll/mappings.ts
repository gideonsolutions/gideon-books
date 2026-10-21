/**
 * Where each payroll component posts. A mapping with code "*" is the default
 * for its component type; a specific code overrides it. Every change is
 * audited, and each posted run keeps a snapshot of the mappings it used.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { payrollMappings, PAYROLL_COMPONENT_TYPES, type PayrollComponentType } from "@/lib/db/schema/payroll";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { systemAccountId } from "@/lib/ledger/accounts";
import type { SystemKey } from "@/lib/ledger/coa-templates";

export type PayrollMapping = typeof payrollMappings.$inferSelect;

export const COMPONENT_LABELS: Record<PayrollComponentType, string> = {
  gross_wages: "Gross wages",
  employee_withholding: "Employee tax withholding",
  employee_deduction: "Employee deduction (benefits, garnishments)",
  employer_tax: "Employer tax",
  employer_benefit: "Employer benefit contribution",
  reimbursement: "Reimbursement",
  net_pay: "Net pay",
};

/** Which sides a component type posts: debit an expense, credit a liability, or both. */
export const COMPONENT_SIDES: Record<PayrollComponentType, { expense: boolean; liability: boolean }> = {
  gross_wages: { expense: true, liability: false },
  employee_withholding: { expense: false, liability: true },
  employee_deduction: { expense: false, liability: true },
  employer_tax: { expense: true, liability: true },
  employer_benefit: { expense: true, liability: true },
  reimbursement: { expense: true, liability: false },
  net_pay: { expense: false, liability: true },
};

const DEFAULTS: Record<PayrollComponentType, { expense?: SystemKey; liability?: SystemKey }> = {
  gross_wages: { expense: "wages_expense" },
  employee_withholding: { liability: "payroll_liabilities" },
  employee_deduction: { liability: "payroll_liabilities" },
  employer_tax: { expense: "payroll_tax_expense", liability: "payroll_liabilities" },
  employer_benefit: { expense: "benefits_expense", liability: "payroll_liabilities" },
  reimbursement: { expense: "general_expense" },
  net_pay: { liability: "net_pay_clearing" },
};

/** Create the per-type defaults ("*") from the system accounts, if missing. */
export async function ensureDefaultMappings(tx: Tx, ctx: Ctx): Promise<void> {
  const existing = await tx
    .select({ type: payrollMappings.componentType })
    .from(payrollMappings)
    .where(and(eq(payrollMappings.orgId, ctx.orgId), eq(payrollMappings.componentCode, "*")));
  const have = new Set(existing.map((e) => e.type));
  for (const type of PAYROLL_COMPONENT_TYPES) {
    if (have.has(type)) continue;
    const d = DEFAULTS[type];
    await tx
      .insert(payrollMappings)
      .values({
        orgId: ctx.orgId,
        componentType: type,
        componentCode: "*",
        label: `Default for ${COMPONENT_LABELS[type].toLowerCase()}`,
        expenseAccountId: d.expense ? await systemAccountId(tx, ctx.orgId, d.expense) : null,
        liabilityAccountId: d.liability ? await systemAccountId(tx, ctx.orgId, d.liability) : null,
        updatedBy: ctx.actor.userId,
      })
      .onConflictDoNothing();
  }
}

export async function listMappings(db: DbOrTx, orgId: string): Promise<PayrollMapping[]> {
  return db.select().from(payrollMappings).where(eq(payrollMappings.orgId, orgId)).orderBy(asc(payrollMappings.componentType), asc(payrollMappings.componentCode));
}

export interface ResolvedMapping {
  mappingId: string;
  code: string;
  isDefault: boolean;
  expenseAccountId: string | null;
  liabilityAccountId: string | null;
}

/** The mapping for a component: its own code, else the type default. Null if neither exists. */
export function resolveMapping(mappings: PayrollMapping[], type: PayrollComponentType, code: string): ResolvedMapping | null {
  const own = mappings.find((m) => m.componentType === type && m.componentCode === code);
  const def = mappings.find((m) => m.componentType === type && m.componentCode === "*");
  const m = own ?? def;
  if (!m) return null;
  return { mappingId: m.id, code: m.componentCode, isDefault: !own, expenseAccountId: m.expenseAccountId, liabilityAccountId: m.liabilityAccountId };
}

export interface MappingInput {
  componentType: PayrollComponentType;
  componentCode: string;
  label?: string | null;
  expenseAccountId?: string | null;
  liabilityAccountId?: string | null;
}

async function validateMapping(tx: DbOrTx, ctx: Ctx, input: MappingInput) {
  const fields: Record<string, string> = {};
  if (!PAYROLL_COMPONENT_TYPES.includes(input.componentType)) fields.componentType = "Choose a component type.";
  const code = input.componentCode.trim().toLowerCase();
  if (code !== "*" && !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(code)) fields.componentCode = "Use lowercase letters, digits, dots, dashes or underscores (or * for the default).";
  const sides = COMPONENT_SIDES[input.componentType] ?? { expense: false, liability: false };
  if (sides.expense && !input.expenseAccountId) fields.expenseAccountId = "Choose the expense account.";
  if (sides.liability && !input.liabilityAccountId) fields.liabilityAccountId = input.componentType === "net_pay" ? "Choose the net pay clearing or bank account." : "Choose the liability account.";
  if (Object.keys(fields).length) throw new ValidationError("Check the mapping.", fields);
  const ids = [input.expenseAccountId, input.liabilityAccountId].filter(Boolean) as string[];
  const rows = ids.length ? await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), inArray(accounts.id, ids))) : [];
  const by = new Map(rows.map((r) => [r.id, r]));
  if (sides.expense) {
    const a = by.get(input.expenseAccountId!);
    if (!a || a.control || !["expense", "asset"].includes(a.type)) fields.expenseAccountId = "Choose an expense account (or a non-control asset account).";
  }
  if (sides.liability) {
    const a = by.get(input.liabilityAccountId!);
    const ok = a && !a.control && (a.type === "liability" || (input.componentType === "net_pay" && ["bank", "cash", "clearing"].includes(a.subtype)));
    if (!ok) fields.liabilityAccountId = input.componentType === "net_pay" ? "Choose a liability (net pay clearing) or bank account." : "Choose a liability account.";
  }
  if (Object.keys(fields).length) throw new ValidationError("Check the mapping's accounts.", fields);
  return code;
}

export async function saveMapping(ctx: Ctx, input: MappingInput, id?: string | null): Promise<PayrollMapping> {
  requirePermission(ctx, "payroll.import");
  return withTransaction(async (tx) => {
    const code = await validateMapping(tx, ctx, input);
    const sides = COMPONENT_SIDES[input.componentType];
    const vals = {
      componentType: input.componentType,
      componentCode: code,
      label: input.label?.trim() || null,
      expenseAccountId: sides.expense ? input.expenseAccountId! : null,
      liabilityAccountId: sides.liability ? input.liabilityAccountId! : null,
      updatedBy: ctx.actor.userId,
      updatedAt: new Date(),
    };
    if (id) {
      const [before] = await tx.select().from(payrollMappings).where(and(eq(payrollMappings.orgId, ctx.orgId), eq(payrollMappings.id, id)));
      if (!before) throw new NotFoundError("The mapping");
      const [row] = await tx.update(payrollMappings).set(vals).where(eq(payrollMappings.id, id)).returning();
      await audit(tx, ctx, { action: "payroll.mapping_updated", entityType: "payroll_mapping", entityId: id, before, after: row });
      return row!;
    }
    const [clash] = await tx
      .select({ id: payrollMappings.id })
      .from(payrollMappings)
      .where(and(eq(payrollMappings.orgId, ctx.orgId), eq(payrollMappings.componentType, input.componentType), eq(payrollMappings.componentCode, code)));
    if (clash) throw new ConflictError("That component already has a mapping; edit it instead.", "duplicate_mapping");
    const [row] = await tx.insert(payrollMappings).values({ orgId: ctx.orgId, ...vals }).returning();
    await audit(tx, ctx, { action: "payroll.mapping_created", entityType: "payroll_mapping", entityId: row!.id, after: row });
    return row!;
  });
}

export async function deleteMapping(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, "payroll.import");
  await withTransaction(async (tx) => {
    const [m] = await tx.select().from(payrollMappings).where(and(eq(payrollMappings.orgId, ctx.orgId), eq(payrollMappings.id, id)));
    if (!m) throw new NotFoundError("The mapping");
    if (m.componentCode === "*") throw new ConflictError("The default for a component type cannot be deleted; change its accounts instead.", "default_mapping");
    await tx.delete(payrollMappings).where(eq(payrollMappings.id, id));
    await audit(tx, ctx, { action: "payroll.mapping_deleted", entityType: "payroll_mapping", entityId: id, before: m });
  });
}
