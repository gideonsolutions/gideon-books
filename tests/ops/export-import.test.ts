import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { getDb, withTransaction } from "@/lib/db/client";
import { saveDraft, issueDocument } from "@/lib/commerce/documents";
import { recordPayment } from "@/lib/commerce/payments";
import { createJurisdiction, addTaxRate, saveTaxCode } from "@/lib/tax/config";
import { postManualEntry, reverseManualEntry } from "@/lib/ledger/journals";
import { closePeriod, ensureFiscalYear, periodFor, setLockDate } from "@/lib/ledger/periods";
import { createAccount, setAccountArchived } from "@/lib/ledger/accounts";
import { uploadAttachment } from "@/lib/storage/attachments";
import { storage } from "@/lib/storage/storage";
import { buildOrgExport } from "@/lib/ops/export";
import { importOrganization, parseExport } from "@/lib/ops/import";
import { customer, refresh, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";

let t: TestOrg;

async function fingerprint(orgId: string) {
  const db = getDb();
  const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await db.execute<T>(s)).rows;
  return {
    tb: await q(sql`select a.code, sum(l.base_amount)::text as b from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id join accounts a on a.org_id = l.org_id and a.id = l.account_id where l.org_id = ${orgId} and e.status = 'posted' group by a.code order by a.code`),
    entries: await q(sql`select entry_number, kind, entry_date, status, (reverses_entry_id is not null) as rev from journal_entries where org_id = ${orgId} order by entry_number nulls last, created_at`),
    openItems: await q(sql`select d.number, sum(l.txn_amount)::text as open from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id join documents d on d.org_id = l.org_id and d.id = l.open_item_id where l.org_id = ${orgId} and e.status = 'posted' group by d.number order by d.number`),
    documents: await q(sql`select number, kind, status, total::text from documents where org_id = ${orgId} order by number`),
    stock: await q(sql`select i.name, c.qty_on_hand::text, c.total_value::text from item_costs c join items i on i.org_id = c.org_id and i.id = c.item_id where c.org_id = ${orgId} order by i.name`),
    moves: await q(sql`select count(*)::int as n from stock_moves where org_id = ${orgId}`),
    cashBasis: await q(sql`select a.code, sum(c.base_amount)::text as b from cash_basis_lines c join accounts a on a.org_id = c.org_id and a.id = c.account_id where c.org_id = ${orgId} group by a.code order by a.code`),
    periods: await q(sql`select start_date, status from fiscal_periods where org_id = ${orgId} order by start_date`),
    archived: await q(sql`select code from accounts where org_id = ${orgId} and is_archived order by code`),
    org: await q(sql`select base_currency, lock_date, fiscal_year_start_month from organizations where id = ${orgId}`),
    attachments: await q(sql`select file_name, sha256, size_bytes from attachments where org_id = ${orgId} order by file_name`),
    audit: await q(sql`select count(*)::int as n from audit_events where org_id = ${orgId}`),
  };
}

