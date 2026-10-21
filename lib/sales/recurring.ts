/**
 * Recurring invoices. A template holds an invoice (without dates) and a
 * schedule; each occurrence becomes a draft invoice dated the occurrence
 * date, optionally issued and emailed.
 *
 * Each occurrence is produced exactly once: the template row is locked while
 * an occurrence is made, the occurrence is recorded in recurring_runs
 * (unique per template and date), and a document left behind by a run that
 * crashed before recording itself is found by its template and date rather
 * than made again. A failed occurrence is recorded and retried on the next
 * run; the schedule only advances past occurrences that were made.
 */
import { and, asc, desc, eq, lte, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { documents, recurringRuns, recurringTemplates } from "@/lib/db/schema/commerce";
import { contacts } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { addDays, addMonths, isIsoDate, todayIn } from "@/lib/dates";
import { issueDocument, saveDraft, type DocumentInput } from "@/lib/commerce/documents";
import { log } from "@/lib/log";
import { emailDocument } from "./documents";

export type RecurringTemplate = typeof recurringTemplates.$inferSelect;
export type Frequency = RecurringTemplate["frequency"];

export const FREQUENCY_LABELS: Record<Frequency, string> = { weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year" };

/** The n-th occurrence date (n = 0 is the start), anchored on the start date so month ends do not drift. */
export function occurrenceDate(start: string, frequency: Frequency, interval: number, n: number): string {
  switch (frequency) {
    case "weekly":
      return addDays(start, 7 * interval * n);
    case "monthly":
      return addMonths(start, interval * n);
    case "quarterly":
      return addMonths(start, 3 * interval * n);
    case "yearly":
      return addMonths(start, 12 * interval * n);
  }
}

export interface ScheduleInput {
  name: string;
  frequency: Frequency;
  interval: number;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  autoIssue: boolean;
  autoSend: boolean;
}

function validateSchedule(s: ScheduleInput) {
  const fields: Record<string, string> = {};
  if (!s.name?.trim()) fields.name = "Name the schedule.";
  if (!["weekly", "monthly", "quarterly", "yearly"].includes(s.frequency)) fields.frequency = "Choose how often.";
  if (!Number.isInteger(s.interval) || s.interval < 1 || s.interval > 52) fields.interval = "Every 1–52.";
  if (!isIsoDate(s.startDate)) fields.startDate = "Enter the first invoice date.";
  if (s.endDate && (!isIsoDate(s.endDate) || s.endDate < s.startDate)) fields.endDate = "On or after the start.";
  if (s.maxOccurrences != null && (!Number.isInteger(s.maxOccurrences) || s.maxOccurrences < 1)) fields.maxOccurrences = "A positive number, or blank.";
  if (s.autoSend && !s.autoIssue) fields.autoSend = "Only issued invoices can be sent; turn on issuing too.";
  if (Object.keys(fields).length) throw new ValidationError("Check the schedule.", fields);
}

async function validatePayload(db: DbOrTx, ctx: Ctx, input: DocumentInput) {
  const fields: Record<string, string> = {};
  if (!input.contactId) fields.contactId = "Choose a customer.";
  else {
    const [c] = await db.select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, input.contactId)));
    if (!c || !c.isCustomer) fields.contactId = "Choose a customer.";
  }
  if (!input.lines.length) fields.lines = "Add at least one line.";
  if (Object.keys(fields).length) throw new ValidationError("Check the invoice.", fields);
}

function payloadOf(input: DocumentInput): DocumentInput {
  return { ...input, kind: "invoice", issueDate: "1970-01-01", postingDate: null, dueDate: null, expiryDate: null, sourceDocumentId: null, recurringTemplateId: null };
}

