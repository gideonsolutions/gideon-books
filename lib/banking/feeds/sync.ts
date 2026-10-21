/**
 * Bank-feed connections and syncing. A connection is an
 * `integration_connections` row (kind "bank_feed") whose secret is
 * encrypted; its accounts are linked one-to-one to money accounts. A sync
 * fetches recent transactions for linked accounts and adds the ones not seen
 * before (by the provider's transaction id) as an import batch with every
 * provider record kept verbatim. Syncing is idempotent and metered (hosted).
 */
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx } from "@/lib/db/client";
import { integrationConnections } from "@/lib/db/schema/core";
import { bankFeedAccounts, bankImportBatches, bankImportRows, bankTransactions } from "@/lib/db/schema/banking";
import { audit } from "@/lib/audit";
import { requirePermission, systemCtx, type Ctx } from "@/lib/context";
import { ConflictError, NotFoundError, ValidationError, isAppError } from "@/lib/errors";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { Decimal } from "@/lib/money/decimal";
import { minorUnits } from "@/lib/money/currency";
import { addDays, todayIn } from "@/lib/dates";
import { assertWithinLimit, recordUsage } from "@/lib/hosted/metering";
import { log } from "@/lib/log";
import { fingerprint, loadMoneyAccount } from "../common";
import { normalizeDescription } from "../csv";
import { applyRulesToTransactions } from "../rules";
import { simplefinProvider } from "./simplefin";
import { sandboxFeedProvider } from "./sandbox";
import type { FeedProvider } from "./types";

export type FeedConnection = typeof integrationConnections.$inferSelect;
export type FeedAccountRow = typeof bankFeedAccounts.$inferSelect;

export const FEED_PROVIDERS: Record<string, FeedProvider> = { simplefin: simplefinProvider, sandbox: sandboxFeedProvider };

/** How far back the first sync reaches, and how much each later sync overlaps. */
export const FIRST_SYNC_DAYS = 90;
export const OVERLAP_DAYS = 10;

export async function listFeedConnections(db: DbOrTx, orgId: string) {
  const conns = await db
    .select()
    .from(integrationConnections)
    .where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.kind, "bank_feed"), ne(integrationConnections.status, "disconnected")))
    .orderBy(asc(integrationConnections.createdAt));
  const accts = conns.length
    ? await db.select().from(bankFeedAccounts).where(and(eq(bankFeedAccounts.orgId, orgId), inArray(bankFeedAccounts.connectionId, conns.map((c) => c.id)))).orderBy(asc(bankFeedAccounts.name))
    : [];
  return conns.map((c) => ({ connection: c, accounts: accts.filter((a) => a.connectionId === c.id) }));
}

/** Connect a provider: SimpleFIN with a setup token, or the sandbox. Demonstration organizations may only use the sandbox. */
export async function connectFeed(ctx: Ctx, input: { provider: "simplefin" | "sandbox"; setupToken?: string | null }): Promise<FeedConnection> {
  requirePermission(ctx, "integrations.manage");
  const provider = FEED_PROVIDERS[input.provider];
  if (!provider) throw new ValidationError("Choose a provider.", { provider: "Unknown provider." });
  if (ctx.org.isDemo && provider.mode !== "sandbox") throw new ValidationError("A demonstration company can only connect the sandbox bank.");
  if (provider.name === "simplefin" && !input.setupToken?.trim()) throw new ValidationError("Paste the setup token from your SimpleFIN Bridge.", { setupToken: "Required." });
  const { secret, displayName } = await provider.connect(input.setupToken ?? "");
  const conn = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(integrationConnections)
      .values({
        orgId: ctx.orgId,
        kind: "bank_feed",
        provider: provider.name,
        mode: provider.mode,
        status: "active",
        displayName,
        config: {},
        secretEnc: encryptSecret(secret),
        createdBy: ctx.actor.userId,
      })
      .returning();
    await audit(tx, ctx, { action: "banking.feed_connected", entityType: "integration_connection", entityId: row!.id, metadata: { provider: provider.name, mode: provider.mode } });
    return row!;
  });
  // Discover its accounts straight away so they can be linked.
  await refreshFeedAccounts(ctx, conn.id).catch((e) => log.warn("feed account discovery failed", { connectionId: conn.id, error: (e as Error).message }));
  return conn;
}