beforeAll(async () => {
  t = await setupOrg({ name: "Round Trip Supply" });
  const ctx = t.ctx;
  const c = await customer(ctx, "Round Customer");
  const v = await vendor(ctx, "Round Vendor");
  const widget = await stockItem(ctx, "Widget");
  const j = await createJurisdiction(ctx, { name: "State" });
  await addTaxRate(ctx, { jurisdictionId: j.id, name: "State", rate: "5", effectiveFrom: "2020-01-01" });
  const code = await saveTaxCode(ctx, { name: "Taxable", components: [{ jurisdictionId: j.id }] });
  await postManualEntry(ctx, { entryDate: "2026-01-05", description: "Capital", lines: [{ accountId: await t.acct("1000"), debit: "5000" }, { accountId: await t.acct("owner_contributions"), credit: "5000" }] });
  const wrong = await postManualEntry(ctx, { entryDate: "2026-01-06", description: "Wrong", lines: [{ accountId: await t.acct("6500"), debit: "40" }, { accountId: await t.acct("1000"), credit: "40" }] });
  await reverseManualEntry(ctx, wrong.entry.id, { date: "2026-01-07", reason: "Wrong account" });
  const bill = await saveDraft(ctx, { kind: "bill", contactId: v.id, issueDate: "2026-02-01", reference: "V-9", lines: [{ itemId: widget.id, quantity: "10", unitPrice: "4" }] });
  await issueDocument(ctx, bill.id);
  const inv = await saveDraft(ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-02-03", lines: [{ itemId: widget.id, quantity: "4", unitPrice: "10", taxCodeId: code.id }, { unitPrice: "100" }] });
  const issued = await issueDocument(ctx, inv.id);
  await recordPayment(ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-02-10", accountId: await t.acct("1000"), amount: "60", allocations: [{ itemType: "document", itemId: issued.id, amount: "60" }] });
  await uploadAttachment(ctx, { entityType: "document", entityId: issued.id, fileName: "po.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4\nround trip\n%%EOF") });
  const spare = await createAccount(ctx, { code: "6123", name: "Unused", subtype: "operating_expense" });
  await setAccountArchived(ctx, spare.id, true);
  await withTransaction((tx) => ensureFiscalYear(tx, ctx.org, "2026-01-01"));
  const jan = (await periodFor(getDb(), t.orgId, "2026-01-15"))!;
  await closePeriod(ctx, jan.id, { acknowledgeWarnings: true });
  await setLockDate(ctx, "2026-01-31", "January closed");
  t.ctx = await refresh(ctx);
});

describe("complete data export and import", () => {
  it("round-trips an organization into a new one with identical books, files and states", async () => {
    const { zip, manifest } = await buildOrgExport(t.orgId);
    expect(manifest.tables.find((x) => x.name === "journal_entries")!.rows).toBeGreaterThan(5);
    expect(manifest.attachments).toHaveLength(1);
    expect(Object.keys(manifest.excludedTables)).toContain("memberships");
    const before = await fingerprint(t.orgId);
    const { orgId } = await importOrganization(t.userId, zip, { name: "Round Trip Copy" });
    expect(orgId).not.toBe(t.orgId);
    const after = await fingerprint(orgId);
    expect(after.tb).toEqual(before.tb);
    expect(after.entries).toEqual(before.entries);
    expect(after.openItems).toEqual(before.openItems);
    expect(after.documents).toEqual(before.documents);
    expect(after.stock).toEqual(before.stock);
    expect(after.moves).toEqual(before.moves);
    expect(after.cashBasis).toEqual(before.cashBasis);
    expect(after.periods).toEqual(before.periods);
    expect(after.archived).toEqual(before.archived);
    expect(after.org).toEqual(before.org);
    expect(after.attachments).toEqual(before.attachments);
    // The importer gets the audit trail too, plus the import event.
    expect((after.audit[0] as { n: number }).n).toBe((before.audit[0] as { n: number }).n + 1);
    // Attachment bytes are stored under the new organization.
    const [att] = (await getDb().execute<{ storage_key: string }>(sql`select storage_key from attachments where org_id = ${orgId}`)).rows;
    expect(att!.storage_key.startsWith(`orgs/${orgId}/`)).toBe(true);
    expect((await storage().get(att!.storage_key)).toString()).toContain("round trip");
    // The source is untouched.
    expect(await fingerprint(t.orgId)).toEqual(before);
  });

  it("refuses a damaged or altered export", async () => {
    const { zip } = await buildOrgExport(t.orgId);
    const files = unzipSync(zip);
    const text = strFromU8(files["tables/journal_lines.jsonl"]!);
    files["tables/journal_lines.jsonl"] = strToU8(text.replace(/"base_amount":"-?\d/, (m) => m.slice(0, -1) + "9"));
    expect(() => parseExport(zipSync(files))).toThrow(/checksum/);
    expect(() => parseExport(strToU8("not a zip"))).toThrow(/ZIP/);
  });
});