/** Create a template (paused until its schedule is set and it is turned on). */
export async function createRecurringTemplate(ctx: Ctx, input: DocumentInput, schedule?: Partial<ScheduleInput>): Promise<RecurringTemplate> {
  requirePermission(ctx, "sales.manage");
  const db = getDb();
  await validatePayload(db, ctx, input);
  const startDate = schedule?.startDate ?? addMonths(todayIn(ctx.org.timezone), 1);
  const s: ScheduleInput = {
    name: schedule?.name ?? "Recurring invoice",
    frequency: schedule?.frequency ?? "monthly",
    interval: schedule?.interval ?? 1,
    startDate,
    endDate: schedule?.endDate ?? null,
    maxOccurrences: schedule?.maxOccurrences ?? null,
    autoIssue: schedule?.autoIssue ?? false,
    autoSend: schedule?.autoSend ?? false,
  };
  validateSchedule(s);
  return withTransaction(async (tx) => {
    const [row] = await tx
      .insert(recurringTemplates)
      .values({
        orgId: ctx.orgId,
        kind: "invoice",
        name: s.name.trim(),
        frequency: s.frequency,
        interval: s.interval,
        startDate: s.startDate,
        endDate: s.endDate ?? null,
        nextRunDate: s.startDate,
        maxOccurrences: s.maxOccurrences ?? null,
        autoIssue: s.autoIssue,
        autoSend: s.autoSend,
        template: payloadOf(input),
        status: schedule?.startDate ? "active" : "paused",
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "recurring.created", entityType: "recurring_template", entityId: row!.id, after: { ...s, status: row!.status } });
    return row!;
  });
}

export async function updateRecurringContent(ctx: Ctx, id: string, input: DocumentInput) {
  requirePermission(ctx, "sales.manage");
  const db = getDb();
  await validatePayload(db, ctx, input);
  await withTransaction(async (tx) => {
    const t = await lockTemplate(tx, ctx, id);
    await tx.update(recurringTemplates).set({ template: payloadOf(input), updatedAt: new Date() }).where(eq(recurringTemplates.id, id));
    await audit(tx, ctx, { action: "recurring.content_updated", entityType: "recurring_template", entityId: id, before: { template: t.template } });
  });
}

export async function updateRecurringSchedule(ctx: Ctx, id: string, s: ScheduleInput) {
  requirePermission(ctx, "sales.manage");
  validateSchedule(s);
  await withTransaction(async (tx) => {
    const t = await lockTemplate(tx, ctx, id);
    if (t.status === "ended") throw new ConflictError("This schedule has ended; create a new one.", "ended");
    // Before anything was made, the schedule simply restarts; after, the next date follows the new rule from the start date.
    const next = t.occurrences === 0 ? s.startDate : occurrenceDate(s.startDate, s.frequency, s.interval, t.occurrences);
    await tx
      .update(recurringTemplates)
      .set({
        name: s.name.trim(),
        frequency: s.frequency,
        interval: s.interval,
        startDate: s.startDate,
        endDate: s.endDate ?? null,
        maxOccurrences: s.maxOccurrences ?? null,
        autoIssue: s.autoIssue,
        autoSend: s.autoSend,
        nextRunDate: next,
        updatedAt: new Date(),
      })
      .where(eq(recurringTemplates.id, id));
    await audit(tx, ctx, { action: "recurring.schedule_updated", entityType: "recurring_template", entityId: id, before: t, after: { ...s, nextRunDate: next } });
  });
}

export async function setRecurringStatus(ctx: Ctx, id: string, status: "active" | "paused") {
  requirePermission(ctx, "sales.manage");
  await withTransaction(async (tx) => {
    const t = await lockTemplate(tx, ctx, id);
    if (t.status === "ended") throw new ConflictError("This schedule has ended.", "ended");
    await tx.update(recurringTemplates).set({ status, updatedAt: new Date() }).where(eq(recurringTemplates.id, id));
    await audit(tx, ctx, { action: status === "active" ? "recurring.resumed" : "recurring.paused", entityType: "recurring_template", entityId: id });
  });
}

export async function deleteRecurringTemplate(ctx: Ctx, id: string) {
  requirePermission(ctx, "sales.manage");
  await withTransaction(async (tx) => {
    const t = await lockTemplate(tx, ctx, id);
    if (t.occurrences > 0) {
      // Keep the history; just end it.
      await tx.update(recurringTemplates).set({ status: "ended", updatedAt: new Date() }).where(eq(recurringTemplates.id, id));
    } else {
      await tx.delete(recurringRuns).where(eq(recurringRuns.templateId, id));
      await tx.delete(recurringTemplates).where(eq(recurringTemplates.id, id));
    }
    await audit(tx, ctx, { action: "recurring.deleted", entityType: "recurring_template", entityId: id });
  });
}

