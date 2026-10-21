/** Recurring invoices: the list, a new template, and a template's page (content, schedule, history). */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { orgCtx } from "@/lib/web/session";
import { FREQUENCY_LABELS, getRecurring, listRecurring } from "@/lib/sales/recurring";
import type { DocumentInput } from "@/lib/commerce/documents";
import { documentFormOptions, emptyDraft } from "@/lib/web/document-form";
import { can, requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { listAudit } from "@/lib/audit";
import type { DocumentDraft } from "@/components/commerce/document-form";
import { DocumentForm } from "@/components/commerce/document-form";
import { blankLine } from "@/lib/commerce/draft";
import { Alert, Card, DateText, EmptyState, LinkButton, Money, PageHeader, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ActionButton, ActionForm, CheckboxField, ConfirmButton, SelectField, SubmitButton, TextField } from "@/components/client/forms";
import { AuditTrail } from "@/components/audit-trail";
import {
  createRecurringAction,
  deleteRecurringAction,
  recurringStatusAction,
  runRecurringNowAction,
  updateRecurringContentAction,
  updateRecurringScheduleAction,
} from "@/app/o/[org]/sales/actions";

function every(frequency: keyof typeof FREQUENCY_LABELS, interval: number) {
  return interval === 1 ? `Every ${FREQUENCY_LABELS[frequency]}` : `Every ${interval} ${FREQUENCY_LABELS[frequency]}s`;
}

export async function RecurringListPage({ slug }: { slug: string }) {
  const ctx = await orgCtx(slug);
  const rows = await listRecurring(getDb(), ctx.orgId);
  const base = `/o/${slug}`;
  return (
    <>
      <PageHeader
        title="Recurring invoices"
        description="Invoices made on a schedule. Each occurrence is made once, dated its occurrence date; it can stay a draft for review, or be issued and emailed automatically. The background worker runs them daily; “Run now” makes anything due immediately."
        actions={can(ctx, "sales.manage") && <LinkButton href={`${base}/sales/recurring/new`}>New recurring invoice</LinkButton>}
      />
      {rows.length === 0 ? (
        <EmptyState title="No recurring invoices" action={can(ctx, "sales.manage") && <LinkButton href={`${base}/sales/recurring/new`}>New recurring invoice</LinkButton>}>
          Set up retainers, subscriptions and rent once; or open any invoice and choose “Make recurring”.
        </EmptyState>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Customer</Th>
              <Th>Schedule</Th>
              <Th>Next</Th>
              <Th>Made</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ t, contactName }) => (
              <tr key={t.id} className="hover:bg-slate-50">
                <Td>
                  <Link href={`${base}/sales/recurring/${t.id}`} className="font-medium text-brand-700 hover:underline">
                    {t.name}
                  </Link>
                </Td>
                <Td>{contactName}</Td>
                <Td>
                  {every(t.frequency, t.interval)}
                  {t.autoIssue ? (t.autoSend ? " · issued and sent" : " · issued") : " · drafts"}
                </Td>
                <Td>{t.status === "ended" ? "—" : <DateText date={t.nextRunDate} />}</Td>
                <Td className="num">
                  {t.occurrences}
                  {t.maxOccurrences ? ` of ${t.maxOccurrences}` : ""}
                </Td>
                <Td>
                  <StatusBadge status={t.status} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </>
  );
}

export async function RecurringNewPage({ slug }: { slug: string }) {
  const ctx = await orgCtx(slug);
  requirePermission(ctx, "sales.manage");
  const today = todayIn(ctx.org.timezone);
  const draft = emptyDraft(today);
  return (
    <>
      <PageHeader title="New recurring invoice" back={{ href: `/o/${slug}/sales/recurring`, label: "Recurring invoices" }} description="First the invoice each occurrence will be (dates are set per occurrence), then the schedule." />
      <Card>
        <DocumentForm
          action={createRecurringAction.bind(null, slug)}
          side="sales"
          kindLabel="Template"
          contactLabel="Customer"
          show={{ terms: true, reference: "Customer's PO number", notes: true, shipping: true }}
          defaults={{ ...draft, lines: [blankLine()] }}
          issueLabel={false}
          draftLabel="Continue to the schedule"
          {...await documentFormOptions(getDb(), ctx, "sales", today)}
        />
      </Card>
    </>
  );
}

function draftOf(input: DocumentInput, today: string): DocumentDraft {
  return {
    ...emptyDraft(today),
    contactId: input.contactId,
    paymentTermsId: input.paymentTermsId ?? "",
    currency: input.currency ?? "",
    taxInclusive: !!input.taxInclusive,
    discountType: input.discountType ?? "",
    discountValue: input.discountValue ?? "",
    reference: input.reference ?? "",
    memo: input.memo ?? "",
    notes: input.notes ?? "",
    lines: input.lines.map((l) => ({
      ...blankLine(),
      lineType: l.lineType ?? "item",
      itemId: l.itemId ?? "",
      description: l.description ?? "",
      quantity: l.quantity ?? "1",
      unitPrice: l.unitPrice ?? "",
      discountPercent: l.discountPercent ?? "",
      accountId: l.accountId ?? "",
      taxCodeId: l.taxCodeId ?? "",
      projectId: l.projectId ?? "",
      classId: l.classId ?? "",
      departmentId: l.departmentId ?? "",
      locationId: l.locationId ?? "",
      fundId: l.fundId ?? "",
    })),
  };
}

export async function RecurringDetailPage({ slug, id, isNew }: { slug: string; id: string; isNew: boolean }) {
  const ctx = await orgCtx(slug);
  const db = getDb();
  const found = await getRecurring(db, ctx.orgId, id).catch(() => null);
  if (!found) notFound();
  const { t, runs } = found;
  const today = todayIn(ctx.org.timezone);
  const base = `/o/${slug}`;
  const canManage = can(ctx, "sales.manage");
  const history = await listAudit(db, ctx.orgId, { entityType: "recurring_template", entityId: id, limit: 20 });
  const payload = t.template as DocumentInput;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {t.name} <StatusBadge status={t.status} />
          </span>
        }
        back={{ href: `${base}/sales/recurring`, label: "Recurring invoices" }}
        actions={
          canManage &&
          t.status !== "ended" && (
            <>
              {t.status === "active" && <ActionButton action={runRecurringNowAction.bind(null, slug, id)}>Run now</ActionButton>}
              {t.status === "active" ? <ActionButton action={recurringStatusAction.bind(null, slug, id, "paused")}>Pause</ActionButton> : <ActionButton variant="primary" action={recurringStatusAction.bind(null, slug, id, "active")}>Turn on</ActionButton>}
              <ConfirmButton
                action={deleteRecurringAction.bind(null, slug, id)}
                label={t.occurrences > 0 ? "End" : "Delete"}
                variant="danger"
                title={t.occurrences > 0 ? "End this schedule?" : "Delete this schedule?"}
                body={t.occurrences > 0 ? "No more invoices will be made. The invoices already made are unaffected." : "Nothing has been made from it yet."}
                confirmLabel={t.occurrences > 0 ? "End" : "Delete"}
              />
            </>
          )
        }
      />
      {isNew && t.status === "paused" && (
        <div className="mb-4">
          <Alert tone="info">Set the schedule below and turn it on. Until then nothing is made.</Alert>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card title="Schedule">
            {canManage && t.status !== "ended" ? (
              <ActionForm action={updateRecurringScheduleAction.bind(null, slug, id)} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField label="Name" name="name" required defaultValue={t.name} />
                  <TextField label="First invoice date" name="startDate" type="date" required defaultValue={t.startDate} />
                  <SelectField
                    label="Repeats"
                    name="frequency"
                    defaultValue={t.frequency}
                    options={[
                      { value: "weekly", label: "Weekly" },
                      { value: "monthly", label: "Monthly" },
                      { value: "quarterly", label: "Quarterly" },
                      { value: "yearly", label: "Yearly" },
                    ]}
                  />
                  <TextField label="Every" name="interval" type="number" min={1} max={52} defaultValue={String(t.interval)} hint="e.g. every 2 months" />
                  <TextField label="Last date (optional)" name="endDate" type="date" defaultValue={t.endDate ?? ""} />
                  <TextField label="Stop after (optional)" name="maxOccurrences" type="number" min={1} defaultValue={t.maxOccurrences ? String(t.maxOccurrences) : ""} hint="occurrences" />
                </div>
                <CheckboxField label="Issue each invoice automatically (otherwise each is left as a draft to review)" name="autoIssue" defaultChecked={t.autoIssue} />
                <CheckboxField label="Email each issued invoice to the customer, with its PDF" name="autoSend" defaultChecked={t.autoSend} />
                {t.status === "paused" && <CheckboxField label="Turn it on when saved" name="activate" defaultChecked={isNew} />}
                <div className="flex items-center justify-between">
                  <p className="text-sm text-slate-600">
                    Next: <DateText date={t.nextRunDate} /> · {t.occurrences} made so far
                  </p>
                  <SubmitButton>Save schedule</SubmitButton>
                </div>
              </ActionForm>
            ) : (
              <p className="text-sm text-slate-700">
                {every(t.frequency, t.interval)} from <DateText date={t.startDate} />. {t.occurrences} made.
              </p>
            )}
          </Card>
          {canManage && t.status !== "ended" && (
            <Card title="The invoice each time">
              <DocumentForm
                action={updateRecurringContentAction.bind(null, slug, id)}
                side="sales"
                kindLabel="Template"
                contactLabel="Customer"
                show={{ terms: true, reference: "Customer's PO number", notes: true, shipping: true }}
                defaults={draftOf(payload, today)}
                issueLabel={false}
                draftLabel="Save invoice template"
                {...await documentFormOptions(db, ctx, "sales", today)}
              />
            </Card>
          )}
          <Card title="Occurrences" padded={false}>
            {runs.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">Nothing made yet.</p>
            ) : (
              <Table className="rounded-none border-0 shadow-none">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Invoice</Th>
                    <Th>Status</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {runs.map(({ run, number, status, total, currency }) => (
                    <tr key={run.id}>
                      <Td><DateText date={run.occurrenceDate} /></Td>
                      <Td>
                        {run.documentId ? (
                          <Link className="text-brand-700 hover:underline" href={`${base}/sales/invoices/${run.documentId}`}>
                            {number ?? "Draft"}
                          </Link>
                        ) : (
                          "—"
                        )}
                        {run.error && <div className="text-xs text-danger-700">{run.error}</div>}
                      </Td>
                      <Td><StatusBadge status={run.status === "failed" ? "failed" : (status ?? run.status)} /></Td>
                      <Td align="right">{total && currency ? <Money amount={total} currency={currency} /> : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
        <AuditTrail events={history} />
      </div>
    </>
  );
}
