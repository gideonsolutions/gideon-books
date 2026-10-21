/**
 * Identity, organizations, membership, audit, idempotency, jobs, attachments,
 * email and integration settings.
 */
import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  unique,
  uuid,
  bigint,
} from "drizzle-orm/pg-core";
import { createdAt, currencyCode, day, id, orgId, ts, updatedAt } from "./_columns";

// ── People ──────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    /** scrypt$N$r$p$salt$hash (lib/auth/password.ts). */
    passwordHash: text("password_hash"),
    /** TOTP secret, encrypted (lib/crypto/secrets.ts). */
    totpSecretEnc: text("totp_secret_enc"),
    totpEnabledAt: ts("totp_enabled_at"),
    /** May create organizations on an instance that restricts sign-up, and see instance health. */
    isInstanceAdmin: boolean("is_instance_admin").notNull().default(false),
    emailVerifiedAt: ts("email_verified_at"),
    disabledAt: ts("disabled_at"),
    lastLoginAt: ts("last_login_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the cookie token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Password checked but the second factor not yet: the session can only finish signing in. */
    pendingMfa: boolean("pending_mfa").notNull().default(false),
    createdAt: createdAt(),
    expiresAt: ts("expires_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
    revokedAt: ts("revoked_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One-time tokens: email verification, password reset. */
export const userTokens = pgTable(
  "user_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    purpose: text("purpose", { enum: ["password_reset", "email_verification"] }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
);

/** Sliding-window counters for sign-in throttling, keyed by account and by address. */
export const authThrottle = pgTable("auth_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: ts("window_started_at").notNull().defaultNow(),
  lockedUntil: ts("locked_until"),
});

// ── Organizations ───────────────────────────────────────────────────────────

export const ROLES = ["owner", "admin", "accountant", "staff", "read_only"] as const;
export type Role = (typeof ROLES)[number];

export const organizations = pgTable(
  "organizations",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    /** ISO 4217. Fixed once anything is posted. */
    baseCurrency: currencyCode("base_currency").notNull(),
    country: text("country").notNull().default("US"),
    timezone: text("timezone").notNull().default("America/New_York"),
    /** First month of the fiscal year, 1–12. */
    fiscalYearStartMonth: integer("fiscal_year_start_month").notNull().default(1),
    /** Default basis for reports; both are always available. */
    reportingBasis: text("reporting_basis", { enum: ["accrual", "cash"] }).notNull().default("accrual"),
    /** The first day the books in Gideon cover. Opening balances are dated the day before. */
    booksStartDate: day("books_start_date"),
    /** Nothing may be posted on or before this date (a hard lock above period status). */
    lockDate: day("lock_date"),
    /** Demonstration company: never mixed with real books, never connected to live providers. */
    isDemo: boolean("is_demo").notNull().default(false),
    entityType: text("entity_type", {
      enum: ["sole_proprietorship", "partnership", "llc", "s_corporation", "c_corporation", "nonprofit", "trust", "estate", "other"],
    })
      .notNull()
      .default("llc"),
    /** Tax rounding: per line, or per document on summed bases. */
    taxRounding: text("tax_rounding", { enum: ["line", "document"] }).notNull().default("line"),
    /** Allow bank rules marked auto-post to post without review (an administrator turns it on). */
    bankRulesAutoPost: boolean("bank_rules_auto_post").notNull().default(false),
    onboardingCompletedAt: ts("onboarding_completed_at"),
    /** Address, contact details and branding for documents. */
    profile: jsonb("profile").$type<OrgProfile>().notNull().default({}),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("org_fy_month", sql`${t.fiscalYearStartMonth} between 1 and 12`),
    check("org_slug_format", sql`${t.slug} ~ '^[a-z0-9][a-z0-9-]{1,62}$'`),
  ],
);

export interface OrgProfile {
  email?: string;
  phone?: string;
  website?: string;
  taxId?: string;
  address?: { line1?: string; line2?: string; city?: string; region?: string; postalCode?: string; country?: string };
  branding?: {
    /** Attachment id of the logo. */
    logoAttachmentId?: string;
    accentColor?: string;
    invoiceFooter?: string;
    paymentInstructions?: string;
  };
}

export const memberships = pgTable(
  "memberships",
  {
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    invitedBy: uuid("invited_by"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role", { enum: ROLES }).notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    revokedAt: ts("revoked_at"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId)],
);

/** API tokens act for a user within one organization, with a role no higher than theirs. */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters, shown so a person can tell tokens apart. */
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    role: text("role", { enum: ROLES }).notNull(),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("api_tokens_org_idx").on(t.orgId)],
);

// ── Audit ───────────────────────────────────────────────────────────────────

/**
 * Append-only (a trigger refuses UPDATE and DELETE). Every consequential
 * change records who, when, what, from where and why.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: uuid("org_id"),
    actorUserId: uuid("actor_user_id"),
    actorType: text("actor_type", { enum: ["user", "api_token", "system", "job", "webhook"] }).notNull(),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    source: text("source", { enum: ["ui", "api", "job", "import", "webhook", "system", "cli"] }).notNull(),
    reason: text("reason"),
    before: jsonb("before"),
    after: jsonb("after"),
    metadata: jsonb("metadata"),
    ip: text("ip"),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_org_created_idx").on(t.orgId, t.createdAt),
    index("audit_entity_idx").on(t.orgId, t.entityType, t.entityId),
  ],
);

// ── Idempotency ─────────────────────────────────────────────────────────────

/**
 * A request carrying an Idempotency-Key is answered once: a repeat with the
 * same key and body gets the stored response; the same key with a different
 * body is refused.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    orgId: uuid("org_id").notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status", { enum: ["in_progress", "completed"] }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.scope, t.key] })],
);

// ── Jobs ────────────────────────────────────────────────────────────────────

/**
 * Durable background work. Workers claim with SELECT … FOR UPDATE SKIP
 * LOCKED; a failed attempt is retried with backoff up to max_attempts, then
 * marked dead. `dedupe_key` makes enqueueing idempotent.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    orgId: uuid("org_id"),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status", { enum: ["queued", "running", "succeeded", "failed", "dead", "cancelled"] })
      .notNull()
      .default("queued"),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lastError: text("last_error"),
    lockedBy: text("locked_by"),
    lockedAt: ts("locked_at"),
    dedupeKey: text("dedupe_key"),
    result: jsonb("result"),
    progress: jsonb("progress"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey),
    index("jobs_claim_idx").on(t.status, t.runAt),
    index("jobs_org_idx").on(t.orgId, t.createdAt),
  ],
);

// ── Attachments ─────────────────────────────────────────────────────────────

/**
 * A file attached to any record. Bytes live in storage (lib/storage) under a
 * key that includes the organization; downloads go through an authorized
 * route, never a public URL.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    storageKey: text("storage_key").notNull(),
    /** Where it came from: an upload, a Gideon Keep reference, an email, an import. */
    origin: text("origin", { enum: ["upload", "keep", "import", "generated", "email"] }).notNull().default("upload"),
    externalRef: text("external_ref"),
    uploadedBy: uuid("uploaded_by"),
    createdAt: createdAt(),
    deletedAt: ts("deleted_at"),
    deletedBy: uuid("deleted_by"),
  },
  (t) => [unique("attachments_org_id_uq").on(t.orgId, t.id), index("attachments_entity_idx").on(t.orgId, t.entityType, t.entityId)],
);

