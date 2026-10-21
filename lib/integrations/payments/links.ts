/**
 * Payment links: a checkout at the connected provider for what is open on
 * an invoice. Creating a link moves no money; the customer pays through the
 * provider's own checkout (or the sandbox page, which moves none at all).
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { documents } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { paymentLinks } from "@/lib/db/schema/sales";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { itemBalance } from "@/lib/commerce/open-items";
import { activePaymentConnection, connectionConfig, connectionSecrets, providerFor } from "./connections";

export type PaymentLink = typeof paymentLinks.$inferSelect;

function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3200").replace(/\/$/, "");
}

export async function createPaymentLink(ctx: Ctx, invoiceId: string): Promise<PaymentLink> {
  requirePermission(ctx, "sales.issue");
  const db = getDb();
  const [inv] = await db.select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, invoiceId)));
  if (!inv || inv.kind !== "invoice") throw new NotFoundError("The invoice");
  if (!["issued", "partially_paid"].includes(inv.status)) throw new ConflictError("Only an issued invoice with a balance can be paid online.", "not_payable");
  const open = (await itemBalance(db, ctx.orgId, invoiceId)).txn;
  if (!open.isPositive()) throw new ConflictError("Nothing is open on this invoice.", "nothing_open");
  const conn = await activePaymentConnection(db, ctx.orgId);
  if (!conn) throw new ValidationError("Connect a payment provider first (Settings → Integrations).");
  if (ctx.org.isDemo && conn.provider !== "sandbox") throw new ValidationError("A demonstration company can only take sandbox payments.");
  const [existing] = await db
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.orgId, ctx.orgId), eq(paymentLinks.documentId, invoiceId), eq(paymentLinks.connectionId, conn.id), eq(paymentLinks.status, "open")))
    .orderBy(desc(paymentLinks.createdAt))
    .limit(1);
  if (existing && open.eq(existing.amount)) return existing;
  const [contact] = inv.contactId ? await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, inv.contactId))) : [];
  const provider = providerFor(conn);
  const token = randomBytes(24).toString("base64url");
  const linkId = crypto.randomUUID();
  const result = await provider.createCheckout(
    {
      orgId: ctx.orgId,
      invoiceId,
      linkId,
      invoiceNumber: inv.number ?? "",
      orgName: ctx.org.name,
      currency: inv.currency,
      amount: open,
      customerEmail: contact?.email ?? null,
      successUrl: `${appUrl()}/pay/${token}?done=1`,
      cancelUrl: `${appUrl()}/pay/${token}?cancelled=1`,
    },
    connectionSecrets(conn),
    connectionConfig(conn),
  );
  return withTransaction(async (tx) => {
    if (existing) await tx.update(paymentLinks).set({ status: "expired" }).where(eq(paymentLinks.id, existing.id));
    const [row] = await tx
      .insert(paymentLinks)
      .values({
        id: linkId,
        orgId: ctx.orgId,
        documentId: invoiceId,
        connectionId: conn.id,
        provider: conn.provider,
        token,
        providerSessionId: result.sessionId,
        url: result.url || `${appUrl()}/pay/${token}`,
        currency: inv.currency,
        amount: open.toString(),
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "invoice.payment_link_created", entityType: "document", entityId: invoiceId, metadata: { provider: conn.provider, amount: open.toString(), linkId } });
    return row!;
  });
}

export async function paymentLinksFor(db: DbOrTx, orgId: string, documentId: string): Promise<PaymentLink[]> {
  return db.select().from(paymentLinks).where(and(eq(paymentLinks.orgId, orgId), eq(paymentLinks.documentId, documentId))).orderBy(desc(paymentLinks.createdAt));
}

/** The open link for an invoice, if any (shown on the invoice and its PDF). */
export async function openPaymentLink(db: DbOrTx, orgId: string, documentId: string): Promise<PaymentLink | null> {
  const [l] = await db
    .select()
    .from(paymentLinks)
    .where(and(eq(paymentLinks.orgId, orgId), eq(paymentLinks.documentId, documentId), eq(paymentLinks.status, "open")))
    .orderBy(desc(paymentLinks.createdAt))
    .limit(1);
  return l ?? null;
}

export async function linkByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [l] = await getDb().select().from(paymentLinks).where(eq(paymentLinks.token, token));
  return l ?? null;
}
