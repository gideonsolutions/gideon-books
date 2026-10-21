/**
 * Importing a payroll run: upload → parse → preview the entry → validate →
 * post. Validation is strict and exact: each employee's gross pay less
 * withholdings and deductions plus reimbursements must equal their net pay
 * to the cent; every component needs a mapping; dimensions must exist; the
 * pay date's period must be open; a run (by provider and run id) or a file
 * (by its SHA-256) can be posted only once unless the earlier run was voided.
 */
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { dimensionValues, projects } from "@/lib/db/schema/ledger";
import { payrollImports, payrollRunLines, payrollRuns, payrollSettlements, type PayrollComponentType } from "@/lib/db/schema/payroll";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { sha256Hex } from "@/lib/crypto/secrets";
import { isIsoDate } from "@/lib/dates";
import { isDateOpen } from "@/lib/ledger/periods";
import { postEntry, reverseEntryInternal, type LineInput } from "@/lib/ledger/posting";
import { adapterFor, type ParsedComponent, type ParsedRun } from "./adapters";
import { COMPONENT_LABELS, COMPONENT_SIDES, ensureDefaultMappings, listMappings, resolveMapping, type ResolvedMapping } from "./mappings";

export type PayrollImport = typeof payrollImports.$inferSelect;
export type PayrollRun = typeof payrollRuns.$inferSelect;

export const MAX_PAYROLL_FILE_BYTES = 5 * 1024 * 1024;

export interface ResolvedComponent extends ParsedComponent {
  mapping: ResolvedMapping | null;
  departmentId: string | null;
  classId: string | null;
  locationId: string | null;
  projectId: string | null;
}

export interface PreviewLine {
  accountId: string;
  amount: string;
  description: string;
  componentType: PayrollComponentType;
  departmentId: string | null;
  classId: string | null;
  locationId: string | null;
  projectId: string | null;
}

export interface Preview {
  run: ParsedRun | null;
  errors: string[];
  warnings: string[];
  totals: Record<PayrollComponentType, string>;
  employeeCount: number;
  components: ResolvedComponent[];
  entryLines: PreviewLine[];
  duplicateOf: { runId: string; reason: string } | null;
}

const ZERO_TOTALS = (): Record<PayrollComponentType, Decimal> => ({
  gross_wages: Decimal.ZERO,
  employee_withholding: Decimal.ZERO,
  employee_deduction: Decimal.ZERO,
  employer_tax: Decimal.ZERO,
  employer_benefit: Decimal.ZERO,
  reimbursement: Decimal.ZERO,
  net_pay: Decimal.ZERO,
});

function equation(t: Record<PayrollComponentType, Decimal>): Decimal {
  // gross − withholdings − deductions + reimbursements − net pay must be zero.
  return t.gross_wages.sub(t.employee_withholding).sub(t.employee_deduction).add(t.reimbursement).sub(t.net_pay);
}

