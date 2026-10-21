import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { accountOptions, contactOptions, currencyOptions, dimensionOptions } from "@/lib/web/options";
import { can, requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui";
import { JournalForm } from "@/components/accounting/journal-form";
import { saveJournalAction } from "../../actions";

export const metadata = { title: "New journal entry" };

export default async function NewJournal({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  requirePermission(ctx, "ledger.draft");
  const db = getDb();
  return (
    <>
      <PageHeader
        title="New journal entry"
        back={{ href: `/o/${org}/accounting/journal`, label: "Journal entries" }}
        description="For adjustments, accruals, reclassifications and anything without its own form. Receivable, payable, inventory and asset accounts are kept by their own records and are not offered here."
      />
      <Card>
        <JournalForm
          action={saveJournalAction.bind(null, org, null)}
          accounts={await accountOptions(db, ctx.orgId, { excludeControl: true })}
          contacts={await contactOptions(db, ctx.orgId)}
          dims={await dimensionOptions(db, ctx.orgId)}
          baseCurrency={ctx.org.baseCurrency}
          currencies={currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency)}
          defaults={{ entryDate: todayIn(ctx.org.timezone), description: "", lines: [] }}
          canPost={can(ctx, "ledger.post")}
          idempotencyKey={randomUUID()}
        />
      </Card>
    </>
  );
}
