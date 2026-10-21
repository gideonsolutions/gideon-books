import Link from "next/link";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { can } from "@/lib/context";
import { previewImport } from "@/lib/payroll/imports";
import { COMPONENT_LABELS } from "@/lib/payroll/mappings";
import { listAccounts } from "@/lib/ledger/accounts";
import { dimensionOptions } from "@/lib/web/options";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ActionButton, ConfirmButton } from "@/components/client/forms";
import { PayrollTabs } from "@/components/payroll/tabs";
import { discardPayrollImportAction, postPayrollImportAction } from "../../actions";
import type { PayrollComponentType } from "@/lib/db/schema/payroll";

export const metadata = { title: "Payroll import" };

export default async function ImportPreview({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { imp, preview } = await previewImport(db, ctx, id);
  const accounts = new Map((await listAccounts(db, ctx.orgId, { includeArchived: true })).map((a) => [a.id, a]));
  const dims = await dimensionOptions(db, ctx.orgId);
  const dimName = (v: string | null) => (v ? [...dims.departments, ...dims.classes, ...dims.locations, ...dims.projects].find((o) => o.value === v)?.label : null);
  const base = `/o/${org}`;
  const cur = ctx.org.baseCurrency;
  const run = preview.run;
  const debits = Decimal.sum(preview.entryLines.filter((l) => Decimal.from(l.amount).isPositive()).map((l) => l.amount));
  const credits = Decimal.sum(preview.entryLines.filter((l) => Decimal.from(l.amount).isNegative()).map((l) => l.amount)).neg();
  const may = can(ctx, "payroll.import");
  return (
    <>
      <PageHeader
        title={`Payroll import: ${imp.fileName}`}
        back={{ href: `${base}/payroll/import`, label: "Import" }}
        actions={
          may &&
          imp.status === "previewed" && (
            <>
              {preview.errors.length === 0 && (
                <ActionButton action={postPayrollImportAction.bind(null, org, id)} variant="primary">
                  Post payroll
                </ActionButton>
              )}
              <ConfirmButton action={discardPayrollImportAction.bind(null, org, id)} label="Discard" title="Discard this import?" body="Nothing was posted. The file stays in the import history." confirmLabel="Discard" />
            </>
          )
        }
      />
      <PayrollTabs org={org} current="import" />
      {imp.status === "posted" && imp.runId && (
        <div className="mb-4">
          <Alert tone="success">
            Posted as{" "}
            <Link className="underline" href={`${base}/payroll/${imp.runId}`}>
              this payroll run
            </Link>
            .
          </Alert>
        </div>
      )}
      {imp.status === "discarded" && (
        <div className="mb-4">
          <Alert tone="info">This import was discarded.</Alert>
        </div>
      )}
      {preview.errors.length > 0 && (
        <div className="mb-4">
          <Alert tone="danger" title={`${preview.errors.length} problem${preview.errors.length === 1 ? "" : "s"} to fix before posting`}>
            <ul className="list-disc pl-5">
              {preview.errors.slice(0, 50).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
            {preview.duplicateOf && (
              <p className="mt-2">
                <Link className="underline" href={`${base}/payroll/${preview.duplicateOf.runId}`}>
                  Open the run already posted
                </Link>
                {" · "}
                <Link className="underline" href={`${base}/payroll/mappings`}>
                  Mappings
                </Link>
              </p>
            )}
          </Alert>
        </div>
      )}
      {preview.warnings.length > 0 && imp.status === "previewed" && (
        <div className="mb-4">
          <Alert tone="warning">
            <ul className="list-disc pl-5">
              {preview.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Alert>
        </div>
      )}
      {run && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-6">
            <Card title="The entry that will post" padded={false}>
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Account</Th>
                    <Th>Component</Th>
                    <Th align="right">Debit</Th>
                    <Th align="right">Credit</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.entryLines.map((l, i) => {
                    const a = accounts.get(l.accountId);
                    const amt = Decimal.from(l.amount);
                    const d = [l.departmentId, l.classId, l.locationId, l.projectId].map(dimName).filter(Boolean).join(" · ");
                    return (
                      <tr key={i}>
                        <Td>
                          {a ? `${a.code} ${a.name}` : l.accountId}
                          {d && <div className="text-xs text-slate-500">{d}</div>}
                        </Td>
                        <Td className="text-slate-600">{l.description}</Td>
                        <Td align="right">{amt.isPositive() && <Money amount={amt.toString()} currency={cur} />}</Td>
                        <Td align="right">{amt.isNegative() && <Money amount={amt.neg().toString()} currency={cur} />}</Td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-50 font-medium">
                  <tr>
                    <Td colSpan={2}>Totals</Td>
                    <Td align="right"><Money amount={debits.toString()} currency={cur} /></Td>
                    <Td align="right"><Money amount={credits.toString()} currency={cur} /></Td>
                  </tr>
                </tfoot>
              </Table>
            </Card>
            <Card title="Employees and components" padded={false}>
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Employee</Th>
                    <Th>Component</Th>
                    <Th align="right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {preview.components.slice(0, 500).map((c, i) => (
                    <tr key={i}>
                      <Td>{c.employeeName ?? c.employeeRef ?? "Summary"}</Td>
                      <Td className="text-slate-600">
                        {COMPONENT_LABELS[c.type]}
                        {c.code !== "net_pay" && ` · ${c.code}`}
                        {c.mapping?.isDefault && <span className="ml-1 text-xs text-amber-700">(default account)</span>}
                        {!c.mapping && <span className="ml-1 text-xs text-danger-700">(no mapping)</span>}
                      </Td>
                      <Td align="right"><Money amount={c.amount} currency={cur} /></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Card>
          </div>
          <Card title="Run">
            <DescriptionList
              items={[
                { label: "Run id", value: run.providerRunId },
                { label: "Pay date (posting date)", value: <DateText date={run.payDate} /> },
                { label: "Period", value: <><DateText date={run.periodStart} /> – <DateText date={run.periodEnd} /></> },
                { label: "Employees", value: preview.employeeCount || "Summary file" },
                ...(Object.keys(preview.totals) as PayrollComponentType[]).map((k) => ({ label: COMPONENT_LABELS[k], value: <Money amount={preview.totals[k]} currency={cur} /> })),
              ]}
            />
          </Card>
        </div>
      )}
    </>
  );
}
