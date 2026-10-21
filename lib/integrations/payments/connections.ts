/**
 * An organization's payment-provider connection (one active at a time):
 * Stripe with its own keys, or the local sandbox. Secrets are encrypted at
 * rest and never leave the server; the browser sees them masked.
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import { integrationConnections } from "@/lib/db/schema/core";
import { accounts } from "@/lib/db/schema/ledger";
import { audit } from "@/lib/audit";
import { requirePermission, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { decryptSecret, encryptSecret, maskSecret } from "@/lib/crypto/secrets";
import { systemAccountId } from "@/lib/ledger/accounts";
import { Decimal } from "@/lib/money/decimal";
import type { ConnectionConfig, ConnectionSecrets, PaymentProvider } from "./types";
import { stripeProvider } from "./stripe";
import { sandboxProvider } from "./sandbox";

export type PaymentConnection = typeof integrationConnections.$inferSelect;

export function providerFor(conn: Pick<PaymentConnection, "provider">): PaymentProvider {
  if (conn.provider === "stripe") return stripeProvider;
  if (conn.provider === "sandbox") return sandboxProvider;
  throw new Error(`unknown payment provider ${conn.provider}`);
}

export function connectionSecrets(conn: Pick<PaymentConnection, "secretEnc">): ConnectionSecrets {
  if (!conn.secretEnc) throw new Error("payment connection has no secrets");
  return JSON.parse(decryptSecret(conn.secretEnc)) as ConnectionSecrets;
}

export function connectionConfig(conn: Pick<PaymentConnection, "config">): ConnectionConfig {
  return (conn.config ?? {}) as ConnectionConfig;
}

export function webhookUrl(connId: string): string {
  return `${(process.env.APP_URL ?? "http://localhost:3200").replace(/\/$/, "")}/api/webhooks/payments/${connId}`;
}

/** What the settings page may show: never a secret, only its last characters. */
export function describeConnection(conn: PaymentConnection) {
  let apiKeyMasked = "";
  let webhookSecretMasked = "";
  try {
    const s = connectionSecrets(conn);
    apiKeyMasked = maskSecret(s.apiKey);
    webhookSecretMasked = maskSecret(s.webhookSecret);
  } catch {
    // shown as not set
  }
  const cfg = connectionConfig(conn);
  return {
    id: conn.id,
    provider: conn.provider,
    mode: conn.mode,
    status: conn.status,
    displayName: conn.displayName,
    testMode: conn.provider === "stripe" && apiKeyMasked !== "" && !!(conn.config as { testMode?: boolean }).testMode,
    apiKeyMasked,
    webhookSecretMasked,
    webhookUrl: webhookUrl(conn.id),
    clearingAccountId: cfg.clearingAccountId ?? null,
    bankAccountId: cfg.bankAccountId ?? null,
    feeAccountId: cfg.feeAccountId ?? null,
    lastError: conn.lastError,
    lastSyncedAt: conn.lastSyncedAt,
    createdAt: conn.createdAt,
  };
}

export async function listPaymentConnections(db: DbOrTx, orgId: string): Promise<PaymentConnection[]> {
  return db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.kind, "payments")))
    .orderBy(desc(integrationConnections.createdAt));
}

export async function activePaymentConnection(db: DbOrTx, orgId: string): Promise<PaymentConnection | null> {
  const [c] = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.kind, "payments"), eq(integrationConnections.status, "active")))
    .orderBy(desc(integrationConnections.createdAt))
    .limit(1);
  return c ?? null;
}

async function checkAccount(tx: Tx, ctx: Ctx, id: string | null | undefined, kinds: string[], label: string): Promise<string | null> {
  if (!id) return null;
  const [a] = await tx.select().from(accounts).where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.id, id)));
  if (!a || !kinds.includes(a.subtype) || a.isArchived) throw new ValidationError(`Choose a ${label}.`, { [label.replace(/ /g, "")]: "Not a suitable account." });
  return a.id;
}

interface CommonInput {
  clearingAccountId?: string | null;
  bankAccountId?: string | null;
  feeAccountId?: string | null;
}

async function insertConnection(tx: Tx, ctx: Ctx, provider: "stripe" | "sandbox", secrets: ConnectionSecrets, input: CommonInput, extra: Record<string, unknown>) {
  const existing = await activePaymentConnection(tx, ctx.orgId);
  if (existing) throw new ConflictError(`A ${providerFor(existing).label} connection is already active. Disconnect it first.`, "already_connected");
  const clearingAccountId = (await checkAccount(tx, ctx, input.clearingAccountId, ["clearing", "bank"], "clearing account")) ?? (await systemAccountId(tx, ctx.orgId, "payment_clearing"));
  const bankAccountId = await checkAccount(tx, ctx, input.bankAccountId, ["bank"], "bank account");
  const feeAccountId = input.feeAccountId ?? (await systemAccountId(tx, ctx.orgId, "payment_fees"));
  const [row] = await tx
    .insert(integrationConnections)
    .values({
      orgId: ctx.orgId,
      kind: "payments",
      provider,
      mode: provider === "sandbox" ? "sandbox" : "live",
      status: "active",
      displayName: provider === "sandbox" ? "Sandbox payments (no real money)" : `Stripe${extra.testMode ? " (test mode)" : ""}`,
      config: { clearingAccountId, bankAccountId, feeAccountId, ...extra },
      secretEnc: encryptSecret(JSON.stringify(secrets)),
      createdBy: ctx.actor.userId,
    })
    .returning();
  await audit(tx, ctx, {
    action: "integration.payments_connected",
    entityType: "integration_connection",
    entityId: row!.id,
    metadata: { provider, clearingAccountId, bankAccountId, feeAccountId },
  });
  return row!;
}