async function lockTemplate(tx: Parameters<Parameters<typeof withTransaction>[0]>[0], ctx: Ctx, id: string) {
  const [t] = await tx
    .select()
    .from(recurringTemplates)
    .where(and(eq(recurringTemplates.orgId, ctx.orgId), eq(recurringTemplates.id, id), eq(recurringTemplates.kind, "invoice")))
    .for("update");
  if (!t) throw new NotFoundError("The recurring invoice");
  return t;
}

export interface RunResult {
  created: number;
  issued: number;
  sent: number;
  errors: string[];
}

/** Make every occurrence of one template due on or before `today`. */
export async function runTemplate(ctx: Ctx, templateId: string, today: string): Promise<RunResult> {
  const result: RunResult = { created: 0, issued: 0, sent: 0, errors: [] };
  for (let guard = 0; guard < 120; guard++) {
    const step = await withTransaction(async (tx) => {
      const [t] = await tx
        .select()
        .from(recurringTemplates)
        .where(and(eq(recurringTemplates.orgId, ctx.orgId), eq(recurringTemplates.id, templateId)))
        .for("update");
      if (!t || t.status !== "active" || !t.nextRunDate || t.nextRunDate > today) return null;
      const date = t.nextRunDate;
      if ((t.endDate && date > t.endDate) || (t.maxOccurrences != null && t.occurrences >= t.maxOccurrences)) {
        await tx.update(recurringTemplates).set({ status: "ended", updatedAt: new Date() }).where(eq(recurringTemplates.id, t.id));
        return null;
      }
      const [run] = await tx.select().from(recurringRuns).where(and(eq(recurringRuns.templateId, t.id), eq(recurringRuns.occurrenceDate, date)));
      let docId = run?.status === "created" ? run.documentId : null;
      if (!docId) {
        const [left] = await tx
          .select({ id: documents.id })
          .from(documents)
          .where(and(eq(documents.orgId, ctx.orgId), eq(documents.recurringTemplateId, t.id), eq(documents.issueDate, date), eq(documents.kind, "invoice")));
        docId = left?.id ?? null;
      }
      if (!docId) {
        try {
          const payload = t.template as DocumentInput;
          const doc = await saveDraft(ctx, { ...payload, kind: "invoice", issueDate: date, postingDate: null, dueDate: null, recurringTemplateId: t.id });
          docId = doc.id;
        } catch (e) {
          const message = (e as Error).message;
          await tx
            .insert(recurringRuns)
            .values({ orgId: ctx.orgId, templateId: t.id, occurrenceDate: date, status: "failed", error: message.slice(0, 1000) })
            .onConflictDoUpdate({ target: [recurringRuns.templateId, recurringRuns.occurrenceDate], set: { status: "failed", error: message.slice(0, 1000) } });
          await tx.update(recurringTemplates).set({ lastRunAt: new Date() }).where(eq(recurringTemplates.id, t.id));
          return { error: `${t.name} (${date}): ${message}` };
        }
      }
      await tx
        .insert(recurringRuns)
        .values({ orgId: ctx.orgId, templateId: t.id, occurrenceDate: date, status: "created", documentId: docId })
        .onConflictDoUpdate({ target: [recurringRuns.templateId, recurringRuns.occurrenceDate], set: { status: "created", documentId: docId, error: null } });
      const occurrences = t.occurrences + 1;
      const next = occurrenceDate(t.startDate, t.frequency, t.interval, occurrences);
      const ended = (t.maxOccurrences != null && occurrences >= t.maxOccurrences) || (t.endDate != null && next > t.endDate);
      await tx
        .update(recurringTemplates)
        .set({ occurrences, nextRunDate: next, lastRunAt: new Date(), status: ended ? "ended" : "active", updatedAt: new Date() })
        .where(eq(recurringTemplates.id, t.id));
      await audit(tx, ctx, { action: "recurring.occurrence_created", entityType: "recurring_template", entityId: t.id, metadata: { date, documentId: docId } });
      return { docId, date, autoIssue: t.autoIssue, autoSend: t.autoSend, name: t.name };
    });
    if (!step) break;
    if (step.error !== undefined) {
      result.errors.push(step.error);
      break;
    }
    result.created++;
    if (step.autoIssue && step.docId) {
      try {
        const [d] = await getDb().select().from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.id, step.docId)));
        if (d?.status === "draft") await issueDocument(ctx, step.docId, { idempotencyKey: `recurring:${templateId}:${step.date}` });
        result.issued++;
        if (step.autoSend) {
          const [c] = await getDb().select().from(contacts).where(and(eq(contacts.orgId, ctx.orgId), eq(contacts.id, d!.contactId!)));
          if (c?.email && !d?.sentAt) {
            await emailDocument(ctx, step.docId, { to: c.email });
            result.sent++;
          } else if (!c?.email) {
            result.errors.push(`${step.name} (${step.date}): the customer has no email address, so the invoice was issued but not sent.`);
          }
        }
      } catch (e) {
        const message = (e as Error).message;
        result.errors.push(`${step.name} (${step.date}): made as a draft but not issued — ${message}`);
        await getDb()
          .update(recurringRuns)
          .set({ error: `Draft made; issuing failed: ${message}`.slice(0, 1000) })
          .where(and(eq(recurringRuns.templateId, templateId), eq(recurringRuns.occurrenceDate, step.date)));
      }
    }
  }
  return result;
}

