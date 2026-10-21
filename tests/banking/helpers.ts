import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { bankTransactions } from "@/lib/db/schema/banking";
import { commitImport } from "@/lib/banking/imports";
import { guessMapping, parseCsv } from "@/lib/banking/csv";
import type { Ctx } from "@/lib/context";
import type { CsvMappingConfig } from "@/lib/db/schema/banking";

export function mappingFor(text: string, over: Partial<CsvMappingConfig> = {}): CsvMappingConfig {
  return { ...guessMapping(parseCsv(text), ","), dateFormat: "YYYY-MM-DD", ...over };
}

export async function importCsv(ctx: Ctx, accountId: string, text: string, over: Partial<CsvMappingConfig> = {}, extra: { includeDuplicateRows?: number[] } = {}) {
  return commitImport(ctx, { accountId, fileName: "statement.csv", text, mapping: mappingFor(text, over), ...extra });
}

export async function txnsOf(orgId: string, accountId: string) {
  return getDb().select().from(bankTransactions).where(and(eq(bankTransactions.orgId, orgId), eq(bankTransactions.accountId, accountId)));
}

export function csv(rows: [string, string, string][]) {
  return ["Date,Description,Amount", ...rows.map((r) => r.map((c) => (c.includes(",") ? `"${c}"` : c)).join(","))].join("\n") + "\n";
}