/** Validate a parsed run against the organization: amounts, mappings, dimensions, period, duplicates. */
export async function validateRun(db: DbOrTx, ctx: Ctx, run: ParsedRun, provider: string, fileSha256: string | null): Promise<Preview> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const mu = minorUnits(ctx.org.baseCurrency);
  const mappings = await listMappings(db, ctx.orgId);
  const dims = await db.select().from(dimensionValues).where(eq(dimensionValues.orgId, ctx.orgId));
  const projRows = await db.select().from(projects).where(eq(projects.orgId, ctx.orgId));
  const findDim = (kind: "department" | "class" | "location", v: string | null) => {
    if (!v) return null;
    const d = dims.find((x) => x.kind === kind && (x.name.toLowerCase() === v.toLowerCase() || (x.code && x.code.toLowerCase() === v.toLowerCase())));
    if (!d) errors.push(`No ${kind} named "${v}" exists. Create it under Accounting → Dimensions, or correct the file.`);
    else if (d.isArchived) errors.push(`The ${kind} "${v}" is archived.`);
    return d?.id ?? null;
  };
  const findProject = (v: string | null) => {
    if (!v) return null;
    const p = projRows.find((x) => x.name.toLowerCase() === v.toLowerCase() || (x.code && x.code.toLowerCase() === v.toLowerCase()));
    if (!p) errors.push(`No project named "${v}" exists.`);
    return p?.id ?? null;
  };

  const components: ResolvedComponent[] = run.components.map((c) => {
    const amt = Decimal.from(c.amount);
    if (amt.decimalPlaces > mu) errors.push(`${c.employeeName ?? c.employeeRef ?? "Summary"}: ${COMPONENT_LABELS[c.type]} ${c.code} has more than ${mu} decimal places.`);
    const mapping = resolveMapping(mappings, c.type, c.code);
    if (!mapping) errors.push(`${COMPONENT_LABELS[c.type]} "${c.code}" has no mapping, and there is no default for its type. Add one under Payroll → Mappings.`);
    return {
      ...c,
      mapping,
      departmentId: findDim("department", c.department),
      classId: findDim("class", c.class),
      locationId: findDim("location", c.location),
      projectId: findProject(c.project),
    };
  });
  const usedDefault = new Set(components.filter((c) => c.mapping?.isDefault).map((c) => `${COMPONENT_LABELS[c.type]} "${c.code}"`));
  for (const u of usedDefault) warnings.push(`${u} uses the default account for its type.`);

  // Per employee: gross − withholdings − deductions + reimbursements = net pay.
  const totals = ZERO_TOTALS();
  const byEmployee = new Map<string, Record<PayrollComponentType, Decimal>>();
  for (const c of components) {
    totals[c.type] = totals[c.type].add(c.amount);
    if (run.level === "employee") {
      const key = c.employeeRef ?? "";
      const t = byEmployee.get(key) ?? ZERO_TOTALS();
      t[c.type] = t[c.type].add(c.amount);
      byEmployee.set(key, t);
    }
  }
  if (run.level === "employee") {
    for (const [ref, t] of byEmployee) {
      const name = components.find((c) => c.employeeRef === ref)?.employeeName ?? ref;
      const diff = equation(t);
      if (!diff.isZero()) {
        errors.push(
          `${name}: gross ${t.gross_wages.toString()} − withholdings ${t.employee_withholding.toString()} − deductions ${t.employee_deduction.toString()} + reimbursements ${t.reimbursement.toString()} is ${t.net_pay.add(diff).toString()}, but net pay is ${t.net_pay.toString()} (off by ${diff.toString()}).`,
        );
      }
    }
  } else if (!equation(totals).isZero()) {
    errors.push(`The summary does not balance: gross − withholdings − deductions + reimbursements − net pay = ${equation(totals).toString()}.`);
  }
  if (totals.net_pay.isZero() && !totals.gross_wages.isZero()) warnings.push("The run has no net pay.");

  if (isIsoDate(run.payDate) && !(await isDateOpen(db, ctx.org, run.payDate))) {
    errors.push(`The pay date ${run.payDate} is in a closed period or before the lock date. Reopen the period or post an adjustment run in an open period.`);
  }

  // Duplicates among runs that were not voided.
  let duplicateOf: Preview["duplicateOf"] = null;
  const [sameRun] = await db
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.orgId, ctx.orgId), eq(payrollRuns.provider, provider), eq(payrollRuns.providerRunId, run.providerRunId), ne(payrollRuns.status, "void")));
  if (sameRun) {
    duplicateOf = { runId: sameRun.id, reason: `Run "${run.providerRunId}" from ${provider} is already posted.` };
    errors.push(`${duplicateOf.reason} Void it first to import a corrected version.`);
  } else if (fileSha256) {
    const [sameFile] = await db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.orgId, ctx.orgId), eq(payrollRuns.fileSha256, fileSha256), ne(payrollRuns.status, "void")));
    if (sameFile) {
      duplicateOf = { runId: sameFile.id, reason: "This exact file was already imported." };
      errors.push(duplicateOf.reason);
    }
  }

  // The entry that would post: debit expenses (with dimensions), credit liabilities.
  const agg = new Map<string, PreviewLine & { sum: Decimal }>();
  const add = (accountId: string, amount: Decimal, c: ResolvedComponent, description: string, withDims: boolean) => {
    const d = withDims ? { departmentId: c.departmentId, classId: c.classId, locationId: c.locationId, projectId: c.projectId } : { departmentId: null, classId: null, locationId: null, projectId: null };
    const key = [accountId, c.type, amount.isNegative() ? "cr" : "dr", d.departmentId, d.classId, d.locationId, d.projectId, description].join("|");
    const prev = agg.get(key);
    if (prev) prev.sum = prev.sum.add(amount);
    else agg.set(key, { accountId, amount: "0", description, componentType: c.type, ...d, sum: amount });
  };
  for (const c of components) {
    if (!c.mapping) continue;
    const amt = Decimal.from(c.amount);
    const sides = COMPONENT_SIDES[c.type];
    const label = `${COMPONENT_LABELS[c.type]}${c.code === "net_pay" ? "" : ` — ${c.code}`}`;
    if (sides.expense) add(c.mapping.expenseAccountId!, amt, c, label, true);
    if (sides.liability) add(c.mapping.liabilityAccountId!, amt.neg(), c, label, false);
  }
  const entryLines = [...agg.values()].filter((l) => !l.sum.isZero()).map(({ sum, ...l }) => ({ ...l, amount: sum.toString() }));
  if (!errors.length) {
    const net = Decimal.sum(entryLines.map((l) => l.amount));
    if (!net.isZero()) errors.push(`The entry would not balance (off by ${net.toString()}).`);
    if (entryLines.length < 2) errors.push("The run has nothing to post.");
  }
  const employeeCount = run.level === "employee" ? byEmployee.size : 0;
  return {
    run,
    errors,
    warnings,
    totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v.toString()])) as Record<PayrollComponentType, string>,
    employeeCount,
    components,
    entryLines,
    duplicateOf,
  };
}