async function loadConnection(db: DbOrTx, orgId: string, id: string): Promise<FeedConnection> {
  const [c] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, orgId), eq(integrationConnections.id, id), eq(integrationConnections.kind, "bank_feed")));
  if (!c) throw new NotFoundError("The bank feed");
  return c;
}

/** Fetch the provider's account list (with a short window) and record new accounts. */
export async function refreshFeedAccounts(ctx: Ctx, connectionId: string) {
  requirePermission(ctx, "banking.import");
  const db = getDb();
  const conn = await loadConnection(db, ctx.orgId, connectionId);
  const provider = FEED_PROVIDERS[conn.provider]!;
  const today = todayIn(ctx.org.timezone);
  const { accounts } = await provider.fetch(decryptSecret(conn.secretEnc!), { start: addDays(today, -3), end: today });
  await withTransaction(async (tx) => {
    for (const a of accounts) {
      await tx
        .insert(bankFeedAccounts)
        .values({ orgId: ctx.orgId, connectionId, externalAccountId: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, balanceDate: a.balanceDate })
        .onConflictDoUpdate({
          target: [bankFeedAccounts.orgId, bankFeedAccounts.connectionId, bankFeedAccounts.externalAccountId],
          set: { name: a.name, institution: a.institution, balance: a.balance, balanceDate: a.balanceDate },
        });
    }
  });
  return accounts.length;
}

/** Link (or unlink, with null) a feed account to a money account. */
export async function linkFeedAccount(ctx: Ctx, feedAccountId: string, accountId: string | null) {
  requirePermission(ctx, "integrations.manage");
  await withTransaction(async (tx) => {
    const [fa] = await tx.select().from(bankFeedAccounts).where(and(eq(bankFeedAccounts.orgId, ctx.orgId), eq(bankFeedAccounts.id, feedAccountId))).for("update");
    if (!fa) throw new NotFoundError("The feed account");
    if (accountId) {
      const account = await loadMoneyAccount(tx, ctx, accountId);
      if (fa.currency && fa.currency !== account.currencyResolved) {
        throw new ValidationError(`The feed reports ${fa.currency}; ${account.name} is kept in ${account.currencyResolved}.`, { accountId: "Currency differs." });
      }
      const [taken] = await tx.select().from(bankFeedAccounts).where(and(eq(bankFeedAccounts.orgId, ctx.orgId), eq(bankFeedAccounts.linkedAccountId, accountId)));
      if (taken && taken.id !== fa.id) throw new ConflictError(`${account.name} is already fed by “${taken.name}”. Unlink that first.`, "already_linked");
    }
    await tx.update(bankFeedAccounts).set({ linkedAccountId: accountId }).where(eq(bankFeedAccounts.id, fa.id));
    await audit(tx, ctx, { action: accountId ? "banking.feed_linked" : "banking.feed_unlinked", entityType: "bank_feed_account", entityId: fa.id, metadata: { accountId } });
  });
}

export async function disconnectFeed(ctx: Ctx, connectionId: string) {
  requirePermission(ctx, "integrations.manage");
  await withTransaction(async (tx) => {
    await loadConnection(tx, ctx.orgId, connectionId);
    await tx.update(bankFeedAccounts).set({ linkedAccountId: null }).where(and(eq(bankFeedAccounts.orgId, ctx.orgId), eq(bankFeedAccounts.connectionId, connectionId)));
    // The secret is destroyed; the row stays as the provenance of what it imported.
    await tx.update(integrationConnections).set({ status: "disconnected", secretEnc: null, updatedAt: new Date() }).where(eq(integrationConnections.id, connectionId));
    await audit(tx, ctx, { action: "banking.feed_disconnected", entityType: "integration_connection", entityId: connectionId });
  });
}

export interface SyncResult {
  connectionId: string;
  accounts: number;
  imported: number;
  seen: number;
  warnings: string[];
}

