/** Options for the item form. */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { accountOptions, contactOptions, taxCodeOptions } from "@/lib/web/options";
import type { Item } from "@/lib/items/items";

export async function itemFormOptions(db: DbOrTx, orgId: string) {
  const all = await accountOptions(db, orgId);
  const rows = await db.select({ id: accounts.id, type: accounts.type, control: accounts.control }).from(accounts).where(eq(accounts.orgId, orgId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    incomeAccounts: all.filter((o) => byId.get(o.value)?.type === "income"),
    expenseAccounts: all.filter((o) => {
      const a = byId.get(o.value);
      return a && (a.type === "expense" || (a.type === "asset" && !a.control));
    }),
    inventoryAccounts: all.filter((o) => byId.get(o.value)?.control === "inventory"),
    taxCodes: await taxCodeOptions(db, orgId),
    vendors: await contactOptions(db, orgId, "vendor"),
  };
}

export function itemDefaults(i?: Item | null) {
  return {
    kind: i?.kind ?? ("stock" as const),
    sku: i?.sku ?? "",
    name: i?.name ?? "",
    description: i?.description ?? "",
    unit: i?.unit ?? "ea",
    salePrice: i?.salePrice ? trim(i.salePrice) : "",
    purchaseCost: i?.purchaseCost ? trim(i.purchaseCost) : "",
    incomeAccountId: i?.incomeAccountId ?? "",
    expenseAccountId: i?.expenseAccountId ?? "",
    inventoryAccountId: i?.inventoryAccountId ?? "",
    saleTaxCodeId: i?.saleTaxCodeId ?? "",
    purchaseTaxCodeId: i?.purchaseTaxCodeId ?? "",
    reorderLevel: i?.reorderLevel ? trim(i.reorderLevel) : "",
    reorderQuantity: i?.reorderQuantity ? trim(i.reorderQuantity) : "",
    preferredVendorId: i?.preferredVendorId ?? "",
  };
}

function trim(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}
