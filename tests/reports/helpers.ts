/** Helpers for report tests: posting shorthand and reading tables. */
import zlib from "node:zlib";
import { withTransaction } from "@/lib/db/client";
import { postEntry } from "@/lib/ledger/posting";
import { issueDocument, saveDraft, type DocumentLineInput } from "@/lib/commerce/documents";
import type { DocumentKind } from "@/lib/db/schema/commerce";
import type { Ctx } from "@/lib/context";
import type { ReportTable } from "@/lib/reports/table";
import { Decimal } from "@/lib/money/decimal";

export async function journal(ctx: Ctx, date: string, lines: [string, string][], description = "test") {
  return withTransaction((tx) => postEntry(tx, ctx, { kind: "manual", entryDate: date, description, lines: lines.map(([accountId, amount]) => ({ accountId, amount })) }));
}

export async function doc(ctx: Ctx, kind: DocumentKind, contactId: string, date: string, lines: DocumentLineInput[], extra: Record<string, unknown> = {}) {
  const d = await saveDraft(ctx, { kind, contactId, issueDate: date, lines: lines.map((l) => ({ quantity: "1", ...l })), ...extra });
  return issueDocument(ctx, d.id);
}

/** The value of a row's cell by its first-cell label (exact). */
export function cell(t: ReportTable, rowLabel: string, col = 1): string | null {
  const r = t.rows.find((x) => x.cells[0]?.value === rowLabel);
  if (!r) throw new Error(`no row "${rowLabel}" in ${t.key}: ${t.rows.map((x) => x.cells[0]?.value).join(" | ")}`);
  return r.cells[col]?.value ?? null;
}

export function amt(v: string | null | undefined): string {
  return Decimal.from(v ?? "0").round(2, "half_up").toFixed(2);
}

/** Text drawn on a PDF's pages (pdf-lib writes standard-font text as hex strings). */
export function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const raw = buf.toString("latin1");
  const chunks: string[] = [raw];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const body = buf.subarray(start, end);
    try {
      chunks.push(zlib.inflateSync(body).toString("latin1"));
    } catch {
      // Not a deflated stream.
    }
  }
  const text: string[] = [];
  for (const c of chunks) {
    for (const h of c.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) text.push(Buffer.from(h[1]!, "hex").toString("latin1"));
    for (const p of c.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) text.push(p[1]!);
  }
  return text.join("\n");
}

/** Parse a CSV produced by toCsv (handles quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}
