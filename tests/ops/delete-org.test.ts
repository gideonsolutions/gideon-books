import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { saveDraft, issueDocument } from "@/lib/commerce/documents";
import { postManualEntry } from "@/lib/ledger/journals";
import { uploadAttachment } from "@/lib/storage/attachments";
import { storage } from "@/lib/storage/storage";
import { createOrganization } from "@/lib/orgs/orgs";
import { userCtx } from "@/lib/context";
import { deleteOrganization } from "@/lib/ops/delete-org";
import { requestExport, runExport } from "@/lib/ops/export";
import { describeOrgTables } from "@/lib/ops/tables";
import { getPool } from "@/lib/db/client";
import { customer, newUser, rejectsWith, setupOrg } from "../helpers";

async function rowsFor(orgId: string): Promise<number> {
  const client = await getPool().connect();
  try {
    let n = 0;
    for (const t of await describeOrgTables(client)) {
      if (t.scope.kind !== "org_id") continue;
      n += Number((await client.query(`select count(*) as n from "${t.name}" where org_id = $1`, [orgId])).rows[0].n);
    }
    n += Number((await client.query(`select count(*) as n from organizations where id = $1`, [orgId])).rows[0].n);
    return n;
  } finally {
    client.release();
  }
}

async function populate(ctx: Parameters<typeof postManualEntry>[0], acct: (k: string) => Promise<string>) {
  await postManualEntry(ctx, { entryDate: "2026-05-01", description: "Capital", lines: [{ accountId: await acct("1000"), debit: "100" }, { accountId: await acct("owner_contributions"), credit: "100" }] });
  const c = await customer(ctx);
  const d = await saveDraft(ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-05-02", lines: [{ unitPrice: "10" }] });
  const issued = await issueDocument(ctx, d.id);
  return uploadAttachment(ctx, { entityType: "document", entityId: issued.id, fileName: "x.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4 x %%EOF") });
}

describe("deleting an organization", () => {
  it("needs the owner, the typed name and an export (or an explicit refusal), and removes only that organization", async () => {
    const victim = await setupOrg({ name: "Going Away LLC" });
    const bystander = await setupOrg({ name: "Staying Put LLC" });
    const att = await populate(victim.ctx, victim.acct);
    await populate(bystander.ctx, bystander.acct);
    const bystanderRows = await rowsFor(bystander.orgId);

    const admin = await victim.as("admin");
    await rejectsWith(deleteOrganization(admin, { confirmName: "Going Away LLC", skipExport: true }), "forbidden");
    await rejectsWith(deleteOrganization(victim.ctx, { confirmName: "Wrong", skipExport: true }), "validation_failed");
    await rejectsWith(deleteOrganization(victim.ctx, { confirmName: "Going Away LLC" }), "export_required");
    const exp = await requestExport(victim.ctx);
    await runExport(exp.id);
    expect(await storage().exists(att.storageKey)).toBe(true);

    const r = await deleteOrganization(victim.ctx, { confirmName: "Going Away LLC", reason: "Business closed" });
    expect(r.deletedRows).toBeGreaterThan(20);
    expect(r.deletedFiles).toBe(2);
    expect(await rowsFor(victim.orgId)).toBe(0);
    expect(await storage().exists(att.storageKey)).toBe(false);
    expect(await rowsFor(bystander.orgId)).toBe(bystanderRows);
    const ev = await getDb().execute<{ n: number }>(sql`select count(*)::int as n from audit_events where org_id is null and action = 'organization.deleted' and entity_id = ${victim.orgId}`);
    expect(ev.rows[0]!.n).toBe(1);
  });

  it("deletes a demonstration company at once", async () => {
    const u = await newUser();
    const demo = await createOrganization(u.id, { name: "Demo Delete", baseCurrency: "USD", template: "services", isDemo: true });
    await deleteOrganization(userCtx(demo, u.id, "owner", u.email), {});
    expect(await rowsFor(demo.id)).toBe(0);
  });
});
