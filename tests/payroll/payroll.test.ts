import { beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@/lib/db/client";
import { genericCsv, genericJson } from "@/lib/payroll/adapters";
import { createImport, postImport, previewImport, voidRun, getRun } from "@/lib/payroll/imports";
import { listMappings, saveMapping } from "@/lib/payroll/mappings";
import { recordLiabilityPayment, recordNetPay, voidSettlement } from "@/lib/payroll/settlements";
import { payrollLiabilityReport, payrollSummary } from "@/lib/payroll/reports";
import { createDimension } from "@/lib/ledger/dimensions";
import { balance, rejectsWith, setupOrg, type TestOrg } from "../helpers";

const HEADER =
  "run_id,pay_date,period_start,period_end,employee_id,employee_name,department,gross:regular,gross:overtime,withholding:federal_income_tax,withholding:social_security,withholding:medicare,deduction:health,employer_tax:social_security,employer_tax:medicare,employer_tax:futa,employer_benefit:health,reimbursement:mileage,net_pay";
const csv = (runId: string, ada = "3324.20") =>
  [
    HEADER,
    `${runId},2026-01-31,2026-01-01,2026-01-31,E1,"Lovelace, Ada",,"4,000.00",200.00,500.00,260.40,60.90,100.00,260.40,60.90,24.00,300.00,45.50,${ada}`,
    `${runId},2026-01-31,2026-01-01,2026-01-31,E2,Grace Hopper,,3000.00,,300.00,186.00,43.50,50.00,186.00,43.50,18.00,200.00,,2420.50`,
  ].join("\n");

describe("payroll import formats", () => {
  it("parses the employee-level CSV", () => {
    const r = genericCsv.parse(csv("PR-1"));
    expect(r.errors).toEqual([]);
    expect(r.run!.level).toBe("employee");
    expect(r.run!.components.filter((c) => c.employeeRef === "E1" && c.type === "gross_wages").map((c) => c.amount)).toEqual(["4000.00", "200.00"]);
    expect(r.run!.components.find((c) => c.employeeRef === "E1")!.employeeName).toBe("Lovelace, Ada");
  });

  it("parses JSON and the summary formats, and refuses float amounts in JSON", () => {
    const j = genericJson.parse(
      JSON.stringify({
        run_id: "J1",
        pay_date: "2026-02-15",
        period_start: "2026-02-01",
        period_end: "2026-02-15",
        employees: [{ employee_id: "E1", name: "Ada", earnings: { regular: "1000.00" }, withholdings: { federal_income_tax: "100.00" }, employer_taxes: { medicare: "14.50" }, net_pay: "900.00" }],
      }),
    );
    expect(j.errors).toEqual([]);
    expect(j.run!.components.length).toBe(4);
    const bad = genericJson.parse(JSON.stringify({ run_id: "J2", pay_date: "2026-02-15", period_start: "2026-02-01", period_end: "2026-02-15", employees: [{ employee_id: "E1", earnings: { regular: 1000.1 }, net_pay: "1000.10" }] }));
    expect(bad.errors.join(" ")).toMatch(/not JSON numbers/);
    const summary = genericCsv.parse(
      ["run_id,pay_date,period_start,period_end,component_type,component_code,amount", "S1,2026-03-31,2026-03-01,2026-03-31,gross_wages,regular,5000.00", "S1,2026-03-31,2026-03-01,2026-03-31,employee_withholding,federal_income_tax,600.00", "S1,2026-03-31,2026-03-01,2026-03-31,net_pay,,4400.00"].join("\n"),
    );
    expect(summary.errors).toEqual([]);
    expect(summary.run!.level).toBe("summary");
  });
});

describe("payroll posting", () => {
  let t: TestOrg;
  beforeAll(async () => {
    t = await setupOrg();
  });

  it("previews, validates and posts a balanced entry per the mappings", async () => {
    const imp = await createImport(t.ctx, { adapter: "generic_csv", fileName: "jan.csv", content: csv("PR-2026-01") });
    const { preview } = await previewImport(getDb(), t.ctx, imp.id);
    expect(preview.errors).toEqual([]);
    expect(preview.employeeCount).toBe(2);
    expect(preview.totals.net_pay).toBe("5744.70");
    const run = await postImport(t.ctx, imp.id);
    expect(run.grossWages).toBe("7200.0000");
    expect(await balance(t.orgId, await t.acct("wages_expense"))).toBe("7200.00");
    expect(await balance(t.orgId, await t.acct("payroll_tax_expense"))).toBe("592.80");
    expect(await balance(t.orgId, await t.acct("benefits_expense"))).toBe("500.00");
    expect(await balance(t.orgId, await t.acct("general_expense"))).toBe("45.50");
    expect(await balance(t.orgId, await t.acct("payroll_liabilities"))).toBe("-2593.60");
    expect(await balance(t.orgId, await t.acct("net_pay_clearing"))).toBe("-5744.70");
    // Posting the same import again returns the same run.
    expect((await postImport(t.ctx, imp.id)).id).toBe(run.id);
  });

  it("refuses the same run or the same file twice", async () => {
    const again = await createImport(t.ctx, { adapter: "generic_csv", fileName: "jan-again.csv", content: csv("PR-2026-01") });
    const { preview } = await previewImport(getDb(), t.ctx, again.id);
    expect(preview.duplicateOf).not.toBeNull();
    await rejectsWith(postImport(t.ctx, again.id), "validation_failed");
    const renamed = await createImport(t.ctx, { adapter: "generic_csv", fileName: "x.csv", content: csv("PR-2026-01") + "\n" });
    await rejectsWith(postImport(t.ctx, renamed.id), "validation_failed");
  });

  it("refuses an employee whose net pay does not follow from the components", async () => {
    const imp = await createImport(t.ctx, { adapter: "generic_csv", fileName: "bad.csv", content: csv("PR-BAD", "3324.21") });
    const { preview } = await previewImport(getDb(), t.ctx, imp.id);
    expect(preview.errors.join(" ")).toMatch(/Lovelace, Ada: .* net pay is 3324.21 \(off by -0.01\)/);
    await rejectsWith(postImport(t.ctx, imp.id), "validation_failed");
  });

  it("refuses unknown dimensions and honors a specific mapping over the default", async () => {
    const o = await setupOrg();
    const content = csv("PR-D").replace(/,E1,"Lovelace, Ada",,/, ',E1,"Lovelace, Ada",Kitchen,');
    let imp = await createImport(o.ctx, { adapter: "generic_csv", fileName: "d.csv", content });
    expect((await previewImport(getDb(), o.ctx, imp.id)).preview.errors.join(" ")).toMatch(/No department named "Kitchen"/);
    await createDimension(o.ctx, { kind: "department", name: "Kitchen" });
    await saveMapping(o.ctx, { componentType: "reimbursement", componentCode: "mileage", expenseAccountId: await o.acct("6850") });
    imp = await createImport(o.ctx, { adapter: "generic_csv", fileName: "d2.csv", content: content + "\n\n" });
    const { preview } = await previewImport(getDb(), o.ctx, imp.id);
    expect(preview.errors).toEqual([]);
    await postImport(o.ctx, imp.id);
    expect(await balance(o.orgId, await o.acct("6850"))).toBe("45.50");
    expect((await listMappings(getDb(), o.orgId)).some((m) => m.componentCode === "*")).toBe(true);
  });

  it("voids a run and allows the corrected import", async () => {
    const o = await setupOrg();
    const imp = await createImport(o.ctx, { adapter: "generic_csv", fileName: "v.csv", content: csv("PR-V") });
    const run = await postImport(o.ctx, imp.id);
    await voidRun(o.ctx, run.id, { date: "2026-02-05", reason: "Wrong overtime" });
    expect(await balance(o.orgId, await o.acct("wages_expense"))).toBe("0.00");
    const again = await createImport(o.ctx, { adapter: "generic_csv", fileName: "v.csv", content: csv("PR-V") });
    const run2 = await postImport(o.ctx, again.id);
    expect(run2.id).not.toBe(run.id);
    expect((await getRun(getDb(), o.orgId, run.id)).run.status).toBe("void");
  });

  it("posts only one of two concurrent imports of the same run", async () => {
    const o = await setupOrg();
    const a = await createImport(o.ctx, { adapter: "generic_csv", fileName: "a.csv", content: csv("PR-C") });
    const b = await createImport(o.ctx, { adapter: "generic_csv", fileName: "b.csv", content: csv("PR-C") + "\n" });
    const results = await Promise.allSettled([postImport(o.ctx, a.id), postImport(o.ctx, b.id)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(1);
  });

  it("settles net pay and liabilities, and the liability report agrees with the ledger", async () => {
    const o = await setupOrg();
    const imp = await createImport(o.ctx, { adapter: "generic_csv", fileName: "s.csv", content: csv("PR-S") });
    const run = await postImport(o.ctx, imp.id);
    await recordNetPay(o.ctx, run.id, { date: "2026-01-31", bankAccountId: await o.acct("1000") });
    expect(await balance(o.orgId, await o.acct("net_pay_clearing"))).toBe("0.00");
    await rejectsWith(recordNetPay(o.ctx, run.id, { date: "2026-01-31", bankAccountId: await o.acct("1000"), amount: "1.00" }), "validation_failed");
    const dep = await recordLiabilityPayment(o.ctx, { runId: run.id, liabilityAccountId: await o.acct("payroll_liabilities"), date: "2026-02-15", bankAccountId: await o.acct("1000"), amount: "2000.00", reference: "EFTPS" });
    expect(await balance(o.orgId, await o.acct("payroll_liabilities"))).toBe("-593.60");
    const rep = await payrollLiabilityReport(getDb(), o.orgId, "2026-01-01", "2026-12-31");
    expect(rep.reconciled).toBe(true);
    const liabId = await o.acct("payroll_liabilities");
    const liab = rep.rows.find((r) => r.accountId === liabId)!;
    expect(liab.accrued).toBe("2593.6000");
    expect(liab.paid).toBe("2000.0000");
    expect(liab.closing).toBe("593.6000");
    expect(liab.ledger).toBe("593.6000");
    await rejectsWith(voidRun(o.ctx, run.id, { date: "2026-02-20", reason: "test" }), "run_settled");
    await voidSettlement(o.ctx, dep.id, { date: "2026-02-20", reason: "Bounced" });
    expect(await balance(o.orgId, await o.acct("payroll_liabilities"))).toBe("-2593.60");
    const summary = await payrollSummary(getDb(), o.orgId, "2026-01-01", "2026-01-31");
    expect(summary.totals.grossWages).toBe("7200.0000");
    expect(summary.totals.employerCost).toBe("8338.3000");
  });
});