/** Parse and store an uploaded file for preview. Nothing is posted. */
export async function createImport(ctx: Ctx, input: { adapter: string; fileName: string; content: string }): Promise<PayrollImport> {
  requirePermission(ctx, "payroll.import");
  const adapter = adapterFor(input.adapter);
  if (!adapter) throw new ValidationError("Choose a supported import format.", { adapter: "Unknown format." });
  if (!input.content.trim()) throw new ValidationError("The file is empty.", { file: "Empty." });
  if (Buffer.byteLength(input.content) > MAX_PAYROLL_FILE_BYTES) throw new ValidationError("Payroll files can be at most 5 MB.", { file: "Too large." });
  const parsed = adapter.parse(input.content);
  const fileSha256 = sha256Hex(input.content);
  return withTransaction(async (tx) => {
    await ensureDefaultMappings(tx, ctx);
    const [row] = await tx
      .insert(payrollImports)
      .values({
        orgId: ctx.orgId,
        adapter: adapter.key,
        fileName: input.fileName.slice(0, 200),
        fileSha256,
        rawContent: input.content,
        parsed: parsed.run,
        errors: parsed.errors,
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "payroll.import_uploaded", entityType: "payroll_import", entityId: row!.id, metadata: { adapter: adapter.key, fileName: input.fileName, sha256: fileSha256, parseErrors: parsed.errors.length } });
    return row!;
  });
}

export async function getImport(db: DbOrTx, orgId: string, id: string): Promise<PayrollImport> {
  const [imp] = await db.select().from(payrollImports).where(and(eq(payrollImports.orgId, orgId), eq(payrollImports.id, id)));
  if (!imp) throw new NotFoundError("The payroll import");
  return imp;
}

export async function previewImport(db: DbOrTx, ctx: Ctx, importId: string): Promise<{ imp: PayrollImport; preview: Preview }> {
  const imp = await getImport(db, ctx.orgId, importId);
  const run = imp.parsed as ParsedRun | null;
  if (!run) {
    return {
      imp,
      preview: { run: null, errors: imp.errors, warnings: [], totals: Object.fromEntries(Object.keys(ZERO_TOTALS()).map((k) => [k, "0"])) as Record<PayrollComponentType, string>, employeeCount: 0, components: [], entryLines: [], duplicateOf: null },
    };
  }
  return { imp, preview: await validateRun(db, ctx, run, imp.adapter, imp.fileSha256) };
}

export async function listImports(db: DbOrTx, orgId: string, limit = 20) {
  return db
    .select({ id: payrollImports.id, adapter: payrollImports.adapter, fileName: payrollImports.fileName, status: payrollImports.status, runId: payrollImports.runId, createdAt: payrollImports.createdAt, errors: payrollImports.errors })
    .from(payrollImports)
    .where(eq(payrollImports.orgId, orgId))
    .orderBy(desc(payrollImports.createdAt))
    .limit(limit);
}

/**
 * Post a previewed import as a payroll run. Validated again with the current
 * mappings; refused if anything is wrong. Idempotent per import.
 */