// ── Email ───────────────────────────────────────────────────────────────────

/** Every message the application sends, with its delivery history. */
export const emailMessages = pgTable(
  "email_messages",
  {
    id: id(),
    orgId: uuid("org_id"),
    /** smtp | resend | outbox (the local outbox delivers nothing) */
    provider: text("provider").notNull(),
    toAddress: text("to_address").notNull(),
    ccAddress: text("cc_address"),
    fromAddress: text("from_address").notNull(),
    replyTo: text("reply_to"),
    subject: text("subject").notNull(),
    textBody: text("text_body").notNull(),
    htmlBody: text("html_body"),
    /** Attachment ids sent with the message. */
    attachmentIds: jsonb("attachment_ids").$type<string[]>().notNull().default([]),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    status: text("status", { enum: ["queued", "sending", "sent", "failed", "delivered", "bounced", "not_delivered"] })
      .notNull()
      .default("queued"),
    providerMessageId: text("provider_message_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    sentAt: ts("sent_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
  },
  (t) => [index("email_org_idx").on(t.orgId, t.createdAt), index("email_entity_idx").on(t.orgId, t.entityType, t.entityId)],
);

export const emailEvents = pgTable(
  "email_events",
  {
    id: id(),
    messageId: uuid("message_id")
      .notNull()
      .references(() => emailMessages.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    detail: text("detail"),
    createdAt: createdAt(),
  },
  (t) => [index("email_events_msg_idx").on(t.messageId)],
);

// ── Integrations ────────────────────────────────────────────────────────────

/**
 * A connection to an outside provider for one organization. Secrets are
 * encrypted at rest (lib/crypto/secrets.ts) and never returned to a browser;
 * `config` holds only non-secret settings. `mode` says whether it is the real
 * provider or the clearly labeled local sandbox.
 */
export const integrationConnections = pgTable(
  "integration_connections",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    kind: text("kind", { enum: ["payments", "bank_feed", "fx_rates", "payroll", "email", "gideon_tax", "gideon_keep"] }).notNull(),
    provider: text("provider").notNull(),
    mode: text("mode", { enum: ["live", "sandbox"] }).notNull(),
    status: text("status", { enum: ["active", "error", "disconnected"] }).notNull().default("active"),
    displayName: text("display_name").notNull(),
    config: jsonb("config").notNull().default({}),
    secretEnc: text("secret_enc"),
    lastError: text("last_error"),
    lastSyncedAt: ts("last_synced_at"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("integration_org_id_uq").on(t.orgId, t.id), index("integration_org_kind_idx").on(t.orgId, t.kind)],
);

/**
 * Incoming webhook events, recorded before they are acted on. The unique
 * (provider, event id) refuses a replay; processing is a job.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    orgId: uuid("org_id"),
    connectionId: uuid("connection_id"),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").notNull(),
    signatureVerified: boolean("signature_verified").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    status: text("status", { enum: ["received", "processed", "ignored", "failed"] }).notNull().default("received"),
    processedAt: ts("processed_at"),
    error: text("error"),
  },
  (t) => [uniqueIndex("webhook_provider_event_uq").on(t.provider, t.eventId), index("webhook_org_idx").on(t.orgId, t.receivedAt)],
);

// ── Numbering ───────────────────────────────────────────────────────────────

/** Per-organization counters for entry and document numbers; the row lock serializes concurrent issuers. */
export const numberSequences = pgTable(
  "number_sequences",
  {
    orgId: orgId().references(() => organizations.id),
    key: text("key").notNull(),
    prefix: text("prefix").notNull().default(""),
    nextValue: integer("next_value").notNull().default(1),
    padding: integer("padding").notNull().default(4),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.key] })],
);

/** Hosted-only: a lightweight per-organization usage counter is in schema/hosted.ts. */
export const instanceSettings = pgTable("instance_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

