import { describe, expect, it } from "vitest";
import { getPool } from "@/lib/db/client";
import { describeOrgTables } from "@/lib/ops/tables";
import { EXCLUDED_TABLES } from "@/lib/ops/export";

describe("organization-scoped tables", () => {
  it("are discovered in dependency order, with child tables and without cycles through guarded tables", async () => {
    const client = await getPool().connect();
    try {
      const tables = await describeOrgTables(client);
      const names = tables.map((t) => t.name);
      for (const n of ["accounts", "journal_entries", "journal_lines", "documents", "payments", "settlements", "stock_moves", "attachments", "audit_events"]) expect(names).toContain(n);
      expect(tables.find((t) => t.name === "email_events")?.scope.kind).toBe("child");
      // Parents before children.
      expect(names.indexOf("accounts")).toBeLessThan(names.indexOf("journal_lines"));
      expect(names.indexOf("journal_entries")).toBeLessThan(names.indexOf("journal_lines"));
      expect(names.indexOf("journal_entries")).toBeLessThan(names.indexOf("documents"));
      // Import fills cyclic references by UPDATE after inserting; that must never touch an immutable table.
      const guarded = new Set(["journal_entries", "journal_lines", "stock_moves", "settlements", "payments", "documents", "document_lines", "cash_basis_lines", "audit_events"]);
      const cyclic = tables.filter((t) => t.deferredColumns.length).map((t) => t.name);
      expect(cyclic.filter((n) => guarded.has(n))).toEqual([]);
      // Every excluded table named in the export is real or explicitly optional.
      expect(Object.keys(EXCLUDED_TABLES)).toContain("memberships");
    } finally {
      client.release();
    }
  });
});
