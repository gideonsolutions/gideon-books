/**
 * Cash settlement of payroll: recording the net pay that went out and the
 * payments of payroll liabilities (tax deposits, benefit remittances).
 * Recording one records it; Gideon Books never moves money.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { payrollRuns, payrollSettlements } from "@/lib/db/schema/payroll";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isIsoDate } from "@/lib/dates";
import { postEntry, reverseEntryInternal } from "@/lib/ledger/posting";
import { listMappings } from "./mappings";

export type PayrollSettlement = typeof payrollSettlements.$inferSelect;

async function checkBank(db: DbOrTx, ctx: Ctx, id: string) {
  const [acc] = await db.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, id)));
  if (!acc || !["bank", "cash", "clearing", "credit_card"].includes(acc.subtype) || acc.isArchived) {
    throw new ValidationError("Choose the bank or cash account the money left from.", { bankAccountId: "Not a money account." });
  }
  return acc;
}

/** Net pay of a run still owed through its clearing account (net pay less disbursements recorded). */
export async function netPayOutstanding(db: DbOrTx, orgId: string, runId: string): Promise<{ clearingAccountId: string | null; outstanding: Decimal }> {
  const [run] = await db.select().from(payrollRuns).where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.id, runId)));
  if (!run) throw new NotFoundError("The payroll run");
  // The account net pay was credited to, from the mappings the run posted with.
  const snapshot = (run.mappingSnapshot ?? []) as { type: string; code: string; liabilityAccountId: string | null }[];
  const m = snapshot.find((x) => x.type === "net_pay" && x.code === "net_pay") ?? snapshot.find((x) => x.type === "net_pay" && x.code === "*");
  if (!m?.liabilityAccountId) return { clearingAccountId: null, outstanding: Decimal.ZERO };
  const [acc] = await db.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.id, m.liabilityAccountId)));
  if (!acc || ["bank", "cash", "clearing"].includes(acc.subtype)) return { clearingAccountId: null, outstanding: Decimal.ZERO };
  const [paid] = await db
    .select({ s: sql<string>`coalesce(sum(${payrollSettlements.amount}), 0)::text` })
    .from(payrollSettlements)
    .where(and(eq(payrollSettlements.orgId, orgId), eq(payrollSettlements.runId, runId), eq(payrollSettlements.kind, "net_pay"), eq(payrollSettlements.status, "posted")));
  return { clearingAccountId: acc.id, outstanding: Decimal.from(run.netPay).sub(paid?.s ?? "0") };
}

/** Record the net pay disbursement of a run: Dr net pay clearing, Cr bank. */
export async function recordNetPay(ctx: Ctx, runId: string, input: { date: string; bankAccountId: string; amount?: string | null; reference?: string | null }) {
  requirePermission(ctx, "payroll.import");
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the date the net pay went out.", { date: "Required." });
  return withTransaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.orgId, ctx.orgId), eq(payrollRuns.id, runId))).for("update");
    if (!run) throw new NotFoundError("The payroll run");
    if (run.status !== "posted") throw new ConflictError("Net pay can only be recorded for a posted run.", "run_not_posted");
    const bank = await checkBank(tx, ctx, input.bankAccountId);
    const { clearingAccountId, outstanding } = await netPayOutstanding(tx, ctx.orgId, runId);
    if (!clearingAccountId) throw new ConflictError("This run's net pay was mapped straight to a bank account, so there is nothing to clear.", "no_clearing");
    const amount = input.amount ? Decimal.tryFrom(input.amount.replace(/[,\s$]/g, "")) : outstanding;
    if (!amount || !amount.isPositive()) throw new ValidationError("Enter the amount disbursed.", { amount: "Must be positive." });
    if (amount.gt(outstanding)) throw new ValidationError(`Only ${outstanding.toString()} of net pay is outstanding for this run.`, { amount: "More than outstanding." });
    const [s] = await tx
      .insert(payrollSettlements)
      .values({ orgId: ctx.orgId, runId, kind: "net_pay", settlementDate: input.date, bankAccountId: bank.id, liabilityAccountId: clearingAccountId, amount: amount.toString(), reference: input.reference?.trim() || null, createdBy: ctx.actor.userId })
      .returning();
    const posted = await postEntry(tx, ctx, {
      kind: "payroll",
      entryDate: input.date,
      description: `Net pay disbursed for payroll ${run.providerRunId}`,
      sourceType: "payroll_settlement",
      sourceId: s!.id,
      sourceRef: input.reference?.trim() || run.providerRunId,
      idempotencyKey: `payroll-settlement:${s!.id}`,
      lines: [
        { accountId: clearingAccountId, amount: amount.toString(), description: "Net pay disbursed" },
        { accountId: bank.id, amount: amount.neg().toString(), description: `Payroll ${run.providerRunId} net pay` },
      ],
    });
    await tx.update(payrollSettlements).set({ journalEntryId: posted.entry.id }).where(eq(payrollSettlements.id, s!.id));
    await audit(tx, ctx, { action: "payroll.net_pay_recorded", entityType: "payroll_run", entityId: runId, metadata: { amount: amount.toString(), settlementId: s!.id } });
    return { ...s!, journalEntryId: posted.entry.id };
  });
}