export async function postImport(ctx: Ctx, importId: string, opts: { adjustsRunId?: string | null } = {}): Promise<PayrollRun> {
  requirePermission(ctx, "payroll.import");
  return withTransaction(async (tx) => {
    const [imp] = await tx.select().from(payrollImports).where(and(eq(payrollImports.orgId, ctx.orgId), eq(payrollImports.id, importId))).for("update");
    if (!imp) throw new NotFoundError("The payroll import");
    if (imp.status === "posted" && imp.runId) {
      const [existing] = await tx.select().from(payrollRuns).where(eq(payrollRuns.id, imp.runId));
      return existing!;
    }
    if (imp.status === "discarded") throw new ConflictError("This import was discarded. Upload the file again.", "import_discarded");
    const run = imp.parsed as ParsedRun | null;
    if (!run) throw new ValidationError(`The file could not be read: ${imp.errors.join(" ")}`);
    // Serialize posting per organization so duplicate checks hold under concurrency.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payroll:${ctx.orgId}`}))`);
    const preview = await validateRun(tx, ctx, run, imp.adapter, imp.fileSha256);
    if (preview.errors.length) {
      throw new ValidationError(`This payroll cannot be posted: ${preview.errors.slice(0, 5).join(" ")}${preview.errors.length > 5 ? ` (and ${preview.errors.length - 5} more)` : ""}`, undefined, { errors: preview.errors, duplicateOf: preview.duplicateOf });
    }
    const t = preview.totals;
    const mappings = await listMappings(tx, ctx.orgId);
    const [row] = await tx
      .insert(payrollRuns)
      .values({
        orgId: ctx.orgId,
        provider: imp.adapter,
        providerRunId: run.providerRunId,
        payDate: run.payDate,
        periodStart: run.periodStart,
        periodEnd: run.periodEnd,
        fileName: imp.fileName,
        fileSha256: imp.fileSha256,
        importId: imp.id,
        employeeCount: preview.employeeCount,
        grossWages: t.gross_wages,
        employeeWithholdings: t.employee_withholding,
        employeeDeductions: t.employee_deduction,
        employerTaxes: t.employer_tax,
        employerBenefits: t.employer_benefit,
        reimbursements: t.reimbursement,
        netPay: t.net_pay,
        isAdjustment: !!opts.adjustsRunId,
        adjustsRunId: opts.adjustsRunId ?? null,
        mappingSnapshot: mappings.map((m) => ({ type: m.componentType, code: m.componentCode, expenseAccountId: m.expenseAccountId, liabilityAccountId: m.liabilityAccountId, updatedAt: m.updatedAt })),
        createdBy: ctx.actor.userId,
      })
      .returning();
    if (preview.components.length) {
      await tx.insert(payrollRunLines).values(
        preview.components.map((c) => ({
          orgId: ctx.orgId,
          runId: row!.id,
          employeeRef: c.employeeRef,
          employeeName: c.employeeName,
          componentType: c.type,
          componentCode: c.code,
          amount: c.amount,
          departmentId: c.departmentId,
          classId: c.classId,
          locationId: c.locationId,
          projectId: c.projectId,
        })),
      );
    }
    const lines: LineInput[] = preview.entryLines.map((l) => ({
      accountId: l.accountId,
      amount: l.amount,
      description: l.description,
      departmentId: l.departmentId,
      classId: l.classId,
      locationId: l.locationId,
      projectId: l.projectId,
    }));
    const posted = await postEntry(tx, ctx, {
      kind: "payroll",
      entryDate: run.payDate,
      description: `Payroll ${run.providerRunId} for ${run.periodStart} to ${run.periodEnd}${opts.adjustsRunId ? " (adjustment)" : ""}`,
      sourceType: "payroll_run",
      sourceId: row!.id,
      sourceRef: run.providerRunId,
      idempotencyKey: `payroll-import:${imp.id}`,
      lines,
    });
    const [final] = await tx.update(payrollRuns).set({ journalEntryId: posted.entry.id }).where(eq(payrollRuns.id, row!.id)).returning();
    await tx.update(payrollImports).set({ status: "posted", runId: row!.id }).where(eq(payrollImports.id, imp.id));
    await audit(tx, ctx, {
      action: "payroll.run_posted",
      entityType: "payroll_run",
      entityId: row!.id,
      metadata: { provider: imp.adapter, providerRunId: run.providerRunId, payDate: run.payDate, gross: t.gross_wages, netPay: t.net_pay, entryId: posted.entry.id },
    });
    return final!;
  });
}

