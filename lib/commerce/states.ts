/**
 * Document states and the transitions allowed between them. Overdue is not
 * a state: it is an issued or partially paid document past its due date.
 */
import type { DocumentKind, DocumentStatus } from "@/lib/db/schema/commerce";

export const STATUS_LABELS: Record<DocumentStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  converted: "Converted",
  expired: "Expired",
  issued: "Issued",
  partially_paid: "Partially paid",
  paid: "Paid",
  partially_received: "Partially received",
  received: "Received",
  closed: "Closed",
  cancelled: "Cancelled",
  void: "Void",
};

export const KIND_LABELS: Record<DocumentKind, string> = {
  estimate: "Estimate",
  invoice: "Invoice",
  credit_note: "Credit note",
  write_off: "Write-off",
  sales_receipt: "Sales receipt",
  purchase_order: "Purchase order",
  bill: "Bill",
  vendor_credit: "Vendor credit",
  expense: "Expense",
};

/** Kinds that post to the ledger when issued. */
export const POSTING_KINDS: readonly DocumentKind[] = ["invoice", "credit_note", "write_off", "sales_receipt", "bill", "vendor_credit", "expense"];

export const SALES_KINDS: readonly DocumentKind[] = ["estimate", "invoice", "credit_note", "write_off", "sales_receipt"];

const TRANSITIONS: Record<DocumentKind, Partial<Record<DocumentStatus, DocumentStatus[]>>> = {
  estimate: {
    draft: ["sent", "accepted", "declined"],
    sent: ["accepted", "declined", "expired", "converted"],
    accepted: ["converted", "declined"],
    expired: ["sent", "accepted"],
    declined: ["sent"],
  },
  invoice: {
    draft: ["issued"],
    issued: ["partially_paid", "paid", "void"],
    partially_paid: ["paid", "issued"],
    paid: ["partially_paid", "issued"],
  },
  credit_note: { draft: ["issued"], issued: ["closed", "void"], closed: ["issued"] },
  write_off: { draft: ["issued"], issued: ["closed", "void"], closed: ["issued"] },
  sales_receipt: { draft: ["paid"], paid: ["void"] },
  purchase_order: {
    draft: ["issued", "cancelled"],
    issued: ["partially_received", "received", "closed", "cancelled"],
    partially_received: ["received", "closed"],
    received: ["closed"],
  },
  bill: {
    draft: ["issued"],
    issued: ["partially_paid", "paid", "void"],
    partially_paid: ["paid", "issued"],
    paid: ["partially_paid", "issued"],
  },
  vendor_credit: { draft: ["issued"], issued: ["closed", "void"], closed: ["issued"] },
  expense: { draft: ["paid"], paid: ["void"] },
};

export function canTransition(kind: DocumentKind, from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[kind][from]?.includes(to) ?? false;
}

export function isOverdue(doc: { kind: DocumentKind; status: DocumentStatus; dueDate: string | null }, today: string): boolean {
  return (doc.kind === "invoice" || doc.kind === "bill") && (doc.status === "issued" || doc.status === "partially_paid") && !!doc.dueDate && doc.dueDate < today;
}

/** The label a person sees, with overdue derived. */
export function displayStatus(doc: { kind: DocumentKind; status: DocumentStatus; dueDate: string | null }, today: string): string {
  if (isOverdue(doc, today)) return doc.status === "partially_paid" ? "Overdue (partially paid)" : "Overdue";
  return STATUS_LABELS[doc.status];
}
