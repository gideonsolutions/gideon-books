/**
 * Operations: complete data exports of an organization (and imports of one
 * into a new organization). The ZIP itself is in storage; this records what
 * was produced, by whom, and its checksum.
 */
import { bigint, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts } from "./_columns";

export const dataExports = pgTable(
  "data_exports",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    kind: text("kind", { enum: ["export", "import"] }).notNull(),
    status: text("status", { enum: ["queued", "running", "completed", "failed"] }).notNull().default("queued"),
    jobId: uuid("job_id"),
    storageKey: text("storage_key"),
    fileName: text("file_name"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    sha256: text("sha256"),
    manifest: jsonb("manifest"),
    /** For an import: the organization it created. */
    resultOrgId: uuid("result_org_id"),
    error: text("error"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    completedAt: ts("completed_at"),
  },
  (t) => [index("data_exports_org_idx").on(t.orgId, t.createdAt)],
);
