/**
 * Entity groups: who may see and manage them, their members, their chart,
 * mappings from member accounts, intercompany pairs, translation rates and
 * eliminations.
 *
 * Access is recomputed on every request: a person may view a group only
 * while they can read reports in every member organization, and manage it
 * only while they hold `consolidation.manage` in every member. A group with
 * no members is visible only to whoever created it. Demonstration
 * organizations are only ever grouped with demonstration organizations.
 */
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, withTransaction, type DbOrTx, type Tx } from "@/lib/db/client";
import {
  eliminationEntries,
  eliminationLines,
  entityGroupMembers,
  entityGroups,
  groupAccountMappings,
  groupAccounts,
  groupAuditEvents,
  groupRates,
  intercompanyPairs,
} from "@/lib/db/schema/consolidation";
import { memberships, organizations } from "@/lib/db/schema/core";
import { accounts } from "@/lib/db/schema/ledger";
import { ROLE_PERMISSIONS, type Permission } from "@/lib/authz/permissions";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { Decimal } from "@/lib/money/decimal";
import { isCurrency, minorUnits } from "@/lib/money/currency";
import { isIsoDate } from "@/lib/dates";
import type { Role } from "@/lib/db/schema/core";

export type EntityGroup = typeof entityGroups.$inferSelect;
export type GroupAccount = typeof groupAccounts.$inferSelect;
export type Org = typeof organizations.$inferSelect;

export interface GroupActor {
  userId: string;
  label: string;
}

export interface GroupMember {
  org: Org;
  ownership: string;
  /** The actor's role in this member, or null if they are not a member of it. */
  role: Role | null;
}

export interface GroupContext {
  actor: GroupActor;
  group: EntityGroup;
  members: GroupMember[];
  canManage: boolean;
}

function roleAllows(role: Role | null, p: Permission): boolean {
  return !!role && ROLE_PERMISSIONS[role].has(p);
}

async function loadMembers(db: DbOrTx, groupId: string, userId: string): Promise<GroupMember[]> {
  const rows = await db
    .select({ org: organizations, ownership: entityGroupMembers.ownership, role: memberships.role })
    .from(entityGroupMembers)
    .innerJoin(organizations, eq(organizations.id, entityGroupMembers.orgId))
    .leftJoin(memberships, and(eq(memberships.orgId, entityGroupMembers.orgId), eq(memberships.userId, userId)))
    .where(eq(entityGroupMembers.groupId, groupId))
    .orderBy(asc(organizations.name));
  return rows.map((r) => ({ org: r.org, ownership: r.ownership, role: r.role ?? null }));
}

function accessFor(group: EntityGroup, members: GroupMember[], userId: string): { view: boolean; manage: boolean } {
  if (members.length === 0) {
    const own = group.createdBy === userId;
    return { view: own, manage: own };
  }
  return {
    view: members.every((m) => roleAllows(m.role, "reports.read")),
    manage: members.every((m) => roleAllows(m.role, "consolidation.manage")),
  };
}

/** The group as `actor` may see it; 404 (not 403) when they may not, so groups are not discoverable. */
export async function groupContext(db: DbOrTx, actor: GroupActor, groupId: string, level: "view" | "manage" = "view"): Promise<GroupContext> {
  const [group] = await db.select().from(entityGroups).where(eq(entityGroups.id, groupId));
  if (!group || group.archivedAt) throw new NotFoundError("The entity group");
  const members = await loadMembers(db, groupId, actor.userId);
  const access = accessFor(group, members, actor.userId);
  if (!access.view) throw new NotFoundError("The entity group");
  if (level === "manage" && !access.manage) {
    throw new ForbiddenError("Managing a group needs the consolidation permission (accountant or above) in every member organization.");
  }
  return { actor, group, members, canManage: access.manage };
}

