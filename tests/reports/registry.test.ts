import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { recordPayment } from "@/lib/commerce/payments";
import { createDimension } from "@/lib/ledger/dimensions";
import { createBudget } from "@/lib/budgets/budgets";
import { buildReport, REPORTS } from "@/lib/reports/registry";
import { profitAndLoss } from "@/lib/reports/statements";
import { toCsv, toPdf } from "@/lib/reports/export";
import { customer, setupOrg, stockItem, vendor, type TestOrg } from "../helpers";
import { doc, parseCsv, pdfText } from "./helpers";

let t: TestOrg;
let budgetId = "";
let classA = "";

beforeAll(async () => {
  t = await setupOrg({ name: "Registry Co" });
  const c = await customer(t.ctx, "Customer, \"Quoted\" & Co");
  const v = await vendor(t.ctx, "=SUM(A1) Vendor");
  const w = await stockItem(t.ctx, "Thing");
  const a = await createDimension(t.ctx, { kind: "class", name: "Retail" });
  classA = a.id;
  await doc(t.ctx, "bill", v.id, "2026-02-01", [{ itemId: w.id, quantity: "5", unitPrice: "10" }], { reference: "B-9" });
  const inv = await doc(t.ctx, "invoice", c.id, "2026-02-03", [
    { itemId: w.id, quantity: "2", unitPrice: "30", classId: a.id },
    { unitPrice: "100", accountId: await t.acct("4100") },
  ]);
  await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-02-10", accountId: await t.acct("1000"), amount: "100", allocations: [{ itemType: "document", itemId: inv.id, amount: "100" }] });
  budgetId = (await createBudget(t.ctx, { name: "B", fiscalYearStart: "2026-01-01", copyActuals: { basis: "accrual" } })).id;
});

describe("every report", () => {
  it("builds, and its CSV and PDF carry the same figures", async () => {
    for (const def of REPORTS) {
      for (const basis of def.basis ? ["accrual", "cash"] : ["accrual"]) {
        const params: Record<string, string> = { from: "2026-01-01", to: "2026-03-31", basis, ...(def.key === "budget-vs-actual" ? { budget: budgetId } : {}), ...(def.extra?.includes("detail") ? { detail: "1" } : {}) };
        const table = await buildReport(getDb(), t.ctx.org, def.key, params);
        expect(table.columns.length, def.key).toBeGreaterThan(0);
        expect(table.warnings ?? [], `${def.key} ${basis}`).toEqual([]);
        const csv = parseCsv(toCsv(table));
        const header = csv.findIndex((r) => r.join("|") === table.columns.map((c) => c.label).join("|"));
        expect(header, def.key).toBeGreaterThan(0);
        const body = csv.slice(header + 1, header + 1 + table.rows.length);
        table.rows.forEach((r, i) => {
          r.cells.forEach((c, j) => {
            if (j === 0) return;
            const v = c.value ?? "";
            const expected = /^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v) ? `'${v}` : v;
            expect(body[i]?.[j] ?? "", `${def.key} row ${i} col ${j}`).toBe(expected);
          });
        });
        const pdf = await toPdf(table, t.ctx.org.name);
        expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
        expect(pdfText(pdf)).toContain(table.title);
      }
    }
  });

  it("neutralizes spreadsheet formulas in CSV text", async () => {
    const table = await buildReport(getDb(), t.ctx.org, "ap-aging", { to: "2026-03-31" });
    const text = toCsv(table);
    expect(text).toContain("'=SUM(A1) Vendor");
  });

  it("puts dimensions in columns, with unassigned lines and a total", async () => {
    const names = new Map([[classA, "Retail"]]);
    const pl = await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual", columnsBy: "class", dimensionNames: names });
    expect(pl.columns.map((c) => c.label)).toEqual(["Retail", "Not assigned", "Total"]);
    // Retail: 60 sales − 20 cost; unassigned: 100 service; total 140.
    expect(pl.netIncome.map((v) => v.toFixed(2))).toEqual(["40.00", "100.00", "140.00"]);
    const filtered = await profitAndLoss(getDb(), t.ctx.org, { from: "2026-01-01", to: "2026-03-31", basis: "accrual", filters: { classId: "none" } });
    expect(filtered.netIncome[0]!.toFixed(2)).toBe("100.00");
  });
});
