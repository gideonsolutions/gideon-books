import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { createProject, projectProfitability, listProjects } from "@/lib/projects/projects";
import { createTimeEntry, deleteTimeEntry, listTimeEntries, weeklyTimesheet, weekStart } from "@/lib/projects/time";
import { billProject, unbilledForProject } from "@/lib/projects/billing";
import { deleteDraft, getDocument, issueDocument, saveDraft, voidDocument } from "@/lib/commerce/documents";
import { customer, rejectsWith, setupOrg, vendor, type TestOrg } from "../helpers";

describe("projects and time", () => {
  let t: TestOrg;
  let customerId: string;
  beforeAll(async () => {
    t = await setupOrg();
    customerId = (await customer(t.ctx, "Riverside Clinic")).id;
  });

  it("records time, shows a weekly sheet, and bills unbilled time and expenses once", async () => {
    const p = await createProject(t.ctx, { name: "Clinic remodel", customerId, billingMethod: "time_and_materials", hourlyRate: "120", budgetAmount: "5000" });
    await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-03-02", userId: t.userId, hours: "3.5", description: "Site visit" });
    await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-03-03", userId: t.userId, hours: "2", rate: "150", description: "Drawings" });
    await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-03-04", userId: t.userId, hours: "1", billable: false, description: "Internal" });
    const week = await weeklyTimesheet(getDb(), t.orgId, "2026-03-05");
    expect(week.start).toBe("2026-03-02");
    expect(week.total.normalize().toString()).toBe("6.5");
    expect(weekStart("2026-03-08")).toBe("2026-03-02");

    // A billable expense on a bill.
    const v = await vendor(t.ctx, "Tile Supplier");
    const bill = await saveDraft(t.ctx, {
      kind: "bill",
      contactId: v.id,
      issueDate: "2026-03-05",
      reference: "T-77",
      lines: [{ description: "Tile", unitPrice: "400", accountId: await t.acct("6650"), projectId: p.id, billableCustomerId: customerId }],
    });
    await issueDocument(t.ctx, bill.id);

    const unbilled = await unbilledForProject(getDb(), t.orgId, p.id);
    expect(unbilled.time.length).toBe(2);
    expect(unbilled.expenses.length).toBe(1);

    const inv = await billProject(t.ctx, p.id, {
      timeEntryIds: unbilled.time.map((x) => x.id),
      expenseLineIds: unbilled.expenses.map((x) => x.lineId),
      markupPercent: "10",
      issueDate: "2026-03-31",
    });
    const { doc, lines } = await getDocument(getDb(), t.orgId, inv.id);
    expect(doc.status).toBe("draft");
    // 3.5 × 120 = 420; 2 × 150 = 300; 400 + 10% = 440
    expect(lines.map((l) => l.netAmount)).toEqual(["420.0000", "300.0000", "440.0000"]);
    expect(doc.total).toBe("1160.0000");
    expect(lines.every((l) => l.projectId === p.id)).toBe(true);

    // Billed work is not offered again and cannot be billed twice.
    const after = await unbilledForProject(getDb(), t.orgId, p.id);
    expect(after.time.length).toBe(0);
    expect(after.expenses.length).toBe(0);
    await rejectsWith(billProject(t.ctx, p.id, { timeEntryIds: unbilled.time.map((x) => x.id), expenseLineIds: [], issueDate: "2026-03-31" }), "already_billed");
    // Billed time is locked.
    await rejectsWith(deleteTimeEntry(t.ctx, unbilled.time[0]!.id), "time_billed");

    // Deleting the draft releases everything.
    await deleteDraft(t.ctx, inv.id);
    expect((await unbilledForProject(getDb(), t.orgId, p.id)).time.length).toBe(2);
  });

  it("releases work from a void invoice and reports profitability from the ledger", async () => {
    const p = await createProject(t.ctx, { name: "Kiosk build", customerId, billingMethod: "time_and_materials", hourlyRate: "100", budgetAmount: "1000" });
    await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-04-01", userId: t.userId, hours: "4" });
    const v = await vendor(t.ctx, "Lumber Co");
    const bill = await saveDraft(t.ctx, { kind: "bill", contactId: v.id, issueDate: "2026-04-02", reference: "L-1", lines: [{ description: "Lumber", unitPrice: "250", accountId: await t.acct("6650"), projectId: p.id }] });
    await issueDocument(t.ctx, bill.id);
    const { time } = await unbilledForProject(getDb(), t.orgId, p.id);
    const inv = await billProject(t.ctx, p.id, { timeEntryIds: time.map((x) => x.id), expenseLineIds: [], issueDate: "2026-04-30" });
    await issueDocument(t.ctx, inv.id);
    const prof = await projectProfitability(getDb(), t.orgId, p.id);
    expect(prof.income.toString()).toBe("400.0000");
    expect(prof.costs.toString()).toBe("250.0000");
    expect(prof.profit.toString()).toBe("150.0000");
    expect(prof.marginPercent).toBe("37.5");
    expect(prof.budgetRemaining!.toString()).toBe("750.0000");
    expect(prof.hours.toString()).toBe("4.00");

    await voidDocument(t.ctx, inv.id, { date: "2026-05-01", reason: "Billed the wrong customer" });
    const again = await unbilledForProject(getDb(), t.orgId, p.id);
    expect(again.time.length).toBe(1);
    const inv2 = await billProject(t.ctx, p.id, { timeEntryIds: again.time.map((x) => x.id), expenseLineIds: [], issueDate: "2026-05-02" });
    expect(inv2.id).not.toBe(inv.id);
    const list = await listTimeEntries(getDb(), t.orgId, { projectId: p.id, state: "billed" });
    expect(list.total).toBe(1);
    const projects = await listProjects(getDb(), t.orgId, { q: "Kiosk" });
    expect(projects.rows[0]!.income).toBe("0.0000");
  });

  it("refuses a billable project without a customer, and billing at no rate", async () => {
    await rejectsWith(createProject(t.ctx, { name: "Orphan", billingMethod: "time_and_materials" }), "validation_failed");
    const p = await createProject(t.ctx, { name: "No rate", customerId, billingMethod: "time_and_materials" });
    const e = await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-04-01", userId: t.userId, hours: "1" });
    await rejectsWith(billProject(t.ctx, p.id, { timeEntryIds: [e.id], expenseLineIds: [], issueDate: "2026-04-30" }), "validation_failed");
  });

  it("bills the same work once when two people bill at the same time", async () => {
    const p = await createProject(t.ctx, { name: "Race", customerId, billingMethod: "time_and_materials", hourlyRate: "50" });
    const e = await createTimeEntry(t.ctx, { projectId: p.id, workDate: "2026-04-01", userId: t.userId, hours: "1" });
    const results = await Promise.allSettled([1, 2].map(() => billProject(t.ctx, p.id, { timeEntryIds: [e.id], expenseLineIds: [], issueDate: "2026-04-30" })));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
    const drafts = await getDb().execute(`select count(*)::int as n from documents where org_id = '${t.orgId}' and memo = 'Billed from project Race'`);
    expect((drafts.rows[0] as { n: number }).n).toBe(1);
  });
});
