/**
 * Gapless per-organization numbering for journal entries and documents. The
 * UPDATE takes a row lock, so concurrent issuers queue rather than collide;
 * a rolled-back transaction returns its number.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { numberSequences } from "@/lib/db/schema/core";

export const SEQUENCE_DEFAULTS: Record<string, { prefix: string; padding: number }> = {
  journal: { prefix: "", padding: 1 },
  invoice: { prefix: "INV-", padding: 4 },
  estimate: { prefix: "EST-", padding: 4 },
  credit_note: { prefix: "CN-", padding: 4 },
  write_off: { prefix: "WO-", padding: 4 },
  sales_receipt: { prefix: "SR-", padding: 4 },
  purchase_order: { prefix: "PO-", padding: 4 },
  bill: { prefix: "BILL-", padding: 4 },
  vendor_credit: { prefix: "VC-", padding: 4 },
  expense: { prefix: "EXP-", padding: 4 },
  customer_payment: { prefix: "PMT-", padding: 4 },
  customer_deposit: { prefix: "DEP-", padding: 4 },
  customer_refund: { prefix: "RFD-", padding: 4 },
  vendor_payment: { prefix: "VP-", padding: 4 },
  vendor_prepayment: { prefix: "VPP-", padding: 4 },
  vendor_refund: { prefix: "VRF-", padding: 4 },
  asset: { prefix: "FA-", padding: 4 },
  stock_adjustment: { prefix: "ADJ-", padding: 4 },
  stock_transfer: { prefix: "TRF-", padding: 4 },
  purchase_receipt: { prefix: "RCV-", padding: 4 },
};

/** Take the next number for `key` and return it formatted (prefix + zero padding) and raw. */
export async function nextNumber(tx: Tx, orgId: string, key: string): Promise<{ value: number; formatted: string }> {
  const defaults = SEQUENCE_DEFAULTS[key] ?? { prefix: "", padding: 4 };
  await tx
    .insert(numberSequences)
    .values({ orgId, key, prefix: defaults.prefix, padding: defaults.padding, nextValue: 1 })
    .onConflictDoNothing();
  const [row] = await tx
    .update(numberSequences)
    .set({ nextValue: sql`${numberSequences.nextValue} + 1` })
    .where(and(eq(numberSequences.orgId, orgId), eq(numberSequences.key, key)))
    .returning({ value: sql<number>`${numberSequences.nextValue} - 1`, prefix: numberSequences.prefix, padding: numberSequences.padding });
  if (!row) throw new Error(`sequence ${key} missing`);
  const value = Number(row.value);
  return { value, formatted: row.prefix + String(value).padStart(row.padding, "0") };
}

/** Change the prefix, padding or next value (an administrator's numbering setting). */
export async function configureSequence(
  tx: Tx,
  orgId: string,
  key: string,
  cfg: { prefix?: string; padding?: number; nextValue?: number },
): Promise<void> {
  const defaults = SEQUENCE_DEFAULTS[key] ?? { prefix: "", padding: 4 };
  await tx
    .insert(numberSequences)
    .values({ orgId, key, prefix: cfg.prefix ?? defaults.prefix, padding: cfg.padding ?? defaults.padding, nextValue: cfg.nextValue ?? 1 })
    .onConflictDoUpdate({
      target: [numberSequences.orgId, numberSequences.key],
      set: {
        ...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
        ...(cfg.padding !== undefined ? { padding: cfg.padding } : {}),
        ...(cfg.nextValue !== undefined ? { nextValue: cfg.nextValue } : {}),
      },
    });
}