/** Groups the person can see: created by them, or containing an organization they belong to and passing the access rule. */
export async function listGroupsForUser(db: DbOrTx, userId: string) {
  const candidates = await db
    .selectDistinct({ group: entityGroups })
    .from(entityGroups)
    .leftJoin(entityGroupMembers, eq(entityGroupMembers.groupId, entityGroups.id))
    .leftJoin(memberships, and(eq(memberships.orgId, entityGroupMembers.orgId), eq(memberships.userId, userId)))
    .where(and(sql`${entityGroups.archivedAt} is null`, or(eq(entityGroups.createdBy, userId), sql`${memberships.userId} is not null`)))
    .orderBy(asc(entityGroups.name));
  const out: { group: EntityGroup; members: GroupMember[]; canManage: boolean }[] = [];
  for (const { group } of candidates) {
    const members = await loadMembers(db, group.id, userId);
    const access = accessFor(group, members, userId);
    if (access.view) out.push({ group, members, canManage: access.manage });
  }
  return out;
}

export async function groupAudit(db: DbOrTx, g: { group: EntityGroup; actor: GroupActor }, action: string, metadata?: Record<string, unknown>, reason?: string | null) {
  await db.insert(groupAuditEvents).values({
    groupId: g.group.id,
    actorUserId: g.actor.userId,
    actorLabel: g.actor.label,
    action,
    reason: reason ?? null,
    metadata: metadata ?? null,
  });
}

export async function groupHistory(db: DbOrTx, groupId: string) {
  return db.select().from(groupAuditEvents).where(eq(groupAuditEvents.groupId, groupId)).orderBy(desc(groupAuditEvents.id)).limit(200);
}

export async function createGroup(actor: GroupActor, input: { name: string; reportingCurrency: string }): Promise<EntityGroup> {
  const fields: Record<string, string> = {};
  if (!input.name?.trim()) fields.name = "Name the group.";
  if (!isCurrency(input.reportingCurrency)) fields.reportingCurrency = "Pick the reporting currency.";
  if (Object.keys(fields).length) throw new ValidationError("Check the group.", fields);
  return withTransaction(async (tx) => {
    const [group] = await tx.insert(entityGroups).values({ name: input.name.trim(), reportingCurrency: input.reportingCurrency, createdBy: actor.userId }).returning();
    await tx.insert(groupAccounts).values([
      { groupId: group!.id, code: "3900", name: "Retained Earnings (prior periods)", type: "equity", role: "retained_earnings" },
      { groupId: group!.id, code: "3990", name: "Cumulative Translation Adjustment", type: "equity", role: "cta" },
    ]);
    await groupAudit(tx, { group: group!, actor }, "group.created", { name: group!.name, reportingCurrency: group!.reportingCurrency });
    return group!;
  });
}

export async function renameGroup(g: GroupContext, name: string) {
  if (!g.canManage) throw new ForbiddenError();
  if (!name.trim()) throw new ValidationError("Name the group.", { name: "Required." });
  await withTransaction(async (tx) => {
    await tx.update(entityGroups).set({ name: name.trim() }).where(eq(entityGroups.id, g.group.id));
    await groupAudit(tx, g, "group.renamed", { from: g.group.name, to: name.trim() });
  });
}

export async function archiveGroup(g: GroupContext, reason: string) {
  if (!g.canManage) throw new ForbiddenError();
  await withTransaction(async (tx) => {
    await tx.update(entityGroups).set({ archivedAt: new Date() }).where(eq(entityGroups.id, g.group.id));
    await groupAudit(tx, g, "group.archived", {}, reason);
  });
}

/**
 * Add an organization. The person needs `consolidation.manage` in it (as in
 * every current member), and demonstration and real organizations never mix.
 */