/** Sync one connection's linked accounts. */
export async function syncConnection(ctx: Ctx, connectionId: string): Promise<SyncResult> {
  requirePermission(ctx, "banking.import");
  const db = getDb();
  const conn = await loadConnection(db, ctx.orgId, connectionId);
  if (conn.status === "disconnected" || !conn.secretEnc) throw new ConflictError("This feed is disconnected.", "disconnected");
  const provider = FEED_PROVIDERS[conn.provider];
  if (!provider) throw new ConflictError(`Unknown feed provider ${conn.provider}.`, "unknown_provider");
  if (ctx.org.isDemo && provider.mode !== "sandbox") throw new ConflictError("A demonstration company can only sync the sandbox bank.", "demo_sandbox_only");
  await assertWithinLimit(db, ctx.orgId, "bank_feed_syncs", 1);
  const links = await db.select().from(bankFeedAccounts).where(and(eq(bankFeedAccounts.orgId, ctx.orgId), eq(bankFeedAccounts.connectionId, connectionId)));
  const today = todayIn(ctx.org.timezone);
  const linked = links.filter((l) => l.linkedAccountId);
  const earliest = linked.length
    ? linked.map((l) => (l.lastSyncedAt ? addDays(l.lastSyncedAt.toISOString().slice(0, 10), -OVERLAP_DAYS) : addDays(today, -FIRST_SYNC_DAYS))).sort()[0]!
    : addDays(today, -3);
  let fetched;
  try {
    fetched = await provider.fetch(decryptSecret(conn.secretEnc), { start: earliest, end: today });
  } catch (e) {
    const message = isAppError(e) ? e.message : (e as Error).message;
    await db.update(integrationConnections).set({ status: "error", lastError: message.slice(0, 1000), updatedAt: new Date() }).where(eq(integrationConnections.id, conn.id));
    throw e;
  }
  let imported = 0;
  let seen = 0;
  await withTransaction(async (tx) => {
    for (const a of fetched.accounts) {
      await tx
        .insert(bankFeedAccounts)
        .values({ orgId: ctx.orgId, connectionId, externalAccountId: a.id, name: a.name, institution: a.institution, currency: a.currency, balance: a.balance, balanceDate: a.balanceDate })
        .onConflictDoUpdate({
          target: [bankFeedAccounts.orgId, bankFeedAccounts.connectionId, bankFeedAccounts.externalAccountId],
          set: { name: a.name, institution: a.institution, balance: a.balance, balanceDate: a.balanceDate },
        });
      const link = links.find((l) => l.externalAccountId === a.id);
      if (!link?.linkedAccountId) continue;
      const account = await loadMoneyAccount(tx, ctx, link.linkedAccountId);
      const mu = minorUnits(account.currencyResolved);
      seen += a.transactions.length;
      if (!a.transactions.length) {
        await tx.update(bankFeedAccounts).set({ lastSyncedAt: new Date() }).where(eq(bankFeedAccounts.id, link.id));
        continue;
      }
      // Serialize with file imports on the same account.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`bank-import:${account.id}`}))`);
      const known = await tx
        .select({ externalId: bankTransactions.externalId })
        .from(bankTransactions)
        .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.accountId, account.id), isNotNull(bankTransactions.externalId), inArray(bankTransactions.externalId, a.transactions.map((t) => t.id))));
      const knownSet = new Set(known.map((k) => k.externalId));
      const fresh = a.transactions.filter((t) => !knownSet.has(t.id) && Decimal.from(t.amount).decimalPlaces <= mu && !Decimal.from(t.amount).isZero());
      if (!fresh.length) {
        await tx.update(bankFeedAccounts).set({ lastSyncedAt: new Date() }).where(eq(bankFeedAccounts.id, link.id));
        continue;
      }
      // Fingerprints as a file import would make them, to spot the same transaction imported from a CSV.
      const occ = new Map<string, number>();
      const prepared = fresh.map((t) => {
        const amt = Decimal.from(t.amount).rescale(mu);
        const key = `${t.postedDate}|${amt.normalize().toString()}|${normalizeDescription(t.description)}`;
        const n = occ.get(key) ?? 0;
        occ.set(key, n + 1);
        return { t, amt, fp: fingerprint(account.id, t.postedDate, amt, t.description, n) };
      });
      const collisions = await tx
        .select({ id: bankTransactions.id, fingerprint: bankTransactions.fingerprint })
        .from(bankTransactions)
        .where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.accountId, account.id), inArray(bankTransactions.fingerprint, prepared.map((p) => p.fp)), ne(bankTransactions.status, "removed")));
      const collide = new Map(collisions.map((c) => [c.fingerprint, c.id]));
      const [batch] = await tx
        .insert(bankImportBatches)
        .values({ orgId: ctx.orgId, accountId: account.id, source: "feed", connectionId, fileName: `${provider.label}: ${a.name}`, totalRows: prepared.length, importedCount: prepared.length, createdBy: ctx.actor.userId })
        .returning();
      const raws = await tx
        .insert(bankImportRows)
        .values(prepared.map((p, i) => ({ orgId: ctx.orgId, batchId: batch!.id, rowNumber: i + 1, raw: p.t.raw as object, outcome: "imported" as const })))
        .returning({ id: bankImportRows.id, rowNumber: bankImportRows.rowNumber });
      const rawBy = new Map(raws.map((r) => [r.rowNumber, r.id]));
      const inserted = await tx
        .insert(bankTransactions)
        .values(
          prepared.map((p, i) => {
            const dup = collide.get(p.fp) ?? null;
            return {
              orgId: ctx.orgId,
              accountId: account.id,
              postedDate: p.t.postedDate,
              amount: p.amt.toString(),
              currency: account.currencyResolved,
              description: p.t.description,
              payee: p.t.payee,
              reference: null,
              externalId: p.t.id,
              fingerprint: dup ? `${p.fp}:feed:${p.t.id}` : p.fp,
              batchId: batch!.id,
              rawRowId: rawBy.get(i + 1)!,
              possibleDuplicateOfId: dup,
            };
          }),
        )
        .onConflictDoNothing()
        .returning({ id: bankTransactions.id });
      imported += inserted.length;
      if (inserted.length !== prepared.length) {
        await tx.update(bankImportBatches).set({ importedCount: inserted.length, duplicateCount: prepared.length - inserted.length }).where(eq(bankImportBatches.id, batch!.id));
      }
      await tx.update(bankFeedAccounts).set({ lastSyncedAt: new Date() }).where(eq(bankFeedAccounts.id, link.id));
      if (inserted.length) await applyRulesToTransactions(tx, ctx, inserted.map((r) => r.id));
    }
    await tx.update(integrationConnections).set({ status: "active", lastError: null, lastSyncedAt: new Date(), updatedAt: new Date() }).where(eq(integrationConnections.id, conn.id));
    await recordUsage(tx, ctx.orgId, "bank_feed_syncs", 1, conn.id);
    await audit(tx, ctx, { action: "banking.feed_synced", entityType: "integration_connection", entityId: conn.id, metadata: { imported, seen, warnings: fetched.warnings } });
  });
  return { connectionId, accounts: fetched.accounts.length, imported, seen, warnings: fetched.warnings };
}

/** Sync every active feed of every organization (the scheduler calls this). Failures are recorded per connection. */
export async function syncAllFeeds(): Promise<{ synced: number; failed: number }> {
  const db = getDb();
  const conns = await db
    .select({ id: integrationConnections.id, orgId: integrationConnections.orgId })
    .from(integrationConnections)
    .where(and(eq(integrationConnections.kind, "bank_feed"), inArray(integrationConnections.status, ["active", "error"]), isNotNull(integrationConnections.secretEnc)));
  let synced = 0;
  let failed = 0;
  for (const c of conns) {
    try {
      const ctx = await systemCtx(c.orgId, "job: bank feed sync");
      await syncConnection(ctx, c.id);
      synced++;
    } catch (e) {
      failed++;
      log.warn("bank feed sync failed", { connectionId: c.id, orgId: c.orgId, error: (e as Error).message });
    }
  }
  return { synced, failed };
}