export async function connectStripe(ctx: Ctx, input: CommonInput & { apiKey: string; webhookSecret: string }): Promise<PaymentConnection> {
  requirePermission(ctx, "integrations.manage");
  if (ctx.org.isDemo) throw new ValidationError("A demonstration company can only use the sandbox provider.");
  const fields: Record<string, string> = {};
  const apiKey = input.apiKey?.trim() ?? "";
  const webhookSecret = input.webhookSecret?.trim() ?? "";
  if (!/^(sk|rk)_(live|test)_[A-Za-z0-9]{10,}$/.test(apiKey)) fields.apiKey = "Paste a Stripe secret or restricted key (sk_live_…, sk_test_…, rk_…).";
  if (!/^whsec_[A-Za-z0-9+/=]{10,}$/.test(webhookSecret)) fields.webhookSecret = "Paste the endpoint's signing secret (whsec_…).";
  if (Object.keys(fields).length) throw new ValidationError("Check the Stripe keys.", fields);
  return withTransaction((tx) => insertConnection(tx, ctx, "stripe", { apiKey, webhookSecret }, input, { testMode: apiKey.includes("_test_") }));
}

export async function connectSandbox(ctx: Ctx, input: CommonInput & { feePercent?: string | null; feeFixedMinor?: number | null }): Promise<PaymentConnection> {
  requirePermission(ctx, "integrations.manage");
  const pct = input.feePercent ? Decimal.tryFrom(input.feePercent) : Decimal.from("2.9");
  if (!pct || pct.isNegative() || pct.gt(20)) throw new ValidationError("Enter a sandbox fee between 0% and 20%.", { feePercent: "0–20." });
  const webhookSecret = `whsec_sandbox_${randomBytes(24).toString("base64url")}`;
  return withTransaction((tx) =>
    insertConnection(tx, ctx, "sandbox", { webhookSecret }, input, {
      sandboxFeeRate: pct.div(100, 6, "half_up").toString(),
      sandboxFeeFixedMinor: input.feeFixedMinor ?? 30,
    }),
  );
}

export async function updatePaymentConnectionAccounts(ctx: Ctx, id: string, input: CommonInput): Promise<void> {
  requirePermission(ctx, "integrations.manage");
  await withTransaction(async (tx) => {
    const [conn] = await tx.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, ctx.orgId), eq(integrationConnections.id, id)));
    if (!conn || conn.kind !== "payments") throw new NotFoundError("The payment connection");
    const cfg = connectionConfig(conn);
    const next = {
      ...cfg,
      clearingAccountId: (await checkAccount(tx, ctx, input.clearingAccountId, ["clearing", "bank"], "clearing account")) ?? cfg.clearingAccountId,
      bankAccountId: (await checkAccount(tx, ctx, input.bankAccountId, ["bank"], "bank account")) ?? cfg.bankAccountId ?? null,
      feeAccountId: input.feeAccountId || cfg.feeAccountId,
    };
    await tx.update(integrationConnections).set({ config: next, updatedAt: new Date() }).where(eq(integrationConnections.id, id));
    await audit(tx, ctx, { action: "integration.payments_updated", entityType: "integration_connection", entityId: id, before: cfg, after: next });
  });
}

export async function disconnectPaymentConnection(ctx: Ctx, id: string): Promise<void> {
  requirePermission(ctx, "integrations.manage");
  await withTransaction(async (tx) => {
    const [conn] = await tx.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, ctx.orgId), eq(integrationConnections.id, id)));
    if (!conn || conn.kind !== "payments") throw new NotFoundError("The payment connection");
    await tx.update(integrationConnections).set({ status: "disconnected", updatedAt: new Date() }).where(eq(integrationConnections.id, id));
    await audit(tx, ctx, { action: "integration.payments_disconnected", entityType: "integration_connection", entityId: id });
  });
}

export async function getPaymentConnection(db: DbOrTx, orgId: string, id: string): Promise<PaymentConnection> {
  const [conn] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.id, id)));
  if (!conn || conn.kind !== "payments") throw new NotFoundError("The payment connection");
  return conn;
}
