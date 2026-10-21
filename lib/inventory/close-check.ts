/** Period-close check: the stock ledger agrees with the inventory accounts at period end. */
import type { CloseCheck } from "@/lib/ledger/close-checks";
import { Decimal } from "@/lib/money/decimal";
import { inventoryReconciliation } from "./valuation";

export const inventoryCloseChecks: CloseCheck = async (db, ctx, period) => {
  const rec = await inventoryReconciliation(db, ctx.orgId, period.endDate);
  if (rec.rows.length === 0) return [];
  const off = rec.rows.filter((r) => !Decimal.from(r.difference).isZero());
  return [
    {
      key: "inventory_reconciled",
      title: "Inventory valuation agrees with the inventory accounts",
      status: off.length === 0 ? "pass" : "fail",
      severity: "blocker",
      ...(off.length
        ? { detail: off.map((r) => `${r.accountCode} ${r.accountName}: ledger ${r.ledgerValue}, stock ${r.stockValue}`).join("; "), href: "/inventory/valuation" }
        : {}),
    },
  ];
};