export async function discardImport(ctx: Ctx, importId: string): Promise<void> {
  requirePermission(ctx, "payroll.import");
  await withTransaction(async (tx) => {
    const [imp] = await tx.select().from(payrollImports).where(and(eq(payrollImports.orgId, ctx.orgId), eq(payrollImports.id, importId))).for("update");
    if (!imp) throw new NotFoundError("The payroll import");
    if (imp.status === "posted") throw new ConflictError("This import is posted; void its run instead.", "import_posted");
    await tx.update(payrollImports).set({ status: "discarded" }).where(eq(payrollImports.id, importId));
    await audit(tx, ctx, { action: "payroll.import_discarded", entityType: "payroll_import", entityId: importId });
  });
}

/**
 * Void a run: its entry is reversed on `date`. Its net pay disbursements and
 * liability payments must be voided first. The same run (or file) can then
 * be imported again.
 */
export async function voidRun(ctx: Ctx, runId: string, input: { date: string; reason: string }): Promise<PayrollRun> {
  requirePermission(ctx, "payroll.import");
  if (!input.reason?.trim()) throw new ValidationError("Say why the run is being voided.", { reason: "Required." });
  if (!isIsoDate(input.date)) throw new ValidationError("Enter the date of the reversal.", { date: "Required." });
  return withTransaction(async (tx) => {
    const [run] = await tx.select().from(payrollRuns).where(and(eq(payrollRuns.orgId, ctx.orgId), eq(payrollRuns.id, runId))).for("update");
    if (!run) throw new NotFoundError("The payroll run");
    if (run.status === "void") throw new ConflictError("This run is already void.", "already_void");
    const [settled] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollSettlements)
      .where(and(eq(payrollSettlements.orgId, ctx.orgId), eq(payrollSettlements.runId, runId), eq(payrollSettlements.status, "posted")));
    if ((settled?.n ?? 0) > 0) throw new ConflictError("Net pay or liability payments are recorded against this run. Void them first.", "run_settled");
    const date = input.date < run.payDate ? run.payDate : input.date;
    const rev = await reverseEntryInternal(tx, ctx, run.journalEntryId!, { date, reason: `Void: ${input.reason.trim()}`, idempotencyKey: `payroll-void:${runId}` });
    const [row] = await tx
      .update(payrollRuns)
      .set({ status: "void", voidEntryId: rev.entry.id, voidReason: input.reason.trim(), voidedAt: new Date() })
      .where(eq(payrollRuns.id, runId))
      .returning();
    await audit(tx, ctx, { action: "payroll.run_voided", entityType: "payroll_run", entityId: runId, reason: input.reason.trim(), metadata: { reversalEntryId: rev.entry.id } });
    return row!;
  });
}

export async function getRun(db: DbOrTx, orgId: string, runId: string) {
  const [run] = await db.select().from(payrollRuns).where(and(eq(payrollRuns.orgId, orgId), eq(payrollRuns.id, runId)));
  if (!run) throw new NotFoundError("The payroll run");
  const lines = await db
    .select()
    .from(payrollRunLines)
    .where(and(eq(payrollRunLines.orgId, orgId), eq(payrollRunLines.runId, runId)))
    .orderBy(asc(payrollRunLines.employeeName), asc(payrollRunLines.componentType), asc(payrollRunLines.componentCode));
  return { run, lines };
}

export async function listRuns(db: DbOrTx, orgId: string, f: { from?: string; to?: string; status?: "posted" | "void"; page?: number; pageSize?: number } = {}) {
  const conds = [eq(payrollRuns.orgId, orgId)];
  if (f.from) conds.push(sql`${payrollRuns.payDate} >= ${f.from}`);
  if (f.to) conds.push(sql`${payrollRuns.payDate} <= ${f.to}`);
  if (f.status) conds.push(eq(payrollRuns.status, f.status));
  const pageSize = Math.min(Math.max(f.pageSize ?? 50, 1), 500);
  const page = Math.max(f.page ?? 1, 1);
  const where = and(...conds);
  const [rows, [count]] = await Promise.all([
    db.select().from(payrollRuns).where(where).orderBy(desc(payrollRuns.payDate), desc(payrollRuns.createdAt)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ n: sql<number>`count(*)::int` }).from(payrollRuns).where(where),
  ]);
  return { rows, total: count?.n ?? 0, page, pageSize };
}

