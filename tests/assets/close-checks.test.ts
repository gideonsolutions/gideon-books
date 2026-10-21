import { describe, expect, it } from "vitest";
import { getDb, withTransaction } from "@/lib/db/client";
import { ensureFiscalYear, periodFor, previewClose } from "@/lib/ledger/periods";
import { capitalizeAsset, createAsset } from "@/lib/assets/assets";
import { postRun, prepareRun } from "@/lib/assets/depreciation";
import { createImport, postImport } from "@/lib/payroll/imports";
import { setupOrg } from "../helpers";

const CSV = [
  "run_id,pay_date,period_start,period_end,employee_id,employee_name,gross:regular,withholding:federal_income_tax,net_pay",
  "R1,2026-01-31,2026-01-01,2026-01-31,E1,Ada,1000.00,100.00,900.00",
].join("\n");

describe("close checks from assets and payroll", () => {
  it("warns about unposted depreciation, pending payroll imports and uncleared net pay", async () => {
    const o = await setupOrg();
    await withTransaction((tx) => ensureFiscalYear(tx, o.ctx.org, "2026-01-15"));
    const jan = (await periodFor(getDb(), o.orgId, "2026-01-15"))!;
    const a = await createAsset(o.ctx, { name: "Laptop", acquisitionDate: "2026-01-05", cost: "1200", usefulLifeMonths: 12, method: "straight_line", acquisitionType: "direct", fundingAccountId: await o.acct("1000") });
    await capitalizeAsset(o.ctx, a.id);
    await createImport(o.ctx, { adapter: "generic_csv", fileName: "pending.csv", content: CSV });
    let { checks } = await previewClose(getDb(), o.ctx, jan.id);
    const byKey = (k: string) => checks.find((c) => c.key === k);
    expect(byKey("depreciation_posted")?.status).toBe("fail");
    expect(byKey("payroll_imports_posted")?.status).toBe("fail");

    await postRun(o.ctx, (await prepareRun(o.ctx, "2026-01-31")).id);
    const imp = await createImport(o.ctx, { adapter: "generic_csv", fileName: "r1.csv", content: CSV + "\n" });
    await postImport(o.ctx, imp.id);
    ({ checks } = await previewClose(getDb(), o.ctx, jan.id));
    expect(byKey("depreciation_posted")?.status).toBe("pass");
    expect(checks.find((c) => c.key === "net_pay_cleared")?.status).toBe("fail");
  });
});
