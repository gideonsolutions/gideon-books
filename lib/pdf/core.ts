/**
 * A small PDF layout kit on pdf-lib: pages with a running header and page
 * numbers, wrapped text, and tables whose numeric columns align right and
 * repeat their heading on each page. Used for invoices, statements and every
 * report export, so they share one look.
 *
 * Fonts are the standard PDF fonts (no files to ship); characters outside
 * their WinAnsi range are replaced, and currency amounts are rendered with
 * the ISO code where the symbol is not representable.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";

export const BRAND = rgb(1 / 255, 62 / 255, 169 / 255);
export const INK = rgb(0.09, 0.11, 0.16);
export const MUTED = rgb(0.4, 0.45, 0.52);
export const RULE = rgb(0.85, 0.87, 0.9);

const WINANSI_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".split(""));

/** Replace characters the standard fonts cannot draw. */
export function pdfSafe(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.has(ch)) out += ch;
    else if (ch === "\n" || ch === "\t") out += " ";
    else if (ch === "≈") out += "~";
    else if (ch === "→") out += "->";
    else out += "?";
  }
  return out;
}

export interface PdfColumn {
  header: string;
  /** Fraction of the content width. */
  width: number;
  align?: "left" | "right";
}

export interface PdfRow {
  cells: string[];
  bold?: boolean;
  /** Draw a rule above the row (totals). */
  ruleAbove?: boolean;
  indent?: number;
  muted?: boolean;
}

export class PdfWriter {
  doc!: PDFDocument;
  font!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  readonly width = 612; // US Letter
  readonly height = 792;
  readonly margin = 48;
  pageNo = 0;
  private header: { title: string; subtitle?: string; org?: string };
  private footerNote: string | undefined;

  private constructor(header: { title: string; subtitle?: string; org?: string }, footerNote?: string) {
    this.header = header;
    this.footerNote = footerNote;
  }

  static async create(header: { title: string; subtitle?: string; org?: string }, footerNote?: string): Promise<PdfWriter> {
    const w = new PdfWriter(header, footerNote);
    w.doc = await PDFDocument.create();
    w.doc.setTitle(pdfSafe(`${header.title}${header.org ? ` — ${header.org}` : ""}`));
    w.doc.setProducer("Gideon Books");
    w.doc.setCreator("Gideon Books");
    w.font = await w.doc.embedFont(StandardFonts.Helvetica);
    w.bold = await w.doc.embedFont(StandardFonts.HelveticaBold);
    w.newPage();
    return w;
  }

  get contentWidth() {
    return this.width - this.margin * 2;
  }

  newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.pageNo++;
    this.y = this.height - this.margin;
    if (this.header.org) this.text(this.header.org, { size: 9, color: MUTED });
    this.text(this.header.title, { size: 15, font: this.bold, color: INK });
    if (this.header.subtitle) this.text(this.header.subtitle, { size: 9, color: MUTED });
    this.y -= 8;
    this.rule();
    this.y -= 6;
  }

  ensure(space: number) {
    if (this.y - space < this.margin + 24) this.newPage();
  }

  textWidth(s: string, size: number, font: PDFFont = this.font) {
    return font.widthOfTextAtSize(pdfSafe(s), size);
  }

  /** Draw a line of text at the current position and move down. */
  text(s: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; align?: "left" | "right"; width?: number; advance?: boolean } = {}) {
    const size = opts.size ?? 10;
    const font = opts.font ?? this.font;
    const safe = pdfSafe(s);
    const w = font.widthOfTextAtSize(safe, size);
    const x0 = opts.x ?? this.margin;
    const x = opts.align === "right" ? x0 + (opts.width ?? this.contentWidth) - w : x0;
    this.page.drawText(safe, { x, y: this.y - size, size, font, color: opts.color ?? INK });
    if (opts.advance !== false) this.y -= size + 4;
  }

  /** Wrapped paragraph. */
  paragraph(s: string, opts: { size?: number; color?: ReturnType<typeof rgb>; width?: number; x?: number } = {}) {
    const size = opts.size ?? 9.5;
    const width = opts.width ?? this.contentWidth;
    for (const para of s.split(/\n/)) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (this.textWidth(next, size) > width && line) {
          this.ensure(size + 4);
          this.text(line, { size, ...(opts.color ? { color: opts.color } : {}), ...(opts.x !== undefined ? { x: opts.x } : {}) });
          line = word;
        } else line = next;
      }
      this.ensure(size + 4);
      this.text(line, { size, ...(opts.color ? { color: opts.color } : {}), ...(opts.x !== undefined ? { x: opts.x } : {}) });
    }
  }

  rule(color = RULE) {
    this.page.drawLine({ start: { x: this.margin, y: this.y }, end: { x: this.width - this.margin, y: this.y }, thickness: 0.6, color });
  }

  space(h = 8) {
    this.y -= h;
  }

  /** A table; heading repeats on new pages. Cells are truncated to fit. */
  table(columns: PdfColumn[], rows: PdfRow[], opts: { size?: number } = {}) {
    const size = opts.size ?? 8.5;
    const rowH = size + 6;
    const xs: number[] = [];
    let x = this.margin;
    for (const c of columns) {
      xs.push(x);
      x += c.width * this.contentWidth;
    }
    const drawHeader = () => {
      this.ensure(rowH * 2);
      columns.forEach((c, i) => {
        const w = c.width * this.contentWidth - 4;
        this.text(c.header.toUpperCase(), { size: size - 1, font: this.bold, color: MUTED, x: xs[i]!, align: c.align ?? "left", width: w, advance: false });
      });
      this.y -= rowH;
      this.rule();
      this.y -= 3;
    };
    drawHeader();
    for (const r of rows) {
      if (this.y - rowH < this.margin + 24) {
        this.newPage();
        drawHeader();
      }
      if (r.ruleAbove) {
        this.rule(MUTED);
        this.y -= 3;
      }
      columns.forEach((c, i) => {
        const w = c.width * this.contentWidth - 4;
        let cell = pdfSafe(r.cells[i] ?? "");
        const font = r.bold ? this.bold : this.font;
        const indent = i === 0 ? (r.indent ?? 0) * 10 : 0;
        while (cell.length > 1 && font.widthOfTextAtSize(cell, size) > w - indent) cell = cell.slice(0, -2) + "…";
        this.text(cell, { size, font, color: r.muted ? MUTED : INK, x: xs[i]! + indent, align: c.align ?? "left", width: w - indent, advance: false });
      });
      this.y -= rowH;
    }
  }

  async embedImage(bytes: Uint8Array, type: string): Promise<PDFImage | null> {
    try {
      if (type === "image/png") return await this.doc.embedPng(bytes);
      if (type === "image/jpeg") return await this.doc.embedJpg(bytes);
    } catch {
      return null;
    }
    return null;
  }

  async finish(): Promise<Uint8Array> {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      const label = pdfSafe(`${this.footerNote ? `${this.footerNote}  ·  ` : ""}Page ${i + 1} of ${pages.length}`);
      p.drawText(label, { x: this.margin, y: 28, size: 7.5, font: this.font, color: MUTED });
    });
    return this.doc.save();
  }
}

/** Format an amount for PDF: the symbol where the font has it, else the ISO code. */
export function pdfMoney(formatted: string, currency: string): string {
  const safe = pdfSafe(formatted);
  return safe.includes("?") ? `${pdfSafe(formatted.replace(/[^\d.,()\-\s]/g, "")).trim()} ${currency}` : safe;
}
