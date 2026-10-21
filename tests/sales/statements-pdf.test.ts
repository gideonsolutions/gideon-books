import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { inflateSync } from "node:zlib";
import { getDb } from "@/lib/db/client";
import { attachments, emailMessages } from "@/lib/db/schema/core";
import { issueDocument, saveDraft } from "@/lib/commerce/documents";
import { recordPayment } from "@/lib/commerce/payments";
import { customerStatement } from "@/lib/sales/statements";
import { renderDocumentPdf, renderStatementPdf } from "@/lib/sales/pdf";
import { emailDocument } from "@/lib/sales/documents";
import { Decimal } from "@/lib/money/decimal";
import { customer, setupOrg, type TestOrg } from "../helpers";

let t: TestOrg;
beforeAll(async () => {
  t = await setupOrg();
});

/** The text content of a PDF's streams (pdf-lib compresses them with Flate). */
function pdfText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1");
  let out = s;
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (const m of s.matchAll(re)) {
    try {
      out += inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      // not compressed
    }
  }
  // Standard-font text is written as hex strings: <48656C6C6F> Tj.
  for (const m of out.matchAll(/<([0-9A-Fa-f]{2,})>\s*Tj/g)) out += Buffer.from(m[1]!, "hex").toString("latin1");
  return out;
}

describe("customer statements", () => {
  it("opens, lists activity, and closes at the customer's receivable balance", async () => {
    const c = await customer(t.ctx, "Statement Co");
    const bank = await t.acct("1000");
    const old = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-01-15", dueDate: "2026-01-30", lines: [{ unitPrice: "300" }] })).id);
    const feb = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-02-10", dueDate: "2026-02-20", lines: [{ unitPrice: "200" }] })).id);
    await recordPayment(t.ctx, { kind: "customer_payment", contactId: c.id, paymentDate: "2026-02-12", accountId: bank, amount: "100", allocations: [{ itemType: "document", itemId: old.id, amount: "100" }] });
    await recordPayment(t.ctx, { kind: "customer_deposit", contactId: c.id, paymentDate: "2026-02-25", accountId: bank, amount: "50" });
    void feb;
    const s = await customerStatement(getDb(), t.ctx, c.id, "2026-02-01", "2026-02-28");
    expect(s.opening).toBe("300.0000");
    // Invoice +200, payment −100, deposit −50 (the application entry nets to zero and is not listed).
    expect(s.lines.map((l) => [l.charge, l.credit])).toEqual([
      ["200.0000", "0"],
      ["0", "100.0000"],
      ["0", "50.0000"],
    ]);
    expect(s.closing).toBe("350.0000");
    const ledger = await getDb().execute<{ s: string }>(sql`
      select coalesce(sum(l.txn_amount),0)::text s from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where l.org_id = ${t.orgId} and l.contact_id = ${c.id} and e.status = 'posted' and e.entry_date <= '2026-02-28' and a.control in ('receivables','customer_deposits')`);
    expect(Decimal.from(ledger.rows[0]!.s).eq(s.closing)).toBe(true);
    // Aging at Feb 28: the January invoice (200 open) is 29 days late; February's (200) is 8 days late; the deposit is a current credit.
    expect(s.aging.map((a) => Decimal.from(a).toFixed(2))).toEqual(["-50.00", "400.00", "0.00", "0.00", "0.00"]);
    const pdf = await renderStatementPdf(getDb(), t.orgId, s);
    expect(Buffer.from(pdf.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdfText(pdf.bytes)).toContain("Closing balance");
  });
});

describe("invoice PDFs and email", () => {
  it("renders a valid PDF with the number and queues an email with it attached (outbox: not delivered)", async () => {
    const c = await customer(t.ctx, "Mailed Customer", { email: "billing@mailed.example" });
    const inv = await issueDocument(t.ctx, (await saveDraft(t.ctx, { kind: "invoice", contactId: c.id, issueDate: "2026-03-01", lines: [{ description: "Consulting", quantity: "3", unitPrice: "150" }], notes: "Thank you" })).id);
    const pdf = await renderDocumentPdf(getDb(), t.orgId, inv.id);
    const bytes = Buffer.from(pdf.bytes);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(pdfText(pdf.bytes)).toContain(inv.number!);
    const msg = await emailDocument(t.ctx, inv.id, { to: "billing@mailed.example" });
    expect(msg.provider).toBe("outbox");
    const [row] = await getDb().select().from(emailMessages).where(eq(emailMessages.id, msg.id));
    expect(row!.attachmentIds).toHaveLength(1);
    const [att] = await getDb().select().from(attachments).where(and(eq(attachments.orgId, t.orgId), eq(attachments.id, row!.attachmentIds[0]!)));
    expect(att!.contentType).toBe("application/pdf");
    expect(att!.origin).toBe("generated");
    const { drain } = await import("@/lib/jobs/queue");
    const { HANDLERS } = await import("@/lib/jobs/handlers");
    await drain(HANDLERS, { kinds: ["email.send"] });
    const [sent] = await getDb().select().from(emailMessages).where(eq(emailMessages.id, msg.id));
    expect(sent!.status).toBe("not_delivered");
  });
});
