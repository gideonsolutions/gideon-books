/**
 * The list, new and detail pages shared by bills, expenses, vendor credits
 * and purchase orders. Each route file is one line choosing the kind.
 */
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { attachments } from "@/lib/db/schema/core";
import { getDocument } from "@/lib/commerce/documents";
import { can, requirePermission } from "@/lib/context";
import { todayIn } from "@/lib/dates";
import { Decimal } from "@/lib/money/decimal";
import { draftFromDocument, emptyDraft } from "@/lib/web/document-form";
import { readParams, type SearchParams } from "@/lib/web/params";
import { orgCtx } from "@/lib/web/session";
import { Alert, Card, LinkButton, PageHeader } from "@/components/ui";
import { ConfirmButton } from "@/components/client/forms";
import { deleteDraftAction, issueAction } from "@/app/o/[org]/purchases/actions";
import { PurchaseDocumentList } from "./document-list";
import { PurchaseDocumentEditor } from "./document-editor";
import { PurchaseDocumentView } from "./document-view";
import { PURCHASE_KINDS, type PurchaseKind } from "./kinds";

type OrgParams = Promise<{ org: string }>;
type IdParams = Promise<{ org: string; id: string }>;

export function listPage(kind: PurchaseKind) {
  return async function List({ params, searchParams }: { params: OrgParams; searchParams: SearchParams }) {
    const { org } = await params;
    const sp = await readParams(searchParams);
    const ctx = await orgCtx(org);
    const cfg = PURCHASE_KINDS[kind];
    const canCreate = can(ctx, "purchases.manage");
    return (
      <>
        <PageHeader
          title={cfg.plural}
          description={cfg.description}
          actions={
            <>
              {kind === "bill" && (
                <LinkButton variant="secondary" href={`/o/${org}/purchases/bills/due`}>
                  What&apos;s due
                </LinkButton>
              )}
              {(kind === "bill" || kind === "expense") && (
                <LinkButton variant="secondary" href={`/o/${org}/purchases/receipts`}>
                  Receipt inbox
                </LinkButton>
              )}
              {canCreate && <LinkButton href={`/o/${org}${cfg.path}/new`}>New {cfg.label.toLowerCase()}</LinkButton>}
            </>
          }
        />
        <PurchaseDocumentList org={org} ctx={ctx} kind={kind} sp={sp} canCreate={canCreate} />
      </>
    );
  };
}

export function newPage(kind: PurchaseKind) {
  return async function New({ params, searchParams }: { params: OrgParams; searchParams: SearchParams }) {
    const { org } = await params;
    const sp = await readParams(searchParams);
    const ctx = await orgCtx(org);
    requirePermission(ctx, "purchases.manage");
    const cfg = PURCHASE_KINDS[kind];
    const draft = emptyDraft(todayIn(ctx.org.timezone));
    if (sp.vendor) draft.contactId = sp.vendor;
    if (kind === "bill" && sp.reimbursement === "1") draft.isReimbursement = true;
    let receipt: typeof attachments.$inferSelect | undefined;
    if (sp.receipt) {
      [receipt] = await getDb()
        .select()
        .from(attachments)
        .where(and(eq(attachments.orgId, ctx.orgId), eq(attachments.id, sp.receipt), eq(attachments.entityType, "receipt_inbox")));
    }
    return (
      <>
        <PageHeader title={`New ${cfg.label.toLowerCase()}`} back={{ href: `/o/${org}${cfg.path}`, label: cfg.plural }} description={cfg.description} />
        {receipt && (
          <div className="mb-4">
            <Alert tone="info">
              From the receipt{" "}
              <a className="underline" href={`/o/${org}/files/${receipt.id}`} target="_blank" rel="noreferrer">
                {receipt.fileName}
              </a>
              . It will be attached when you save.
            </Alert>
          </div>
        )}
        <Card>
          <PurchaseDocumentEditor org={org} ctx={ctx} kind={kind} id={null} draft={draft} receiptAttachmentId={receipt?.id ?? null} />
        </Card>
      </>
    );
  };
}

export function detailPage(kind: PurchaseKind) {
  return async function Detail({ params }: { params: IdParams }) {
    const { org, id } = await params;
    const ctx = await orgCtx(org);
    const cfg = PURCHASE_KINDS[kind];
    let found;
    try {
      found = await getDocument(getDb(), ctx.orgId, id);
    } catch {
      notFound();
    }
    const { doc, lines } = found;
    if (doc.kind !== kind) notFound();
    if (doc.status === "draft" && can(ctx, "purchases.manage")) {
      const fromOrder = lines.some((l) => l.sourceLineId);
      return (
        <>
          <PageHeader
            title={`Draft ${cfg.label.toLowerCase()}`}
            back={{ href: `/o/${org}${cfg.path}`, label: cfg.plural }}
            actions={
              <>
                {kind === "bill" && fromOrder && (
                  <ConfirmButton
                    action={issueAction.bind(null, org, kind, id)}
                    label="Post, billing more than ordered"
                    title="Post this bill even though it bills more than the order?"
                    body="Use this when the vendor shipped and billed more than you ordered and you accept it. The extra is received with the bill. Save your changes first."
                    hidden={{ allowOverBilling: "on" }}
                    confirmLabel="Post the bill"
                  />
                )}
                <ConfirmButton
                  action={deleteDraftAction.bind(null, org, kind, id)}
                  label="Delete draft"
                  variant="danger"
                  title="Delete this draft?"
                  body="It was never posted, so nothing in the books changes."
                  confirmLabel="Delete"
                />
              </>
            }
          />
          {fromOrder && (
            <div className="mb-4">
              <Alert tone="info">Lines from a purchase order are matched to the goods already received when the bill is posted: received value comes out of goods received not invoiced, and any price difference goes to purchase price variance.</Alert>
            </div>
          )}
          <Card>
            <PurchaseDocumentEditor org={org} ctx={ctx} kind={kind} id={id} draft={draftFromDocument(doc, lines, ctx.org.baseCurrency)} />
          </Card>
        </>
      );
    }
    if (kind === "purchase_order" && doc.status === "issued" && can(ctx, "purchases.manage") && !lines.some((l) => Decimal.from(l.receivedQuantity).isPositive() || Decimal.from(l.billedQuantity).isPositive())) {
      // An issued order nothing has been received or billed against can still be edited.
      return (
        <>
          <PurchaseDocumentView org={org} ctx={ctx} id={id} kind={kind} />
          <div className="mt-6">
            <Card title="Edit the order">
              <PurchaseDocumentEditor org={org} ctx={ctx} kind={kind} id={id} draft={draftFromDocument(doc, lines, ctx.org.baseCurrency)} issueLabel={false} />
            </Card>
          </div>
        </>
      );
    }
    return <PurchaseDocumentView org={org} ctx={ctx} id={id} kind={kind} />;
  };
}
