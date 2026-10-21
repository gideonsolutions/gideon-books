import { getDb } from "@/lib/db/client";
import { requirePermission } from "@/lib/context";
import { itemDefaults, itemFormOptions } from "@/lib/inventory/item-options";
import { orgCtx } from "@/lib/web/session";
import { Card, PageHeader } from "@/components/ui";
import { ItemForm } from "@/components/inventory/item-form";
import { createItemAction } from "../../actions";

export const metadata = { title: "New item" };

export default async function NewItem({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "items.manage");
  return (
    <>
      <PageHeader title="New product or service" back={{ href: `/o/${org}/inventory/items`, label: "Products & services" }} />
      <Card className="max-w-4xl">
        <ItemForm action={createItemAction.bind(null, org)} defaults={itemDefaults(null)} {...await itemFormOptions(getDb(), ctx.orgId)} submitLabel="Create item" />
      </Card>
    </>
  );
}
