/**
 * Importing bank statements from CSV: map the columns, preview every row
 * (with its errors and whether it duplicates something already imported),
 * then commit — the batch, every raw row exactly as received, and the new
 * bank transactions — in one transaction. An import can be undone while none
 * of its transactions has been matched or categorized.
 */
import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { bankCsvMappings, bankImportBatches, bankImportRows, bankTransactions, type CsvMappingConfig } from "@/lib/db/schema/banking";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { uploadAttachment } from "@/lib/storage/attachments";
import { normalizeDescription, parseBankDate, parseCsv, parseUserAmount } from "./csv";
import { fingerprint, loadMoneyAccount } from "./common";
import { applyRulesToTransactions } from "./rules";

export type ImportBatch = typeof bankImportBatches.$inferSelect;
export type CsvMapping = typeof bankCsvMappings.$inferSelect;

export const MAX_IMPORT_ROWS = 20_000;

export interface PreviewRow {
  rowNumber: number;
  cells: string[];
  date: string | null;
  amount: string | null;
  description: string;
  payee: string | null;
  reference: string | null;
  balance: string | null;
  errors: string[];
  fingerprint: string | null;
  duplicate: boolean;
  /** Why it is a duplicate. */
  duplicateOf: string | null;
}

export interface ImportPreview {
  delimiter: string;
  headers: string[];
  rows: PreviewRow[];
  counts: { total: number; valid: number; errors: number; duplicates: number; new: number };
  totalIn: string;
  totalOut: string;
  currency: string;
}

function validateMapping(m: CsvMappingConfig, width: number) {
  const fields: Record<string, string> = {};
  const col = (v: number | null | undefined, name: string, required: boolean) => {
    if (v === null || v === undefined) {
      if (required) fields[name] = "Choose a column.";
      return;
    }
    if (!Number.isInteger(v) || v < 0 || v >= width) fields[name] = "That column is not in the file.";
  };
  col(m.dateColumn, "dateColumn", true);
  col(m.descriptionColumn, "descriptionColumn", true);
  if (m.amountMode === "single") col(m.amountColumn, "amountColumn", true);
  else {
    col(m.debitColumn, "debitColumn", true);
    col(m.creditColumn, "creditColumn", true);
  }
  col(m.payeeColumn, "payeeColumn", false);
  col(m.referenceColumn, "referenceColumn", false);
  col(m.balanceColumn, "balanceColumn", false);
  if (!Number.isInteger(m.skipRows) || m.skipRows < 0 || m.skipRows > 100) fields.skipRows = "Skip 0–100 rows.";
  if (Object.keys(fields).length) throw new ValidationError("Check the column mapping.", fields);
}

