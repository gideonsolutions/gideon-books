/**
 * The receipt inbox: receipts uploaded before the bill or expense they
 * support is entered, then matched to it (or turned into an expense). A
 * match puts the same file on the document; unmatching takes it off again.
 * Both are kept in the audit trail.
 *
 * Gideon Keep holds supporting documents for some people, but it publishes
 * no interface for Books to read receipts from, so the inbox takes uploads
 * only. (docs/purchases.md)
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { withTransaction, type DbOrTx } from "@/lib/db/client";
import { attachments } from "@/lib/db/schema/core";
import { documents } from "@/lib/db/schema/commerce";
import { receiptMatches } from "@/lib/db/schema/purchasing";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { uploadAttachment } from "@/lib/storage/attachments";

export async function addToInbox(ctx: Ctx, file: { fileName: string; contentType: string; bytes: Buffer }) {
  requirePermission(ctx, "purchases.manage");
  return uploadAttachment(ctx, { entityType: "receipt_inbox", entityId: null, ...file });
}

export async function listInbox(db: DbOrTx, orgId: string, status: "unmatched" | "matched" | "all" = "unmatched") {
  const rows = await db
    .select({
      attachment: attachments,
      matchId: receiptMatches.id,
      documentId: receiptMatches.documentId,
      matchedAt: receiptMatches.matchedAt,
      docKind: documents.kind,
      docNumber: documents.number,
      docReference: documents.reference,
    })
    .from(attachments)
    .leftJoin(receiptMatches, and(eq(receiptMatches.orgId, attachments.orgId), eq(receiptMatches.attachmentId, attachments.id), isNull(receiptMatches.unmatchedAt)))
    .leftJoin(documents, and(eq(documents.orgId, receiptMatches.orgId), eq(documents.id, receiptMatches.documentId)))
    .where(
      and(
        eq(attachments.orgId, orgId),
        eq(attachments.entityType, "receipt_inbox"),
        isNull(attachments.deletedAt),
        status === "unmatched" ? isNull(receiptMatches.id) : status === "matched" ? sql`${receiptMatches.id} is not null` : sql`true`,
      ),
    )
    .orderBy(desc(attachments.createdAt))
    .limit(500);
  return rows;
}

/** Match an inbox receipt to a bill or expense (it appears among the document's attachments). */
export async function matchReceipt(ctx: Ctx, attachmentId: string, documentId: string) {
  requirePermission(ctx, "purchases.manage");
  return withTransaction(async (tx) => {
    const [a] = await tx
      .select()
      .from(attachments)
      .where(and(eq(attachments.orgId, ctx.orgId), eq(attachments.id, attachmentId), eq(attachments.entityType, "receipt_inbox"), isNull(attachments.deletedAt)))
      .for("update");
    if (!a) throw new NotFoundError("The receipt");
    const [doc] = await tx.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, documentId)));
    if (!doc || doc.side !== "purchases") throw new ValidationError("Match receipts to a bill, expense, vendor credit or purchase order.");
    const [existing] = await tx
      .select()
      .from(receiptMatches)
      .where(and(eq(receiptMatches.orgId, ctx.orgId), eq(receiptMatches.attachmentId, attachmentId), isNull(receiptMatches.unmatchedAt)));
    if (existing) throw new ConflictError("That receipt is already matched. Unmatch it first.", "already_matched");
    const [linked] = await tx
      .insert(attachments)
      .values({
        orgId: ctx.orgId,
        entityType: "purchase_document",
        entityId: documentId,
        fileName: a.fileName,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        storageKey: a.storageKey,
        origin: a.origin,
        externalRef: a.id,
        uploadedBy: ctx.actor.userId,
      })
      .returning();
    const [m] = await tx
      .insert(receiptMatches)
      .values({ orgId: ctx.orgId, attachmentId, documentId, linkedAttachmentId: linked!.id, matchedBy: ctx.actor.userId })
      .returning();
    await audit(tx, ctx, { action: "receipt.matched", entityType: "document", entityId: documentId, metadata: { attachmentId, fileName: a.fileName, matchId: m!.id } });
    return m!;
  });
}

export async function unmatchReceipt(ctx: Ctx, matchId: string) {
  requirePermission(ctx, "purchases.manage");
  await withTransaction(async (tx) => {
    const [m] = await tx
      .select()
      .from(receiptMatches)
      .where(and(eq(receiptMatches.orgId, ctx.orgId), eq(receiptMatches.id, matchId), isNull(receiptMatches.unmatchedAt)))
      .for("update");
    if (!m) throw new NotFoundError("The match");
    await tx.update(receiptMatches).set({ unmatchedAt: new Date(), unmatchedBy: ctx.actor.userId }).where(eq(receiptMatches.id, m.id));
    if (m.linkedAttachmentId) {
      await tx.update(attachments).set({ deletedAt: new Date(), deletedBy: ctx.actor.userId }).where(and(eq(attachments.orgId, ctx.orgId), eq(attachments.id, m.linkedAttachmentId)));
    }
    await audit(tx, ctx, { action: "receipt.unmatched", entityType: "document", entityId: m.documentId, metadata: { attachmentId: m.attachmentId } });
  });
}

/** The inbox receipt matched to a document's attachment, if that is where it came from. */
export async function matchForLinkedAttachment(db: DbOrTx, orgId: string, documentId: string) {
  return db
    .select()
    .from(receiptMatches)
    .where(and(eq(receiptMatches.orgId, orgId), eq(receiptMatches.documentId, documentId), isNull(receiptMatches.unmatchedAt)));
}
