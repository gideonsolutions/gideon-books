import { describe, expect, it } from "vitest";
import { ecbCross, parseEcbXml } from "@/lib/fx/providers";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-03-05'>
      <Cube currency='USD' rate='1.0850'/>
      <Cube currency='JPY' rate='161.20'/>
      <Cube currency='GBP' rate='0.84150'/>
    </Cube>
    <Cube time='2026-03-04'>
      <Cube currency='USD' rate='1.0800'/>
      <Cube currency='GBP' rate='0.84000'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

describe("ECB reference rates", () => {
  it("parses the published XML by day", () => {
    const days = parseEcbXml(SAMPLE);
    expect([...days.keys()]).toEqual(["2026-03-05", "2026-03-04"]);
    expect(days.get("2026-03-05")!.get("USD")!.toString()).toBe("1.0850");
    expect(days.get("2026-03-05")!.get("EUR")!.toString()).toBe("1");
  });

  it("crosses rates into the organization's base currency exactly", () => {
    const d = parseEcbXml(SAMPLE).get("2026-03-05")!;
    // USD per EUR is the EUR quote itself.
    expect(ecbCross(d, "USD", "EUR")!.toString()).toBe("1.0850000000");
    // USD per GBP = 1.0850 / 0.84150, rounded half-up to 10 places.
    expect(ecbCross(d, "USD", "GBP")!.toString()).toBe("1.2893642305");
    // EUR per USD for a euro-based organization.
    expect(ecbCross(d, "EUR", "USD")!.toString()).toBe("0.9216589862");
    expect(ecbCross(d, "USD", "CHF")).toBeNull();
  });
});