/** Apply a mapping to parsed CSV rows (no database). */
export function mapRows(allRows: string[][], m: CsvMappingConfig, accountId: string, currency: string): { headers: string[]; rows: PreviewRow[] } {
  const afterSkip = allRows.slice(m.skipRows);
  const headers = m.hasHeader ? (afterSkip[0] ?? []).map((h) => h.trim()) : (afterSkip[0] ?? []).map((_, i) => `Column ${i + 1}`);
  const data = afterSkip.slice(m.hasHeader ? 1 : 0);
  if (data.length > MAX_IMPORT_ROWS) throw new ValidationError(`A file can have at most ${MAX_IMPORT_ROWS.toLocaleString("en-US")} rows; split it.`);
  const firstDataLine = m.skipRows + (m.hasHeader ? 1 : 0);
  const mu = minorUnits(currency);
  const occurrences = new Map<string, number>();
  const rows = data.map((cells, i): PreviewRow => {
    const errors: string[] = [];
    const cell = (c: number | null) => (c === null || c === undefined ? "" : (cells[c] ?? "").trim());
    const date = parseBankDate(cell(m.dateColumn), m.dateFormat);
    if (!date) errors.push(`Date “${cell(m.dateColumn)}” is not ${m.dateFormat}.`);
    let amount: Decimal | null = null;
    if (m.amountMode === "single") {
      amount = parseUserAmount(cell(m.amountColumn), { decimalComma: m.decimalComma });
      if (!amount) errors.push(`Amount “${cell(m.amountColumn)}” is not a number.`);
    } else {
      const debitText = cell(m.debitColumn);
      const creditText = cell(m.creditColumn);
      const debit = debitText ? parseUserAmount(debitText, { decimalComma: m.decimalComma }) : Decimal.ZERO;
      const credit = creditText ? parseUserAmount(creditText, { decimalComma: m.decimalComma }) : Decimal.ZERO;
      if (debit === null) errors.push(`Debit “${debitText}” is not a number.`);
      if (credit === null) errors.push(`Credit “${creditText}” is not a number.`);
      if (debit !== null && credit !== null) {
        if (!debitText && !creditText) errors.push("Both debit and credit are empty.");
        // Money in is positive; debits (withdrawals) are money out whatever sign the bank wrote.
        amount = credit.abs().sub(debit.abs());
      }
    }
    if (amount && m.invertSign) amount = amount.neg();
    if (amount && amount.decimalPlaces > mu) errors.push(`Amount has more than ${mu} decimal places for ${currency}.`);
    if (amount && amount.isZero()) errors.push("The amount is zero.");
    const description = cell(m.descriptionColumn);
    if (!description) errors.push("The description is empty.");
    const balance = m.balanceColumn !== null ? parseUserAmount(cell(m.balanceColumn), { decimalComma: m.decimalComma }) : null;
    let fp: string | null = null;
    if (!errors.length && date && amount) {
      const key = `${date}|${amount.normalize().toString()}|${normalizeDescription(description)}`;
      const n = occurrences.get(key) ?? 0;
      occurrences.set(key, n + 1);
      fp = fingerprint(accountId, date, amount, description, n);
    }
    return {
      rowNumber: firstDataLine + i + 1,
      cells,
      date,
      amount: amount && !errors.length ? amount.rescale(mu).toString() : null,
      description,
      payee: cell(m.payeeColumn) || null,
      reference: cell(m.referenceColumn) || null,
      balance: balance && balance.decimalPlaces <= mu ? balance.rescale(mu).toString() : null,
      errors,
      fingerprint: fp,
      duplicate: false,
      duplicateOf: null,
    };
  });
  return { headers, rows };
}

async function flagDuplicates(db: DbOrTx, orgId: string, accountId: string, rows: PreviewRow[]) {
  const fps = rows.map((r) => r.fingerprint).filter(Boolean) as string[];
  if (!fps.length) return;
  const existing = new Map<string, { id: string; postedDate: string; batchId: string | null }>();
  for (let i = 0; i < fps.length; i += 1000) {
    const chunk = fps.slice(i, i + 1000);
    const found = await db
      .select({ id: bankTransactions.id, fingerprint: bankTransactions.fingerprint, postedDate: bankTransactions.postedDate, batchId: bankTransactions.batchId })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.accountId, accountId), inArray(bankTransactions.fingerprint, chunk), ne(bankTransactions.status, "removed")));
    for (const f of found) existing.set(f.fingerprint, f);
  }
  for (const r of rows) {
    const hit = r.fingerprint ? existing.get(r.fingerprint) : undefined;
    if (hit) {
      r.duplicate = true;
      r.duplicateOf = hit.id;
    }
  }
}

function summarize(rows: PreviewRow[]) {
  let inn = Decimal.ZERO;
  let out = Decimal.ZERO;
  for (const r of rows) {
    if (!r.amount || r.errors.length || r.duplicate) continue;
    const a = Decimal.from(r.amount);
    if (a.isPositive()) inn = inn.add(a);
    else out = out.add(a.neg());
  }
  const errors = rows.filter((r) => r.errors.length).length;
  const duplicates = rows.filter((r) => r.duplicate).length;
  return {
    counts: { total: rows.length, valid: rows.length - errors, errors, duplicates, new: rows.length - errors - duplicates },
    totalIn: inn.toString(),
    totalOut: out.toString(),
  };
}

