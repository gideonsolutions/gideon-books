import { getDb } from "@/lib/db/client";
import type { Ctx } from "@/lib/context";
import { DocumentForm, type DocumentDraft } from "@/components/commerce/document-form";
import { documentFormOptions } from "@/lib/web/document-form";
import { saveDocumentAction } from "@/app/o/[org]/purchases/actions";
import { PURCHASE_KINDS, type PurchaseKind } from "./kinds";

/** The editor for a purchase document (new or draft), with its options loaded. */
export async function PurchaseDocumentEditor({
  org,
  ctx,
  kind,
  id,
  draft,
  receiptAttachmentId,
  issueLabel,
}: {
  org: string;
  ctx: Ctx;
  kind: PurchaseKind;
  id: string | null;
  draft: DocumentDraft;
  receiptAttachmentId?: string | null;
  issueLabel?: string | false;
}) {
  const cfg = PURCHASE_KINDS[kind];
  const opts = await documentFormOptions(getDb(), ctx, "purchases", draft.issueDate);
  return (
    <DocumentForm
      action={saveDocumentAction.bind(null, org, kind, id, receiptAttachmentId ?? null)}
      side="purchases"
      kindLabel={cfg.label}
      contactLabel={kind === "bill" ? "Vendor or employee" : "Vendor"}
      {...opts}
      contacts={kind === "bill" || kind === "expense" ? opts.contacts : opts.contacts.filter((c) => !c.label.endsWith("(employee)"))}
      show={cfg.show}
      defaults={draft}
      issueLabel={issueLabel ?? cfg.issueLabel}
      draftLabel={id ? "Save changes" : "Save draft"}
    />
  );
}
