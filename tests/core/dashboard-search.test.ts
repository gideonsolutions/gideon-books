import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { loadSyntheticDataset } from "@/lib/demo/dataset";
import { dashboardData } from "@/lib/dashboard";
import { searchOrg } from "@/lib/search";
import { refresh, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg({ name: "Dash Co", booksStartDate: "2025-01-01" });
  await loadSyntheticDataset(t.ctx, { year: 2025 });
  t.ctx = await refresh(t.ctx);
}, 120_000);

describe("dashboard", () => {
  it("shows cash, receivables and payables that agree with the ledger", async () => {
    const d = await dashboardData(getDb(), t.ctx, "2025-04-30");
    // Checking 28,261.79 + clearing 0 (+ other money accounts at zero)
    expect(d.cashTotal).toBe("28261.7900");
    expect(d.ar.total).toBe("209.5000");
    expect(d.ap.total).toBe("490.0000");
    // B3 was due 30 days after 01-20, so it is overdue at 04-30.
    expect(d.ap.overdue).toBe("250.0000");
    expect(d.series).toHaveLength(12);
  });
});

describe("search", () => {
  it("finds contacts, documents and entries, only in the organization", async () => {
    const hits = await searchOrg(getDb(), t.orgId, "bluewater");
    expect(hits.some((h) => h.type === "contact" && h.title === "Bluewater Cafe")).toBe(true);
    expect(hits.some((h) => h.type === "document")).toBe(true);
    const other = await setupOrg({ name: "Other" });
    expect(await searchOrg(getDb(), other.orgId, "bluewater")).toEqual([]);
    const inv = await searchOrg(getDb(), t.orgId, "INV-0001");
    expect(inv[0]?.type).toBe("document");
  });
});
