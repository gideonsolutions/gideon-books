"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db/client";
import {
  addGroupRate,
  addMember,
  addPair,
  adoptChartAndAutoMap,
  archiveGroup,
  createElimination,
  createGroup,
  groupContext,
  removeMember,
  removePair,
  renameGroup,
  saveGroupAccount,
  setMapping,
  voidElimination,
  type GroupActor,
} from "@/lib/consolidation/groups";
import { runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx, requireUser } from "@/lib/web/session";
import { ValidationError } from "@/lib/errors";

type R<T = unknown> = Promise<ActionResult<T>>;

async function actor(slug: string): Promise<GroupActor> {
  await orgCtx(slug);
  const u = await requireUser();
  return { userId: u.id, label: u.email };
}

async function manage(slug: string, groupId: string) {
  return groupContext(getDb(), await actor(slug), groupId, "manage");
}

export async function createGroupAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const g = await createGroup(await actor(slug), { name: str(fd, "name") ?? "", reportingCurrency: str(fd, "reportingCurrency") ?? "" });
    return { href: `/o/${slug}/consolidation/${g.id}` };
  });
}

export async function renameGroupAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(async () => renameGroup(await manage(slug, groupId), str(fd, "name") ?? ""), "Renamed.");
}

export async function archiveGroupAction(slug: string, groupId: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    await archiveGroup(await manage(slug, groupId), str(fd, "reason") ?? "");
    return { href: `/o/${slug}/consolidation` };
  });
}

export async function addMemberAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const orgId = str(fd, "orgId");
    if (!orgId) throw new ValidationError("Choose an organization.", { orgId: "Required." });
    await addMember(await manage(slug, groupId), orgId, str(fd, "ownership") ?? "100");
    revalidatePath(`/o/${slug}/consolidation/${groupId}`);
  }, "Member added.");
}

export async function removeMemberAction(slug: string, groupId: string, orgId: string, _: unknown, fd: FormData): R {
  return runAction(async () => removeMember(await manage(slug, groupId), orgId, str(fd, "reason") ?? ""), "Member removed.");
}

export async function addRateAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(
    async () =>
      addGroupRate(await manage(slug, groupId), { currency: str(fd, "currency") ?? "", rateDate: str(fd, "rateDate") ?? "", rate: str(fd, "rate") ?? "", note: str(fd, "note") }),
    "Rate saved.",
  );
}

export async function saveGroupAccountAction(slug: string, groupId: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await saveGroupAccount(await manage(slug, groupId), { id, code: str(fd, "code") ?? "", name: str(fd, "name") ?? "", type: (str(fd, "type") ?? "") as never });
  }, "Saved.");
}

/** Save a member's mappings in one go: map.<accountId> = groupAccountId | "". */
export async function saveMappingsAction(slug: string, groupId: string, orgId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const g = await manage(slug, groupId);
    let n = 0;
    for (const [k, v] of fd.entries()) {
      const m = /^map\.([0-9a-f-]{36})$/.exec(k);
      if (!m || typeof v !== "string") continue;
      const before = String(fd.get(`was.${m[1]}`) ?? "");
      if (before === v) continue;
      await setMapping(g, orgId, m[1]!, v || null);
      n++;
    }
    return { changed: n };
  }, "Mappings saved.");
}

export async function adoptChartAction(slug: string, groupId: string, orgId: string): R {
  return runAction(async () => adoptChartAndAutoMap(await manage(slug, groupId), orgId), "Group chart created from that member, and accounts with matching codes were mapped.");
}

export async function addPairAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const a = (str(fd, "a") ?? "").split(":");
    const b = (str(fd, "b") ?? "").split(":");
    if (a.length !== 2 || b.length !== 2) throw new ValidationError("Choose both accounts.", { a: "Required.", b: "Required." });
    await addPair(await manage(slug, groupId), { orgA: a[0]!, accountA: a[1]!, orgB: b[0]!, accountB: b[1]!, description: str(fd, "description") });
  }, "Intercompany pair added.");
}

export async function removePairAction(slug: string, groupId: string, pairId: string): R {
  return runAction(async () => removePair(await manage(slug, groupId), pairId), "Pair removed.");
}

export async function createEliminationAction(slug: string, groupId: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    const lines: { groupAccountId: string; amount: string; orgId: string | null; description: string | null }[] = [];
    for (let i = 0; i < 50; i++) {
      if (!fd.has(`lines.${i}.groupAccountId`)) break;
      const debit = str(fd, `lines.${i}.debit`);
      const credit = str(fd, `lines.${i}.credit`);
      const ga = str(fd, `lines.${i}.groupAccountId`);
      if (!ga && !debit && !credit) continue;
      lines.push({
        groupAccountId: ga ?? "",
        amount: debit ? debit : credit ? `-${credit.replace(/^-/, "")}` : "",
        orgId: str(fd, `lines.${i}.orgId`),
        description: str(fd, `lines.${i}.description`),
      });
    }
    await createElimination(await manage(slug, groupId), {
      entryDate: str(fd, "entryDate") ?? "",
      description: str(fd, "description") ?? "",
      lines,
      source: str(fd, "source") === "suggested" ? "suggested" : "manual",
    });
  }, "Elimination recorded.");
}

export async function voidEliminationAction(slug: string, groupId: string, entryId: string, _: unknown, fd: FormData): R {
  return runAction(async () => voidElimination(await manage(slug, groupId), entryId, str(fd, "reason") ?? ""), "Elimination voided.");
}
