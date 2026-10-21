import { describe, expect, it } from "vitest";
import { readAttachment, sniffType, uploadAttachment } from "@/lib/storage/attachments";
import { getDb } from "@/lib/db/client";
import { rejectsWith, setupOrg } from "../helpers";

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

describe("attachments", () => {
  it("identifies files by content, not by name", () => {
    expect(sniffType(PDF, "application/pdf", "a.pdf")).toBe("application/pdf");
    expect(sniffType(Buffer.from("<html><script>alert(1)</script>"), "text/plain", "a.txt")).toBeNull();
    expect(sniffType(Buffer.from("<svg onload=alert(1)>"), "image/svg+xml", "a.svg")).toBeNull();
    expect(sniffType(Buffer.from("date,amount\n2026-01-01,5.00\n"), "text/csv", "bank.csv")).toBe("text/csv");
    expect(sniffType(Buffer.from("MZ\x90\x00"), "application/pdf", "evil.pdf")).toBeNull();
  });

  it("stores under the organization and refuses another organization's reader", async () => {
    const a = await setupOrg({ name: "A" });
    const b = await setupOrg({ name: "B" });
    const row = await uploadAttachment(a.ctx, { entityType: "journal_entry", entityId: null, fileName: "../../etc/passwd.pdf", contentType: "application/pdf", bytes: PDF });
    expect(row.storageKey.startsWith(`orgs/${a.orgId}/`)).toBe(true);
    expect(row.fileName).not.toContain("/");
    const ok = await readAttachment(getDb(), a.ctx, row.id);
    expect(ok.bytes.equals(PDF)).toBe(true);
    await rejectsWith(readAttachment(getDb(), b.ctx, row.id), "not_found");
    const ro = await a.as("read_only");
    await rejectsWith(uploadAttachment(ro, { entityType: "journal_entry", entityId: null, fileName: "x.pdf", contentType: "application/pdf", bytes: PDF }), "forbidden");
  });
});
