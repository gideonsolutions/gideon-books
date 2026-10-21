import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { requirePermission } from "@/lib/context";
import { listMappings } from "@/lib/banking/imports";
import { moneyAccountOptions } from "@/lib/web/options";
import { readParams, type SearchParams } from "@/lib/web/params";
import { PageHeader } from "@/components/ui";
import { ImportWizard } from "@/components/banking/import-wizard";
import { commitImportAction, previewImportAction } from "../../actions";

export const metadata = { title: "Import a statement" };

export default async function NewImport({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const { org } = await params;
  const sp = await readParams(searchParams);
  const ctx = await orgCtx(org);
  requirePermission(ctx, "banking.import");
  const db = getDb();
  const mappings = await listMappings(db, ctx.orgId);
  return (
    <>
      <PageHeader
        title="Import a statement"
        back={{ href: `/o/${org}/banking/imports`, label: "Imports" }}
        description="Download transactions from your bank as CSV, then bring them in here. Rows already imported are recognized and skipped; you see every row before anything is saved."
      />
      <ImportWizard
        accounts={await moneyAccountOptions(db, ctx.orgId)}
        mappings={mappings.map((m) => ({ id: m.id, name: m.name, accountId: m.accountId, config: m.config, headerSignature: m.headerSignature }))}
        defaultAccountId={sp.account}
        preview={previewImportAction.bind(null, org)}
        commit={commitImportAction.bind(null, org)}
      />
    </>
  );
}
