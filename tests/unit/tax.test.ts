import { describe, expect, it } from "vitest";
import { D } from "@/lib/money/decimal";
import { calculateTaxes, inclusiveMultiplier, type TaxComponent } from "@/lib/tax/calculate";
import { computeDocument } from "@/lib/commerce/compute";

const state: TaxComponent = { jurisdictionId: "s", taxRateId: "rs", rate: D("0.0475"), sequence: 1, isCompound: false, accountId: "a" };
const county: TaxComponent = { jurisdictionId: "c", taxRateId: "rc", rate: D("0.0225"), sequence: 2, isCompound: false, accountId: "a" };
const compound: TaxComponent = { jurisdictionId: "q", taxRateId: "rq", rate: D("0.10"), sequence: 2, isCompound: true, accountId: "a" };

describe("sales tax", () => {
  it("rounds per line, half-up, per component", () => {
    const [r] = calculateTaxes([{ key: "1", amount: D("19.99"), components: [state, county], exempt: false }], { currency: "USD", inclusive: false, rounding: "line" });
    // 19.99 × 4.75% = 0.949525 → 0.95; × 2.25% = 0.449775 → 0.45
    expect(r!.taxes.map((t) => t.amount.toString())).toEqual(["0.95", "0.45"]);
    expect(r!.gross.toString()).toBe("21.39");
  });

  it("document rounding sums before rounding and spreads back exactly", () => {
    const lines = [1, 2, 3].map((k) => ({ key: String(k), amount: D("0.10"), components: [state], exempt: false }));
    const perLine = calculateTaxes(lines, { currency: "USD", inclusive: false, rounding: "line" });
    const perDoc = calculateTaxes(lines, { currency: "USD", inclusive: false, rounding: "document" });
    // each line: 0.00475 → 0.00; the document: 0.01425 → 0.01
    expect(perLine.reduce((s, l) => s.add(l.tax), D("0")).toString()).toBe("0.00");
    expect(perDoc.reduce((s, l) => s.add(l.tax), D("0")).toString()).toBe("0.01");
  });

  it("compounds on the running total", () => {
    const [r] = calculateTaxes([{ key: "1", amount: D("100.00"), components: [{ ...state, rate: D("0.05") }, compound], exempt: false }], { currency: "USD", inclusive: false, rounding: "line" });
    // 5.00, then 10% of 105.00 = 10.50
    expect(r!.taxes.map((t) => t.amount.toString())).toEqual(["5.00", "10.50"]);
    expect(inclusiveMultiplier([{ ...state, rate: D("0.05") }, compound]).toString()).toBe("1.1550");
  });

  it("backs tax out of inclusive prices so the gross is exactly the price", () => {
    const [r] = calculateTaxes([{ key: "1", amount: D("10.00"), components: [state, county], exempt: false }], { currency: "USD", inclusive: true, rounding: "line" });
    expect(r!.gross.toString()).toBe("10.00");
    expect(r!.net.add(r!.tax).toString()).toBe("10.00");
    // 10 / 1.07 = 9.345794… → 9.35; taxes 0.44 + 0.21 = 0.65; net absorbs → 9.35
    expect(r!.net.toString()).toBe("9.35");
  });

  it("records exempt lines with zero tax", () => {
    const [r] = calculateTaxes([{ key: "1", amount: D("50.00"), components: [state], exempt: true }], { currency: "USD", inclusive: false, rounding: "line" });
    expect(r!.tax.toString()).toBe("0.00");
    expect(r!.taxes[0]!.exempt).toBe(true);
  });

  it("computes a document with line and document discounts", () => {
    const doc = computeDocument({
      currency: "USD",
      taxInclusive: false,
      rounding: "line",
      discountType: "percent",
      discountValue: "10",
      lines: [
        { key: "a", quantity: "3", unitPrice: "19.99", discountRate: "0.05", taxComponents: [state] },
        { key: "b", quantity: "1", unitPrice: "10", taxComponents: [] },
        { key: "s", lineType: "shipping", quantity: "1", unitPrice: "7.50", taxComponents: [] },
      ],
    });
    // a: 59.97 − 3.00 = 56.97; b: 10.00; discount 10% of 66.97 = 6.70 split 5.70 / 1.00
    expect(doc.lines.map((l) => l.amount.toString())).toEqual(["56.97", "10.00", "7.50"]);
    expect(doc.discountTotal.toString()).toBe("6.70");
    expect(doc.lines.map((l) => l.documentDiscount.toString())).toEqual(["5.70", "1.00", "0.00"]);
    // tax on 51.27 at 4.75% = 2.435325 → 2.44
    expect(doc.taxTotal.toString()).toBe("2.44");
    expect(doc.total.toString()).toBe(D("51.27").add("9.00").add("7.50").add("2.44").toString());
  });
});