/** Parse, map and check a file without saving anything. */
export async function previewImport(db: DbOrTx, ctx: Ctx, input: { accountId: string; text: string; mapping: CsvMappingConfig }): Promise<ImportPreview> {
  requirePermission(ctx, "banking.import");
  const account = await loadMoneyAccount(db, ctx, input.accountId);
  const all = parseCsv(input.text, input.mapping.delimiter);
  if (!all.length) throw new ValidationError("The file has no rows.", { file: "Empty file." });
  const width = Math.max(...all.slice(input.mapping.skipRows, input.mapping.skipRows + 20).map((r) => r.length), 0);
  validateMapping(input.mapping, width);
  const { headers, rows } = mapRows(all, input.mapping, account.id, account.currencyResolved);
  await flagDuplicates(db, ctx.orgId, account.id, rows);
  return { delimiter: input.mapping.delimiter ?? "", headers, rows, ...summarize(rows), currency: account.currencyResolved };
}

export interface CommitImportInput {
  accountId: string;
  fileName: string;
  text: string;
  mapping: CsvMappingConfig;
  mappingId?: string | null;
  /** Rows flagged as duplicates that the person chose to import anyway. */
  includeDuplicateRows?: number[];
  /** Save the mapping under this name for next time. */
  saveMappingAs?: string | null;
}

export async function commitImport(ctx: Ctx, input: CommitImportInput): Promise<ImportBatch> {
  requirePermission(ctx, "banking.import");
  const fileSha = createHash("sha256").update(input.text).digest("hex");
  const batch = await withTransaction(async (tx) => {
    const account = await loadMoneyAccount(tx, ctx, input.accountId);
    if (account.isArchived) throw new ValidationError(`${account.name} is archived.`);
    // One import per account at a time, so duplicate checks see each other.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bank-import:${account.id}`}))`);
    const preview = await previewImport(tx, ctx, input);
    const include = new Set(input.includeDuplicateRows ?? []);
    let mappingId = input.mappingId ?? null;
    if (input.saveMappingAs?.trim()) {
      mappingId = (await saveMappingTx(tx, ctx, { name: input.saveMappingAs.trim(), accountId: account.id, config: input.mapping, headerSignature: preview.headers.join("|") })).id;
    }
    const [b] = await tx
      .insert(bankImportBatches)
      .values({
        orgId: ctx.orgId,
        accountId: account.id,
        source: "csv",
        fileName: input.fileName.slice(0, 200),
        fileSha256: fileSha,
        mappingId,
        mappingSnapshot: input.mapping,
        totalRows: preview.rows.length,
        createdBy: ctx.actor.userId,
      })
      .returning();
    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    const newIds: string[] = [];
    const CHUNK = 500;
    for (let c = 0; c < preview.rows.length; c += CHUNK) {
      const chunk = preview.rows.slice(c, c + CHUNK);
      const outcomes = chunk.map((r) => (r.errors.length ? "error" : r.duplicate && !include.has(r.rowNumber) ? "duplicate" : "imported") as "error" | "duplicate" | "imported");
      const raws = await tx
        .insert(bankImportRows)
        .values(
          chunk.map((r, i) => ({
            orgId: ctx.orgId,
            batchId: b!.id,
            rowNumber: r.rowNumber,
            raw: { cells: r.cells },
            outcome: outcomes[i]!,
            message: r.errors.length ? r.errors.join(" ") : outcomes[i] === "duplicate" ? `Already imported (transaction ${r.duplicateOf}).` : null,
          })),
        )
        .returning({ id: bankImportRows.id, rowNumber: bankImportRows.rowNumber });
      const rawByRow = new Map(raws.map((r) => [r.rowNumber, r.id]));
      const toInsert = chunk.filter((_, i) => outcomes[i] === "imported");
      errors += outcomes.filter((o) => o === "error").length;
      duplicates += outcomes.filter((o) => o === "duplicate").length;
      if (!toInsert.length) continue;
      const inserted = await tx
        .insert(bankTransactions)
        .values(
          toInsert.map((r) => ({
            orgId: ctx.orgId,
            accountId: account.id,
            postedDate: r.date!,
            amount: r.amount!,
            currency: account.currencyResolved,
            description: r.description.slice(0, 500),
            payee: r.payee?.slice(0, 200) ?? null,
            reference: r.reference?.slice(0, 100) ?? null,
            bankBalance: r.balance,
            // A duplicate the person chose to keep gets a fingerprint of its own.
            fingerprint: r.duplicate ? `${r.fingerprint}:kept:${b!.id}:${r.rowNumber}` : r.fingerprint!,
            batchId: b!.id,
            rawRowId: rawByRow.get(r.rowNumber)!,
          })),
        )
        .returning({ id: bankTransactions.id });
      newIds.push(...inserted.map((t) => t.id));
      imported += inserted.length;
    }
    const [done] = await tx
      .update(bankImportBatches)
      .set({ importedCount: imported, duplicateCount: duplicates, errorCount: errors })
      .where(eq(bankImportBatches.id, b!.id))
      .returning();
    await audit(tx, ctx, {
      action: "banking.imported",
      entityType: "import_batch",
      entityId: b!.id,
      metadata: { accountId: account.id, fileName: input.fileName, sha256: fileSha, rows: preview.rows.length, imported, duplicates, errors },
    });
    if (newIds.length) await applyRulesToTransactions(tx, ctx, newIds);
    return done!;
  });
  // Keep the original file with the batch (best effort: the raw rows already preserve every cell).
  try {
    const att = await uploadAttachment(ctx, {
      entityType: "import_batch",
      entityId: batch.id,
      fileName: input.fileName.toLowerCase().endsWith(".csv") ? input.fileName : `${input.fileName}.csv`,
      contentType: "text/csv",
      bytes: Buffer.from(input.text, "utf8"),
      origin: "import",
    });
    await getDb().update(bankImportBatches).set({ attachmentId: att.id }).where(eq(bankImportBatches.id, batch.id));
    return { ...batch, attachmentId: att.id };
  } catch {
    return batch;
  }
}

