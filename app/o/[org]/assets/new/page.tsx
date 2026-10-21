import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can, requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { assetFormOptions, defaultsForNew } from "@/lib/assets/form-options";
import { Card, PageHeader } from "@/components/ui";
import { AssetForm } from "@/components/assets/asset-form";
import { createAssetAction } from "../actions";

export const metadata = { title: "New asset" };

export default async function NewAsset({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<{ line?: string }> }) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "assets.manage");
  const db = getDb();
  const opts = await assetFormOptions(db, ctx);
  const defaults = await defaultsForNew(db, ctx, todayIn(ctx.org.timezone));
  const line = sp.line ? opts.lines.find((l) => l.lineId === sp.line) : undefined;
  if (line) {
    Object.assign(defaults, { acquisitionType: "document_line", sourceDocumentLineId: line.lineId, cost: line.amount, acquisitionDate: line.date, assetAccountId: line.accountId, name: line.description });
  }
  return (
    <>
      <PageHeader
        title="New fixed asset"
        back={{ href: `/o/${org}/assets`, label: "Fixed assets" }}
        description="Save it as a draft to finish later, or put it on the books now. Nothing posts until it is capitalized."
      />
      <Card>
        <AssetForm action={createAssetAction.bind(null, org)} defaults={defaults} {...opts} capitalized={false} canCapitalize={can(ctx, "assets.manage")} />
      </Card>
    </>
  );
}
