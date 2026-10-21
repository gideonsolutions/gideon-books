import { getDb } from "@/lib/db/client";
import { requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { MOVEMENT_LABELS, type MovementKind } from "@/lib/inventory/movements";
import { stockOnHand } from "@/lib/inventory/queries";
import { formatQuantity } from "@/lib/money/format";
import { accountOptions, locationOptions } from "@/lib/web/options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { MovementForm } from "@/components/inventory/movement-form";
import { recordMovementAction } from "../../actions";

export const metadata = { title: "Record a stock movement" };

const KINDS: MovementKind[] = ["opening", "adjustment", "transfer", "revaluation"];

export default async function NewMovement({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "inventory.manage");
  const kind: MovementKind = KINDS.includes(sp.kind as MovementKind) ? (sp.kind as MovementKind) : "adjustment";
  if (kind === "opening") requirePermission(ctx, "opening_balances.manage");
  const db = getDb();
  const stock = await stockOnHand(db, ctx.orgId, {});
  const locs = await locationOptions(db, ctx.orgId);
  const offsets = await accountOptions(db, ctx.orgId, { types: kind === "opening" ? ["equity"] : ["expense", "income", "equity"], excludeControl: true });
  return (
    <>
      <PageHeader title={MOVEMENT_LABELS[kind]} back={{ href: `/o/${org}/inventory/movements`, label: "Adjustments & transfers" }} />
      {stock.length === 0 ? (
        <EmptyState title="No stock items" action={<LinkButton href={`/o/${org}/inventory/items/new`}>New stock item</LinkButton>}>
          Create a stock item first.
        </EmptyState>
      ) : kind === "transfer" && locs.length < 2 ? (
        <EmptyState title="Only one location" action={<LinkButton href={`/o/${org}/inventory/locations`}>Add a location</LinkButton>}>
          Transfers need a second stock location.
        </EmptyState>
      ) : (
        <Card>
          <MovementForm
            action={recordMovementAction.bind(null, org, kind)}
            kind={kind}
            items={stock.map((s) => ({ value: s.itemId, label: s.sku ? `${s.name} (${s.sku})` : s.name, unit: s.unit, onHand: formatQuantity(s.qtyOnHand), avgCost: s.avgCost }))}
            locations={locs}
            offsetAccounts={offsets}
            defaultDate={todayIn(ctx.org.timezone)}
            defaultItemId={sp.item}
            baseCurrency={ctx.org.baseCurrency}
          />
        </Card>
      )}
    </>
  );
}
