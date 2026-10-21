/** The chart of accounts as reports need it: ordered, with depth, by id. */
import { asc, eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts, type AccountSubtype, type AccountType } from "@/lib/db/schema/ledger";
import { defaultCashFlowSection, type CashFlowSection } from "@/lib/ledger/coa-templates";

export interface ReportAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  parentId: string | null;
  depth: number;
  isArchived: boolean;
  control: string | null;
  systemKey: string | null;
  currency: string | null;
  cashFlowSection: CashFlowSection;
  hasChildren: boolean;
}

export interface Chart {
  ordered: ReportAccount[];
  byId: Map<string, ReportAccount>;
  /** An account and all of its descendants. */
  descendants(id: string): string[];
}

export async function loadChart(db: DbOrTx, orgId: string): Promise<Chart> {
  const rows = await db.select().from(accounts).where(eq(accounts.orgId, orgId)).orderBy(asc(accounts.code));
  const children = new Map<string | null, typeof rows>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    const parent = r.parentId && ids.has(r.parentId) ? r.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const ordered: ReportAccount[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      ordered.push({
        id: r.id,
        code: r.code,
        name: r.name,
        type: r.type,
        subtype: r.subtype,
        parentId: parent,
        depth,
        isArchived: r.isArchived,
        control: r.control,
        systemKey: r.systemKey,
        currency: r.currency,
        cashFlowSection: (r.cashFlowSection as CashFlowSection | null) ?? defaultCashFlowSection(r.type, r.subtype),
        hasChildren: (children.get(r.id)?.length ?? 0) > 0,
      });
      if (depth < 8) walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  const byId = new Map(ordered.map((a) => [a.id, a]));
  const descendants = (id: string): string[] => {
    const out = [id];
    for (const c of children.get(id) ?? []) out.push(...descendants(c.id));
    return out;
  };
  return { ordered, byId, descendants };
}

export const isProfitAndLoss = (t: AccountType) => t === "income" || t === "expense";

/** Credit-normal accounts are shown with the sign flipped (a credit balance is positive). */
export const creditNormal = (t: AccountType) => t === "liability" || t === "equity" || t === "income";

export function label(a: Pick<ReportAccount, "code" | "name">): string {
  return `${a.code} ${a.name}`;
}
