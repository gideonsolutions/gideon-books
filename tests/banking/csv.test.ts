import { describe, expect, it } from "vitest";
import { detectDelimiter, guessMapping, parseBankDate, parseCsv, parseUserAmount } from "@/lib/banking/csv";
import { mapRows } from "@/lib/banking/imports";
import { computeSplits, firstMatchingRule, ruleMatches, type BankRule } from "@/lib/banking/rules-engine";

describe("CSV parsing", () => {
  it("handles quotes, doubled quotes, embedded delimiters and newlines, CRLF and a BOM", () => {
    const text = '﻿Date,Description,Amount\r\n2026-01-02,"Coffee, ""large""",-4.50\r\n2026-01-03,"Line one\nline two",10\r\n';
    expect(parseCsv(text)).toEqual([
      ["Date", "Description", "Amount"],
      ["2026-01-02", 'Coffee, "large"', "-4.50"],
      ["2026-01-03", "Line one\nline two", "10"],
    ]);
  });

  it("detects semicolon, tab and pipe delimiters", () => {
    expect(detectDelimiter("a;b;c\n1;2;3\n")).toBe(";");
    expect(detectDelimiter("a\tb\tc\n1\t2\t3\n")).toBe("\t");
    expect(detectDelimiter("a|b\n1|2\n")).toBe("|");
    expect(detectDelimiter('a,b\n"x;y",2\n')).toBe(",");
  });

  it("skips blank lines and keeps a missing trailing newline", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("amounts and dates", () => {
  it("parses the ways banks write amounts, never through a float", () => {
    const cases: [string, string | null][] = [
      ["$1,234.56", "1234.56"],
      ["(12.00)", "-12.00"],
      ["-12", "-12"],
      ["12-", "-12"],
      ["+3.10", "3.10"],
      ["12.00 CR", "12.00"],
      ["12.00 DR", "-12.00"],
      ["USD 99.99", "99.99"],
      ["0.1", "0.1"],
      ["abc", null],
      ["", null],
      ["1.2.3", null],
    ];
    for (const [input, want] of cases) expect(parseUserAmount(input)?.toString() ?? null).toBe(want);
    expect(parseUserAmount("1.234,56", { decimalComma: true })?.toString()).toBe("1234.56");
  });

  it("parses each date format and refuses impossible dates", () => {
    expect(parseBankDate("2026-03-05", "YYYY-MM-DD")).toBe("2026-03-05");
    expect(parseBankDate("03/05/2026", "MM/DD/YYYY")).toBe("2026-03-05");
    expect(parseBankDate("3/5/26", "M/D/YY")).toBe("2026-03-05");
    expect(parseBankDate("05/03/2026", "DD/MM/YYYY")).toBe("2026-03-05");
    expect(parseBankDate("05.03.2026", "DD.MM.YYYY")).toBe("2026-03-05");
    expect(parseBankDate("2026/03/05", "YYYY/MM/DD")).toBe("2026-03-05");
    expect(parseBankDate("02/30/2026", "MM/DD/YYYY")).toBeNull();
    expect(parseBankDate("2026-03-05 14:22", "YYYY-MM-DD")).toBe("2026-03-05");
  });
});

describe("mapping", () => {
  const csv = "Posted Date,Description,Debit,Credit,Balance\n01/02/2026,COFFEE,4.50,,95.50\n01/03/2026,DEPOSIT,,100.00,195.50\n13/45/2026,BAD,1,,\n";
  it("guesses a mapping from headers and maps debit/credit to signed amounts", () => {
    const rows = parseCsv(csv);
    const m = guessMapping(rows, ",");
    expect(m.amountMode).toBe("debit_credit");
    expect(m.hasHeader).toBe(true);
    const { rows: mapped } = mapRows(rows, m, "acct", "USD");
    expect(mapped.map((r) => r.amount)).toEqual(["-4.50", "100.00", null]);
    expect(mapped[2]!.errors.join(" ")).toMatch(/Date/);
    expect(mapped[0]!.balance).toBe("95.50");
  });

  it("inverts signs for credit-card exports and flags too many decimals", () => {
    const rows = parseCsv("Date,Desc,Amount\n2026-01-02,Charge,25.00\n2026-01-03,Odd,1.005\n");
    const { rows: mapped } = mapRows(rows, { ...guessMapping(rows, ","), dateFormat: "YYYY-MM-DD", invertSign: true }, "acct", "USD");
    expect(mapped[0]!.amount).toBe("-25.00");
    expect(mapped[1]!.errors.join(" ")).toMatch(/decimal places/);
  });

  it("gives identical rows in one file distinct fingerprints, and the same file the same ones", () => {
    const rows = parseCsv("Date,Desc,Amount\n2026-01-02,Coffee,-4.50\n2026-01-02,Coffee,-4.50\n");
    const m = { ...guessMapping(rows, ","), dateFormat: "YYYY-MM-DD" as const };
    const a = mapRows(rows, m, "acct", "USD").rows.map((r) => r.fingerprint);
    const b = mapRows(rows, m, "acct", "USD").rows.map((r) => r.fingerprint);
    expect(a[0]).not.toBe(a[1]);
    expect(a).toEqual(b);
  });
});

describe("rule engine", () => {
  const rule = (over: Partial<BankRule>): BankRule => ({
    id: over.id ?? "r",
    orgId: "o",
    name: over.name ?? "r",
    priority: over.priority ?? 10,
    conditions: over.conditions ?? { descriptionContains: "coffee" },
    actions: over.actions ?? { splits: [{ accountId: "meals" }] },
    mode: "suggest",
    isActive: true,
    createdBy: null,
    updatedBy: null,
    editorMayAutopost: false,
    createdAt: new Date(over.priority ?? 0),
    updatedAt: new Date(),
  });
  const t = { accountId: "a", amount: "-10.00", description: "CORNER COFFEE 123", payee: null, currency: "USD" };

  it("matches on conditions and refuses an empty rule", () => {
    expect(ruleMatches({ descriptionContains: "coffee", direction: "out", maxAmount: "20" }, t)).toBe(true);
    expect(ruleMatches({ descriptionContains: "coffee", direction: "in" }, t)).toBe(false);
    expect(ruleMatches({ descriptionRegex: "^corner\\s+coffee" }, t)).toBe(true);
    expect(ruleMatches({ minAmount: "11" }, t)).toBe(false);
    expect(ruleMatches({}, t)).toBe(false);
  });

  it("applies precedence: the lowest priority number wins", () => {
    const hit = firstMatchingRule([rule({ id: "b", name: "B", priority: 20 }), rule({ id: "a", name: "A", priority: 5 })], t);
    expect(hit?.rule.id).toBe("a");
  });

  it("splits fixed amounts first, then percentages of the rest, exactly", () => {
    const s = computeSplits({ splits: [{ accountId: "fee", amount: "1.00" }, { accountId: "x", percent: "50" }, { accountId: "y", percent: "50" }] }, "-10.01", "USD")!;
    expect(s.map((p) => [p.accountId, p.amount.toString()])).toEqual([
      ["fee", "1.00"],
      ["x", "4.51"],
      ["y", "4.50"],
    ]);
    expect(computeSplits({ splits: [{ accountId: "fee", amount: "20.00" }] }, "-10", "USD")).toBeNull();
  });
});
