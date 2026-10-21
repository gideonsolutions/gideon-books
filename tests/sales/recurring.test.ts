import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { documents, recurringRuns, recurringTemplates } from "@/lib/db/schema/commerce";
import { createRecurringTemplate, occurrenceDate, runDueRecurring, runTemplate, updateRecurringSchedule } from "@/lib/sales/recurring";
import { customer, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

describe("recurring invoices", () => {
  it("anchors occurrences on the start date", () => {
    expect(occurrenceDate("2026-01-31", "monthly", 1, 1)).toBe("2026-02-28");
    expect(occurrenceDate("2026-01-31", "monthly", 1, 2)).toBe("2026-03-31");
    expect(occurrenceDate("2026-01-05", "weekly", 2, 3)).toBe("2026-02-16");
    expect(occurrenceDate("2026-01-15", "quarterly", 1, 2)).toBe("2026-07-15");
  });

  it("makes each occurrence exactly once, even when run twice or concurrently", async () => {
    const c = await customer(t.ctx, "Subscriber", { email: "subscriber@example.test" });
    const tpl = await createRecurringTemplate(
      t.ctx,
      { kind: "invoice", contactId: c.id, issueDate: "2026-01-01", lines: [{ description: "Monthly service", unitPrice: "99" }] },
      { name: "Monthly service", frequency: "monthly", interval: 1, startDate: "2026-01-10", autoIssue: true, autoSend: true },
    );
    expect(tpl.status).toBe("active");
    const results = await Promise.all([runTemplate(t.ctx, tpl.id, "2026-03-15"), runTemplate(t.ctx, tpl.id, "2026-03-15"), runDueRecurring("2026-03-15", t.orgId)]);
    expect(results.reduce((s, r) => s + r.created, 0)).toBe(3);
    const again = await runTemplate(t.ctx, tpl.id, "2026-03-15");
    expect(again.created).toBe(0);
    const docs = await getDb().select().from(documents).where(and(eq(documents.orgId, t.orgId), eq(documents.recurringTemplateId, tpl.id)));
    expect(docs.map((d) => d.issueDate).sort()).toEqual(["2026-01-10", "2026-02-10", "2026-03-10"]);
    expect(docs.every((d) => d.status === "issued" && d.sentAt)).toBe(true);
    const runs = await getDb().select().from(recurringRuns).where(eq(recurringRuns.templateId, tpl.id));
    expect(runs).toHaveLength(3);
    const [after] = await getDb().select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect(after!.nextRunDate).toBe("2026-04-10");
    expect(after!.occurrences).toBe(3);
  });

  it("ends after the maximum, and records a failure without skipping the occurrence", async () => {
    const c = await customer(t.ctx, "Limited");
    const tpl = await createRecurringTemplate(
      t.ctx,
      { kind: "invoice", contactId: c.id, issueDate: "2026-01-01", lines: [{ unitPrice: "10" }] },
      { name: "Two only", frequency: "weekly", interval: 1, startDate: "2026-02-02", maxOccurrences: 2, autoIssue: false, autoSend: false },
    );
    const r = await runTemplate(t.ctx, tpl.id, "2026-03-31");
    expect(r.created).toBe(2);
    const [after] = await getDb().select().from(recurringTemplates).where(eq(recurringTemplates.id, tpl.id));
    expect(after!.status).toBe("ended");

    const bad = await createRecurringTemplate(
      t.ctx,
      { kind: "invoice", contactId: c.id, issueDate: "2026-01-01", lines: [{ unitPrice: "10", taxCodeId: "00000000-0000-4000-8000-000000000000" }] },
      { name: "Broken", frequency: "monthly", interval: 1, startDate: "2026-02-01", autoIssue: false, autoSend: false },
    );
    const r2 = await runTemplate(t.ctx, bad.id, "2026-02-15");
    expect(r2.created).toBe(0);
    expect(r2.errors).toHaveLength(1);
    const [b] = await getDb().select().from(recurringTemplates).where(eq(recurringTemplates.id, bad.id));
    expect(b!.nextRunDate).toBe("2026-02-01");
    const [run] = await getDb().select().from(recurringRuns).where(eq(recurringRuns.templateId, bad.id));
    expect(run!.status).toBe("failed");
    // Fixing the schedule keeps the occurrence pending.
    await updateRecurringSchedule(t.ctx, bad.id, { name: "Broken", frequency: "monthly", interval: 1, startDate: "2026-02-01", autoIssue: false, autoSend: false });
  });
});