export async function addMember(g: GroupContext, orgId: string, ownershipPercent = "100"): Promise<void> {
  if (!g.canManage) throw new ForbiddenError("Managing a group needs the consolidation permission in every member organization.");
  const db = getDb();
  const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId));
  if (!org) throw new NotFoundError("The organization");
  const [m] = await db.select().from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, g.actor.userId)));
  if (!roleAllows(m?.role ?? null, "consolidation.manage")) {
    throw new ForbiddenError(`You need the consolidation permission (accountant or above) in ${org.name} to add it.`);
  }
  if (g.members.some((x) => x.org.id === orgId)) throw new ConflictError(`${org.name} is already in the group.`, "already_member");
  const hasMembers = g.members.length > 0;
  if (hasMembers && g.group.isDemo !== org.isDemo) {
    throw new ConflictError(
      g.group.isDemo ? "This group holds demonstration companies; a real organization cannot join it." : "A demonstration company cannot be grouped with real organizations.",
      "demo_mixing",
    );
  }
  const pct = Decimal.tryFrom(ownershipPercent.replace("%", "").trim());
  if (!pct || !pct.isPositive() || pct.gt(100)) throw new ValidationError("Ownership is a percentage above 0 and at most 100.", { ownership: "0–100." });
  await withTransaction(async (tx) => {
    if (!hasMembers) await tx.update(entityGroups).set({ isDemo: org.isDemo }).where(eq(entityGroups.id, g.group.id));
    await tx.insert(entityGroupMembers).values({ groupId: g.group.id, orgId, ownership: pct.div(100, 8, "half_up").toString(), addedBy: g.actor.userId });
    await groupAudit(tx, g, "group.member_added", { orgId, name: org.name, ownership: pct.toString() });
  });
}

export async function removeMember(g: GroupContext, orgId: string, reason: string) {
  if (!g.canManage) throw new ForbiddenError();
  await withTransaction(async (tx) => {
    await tx.delete(entityGroupMembers).where(and(eq(entityGroupMembers.groupId, g.group.id), eq(entityGroupMembers.orgId, orgId)));
    await groupAudit(tx, g, "group.member_removed", { orgId }, reason);
  });
}

// ── Group chart and mappings ────────────────────────────────────────────────

export async function listGroupAccounts(db: DbOrTx, groupId: string): Promise<GroupAccount[]> {
  return db.select().from(groupAccounts).where(eq(groupAccounts.groupId, groupId)).orderBy(asc(groupAccounts.code));
}

export async function saveGroupAccount(g: GroupContext, input: { id?: string | null; code: string; name: string; type: GroupAccount["type"] }): Promise<GroupAccount> {
  if (!g.canManage) throw new ForbiddenError();
  const fields: Record<string, string> = {};
  if (!input.code?.trim()) fields.code = "Enter a code.";
  if (!input.name?.trim()) fields.name = "Enter a name.";
  if (!["asset", "liability", "equity", "income", "expense"].includes(input.type)) fields.type = "Choose a type.";
  if (Object.keys(fields).length) throw new ValidationError("Check the account.", fields);
  return withTransaction(async (tx) => {
    const [clash] = await tx.select().from(groupAccounts).where(and(eq(groupAccounts.groupId, g.group.id), eq(groupAccounts.code, input.code.trim())));
    if (clash && clash.id !== input.id) throw new ValidationError("That code is taken in this group.", { code: "Taken." });
    let row: GroupAccount;
    if (input.id) {
      const [before] = await tx.select().from(groupAccounts).where(and(eq(groupAccounts.groupId, g.group.id), eq(groupAccounts.id, input.id)));
      if (!before) throw new NotFoundError("The group account");
      if (before.role && before.type !== input.type) throw new ConflictError("The consolidation posts to this account by its role; its type is fixed.", "role_account");
      [row] = (await tx.update(groupAccounts).set({ code: input.code.trim(), name: input.name.trim(), type: input.type }).where(eq(groupAccounts.id, input.id)).returning()) as [GroupAccount];
    } else {
      [row] = (await tx.insert(groupAccounts).values({ groupId: g.group.id, code: input.code.trim(), name: input.name.trim(), type: input.type }).returning()) as [GroupAccount];
    }
    await groupAudit(tx, g, input.id ? "group.account_updated" : "group.account_created", { code: row.code, name: row.name, type: row.type });
    return row;
  });
}

