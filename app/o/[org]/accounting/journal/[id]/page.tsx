import Link from "next/link";
import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { getEntryDetail } from "@/lib/ledger/journals";
import { DIRECTLY_REVERSIBLE } from "@/lib/ledger/posting";
import { accountOptions, contactOptions, currencyOptions, dimensionOptions } from "@/lib/web/options";
import { listAudit } from "@/lib/audit";
import { listAttachments } from "@/lib/storage/attachments";
import { can } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { Alert, Badge, Card, DateText, DescriptionList, Money, PageHeader, Table, Td, Th } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { JournalForm } from "@/components/accounting/journal-form";
import { Attachments } from "@/components/attachments";
import { AuditTrail } from "@/components/audit-trail";
import { deleteDraftAction, reverseEntryAction, saveJournalAction } from "../../actions";
import { sourceHref } from "@/lib/web/links";

export const metadata = { title: "Journal entry" };

export default async function EntryPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org, id } = await params;
  const ctx = await orgCtx(org);
  const db = getDb();
  const { entry, lines, reversedBy, reverses } = await getEntryDetail(db, ctx.orgId, id);
  const base = `/o/${org}`;
  const today = todayIn(ctx.org.timezone);

  if (entry.status === "draft" && entry.kind === "manual" && can(ctx, "ledger.draft")) {
    return (
      <>
        <PageHeader
          title="Draft journal entry"
          back={{ href: `${base}/accounting/journal`, label: "Journal entries" }}
          actions={
            <ConfirmButton action={deleteDraftAction.bind(null, org, id)} label="Delete draft" variant="danger" title="Delete this draft?" body="Drafts were never posted, so deleting one leaves no trace in the books." confirmLabel="Delete" />
          }
        />
        <Card>
          <JournalForm
            action={saveJournalAction.bind(null, org, id)}
            accounts={await accountOptions(db, ctx.orgId, { excludeControl: true })}
            contacts={await contactOptions(db, ctx.orgId)}
            dims={await dimensionOptions(db, ctx.orgId)}
            baseCurrency={ctx.org.baseCurrency}
            currencies={currencyOptions().filter((c) => c.value !== ctx.org.baseCurrency)}
            canPost={can(ctx, "ledger.post")}
            idempotencyKey={randomUUID()}
            defaults={{
              entryDate: entry.entryDate,
              description: entry.description,
              reference: entry.sourceRef ?? "",
              isAdjusting: entry.isAdjusting,
              lines: lines.map((l) => {
                const amt = Decimal.from(l.txnAmount);
                return {
                  accountId: l.accountId,
                  debit: amt.isPositive() ? amt.toString() : "",
                  credit: amt.isNegative() ? amt.neg().toString() : "",
                  description: l.description ?? "",
                  contactId: l.contactId ?? "",
                  currency: l.currency === ctx.org.baseCurrency ? "" : l.currency,
                  fxRate: l.currency === ctx.org.baseCurrency ? "" : l.fxRate,
                  projectId: l.projectId ?? "",
                  classId: l.classId ?? "",
                  departmentId: l.departmentId ?? "",
                  locationId: l.locationId ?? "",
                  fundId: l.fundId ?? "",
                };
              }),
            }}
          />
        </Card>
      </>
    );
  }

  const debits = Decimal.sum(lines.filter((l) => Decimal.from(l.baseAmount).isPositive()).map((l) => l.baseAmount));
  const credits = Decimal.sum(lines.filter((l) => Decimal.from(l.baseAmount).isNegative()).map((l) => l.baseAmount)).neg();
  const foreign = lines.some((l) => l.currency !== ctx.org.baseCurrency);
  const history = await listAudit(db, ctx.orgId, { entityType: "journal_entry", entityId: id });
  const files = await listAttachments(db, ctx.orgId, "journal_entry", id);
  const source = sourceHref(base, entry.sourceType, entry.sourceId);
  return (
    <>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            Entry #{entry.entryNumber}
            <Badge tone={entry.status === "posted" ? "green" : "amber"}>{entry.status}</Badge>
            {reversedBy && <Badge tone="red">reversed</Badge>}
            {entry.reversesEntryId && <Badge>reversal</Badge>}
          </span>
        }
        back={{ href: `${base}/accounting/journal`, label: "Journal entries" }}
        actions={
          entry.status === "posted" &&
          !reversedBy &&
          !entry.reversesEntryId &&
          DIRECTLY_REVERSIBLE.includes(entry.kind) &&
          can(ctx, "ledger.reverse") && (
            <ConfirmButton
              action={reverseEntryAction.bind(null, org, id)}
              label="Reverse"
              title={`Reverse entry #${entry.entryNumber}?`}
              body="A new entry with every line reversed is posted on the date you choose and linked to this one. This entry stays exactly as it is."
              dateLabel="Reversal date"
              defaultDate={today < entry.entryDate ? entry.entryDate : today}
              reasonLabel="Why is it being reversed?"
              confirmLabel="Post reversal"
              variant="danger"
            />
          )
        }
      />
      {reversedBy && (
        <div className="mb-4">
          <Alert tone="warning">
            Reversed by{" "}
            <Link href={`${base}/accounting/journal/${reversedBy.id}`} className="font-medium underline">
              entry #{reversedBy.entryNumber}
            </Link>{" "}
            on <DateText date={reversedBy.entryDate} />: {reversedBy.reversalReason}
          </Alert>
        </div>
      )}
      {reverses && (
        <div className="mb-4">
          <Alert tone="info">
            Reverses{" "}
            <Link href={`${base}/accounting/journal/${reverses.id}`} className="font-medium underline">
              entry #{reverses.entryNumber}
            </Link>
            . Reason: {entry.reversalReason}
          </Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Card title={entry.description}>
            <DescriptionList
              items={[
                { label: "Posting date", value: <DateText date={entry.entryDate} /> },
                { label: "Document date", value: <DateText date={entry.documentDate} /> },
                { label: "Source", value: source ? <Link className="text-brand-700 hover:underline" href={source}>{entry.kind.replace(/_/g, " ")}{entry.sourceRef ? ` ${entry.sourceRef}` : ""}</Link> : `${entry.kind.replace(/_/g, " ")}${entry.sourceRef ? ` · ${entry.sourceRef}` : ""}` },
                { label: "Cash basis", value: entry.cashBasis === "as_is" ? "Included as posted" : entry.cashBasis === "deferred" ? "Recognized as it is paid" : "Settlement (recognizes what it settles)" },
                { label: "Posted", value: entry.postedAt ? `${entry.postedAt.toISOString().slice(0, 16).replace("T", " ")} UTC via ${entry.origin}` : "—" },
                { label: "Auto-reverses on", value: <DateText date={entry.autoReverseOn} /> },
              ]}
            />
          </Card>
          <Table>
            <thead>
              <tr>
                <Th>Account</Th>
                <Th>Description</Th>
                {foreign && <Th align="right">Original</Th>}
                <Th align="right">Debit</Th>
                <Th align="right">Credit</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lines.map((l) => {
                const amt = Decimal.from(l.baseAmount);
                return (
                  <tr key={l.id}>
                    <Td>
                      <Link href={`${base}/accounting/accounts/${l.accountId}`} className="hover:text-brand-700">
                        <span className="font-mono text-xs text-slate-500">{l.account.code}</span> {l.account.name}
                      </Link>
                    </Td>
                    <Td className="text-slate-600">{l.description}</Td>
                    {foreign && (
                      <Td align="right" className="text-xs text-slate-500">
                        {l.currency !== ctx.org.baseCurrency && (
                          <>
                            <Money amount={l.txnAmount} currency={l.currency} /> @ {Decimal.from(l.fxRate).normalize().toString()}
                          </>
                        )}
                      </Td>
                    )}
                    <Td align="right">{amt.isPositive() && <Money amount={l.baseAmount} currency={ctx.org.baseCurrency} />}</Td>
                    <Td align="right">{amt.isNegative() && <Money amount={amt.neg().toString()} currency={ctx.org.baseCurrency} />}</Td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 font-medium">
              <tr>
                <Td colSpan={foreign ? 3 : 2}>Totals</Td>
                <Td align="right">
                  <Money amount={debits.toString()} currency={ctx.org.baseCurrency} />
                </Td>
                <Td align="right">
                  <Money amount={credits.toString()} currency={ctx.org.baseCurrency} />
                </Td>
              </tr>
            </tfoot>
          </Table>
        </div>
        <div className="space-y-6">
          <Attachments org={org} entityType="journal_entry" entityId={id} files={files} canUpload={can(ctx, "ledger.draft")} />
          <AuditTrail events={history} />
        </div>
      </div>
    </>
  );
}
