/** Canonical pages for documents and payments by kind. */
import type { DocumentKind, PaymentKind } from "@/lib/db/schema/commerce";

export const DOCUMENT_PATHS: Record<DocumentKind, string> = {
  estimate: "/sales/estimates",
  invoice: "/sales/invoices",
  credit_note: "/sales/credit-notes",
  write_off: "/sales/credit-notes",
  sales_receipt: "/sales/receipts",
  purchase_order: "/purchases/orders",
  bill: "/purchases/bills",
  vendor_credit: "/purchases/credits",
  expense: "/purchases/expenses",
};

export function documentPath(base: string, kind: DocumentKind, id: string): string {
  return `${base}${DOCUMENT_PATHS[kind]}/${id}`;
}

export function paymentPath(base: string, kind: PaymentKind, id: string): string {
  return `${base}${kind.startsWith("customer") ? "/sales/payments" : "/purchases/payments"}/${id}`;
}
