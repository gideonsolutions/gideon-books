import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { accountOptions, currencyOptions, subtypeOptions } from "@/lib/web/options";
import { Card, PageHeader } from "@/components/ui";
import { AccountForm } from "@/components/accounting/account-form";
import { createAccountAction } from "../../actions";

export const metadata = { title: "New account" };

export default async function NewAccount({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await orgCtx(org);
  return (
    <>
      <PageHeader title="New account" back={{ href: `/o/${org}/accounting/accounts`, label: "Chart of accounts" }} />
      <Card className="max-w-2xl">
        <AccountForm
          action={createAccountAction.bind(null, org)}
          subtypes={subtypeOptions()}
          parents={await accountOptions(getDb(), ctx.orgId)}
          currencies={[{ value: "", label: `${ctx.org.baseCurrency} (base)` }, ...currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency)]}
          submitLabel="Create account"
        />
      </Card>
    </>
  );
}
