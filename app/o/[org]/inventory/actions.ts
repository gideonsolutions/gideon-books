"use server";

import { createItem, setItemArchived, updateItem, type ItemInput } from "@/lib/items/items";
import { recordMovement, type MovementInput, type MovementKind } from "@/lib/inventory/movements";
import { saveLocation } from "@/lib/inventory/locations";
import { bool, runAction, str, type ActionResult } from "@/lib/web/actions";
import { orgCtx } from "@/lib/web/session";

type R<T = unknown> = Promise<ActionResult<T>>;

function itemInput(fd: FormData): ItemInput {
  return {
    kind: (str(fd, "kind") ?? "service") as ItemInput["kind"],
    sku: str(fd, "sku"),
    name: str(fd, "name") ?? "",
    description: str(fd, "description"),
    unit: str(fd, "unit"),
    salePrice: str(fd, "salePrice"),
    purchaseCost: str(fd, "purchaseCost"),
    incomeAccountId: str(fd, "incomeAccountId"),
    expenseAccountId: str(fd, "expenseAccountId"),
    inventoryAccountId: str(fd, "inventoryAccountId"),
    saleTaxCodeId: str(fd, "saleTaxCodeId"),
    purchaseTaxCodeId: str(fd, "purchaseTaxCodeId"),
    reorderLevel: str(fd, "reorderLevel"),
    reorderQuantity: str(fd, "reorderQuantity"),
    preferredVendorId: str(fd, "preferredVendorId"),
  };
}

export async function createItemAction(slug: string, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const item = await createItem(await orgCtx(slug), itemInput(fd));
    return { href: `/o/${slug}/inventory/items/${item.id}` };
  });
}

export async function updateItemAction(slug: string, id: string, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await updateItem(await orgCtx(slug), id, itemInput(fd));
  }, "Saved.");
}

export async function archiveItemAction(slug: string, id: string, archived: boolean): R {
  return runAction(async () => {
    await setItemArchived(await orgCtx(slug), id, archived);
  }, archived ? "Archived." : "Restored.");
}

export async function recordMovementAction(slug: string, kind: MovementKind, _: unknown, fd: FormData): R<{ href: string }> {
  return runAction(async () => {
    const lines: MovementInput["lines"] = [];
    const count = Number(fd.get("lineCount") ?? 0);
    for (let i = 0; i < Math.min(count, 500); i++) {
      const itemId = str(fd, `lines.${i}.itemId`);
      if (!itemId) continue;
      lines.push({ itemId, quantity: str(fd, `lines.${i}.quantity`), unitCost: str(fd, `lines.${i}.unitCost`), valueChange: str(fd, `lines.${i}.valueChange`) });
    }
    const mv = await recordMovement(await orgCtx(slug), {
      kind,
      date: str(fd, "date") ?? "",
      reason: str(fd, "reason") ?? "",
      locationId: str(fd, "locationId"),
      toLocationId: str(fd, "toLocationId"),
      offsetAccountId: str(fd, "offsetAccountId"),
      lines,
    });
    return { href: `/o/${slug}/inventory/movements/${mv.id}` };
  });
}

export async function saveLocationAction(slug: string, id: string | null, _: unknown, fd: FormData): R {
  return runAction(async () => {
    await saveLocation(await orgCtx(slug), {
      id,
      code: str(fd, "code") ?? "",
      name: str(fd, "name") ?? "",
      isDefault: bool(fd, "isDefault"),
      isArchived: bool(fd, "isArchived"),
    });
  }, "Saved.");
}
