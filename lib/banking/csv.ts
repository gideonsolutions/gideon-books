/**
 * Reading bank exports: RFC 4180 CSV (quoted fields, doubled quotes,
 * embedded delimiters and newlines, CRLF or LF, a leading byte-order mark),
 * delimiter detection, and the tolerant parsing of amounts and dates that
 * bank files need. Amounts become Decimals — never floats.
 */
import { Decimal } from "@/lib/money/decimal";
import { fromParts, isIsoDate } from "@/lib/dates";
import type { CsvMappingConfig } from "@/lib/db/schema/banking";

export const DELIMITERS = [",", ";", "\t", "|"] as const;

/** Count delimiter occurrences outside quotes in the first few lines. */
export function detectDelimiter(text: string): string {
  const sample = text.replace(/^﻿/, "").slice(0, 8192);
  let best = ",";
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts: number[] = [];
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < sample.length && counts.length < 10; i++) {
      const ch = sample[i]!;
      if (ch === '"') {
        if (inQuotes && sample[i + 1] === '"') i++;
        else inQuotes = !inQuotes;
      } else if (!inQuotes && ch === d) count++;
      else if (!inQuotes && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && sample[i + 1] === "\n") i++;
        counts.push(count);
        count = 0;
      }
    }
    if (count > 0) counts.push(count);
    const nonEmpty = counts.filter((c) => c > 0);
    if (!nonEmpty.length) continue;
    // Consistent counts across lines score best.
    const mode = nonEmpty.sort((a, b) => nonEmpty.filter((x) => x === b).length - nonEmpty.filter((x) => x === a).length)[0]!;
    const consistency = nonEmpty.filter((c) => c === mode).length;
    const score = consistency * 100 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

/** Parse CSV text into rows of cells. */
export function parseCsv(text: string, delimiter?: string | null): string[][] {
  const src = text.replace(/^﻿/, "");
  const d = delimiter || detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === "") {
      inQuotes = true;
      cell = "";
      i++;
      continue;
    }
    if (ch === d) {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (ch === "\r" && src[i + 1] === "\n") i++;
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // Drop lines that are entirely empty.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/**
 * Parse an amount the way people and banks write them: "$1,234.56",
 * "(12.00)", "-12", "12-", "+3", "1.234,56" (with decimalComma), "12.00 CR".
 * Returns null when it is not a number.
 */
export function parseUserAmount(input: string | null | undefined, opts: { decimalComma?: boolean } = {}): Decimal | null {
  if (input === null || input === undefined) return null;
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  const suffix = /\s*(CR|DR|-)$/i.exec(s);
  if (suffix) {
    if (suffix[1]!.toUpperCase() === "DR" || suffix[1] === "-") negative = !negative;
    s = s.slice(0, suffix.index).trim();
  }
  // Currency symbols and codes.
  s = s.replace(/^[A-Z]{3}\s*/i, "").replace(/\s*[A-Z]{3}$/i, "").replace(/[$€£¥₹₩₽₪₫₱₦₴₸₺]/g, "").trim();
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }
  s = s.replace(/[\s ']/g, "");
  if (opts.decimalComma) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;
  if (s.startsWith(".")) s = `0${s}`;
  const d = Decimal.from(s);
  return negative ? d.neg() : d;
}

/** Parse a date in the stated format. Two-digit years are 20xx below 70, else 19xx. */
export function parseBankDate(input: string | null | undefined, format: CsvMappingConfig["dateFormat"]): string | null {
  if (!input) return null;
  const s = input.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\s*[AP]M)?$/i, "");
  let m: RegExpExecArray | null;
  let y: number, mo: number, d: number;
  const year = (v: string) => {
    const n = Number(v);
    return v.length === 2 ? (n < 70 ? 2000 + n : 1900 + n) : n;
  };
  switch (format) {
    case "YYYY-MM-DD":
    case "YYYY/MM/DD":
      m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
      if (!m) return null;
      [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      break;
    case "MM/DD/YYYY":
    case "M/D/YY":
      m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      [mo, d, y] = [Number(m[1]), Number(m[2]), year(m[3]!)];
      break;
    case "DD/MM/YYYY":
    case "DD.MM.YYYY":
      m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2}|\d{4})$/.exec(s);
      if (!m) return null;
      [d, mo, y] = [Number(m[1]), Number(m[2]), year(m[3]!)];
      break;
    default:
      return null;
  }
  const iso = fromParts(y, mo, d);
  return isIsoDate(iso) ? iso : null;
}

/** Guess the date format from sample values (the first that parses them all). */
export function guessDateFormat(samples: string[]): CsvMappingConfig["dateFormat"] {
  const formats: CsvMappingConfig["dateFormat"][] = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD.MM.YYYY"];
  const vals = samples.filter((s) => s.trim()).slice(0, 50);
  for (const f of formats) if (vals.length && vals.every((v) => parseBankDate(v, f))) return f;
  return "MM/DD/YYYY";
}

/** A best-effort mapping from header names, which the person then checks. */
export function guessMapping(rows: string[][], delimiter: string): CsvMappingConfig {
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase());
  const find = (...names: RegExp[]) => {
    for (const re of names) {
      const i = header.findIndex((h) => re.test(h));
      if (i >= 0) return i;
    }
    return -1;
  };
  const hasHeader = header.some((h) => /date|amount|description|memo|debit|credit|payee/.test(h));
  const dateColumn = Math.max(0, find(/^posted|^posting date|^transaction date|^date/, /date/));
  const amountColumn = find(/^amount$/, /amount/);
  const debitColumn = find(/^debit|withdraw|money out|paid out/);
  const creditColumn = find(/^credit|deposit|money in|paid in/);
  const descriptionColumn = Math.max(0, find(/^description|^details|^narrative|^memo|^name|^transaction/, /desc/));
  const payeeColumn = find(/^payee|merchant|counterparty/);
  const referenceColumn = find(/^ref|check|cheque|^number|^id$/);
  const balanceColumn = find(/balance/);
  const dataRows = rows.slice(hasHeader ? 1 : 0);
  const useDebitCredit = amountColumn < 0 && debitColumn >= 0 && creditColumn >= 0;
  return {
    delimiter,
    hasHeader,
    skipRows: 0,
    dateColumn,
    dateFormat: guessDateFormat(dataRows.map((r) => r[dateColumn] ?? "")),
    amountMode: useDebitCredit ? "debit_credit" : "single",
    amountColumn: useDebitCredit ? null : amountColumn >= 0 ? amountColumn : Math.min(1, header.length - 1),
    debitColumn: debitColumn >= 0 ? debitColumn : null,
    creditColumn: creditColumn >= 0 ? creditColumn : null,
    invertSign: false,
    decimalComma: delimiter === ";",
    descriptionColumn,
    payeeColumn: payeeColumn >= 0 ? payeeColumn : null,
    referenceColumn: referenceColumn >= 0 ? referenceColumn : null,
    balanceColumn: balanceColumn >= 0 ? balanceColumn : null,
  };
}

/** Description normalized for duplicate detection: case, spacing and punctuation do not matter. */
export function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