export async function listMappings(db: DbOrTx, groupId: string) {
  return db.select().from(groupAccountMappings).where(eq(groupAccountMappings.groupId, groupId));
}

/** Member accounts of the group with their current mapping (for the mapping screen). */
export async function memberAccountsWithMappings(db: DbOrTx, g: GroupContext) {
  const orgIds = g.members.map((m) => m.org.id);
  if (!orgIds.length) return [];
  const rows = await db
    .select({ account: accounts, mapping: groupAccountMappings })
    .from(accounts)
    .leftJoin(groupAccountMappings, and(eq(groupAccountMappings.groupId, g.group.id), eq(groupAccountMappings.accountId, accounts.id)))
    .where(inArray(accounts.orgId, orgIds))
    .orderBy(asc(accounts.code));
  return rows;
}

export async function setMapping(g: GroupContext, orgId: string, accountId: string, groupAccountId: string | null): Promise<void> {
  if (!g.canManage) throw new ForbiddenError();
  if (!g.members.some((m) => m.org.id === orgId)) throw new NotFoundError("The member");
  await withTransaction(async (tx) => {
    const [acc] = await tx.select().from(accounts).where(and(eq(accounts.orgId, orgId), eq(accounts.id, accountId)));
    if (!acc) throw new NotFoundError("The account");
    if (!groupAccountId) {
      await tx.delete(groupAccountMappings).where(and(eq(groupAccountMappings.groupId, g.group.id), eq(groupAccountMappings.accountId, accountId)));
    } else {
      const [ga] = await tx.select().from(groupAccounts).where(and(eq(groupAccounts.groupId, g.group.id), eq(groupAccounts.id, groupAccountId)));
      if (!ga) throw new NotFoundError("The group account");
      if (ga.type !== acc.type) {
        throw new ValidationError(`${acc.code} ${acc.name} is ${acc.type === "asset" || acc.type === "expense" ? "an" : "a"} ${acc.type} account; map it to a group ${acc.type} account.`, { groupAccountId: "Type differs." });
      }
      await tx
        .insert(groupAccountMappings)
        .values({ groupId: g.group.id, orgId, accountId, groupAccountId, updatedBy: g.actor.userId })
        .onConflictDoUpdate({ target: [groupAccountMappings.groupId, groupAccountMappings.accountId], set: { groupAccountId, updatedBy: g.actor.userId, updatedAt: new Date() } });
    }
    await groupAudit(tx, g, "group.mapping_set", { orgId, accountId, accountCode: acc.code, groupAccountId });
  });
}

/**
 * Convenience: create group accounts for a member's chart (by code) and map
 * every member account whose code matches a group account of the same type.
 * Existing mappings are left alone.
 */
export async function adoptChartAndAutoMap(g: GroupContext, templateOrgId: string): Promise<{ created: number; mapped: number }> {
  if (!g.canManage) throw new ForbiddenError();
  if (!g.members.some((m) => m.org.id === templateOrgId)) throw new NotFoundError("The member");
  return withTransaction(async (tx) => {
    const existing = await tx.select().from(groupAccounts).where(eq(groupAccounts.groupId, g.group.id));
    const byCode = new Map(existing.map((a) => [a.code, a]));
    const tmpl = await tx.select().from(accounts).where(and(eq(accounts.orgId, templateOrgId), eq(accounts.isArchived, false))).orderBy(asc(accounts.code));
    let created = 0;
    for (const a of tmpl) {
      if (byCode.has(a.code)) continue;
      const [row] = await tx.insert(groupAccounts).values({ groupId: g.group.id, code: a.code, name: a.name, type: a.type }).returning();
      byCode.set(a.code, row!);
      created++;
    }
    const memberAccounts = await tx.select().from(accounts).where(inArray(accounts.orgId, g.members.map((m) => m.org.id)));
    const mapped = await tx.select().from(groupAccountMappings).where(eq(groupAccountMappings.groupId, g.group.id));
    const already = new Set(mapped.map((m) => m.accountId));
    let n = 0;
    for (const a of memberAccounts) {
      if (already.has(a.id)) continue;
      const ga = byCode.get(a.code);
      if (!ga || ga.type !== a.type) continue;
      await tx.insert(groupAccountMappings).values({ groupId: g.group.id, orgId: a.orgId, accountId: a.id, groupAccountId: ga.id, updatedBy: g.actor.userId });
      n++;
    }
    await groupAudit(tx, g, "group.chart_adopted", { templateOrgId, created, mapped: n });
    return { created, mapped: n };
  });
}

