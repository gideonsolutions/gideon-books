/**
 * Attachments: receipts, contracts, statements — on any record. Uploads are
 * size-limited and their content is checked against what they claim to be;
 * only document and image types are accepted (no HTML, SVG or executables,
 * which a browser might run). Downloads go through an authorized route.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { attachments } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { sha256Hex } from "@/lib/crypto/secrets";
import { storage } from "./storage";
import { getDb } from "@/lib/db/client";
import { assertWithinLimit, recordUsage } from "@/lib/hosted/metering";

export type Attachment = typeof attachments.$inferSelect;

export const MAX_ATTACHMENT_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES ?? 20 * 1024 * 1024);

/** Record types an attachment may hang on, and the permission needed to attach to each. */
export const ATTACHABLE: Record<string, Parameters<typeof requirePermission>[1]> = {
  journal_entry: "ledger.draft",
  document: "sales.manage",
  purchase_document: "purchases.manage",
  payment: "payments.record",
  bank_transaction: "banking.categorize",
  reconciliation: "banking.reconcile",
  asset: "assets.manage",
  contact: "contacts.manage",
  payroll_run: "payroll.import",
  organization: "org.settings",
  tax_export: "tax_export.manage",
  import_batch: "banking.import",
  receipt_inbox: "purchases.manage",
};

/** Identify a file by its first bytes. Returns the MIME type it really is, or null. */
export function sniffType(bytes: Buffer, declared: string, fileName: string): string | null {
  const h = bytes.subarray(0, 16);
  if (h.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (h[0] === 0x89 && h.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return "image/jpeg";
  if (h.subarray(0, 6).toString("latin1").startsWith("GIF8")) return "image/gif";
  if (h.subarray(0, 4).toString("latin1") === "RIFF" && h.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (h.subarray(4, 8).toString("latin1") === "ftyp" && /heic|heix|mif1/.test(h.subarray(8, 12).toString("latin1"))) return "image/heic";
  // Text formats: must decode as UTF-8 and must not look like markup.
  const lower = fileName.toLowerCase();
  const textual = /\.(csv|txt|ofx|qfx|qbo|json)$/.test(lower) || /^text\/(csv|plain)$/.test(declared);
  if (textual) {
    const text = bytes.toString("utf8");
    if (text.includes("�") && !/\.(ofx|qfx|qbo)$/.test(lower)) return null;
    if (/<\s*(script|html|svg|iframe)/i.test(text.slice(0, 4096))) return null;
    if (lower.endsWith(".csv")) return "text/csv";
    if (lower.endsWith(".json")) return "application/json";
    if (/\.(ofx|qfx|qbo)$/.test(lower)) return "application/x-ofx";
    return "text/plain";
  }
  return null;
}

export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 150);
  return cleaned || "file";
}

export async function uploadAttachment(
  ctx: Ctx,
  input: { entityType: string; entityId: string | null; fileName: string; contentType: string; bytes: Buffer; origin?: Attachment["origin"]; externalRef?: string | null },
): Promise<Attachment> {
  const perm = ATTACHABLE[input.entityType];
  if (!perm) throw new ValidationError(`Files cannot be attached to ${input.entityType}.`);
  requirePermission(ctx, perm);
  if (input.bytes.length === 0) throw new ValidationError("The file is empty.", { file: "Empty file." });
  if (input.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(`Files can be at most ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB.`, { file: "Too large." });
  }
  const fileName = cleanFileName(input.fileName);
  const type = sniffType(input.bytes, input.contentType, fileName);
  if (!type) throw new ValidationError("Attach a PDF, an image (PNG, JPEG, GIF, WebP, HEIC) or a CSV/text file.", { file: "That file type is not accepted." });
  await assertWithinLimit(getDb(), ctx.orgId, "storage_bytes", input.bytes.length);
  await assertWithinLimit(getDb(), ctx.orgId, "documents_processed", 1);
  const id = randomUUID();
  const key = `orgs/${ctx.orgId}/attachments/${id}`;
  await storage().put(key, input.bytes, type);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(attachments)
      .values({
        id,
        orgId: ctx.orgId,
        entityType: input.entityType,
        entityId: input.entityId,
        fileName,
        contentType: type,
        sizeBytes: input.bytes.length,
        sha256: sha256Hex(input.bytes),
        storageKey: key,
        origin: input.origin ?? "upload",
        externalRef: input.externalRef ?? null,
        uploadedBy: ctx.actor.userId,
      })
      .returning();
    await recordUsage(tx, ctx.orgId, "storage_bytes", input.bytes.length, id);
    await recordUsage(tx, ctx.orgId, "documents_processed", 1, id);
    await audit(tx, ctx, { action: "attachment.added", entityType: input.entityType, entityId: input.entityId, metadata: { attachmentId: id, fileName, size: input.bytes.length, type } });
    return row!;
  });
}

export async function listAttachments(db: DbOrTx, orgId: string, entityType: string, entityId: string): Promise<Attachment[]> {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.orgId, orgId), eq(attachments.entityType, entityType), eq(attachments.entityId, entityId), isNull(attachments.deletedAt)))
    .orderBy(desc(attachments.createdAt));
}

/** The attachment row and its bytes, if it belongs to the organization. */
export async function readAttachment(db: DbOrTx, ctx: Ctx, id: string): Promise<{ row: Attachment; bytes: Buffer }> {
  requirePermission(ctx, "org.read");
  const [row] = await db.select().from(attachments).where(and(eq(attachments.orgId, ctx.orgId), eq(attachments.id, id), isNull(attachments.deletedAt)));
  if (!row) throw new NotFoundError("The file");
  if (!row.storageKey.startsWith(`orgs/${ctx.orgId}/`)) throw new NotFoundError("The file");
  return { row, bytes: await storage().get(row.storageKey) };
}

/** Remove an attachment from its record. The bytes are kept for the audit trail until the organization is deleted. */
export async function removeAttachment(ctx: Ctx, id: string): Promise<void> {
  await withTransaction(async (tx) => {
    const [row] = await tx.select().from(attachments).where(and(eq(attachments.orgId, ctx.orgId), eq(attachments.id, id), isNull(attachments.deletedAt)));
    if (!row) throw new NotFoundError("The file");
    requirePermission(ctx, ATTACHABLE[row.entityType] ?? "org.settings");
    await tx.update(attachments).set({ deletedAt: new Date(), deletedBy: ctx.actor.userId }).where(eq(attachments.id, id));
    await audit(tx, ctx, { action: "attachment.removed", entityType: row.entityType, entityId: row.entityId, metadata: { attachmentId: id, fileName: row.fileName } });
  });
}