/** Undo an import: its transactions are removed (kept for history), allowed while none has been matched or categorized. */
export async function undoImport(ctx: Ctx, batchId: string, reason: string): Promise<void> {
  requirePermission(ctx, "banking.import");
  if (!reason?.trim()) throw new ValidationError("Say why the import is being undone.", { reason: "Required." });
  await withTransaction(async (tx) => {
    const [b] = await tx.select().from(bankImportBatches).where(and(eq(bankImportBatches.orgId, ctx.orgId), eq(bankImportBatches.id, batchId))).for("update");
    if (!b) throw new NotFoundError("The import");
    if (b.status === "undone") throw new ConflictError("This import was already undone.", "already_undone");
    const used = await tx
      .select({ id: bankTransactions.id, status: bankTransactions.status })
      .from(bankTransactions)
      .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.batchId, batchId), inArray(bankTransactions.status, ["matched", "categorized"])));
    if (used.length) {
      throw new ConflictError(
        `${used.length} transaction${used.length === 1 ? " from this import has" : "s from this import have"} been matched or categorized. Undo those first, then undo the import.`,
        "import_in_use",
        { transactions: used.map((u) => u.id) },
      );
    }
    await tx
      .update(bankTransactions)
      .set({ status: "removed", statusReason: `Import undone: ${reason.trim()}`, updatedAt: new Date() })
      .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.batchId, batchId), ne(bankTransactions.status, "removed")));
    await tx
      .update(bankImportBatches)
      .set({ status: "undone", undoneAt: new Date(), undoneBy: ctx.actor.userId, undoReason: reason.trim() })
      .where(eq(bankImportBatches.id, batchId));
    await audit(tx, ctx, { action: "banking.import_undone", entityType: "import_batch", entityId: batchId, reason: reason.trim() });
  });
}