// ── Intercompany pairs ──────────────────────────────────────────────────────

export async function listPairs(db: DbOrTx, groupId: string) {
  return db.select().from(intercompanyPairs).where(eq(intercompanyPairs.groupId, groupId)).orderBy(asc(intercompanyPairs.createdAt));
}

export async function addPair(g: GroupContext, input: { orgA: string; accountA: string; orgB: string; accountB: string; description?: string | null }) {
  if (!g.canManage) throw new ForbiddenError();
  if (input.orgA === input.orgB) throw new ValidationError("An intercompany pair links accounts in two different members.", { orgB: "Pick another member." });
  for (const [o, a] of [
    [input.orgA, input.accountA],
    [input.orgB, input.accountB],
  ] as const) {
    if (!g.members.some((m) => m.org.id === o)) throw new NotFoundError("The member");
    const [acc] = await getDb().select().from(accounts).where(and(eq(accounts.orgId, o), eq(accounts.id, a)));
    if (!acc) throw new NotFoundError("The account");
  }
  await withTransaction(async (tx) => {
    await tx.insert(intercompanyPairs).values({ groupId: g.group.id, ...input, description: input.description ?? null });
    await groupAudit(tx, g, "group.intercompany_pair_added", input);
  });
}

export async function removePair(g: GroupContext, pairId: string) {
  if (!g.canManage) throw new ForbiddenError();
  await withTransaction(async (tx) => {
    await tx.delete(intercompanyPairs).where(and(eq(intercompanyPairs.groupId, g.group.id), eq(intercompanyPairs.id, pairId)));
    await groupAudit(tx, g, "group.intercompany_pair_removed", { pairId });
  });
}

// ── Translation rates ───────────────────────────────────────────────────────

export async function listGroupRates(db: DbOrTx, groupId: string) {
  return db.select().from(groupRates).where(eq(groupRates.groupId, groupId)).orderBy(desc(groupRates.rateDate), asc(groupRates.currency));
}

export async function addGroupRate(g: GroupContext, input: { currency: string; rateDate: string; rate: string; note?: string | null }) {
  if (!g.canManage) throw new ForbiddenError();
  const fields: Record<string, string> = {};
  if (!isCurrency(input.currency) || input.currency === g.group.reportingCurrency) fields.currency = "Pick a member currency other than the reporting currency.";
  if (!isIsoDate(input.rateDate)) fields.rateDate = "Enter the date.";
  const r = Decimal.tryFrom(input.rate?.trim());
  if (!r || !r.isPositive()) fields.rate = `${g.group.reportingCurrency} per 1 ${input.currency}.`;
  if (Object.keys(fields).length) throw new ValidationError("Check the rate.", fields);
  await withTransaction(async (tx) => {
    await tx
      .insert(groupRates)
      .values({ groupId: g.group.id, currency: input.currency, rateDate: input.rateDate, rate: r!.round(12, "half_up").toString(), note: input.note ?? null, createdBy: g.actor.userId })
      .onConflictDoUpdate({ target: [groupRates.groupId, groupRates.currency, groupRates.rateDate], set: { rate: r!.round(12, "half_up").toString(), note: input.note ?? null } });
    await groupAudit(tx, g, "group.rate_set", input);
  });
}

// ── Eliminations ────────────────────────────────────────────────────────────

export interface EliminationLineInput {
  groupAccountId: string;
  amount: string;
  orgId?: string | null;
  description?: string | null;
}

