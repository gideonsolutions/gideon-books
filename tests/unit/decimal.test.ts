import { describe, expect, it } from "vitest";
import { Decimal, D } from "@/lib/money/decimal";
import { roundMoney, parseMoney } from "@/lib/money/currency";
import { formatMoney } from "@/lib/money/format";

describe("Decimal", () => {
  it("adds without binary floating-point error", () => {
    expect(D("0.1").add("0.2").toString()).toBe("0.3");
    expect(Decimal.sum(Array(10).fill("0.1")).toString()).toBe("1.0");
  });

  it("refuses non-integer JavaScript numbers", () => {
    expect(() => Decimal.from(0.1)).toThrow(/refuses/);
    expect(Decimal.from(3).toString()).toBe("3");
  });

  it("multiplies exactly and divides with an explicit rounding mode", () => {
    expect(D("19.99").mul("3").toString()).toBe("59.97");
    expect(D("10").div("3", 2, "half_up").toString()).toBe("3.33");
    expect(D("2").div("3", 2, "half_up").toString()).toBe("0.67");
    expect(D("-2").div("3", 2, "half_up").toString()).toBe("-0.67");
  });

  it("rounds half-up away from zero and half-even to even", () => {
    expect(D("2.345").round(2, "half_up").toString()).toBe("2.35");
    expect(D("-2.345").round(2, "half_up").toString()).toBe("-2.35");
    expect(D("2.345").round(2, "half_even").toString()).toBe("2.34");
    expect(D("2.355").round(2, "half_even").toString()).toBe("2.36");
    expect(D("2.349").round(2, "down").toString()).toBe("2.34");
    expect(D("-2.341").round(2, "floor").toString()).toBe("-2.35");
    expect(D("2.341").round(2, "ceiling").toString()).toBe("2.35");
  });

  it("allocates so parts sum exactly", () => {
    const parts = D("100.00").allocate(["1", "1", "1"], 2).map((p) => p.toString());
    expect(parts).toEqual(["33.34", "33.33", "33.33"]);
    expect(Decimal.sum(parts).toString()).toBe("100.00");
    const uneven = D("10.00").allocate(["0.5", "0.25", "0.25"], 2).map(String);
    expect(uneven).toEqual(["5.00", "2.50", "2.50"]);
  });

  it("refuses to drop precision silently", () => {
    expect(() => D("1.005").toFixed(2)).toThrow();
    expect(() => parseMoney("1.005", "USD")).toThrow(/decimal places/);
    expect(parseMoney("1.5", "USD").toString()).toBe("1.50");
    expect(() => parseMoney("1.5", "JPY")).toThrow();
    expect(roundMoney("1.005", "USD").toString()).toBe("1.01");
    expect(roundMoney("1.0005", "BHD").toString()).toBe("1.001");
  });

  it("parses strictly", () => {
    expect(() => D("1,000")).toThrow();
    expect(() => D("1e3")).toThrow();
    expect(D("-0012.50").toString()).toBe("-12.50");
  });

  it("formats with the currency's minor units and accounting negatives", () => {
    expect(formatMoney("1234.5", "USD")).toBe("$1,234.50");
    expect(formatMoney("-1234.5", "USD")).toBe("($1,234.50)");
    expect(formatMoney("1234", "JPY")).toBe("¥1,234");
    expect(formatMoney("12345678901234.56", "USD")).toBe("$12,345,678,901,234.56");
  });
});