export async function listImportBatches(db: DbOrTx, orgId: string, opts: { accountId?: string; limit?: number } = {}) {
  const conds = [eq(bankImportBatches.orgId, orgId)];
  if (opts.accountId) conds.push(eq(bankImportBatches.accountId, opts.accountId));
  return db.select().from(bankImportBatches).where(and(...conds)).orderBy(desc(bankImportBatches.createdAt)).limit(opts.limit ?? 100);
}

export async function getImportBatch(db: DbOrTx, orgId: string, id: string) {
  const [b] = await db.select().from(bankImportBatches).where(and(eq(bankImportBatches.orgId, orgId), eq(bankImportBatches.id, id)));
  if (!b) throw new NotFoundError("The import");
  const rows = await db.select().from(bankImportRows).where(and(eq(bankImportRows.orgId, orgId), eq(bankImportRows.batchId, id))).orderBy(asc(bankImportRows.rowNumber));
  const txns = await db.select().from(bankTransactions).where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.batchId, id)));
  return { batch: b, rows, transactions: txns };
}

// ── Saved mappings ──────────────────────────────────────────────────────────

async function saveMappingTx(tx: Tx, ctx: Ctx, input: { id?: string | null; name: string; accountId?: string | null; config: CsvMappingConfig; headerSignature?: string | null }): Promise<CsvMapping> {
  if (!input.name.trim()) throw new ValidationError("Name the mapping.", { mappingName: "Required." });
  const [existing] = await tx
    .select()
    .from(bankCsvMappings)
    .where(and(eq(bankCsvMappings.orgId, ctx.orgId), input.id ? eq(bankCsvMappings.id, input.id) : eq(bankCsvMappings.name, input.name.trim())));
  if (existing) {
    const [row] = await tx
      .update(bankCsvMappings)
      .set({ name: input.name.trim(), config: input.config, accountId: input.accountId ?? existing.accountId, headerSignature: input.headerSignature ?? existing.headerSignature, updatedAt: new Date() })
      .where(eq(bankCsvMappings.id, existing.id))
      .returning();
    await audit(tx, ctx, { action: "banking.mapping_updated", entityType: "bank_csv_mapping", entityId: existing.id, before: existing.config, after: input.config });
    return row!;
  }
  const [row] = await tx
    .insert(bankCsvMappings)
    .values({ orgId: ctx.orgId, name: input.name.trim(), accountId: input.accountId ?? null, config: input.config, headerSignature: input.headerSignature ?? null, createdBy: ctx.actor.userId })
    .returning();
  await audit(tx, ctx, { action: "banking.mapping_saved", entityType: "bank_csv_mapping", entityId: row!.id, after: row });
  return row!;
}

export async function saveMapping(ctx: Ctx, input: { id?: string | null; name: string; accountId?: string | null; config: CsvMappingConfig; headerSignature?: string | null }) {
  requirePermission(ctx, "banking.import");
  return withTransaction((tx) => saveMappingTx(tx, ctx, input));
}

export async function deleteMapping(ctx: Ctx, id: string) {
  requirePermission(ctx, "banking.import");
  await withTransaction(async (tx) => {
    const [m] = await tx.select().from(bankCsvMappings).where(and(eq(bankCsvMappings.orgId, ctx.orgId), eq(bankCsvMappings.id, id)));
    if (!m) throw new NotFoundError("The mapping");
    await tx.update(bankImportBatches).set({ mappingId: null }).where(and(eq(bankImportBatches.orgId, ctx.orgId), eq(bankImportBatches.mappingId, id)));
    await tx.delete(bankCsvMappings).where(eq(bankCsvMappings.id, id));
    await audit(tx, ctx, { action: "banking.mapping_deleted", entityType: "bank_csv_mapping", entityId: id, before: m });
  });
}

export async function listMappings(db: DbOrTx, orgId: string): Promise<CsvMapping[]> {
  return db.select().from(bankCsvMappings).where(eq(bankCsvMappings.orgId, orgId)).orderBy(asc(bankCsvMappings.name));
}
