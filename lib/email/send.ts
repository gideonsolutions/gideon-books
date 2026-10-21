/**
 * Outgoing email: queued as a row (the delivery history), delivered by a
 * job through the configured provider.
 *
 * EMAIL_PROVIDER:
 *   outbox (default) — nothing is sent; messages are kept and shown under
 *                      Settings → Email as "not delivered". Safe for development
 *                      and the only provider a demonstration company ever uses.
 *   smtp             — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_SECURE
 *   resend           — RESEND_API_KEY
 * EMAIL_FROM sets the sender ("Gideon Books <books@example.com>").
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import nodemailer from "nodemailer";
import { getDb, type DbOrTx, type Tx } from "@/lib/db/client";
import { attachments, emailEvents, emailMessages, organizations } from "@/lib/db/schema/core";
import { audit } from "@/lib/audit";
import type { Ctx } from "@/lib/context";
import { ValidationError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs/queue";
import { storage } from "@/lib/storage/storage";
import { log } from "@/lib/log";
import { assertWithinLimit, recordUsage } from "@/lib/hosted/metering";

export type EmailMessage = typeof emailMessages.$inferSelect;

export interface OutgoingAttachment {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface EmailProvider {
  name: string;
  /** Whether this provider actually delivers mail. */
  delivers: boolean;
  send(msg: { from: string; to: string; cc?: string | null; replyTo?: string | null; subject: string; text: string; html?: string | null; attachments: OutgoingAttachment[] }): Promise<{ providerMessageId: string | null }>;
}

const outboxProvider: EmailProvider = {
  name: "outbox",
  delivers: false,
  async send() {
    return { providerMessageId: null };
  },
};

function smtpProvider(): EmailProvider {
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error("EMAIL_PROVIDER=smtp needs SMTP_HOST");
  const transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? "" } } : {}),
  });
  return {
    name: "smtp",
    delivers: true,
    async send(m) {
      const info = await transport.sendMail({
        from: m.from,
        to: m.to,
        ...(m.cc ? { cc: m.cc } : {}),
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        subject: m.subject,
        text: m.text,
        ...(m.html ? { html: m.html } : {}),
        attachments: m.attachments.map((a) => ({ filename: a.fileName, content: a.bytes, contentType: a.contentType })),
      });
      return { providerMessageId: info.messageId ?? null };
    },
  };
}

function resendProvider(): EmailProvider {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY");
  return {
    name: "resend",
    delivers: true,
    async send(m) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: m.from,
          to: [m.to],
          ...(m.cc ? { cc: [m.cc] } : {}),
          ...(m.replyTo ? { reply_to: m.replyTo } : {}),
          subject: m.subject,
          text: m.text,
          ...(m.html ? { html: m.html } : {}),
          attachments: m.attachments.map((a) => ({ filename: a.fileName, content: a.bytes.toString("base64") })),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok) throw new Error(`Resend answered ${res.status}: ${body.message ?? "error"}`);
      return { providerMessageId: body.id ?? null };
    },
  };
}

let override: EmailProvider | null = null;
export function setEmailProviderForTests(p: EmailProvider | null) {
  override = p;
}

export function configuredEmailProvider(): EmailProvider {
  if (override) return override;
  const name = (process.env.EMAIL_PROVIDER ?? "outbox").toLowerCase();
  if (name === "smtp") return smtpProvider();
  if (name === "resend") return resendProvider();
  return outboxProvider;
}

export function emailFrom(): string {
  return process.env.EMAIL_FROM ?? "Gideon Books <no-reply@localhost>";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Queue a message (and its delivery job). Demonstration companies always use
 * the outbox, so nobody real ever receives demo mail.
 */
export async function queueEmail(
  db: DbOrTx | Tx,
  ctx: Ctx | null,
  input: {
    orgId?: string | null;
    to: string;
    cc?: string | null;
    replyTo?: string | null;
    subject: string;
    text: string;
    html?: string | null;
    attachmentIds?: string[];
    entityType?: string | null;
    entityId?: string | null;
  },
): Promise<EmailMessage> {
  if (!EMAIL_RE.test(input.to.trim())) throw new ValidationError("That is not an email address.", { to: "Invalid address." });
  if (input.cc && !EMAIL_RE.test(input.cc.trim())) throw new ValidationError("The copy address is not an email address.", { cc: "Invalid address." });
  const orgId = input.orgId ?? ctx?.orgId ?? null;
  let isDemo = ctx?.org.isDemo ?? false;
  if (orgId && !ctx) {
    const [o] = await db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, orgId));
    isDemo = !!o?.isDemo;
  }
  const provider = isDemo ? outboxProvider : configuredEmailProvider();
  if (orgId && provider.delivers) await assertWithinLimit(db, orgId, "emails_sent", 1);
  const [msg] = await db
    .insert(emailMessages)
    .values({
      orgId,
      provider: provider.name,
      toAddress: input.to.trim(),
      ccAddress: input.cc?.trim() || null,
      fromAddress: emailFrom(),
      replyTo: input.replyTo ?? null,
      subject: input.subject.slice(0, 300),
      textBody: input.text,
      htmlBody: input.html ?? null,
      attachmentIds: input.attachmentIds ?? [],
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      status: "queued",
      createdBy: ctx?.actor.userId ?? null,
    })
    .returning();
  await db.insert(emailEvents).values({ messageId: msg!.id, status: "queued", detail: provider.delivers ? `via ${provider.name}` : "local outbox: will not be delivered" });
  await enqueue(db, "email.send", { messageId: msg!.id }, { orgId, dedupeKey: `email:${msg!.id}`, maxAttempts: 6 });
  if (ctx) {
    await audit(db, ctx, { action: "email.queued", entityType: input.entityType ?? "email", entityId: input.entityId ?? msg!.id, metadata: { to: msg!.toAddress, subject: msg!.subject, provider: provider.name } });
  }
  return msg!;
}