export async function createElimination(
  g: GroupContext,
  input: { entryDate: string; description: string; lines: EliminationLineInput[]; source?: "manual" | "suggested" },
  tx?: Tx,
) {
  if (!g.canManage) throw new ForbiddenError();
  const fields: Record<string, string> = {};
  if (!isIsoDate(input.entryDate)) fields.entryDate = "Enter the date.";
  if (!input.description?.trim()) fields.description = "Describe the elimination.";
  const mu = minorUnits(g.group.reportingCurrency);
  const lines = input.lines.filter((l) => l.groupAccountId && l.amount?.trim());
  if (lines.length < 2) fields.lines = "An elimination needs at least two lines.";
  let sum = Decimal.ZERO;
  for (const [i, l] of lines.entries()) {
    const d = Decimal.tryFrom(l.amount.replace(/,/g, ""));
    if (!d || d.isZero()) fields[`lines.${i}.amount`] = "Enter a non-zero amount.";
    else if (d.decimalPlaces > mu) fields[`lines.${i}.amount`] = `At most ${mu} decimal places.`;
    else sum = sum.add(d);
  }
  if (!Object.keys(fields).length && !sum.isZero()) fields.lines = `Lines must balance; they differ by ${sum.toString()} ${g.group.reportingCurrency}.`;
  if (Object.keys(fields).length) throw new ValidationError("Check the elimination.", fields);
  const run = async (t: Tx) => {
    const ga = await t.select().from(groupAccounts).where(eq(groupAccounts.groupId, g.group.id));
    const ids = new Set(ga.map((a) => a.id));
    for (const l of lines) if (!ids.has(l.groupAccountId)) throw new NotFoundError("The group account");
    const [entry] = await t
      .insert(eliminationEntries)
      .values({ groupId: g.group.id, entryDate: input.entryDate, description: input.description.trim(), source: input.source ?? "manual", createdBy: g.actor.userId })
      .returning();
    await t.insert(eliminationLines).values(
      lines.map((l) => ({
        groupId: g.group.id,
        entryId: entry!.id,
        groupAccountId: l.groupAccountId,
        amount: Decimal.from(l.amount.replace(/,/g, "")).rescale(mu).toString(),
        orgId: l.orgId ?? null,
        description: l.description ?? null,
      })),
    );
    await groupAudit(t, g, "group.elimination_created", { entryId: entry!.id, date: input.entryDate, description: input.description, lines: lines.length, source: input.source ?? "manual" });
    return entry!;
  };
  return tx ? run(tx) : withTransaction(run);
}

export async function voidElimination(g: GroupContext, entryId: string, reason: string) {
  if (!g.canManage) throw new ForbiddenError();
  if (!reason?.trim()) throw new ValidationError("Say why the elimination is being voided.", { reason: "Required." });
  await withTransaction(async (tx) => {
    const [e] = await tx.select().from(eliminationEntries).where(and(eq(eliminationEntries.groupId, g.group.id), eq(eliminationEntries.id, entryId))).for("update");
    if (!e) throw new NotFoundError("The elimination");
    if (e.status === "void") throw new ConflictError("This elimination is already void.", "already_void");
    await tx.update(eliminationEntries).set({ status: "void", voidedAt: new Date(), voidedBy: g.actor.userId, voidReason: reason.trim() }).where(eq(eliminationEntries.id, entryId));
    await groupAudit(tx, g, "group.elimination_voided", { entryId }, reason.trim());
  });
}

export async function listEliminations(db: DbOrTx, groupId: string) {
  const entries = await db.select().from(eliminationEntries).where(eq(eliminationEntries.groupId, groupId)).orderBy(desc(eliminationEntries.entryDate), desc(eliminationEntries.createdAt));
  const lines = await db.select().from(eliminationLines).where(eq(eliminationLines.groupId, groupId));
  return entries.map((e) => ({ ...e, lines: lines.filter((l) => l.entryId === e.id) }));
}