/** Run now (a person's "Run now" button): every due occurrence up to today. */
export async function runTemplateNow(ctx: Ctx, templateId: string) {
  requirePermission(ctx, "sales.manage");
  return runTemplate(ctx, templateId, todayIn(ctx.org.timezone));
}

/**
 * The scheduler's entry point (job `sales.recurring`): make every due
 * occurrence of every active recurring invoice, in each organization's own
 * time zone. Safe to run as often as wanted.
 */
export async function runDueRecurring(today?: string, orgId?: string): Promise<RunResult & { templates: number }> {
  const db = getDb();
  const conds = [eq(recurringTemplates.kind, "invoice"), eq(recurringTemplates.status, "active"), sql`${recurringTemplates.nextRunDate} is not null`];
  if (orgId) conds.push(eq(recurringTemplates.orgId, orgId));
  // A generous bound (the latest date anywhere on Earth); each organization's own today is applied below.
  const horizon = today ?? addDays(todayIn("UTC"), 1);
  conds.push(lte(recurringTemplates.nextRunDate, horizon));
  const due = await db.select({ id: recurringTemplates.id, orgId: recurringTemplates.orgId }).from(recurringTemplates).where(and(...conds)).orderBy(asc(recurringTemplates.orgId));
  const total: RunResult & { templates: number } = { created: 0, issued: 0, sent: 0, errors: [], templates: 0 };
  const ctxs = new Map<string, Ctx>();
  for (const t of due) {
    let ctx = ctxs.get(t.orgId);
    if (!ctx) {
      ctx = await systemCtx(t.orgId, "job: recurring invoices");
      ctxs.set(t.orgId, ctx);
    }
    const r = await runTemplate(ctx, t.id, today ?? todayIn(ctx.org.timezone));
    total.templates++;
    total.created += r.created;
    total.issued += r.issued;
    total.sent += r.sent;
    total.errors.push(...r.errors);
  }
  if (total.errors.length) log.warn("recurring invoices had problems", { errors: total.errors.slice(0, 20) });
  return total;
}

export async function listRecurring(db: DbOrTx, orgId: string) {
  return db
    .select({ t: recurringTemplates, contactName: contacts.displayName })
    .from(recurringTemplates)
    .leftJoin(contacts, and(eq(contacts.orgId, recurringTemplates.orgId), sql`${contacts.id}::text = ${recurringTemplates.template}->>'contactId'`))
    .where(and(eq(recurringTemplates.orgId, orgId), eq(recurringTemplates.kind, "invoice")))
    .orderBy(asc(recurringTemplates.status), asc(recurringTemplates.nextRunDate));
}

export async function getRecurring(db: DbOrTx, orgId: string, id: string) {
  const [t] = await db.select().from(recurringTemplates).where(and(eq(recurringTemplates.orgId, orgId), eq(recurringTemplates.id, id), eq(recurringTemplates.kind, "invoice")));
  if (!t) throw new NotFoundError("The recurring invoice");
  const runs = await db
    .select({ run: recurringRuns, number: documents.number, status: documents.status, total: documents.total, currency: documents.currency })
    .from(recurringRuns)
    .leftJoin(documents, and(eq(documents.orgId, recurringRuns.orgId), eq(documents.id, recurringRuns.documentId)))
    .where(and(eq(recurringRuns.orgId, orgId), eq(recurringRuns.templateId, id)))
    .orderBy(desc(recurringRuns.occurrenceDate))
    .limit(100);
  return { t, runs };
}