/** Record a payment of a payroll liability (tax deposit, benefit remittance): Dr liability, Cr bank. */
export async function recordLiabilityPayment(
  ctx: Ctx,
  input: { runId?: string | null; liabilityAccountId: string; date: string; bankAccountId: string; amount: string; reference?: string | null; memo?: string | null },
) {
  requirePermission(ctx, "payroll.import");
  const amount = Decimal.tryFrom(input.amount?.replace(/[,\s$]/g, ""));
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.date)) fields.date = "Enter the payment date.";
  if (!amount || !amount.isPositive()) fields.amount = "Enter the amount paid.";
  if (!input.liabilityAccountId) fields.liabilityAccountId = "Choose the liability paid.";
  if (Object.keys(fields).length) throw new ValidationError("Check the payment.", fields);
  return withTransaction(async (tx) => {
    const bank = await checkBank(tx, ctx, input.bankAccountId);
    const [liab] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, input.liabilityAccountId)));
    if (!liab || liab.type !== "liability" || liab.control) throw new ValidationError("Choose a payroll liability account.", { liabilityAccountId: "Not a liability." });
    let ref = input.reference?.trim() || null;
    if (input.runId) {
      const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.orgId, ctx.orgId), eq(payrollRuns.id, input.runId)));
      if (!run) throw new NotFoundError("The payroll run");
      if (run.status !== "posted") throw new ConflictError("Link payments to a posted run.", "run_not_posted");
      ref ??= run.providerRunId;
    }
    const [s] = await tx
      .insert(payrollSettlements)
      .values({ orgId: ctx.orgId, runId: input.runId || null, kind: "liability", settlementDate: input.date, bankAccountId: bank.id, liabilityAccountId: liab.id, amount: amount!.toString(), reference: ref, memo: input.memo?.trim() || null, createdBy: ctx.actor.userId })
      .returning();
    const posted = await postEntry(tx, ctx, {
      kind: "payroll",
      entryDate: input.date,
      description: `Payment of ${liab.name}${ref ? ` (${ref})` : ""}`,
      sourceType: "payroll_settlement",
      sourceId: s!.id,
      sourceRef: ref,
      idempotencyKey: `payroll-settlement:${s!.id}`,
      lines: [
        { accountId: liab.id, amount: amount!.toString(), description: input.memo?.trim() || `${liab.name} paid` },
        { accountId: bank.id, amount: amount!.neg().toString(), description: `${liab.name} payment` },
      ],
    });
    await tx.update(payrollSettlements).set({ journalEntryId: posted.entry.id }).where(eq(payrollSettlements.id, s!.id));
    await audit(tx, ctx, { action: "payroll.liability_paid", entityType: "payroll_settlement", entityId: s!.id, metadata: { account: liab.code, amount: amount!.toString() } });
    return { ...s!, journalEntryId: posted.entry.id };
  });
}

export async function voidSettlement(ctx: Ctx, settlementId: string, input: { date: string; reason: string }) {
  requirePermission(ctx, "payroll.import");
  if (!input.reason?.trim()) throw new ValidationError("Say why it is being voided.", { reason: "Required." });
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the date.", { date: "Required." });
  return withTransaction(async (tx) => {
    const [s] = await tx.select().from(payrollSettlements).where(and(eq(payrollSettlements.orgId, ctx.orgId), eq(payrollSettlements.id, settlementId))).for("update");
    if (!s) throw new NotFoundError("The payment");
    if (s.status === "void") throw new ConflictError("Already void.", "already_void");
    const date = input.date < s.settlementDate ? s.settlementDate : input.date;
    const rev = await reverseEntryInternal(tx, ctx, s.journalEntryId!, { date, reason: `Void: ${input.reason.trim()}` });
    await tx.update(payrollSettlements).set({ status: "void", voidEntryId: rev.entry.id, voidReason: input.reason.trim() }).where(eq(payrollSettlements.id, settlementId));
    await audit(tx, ctx, { action: "payroll.settlement_voided", entityType: "payroll_settlement", entityId: settlementId, reason: input.reason.trim() });
  });
}

export async function settlementsForRun(db: DbOrTx, orgId: string, runId: string) {
  return db.select().from(payrollSettlements).where(and(eq(payrollSettlements.orgId, orgId), eq(payrollSettlements.runId, runId))).orderBy(desc(payrollSettlements.settlementDate));
}

export async function listSettlements(db: DbOrTx, orgId: string, limit = 100) {
  return db
    .select({ s: payrollSettlements, account: accounts })
    .from(payrollSettlements)
    .innerJoin(accounts, and(eq(accounts.orgId, payrollSettlements.orgId), eq(accounts.id, payrollSettlements.liabilityAccountId)))
    .where(eq(payrollSettlements.orgId, orgId))
    .orderBy(desc(payrollSettlements.settlementDate), desc(payrollSettlements.createdAt))
    .limit(limit);
}

/** The liability accounts payroll uses (from mappings), for payment forms and reports. */
export async function payrollLiabilityAccounts(db: DbOrTx, orgId: string) {
  const mappings = await listMappings(db, orgId);
  const ids = [...new Set(mappings.map((m) => m.liabilityAccountId).filter(Boolean) as string[])];
  if (!ids.length) return [];
  const rows = await db.select().from(accounts).where(and(eq(accounts.orgId, orgId), sql`${accounts.id} in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
  return rows.filter((r) => r.type === "liability").sort((a, b) => a.code.localeCompare(b.code));
}