/** Deliver one queued message (the email.send job). Idempotent: a sent message is not sent again. */
export async function deliverEmail(messageId: string) {
  const db = getDb();
  const [msg] = await db.select().from(emailMessages).where(eq(emailMessages.id, messageId));
  if (!msg) return { skipped: "missing" };
  if (msg.status === "sent" || msg.status === "delivered" || msg.status === "not_delivered") return { skipped: msg.status };
  let isDemo = false;
  if (msg.orgId) {
    const [o] = await db.select({ isDemo: organizations.isDemo }).from(organizations).where(eq(organizations.id, msg.orgId));
    isDemo = !!o?.isDemo;
  }
  const provider = isDemo || msg.provider === "outbox" ? outboxProvider : configuredEmailProvider();
  const files: OutgoingAttachment[] = [];
  if (msg.attachmentIds.length && msg.orgId) {
    const rows = await db.select().from(attachments).where(and(eq(attachments.orgId, msg.orgId), inArray(attachments.id, msg.attachmentIds)));
    for (const r of rows) files.push({ fileName: r.fileName, contentType: r.contentType, bytes: await storage().get(r.storageKey) });
  }
  await db.update(emailMessages).set({ status: "sending", attempts: msg.attempts + 1 }).where(eq(emailMessages.id, msg.id));
  try {
    const r = await provider.send({
      from: msg.fromAddress,
      to: msg.toAddress,
      cc: msg.ccAddress,
      replyTo: msg.replyTo,
      subject: msg.subject,
      text: msg.textBody,
      html: msg.htmlBody,
      attachments: files,
    });
    const status = provider.delivers ? "sent" : "not_delivered";
    if (msg.orgId && provider.delivers) await recordUsage(db, msg.orgId, "emails_sent", 1, msg.id);
    await db.update(emailMessages).set({ status, providerMessageId: r.providerMessageId, sentAt: provider.delivers ? new Date() : null, lastError: null }).where(eq(emailMessages.id, msg.id));
    await db.insert(emailEvents).values({ messageId: msg.id, status, detail: provider.delivers ? `accepted by ${provider.name}` : "kept in the local outbox; no email was sent" });
    return { status };
  } catch (err) {
    const message = (err as Error).message;
    await db.update(emailMessages).set({ status: "failed", lastError: message.slice(0, 1000) }).where(eq(emailMessages.id, msg.id));
    await db.insert(emailEvents).values({ messageId: msg.id, status: "failed", detail: message.slice(0, 1000) });
    log.warn("email delivery failed", { messageId: msg.id, provider: provider.name, error: message });
    throw err;
  }
}

export async function listEmails(db: DbOrTx, orgId: string, opts: { entityType?: string; entityId?: string; limit?: number } = {}) {
  const conds = [eq(emailMessages.orgId, orgId)];
  if (opts.entityType) conds.push(eq(emailMessages.entityType, opts.entityType));
  if (opts.entityId) conds.push(eq(emailMessages.entityId, opts.entityId));
  return db.select().from(emailMessages).where(and(...conds)).orderBy(desc(emailMessages.createdAt)).limit(opts.limit ?? 100);
}

export async function emailHistory(db: DbOrTx, messageId: string) {
  return db.select().from(emailEvents).where(eq(emailEvents.messageId, messageId)).orderBy(emailEvents.createdAt);
}

/** Whether the instance can actually deliver mail (for the UI to say so plainly). */
export function emailDeliveryConfigured(): boolean {
  try {
    return configuredEmailProvider().delivers;
  } catch {
    return false;
  }
}

/** Escape text for the simple HTML bodies we send. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
