/** How each purchase document kind is named and shown. */
import type { DocumentFormProps } from "@/components/commerce/document-form";

export interface PurchaseKindConfig {
  label: string;
  plural: string;
  path: string;
  issueLabel: string | false;
  description: string;
  show: DocumentFormProps["show"];
}

export const PURCHASE_KINDS = {
  bill: {
    label: "Bill",
    plural: "Bills",
    path: "/purchases/bills",
    issueLabel: "Save and post",
    description: "What vendors have billed you. A posted bill is owed until it is paid, credited or voided.",
    show: { dueDate: true, terms: true, reference: "Vendor's invoice number", postingDate: true, reimbursement: true, billable: true },
  },
  expense: {
    label: "Expense",
    plural: "Expenses",
    path: "/purchases/expenses",
    issueLabel: "Save and post",
    description: "Purchases paid at once from a bank account, card or cash — nothing owed afterwards.",
    show: { cashAccount: true, reference: "Receipt or check number", postingDate: true, billable: true },
  },
  vendor_credit: {
    label: "Vendor credit",
    plural: "Vendor credits",
    path: "/purchases/credits",
    issueLabel: "Save and post",
    description: "Credits from vendors for returns and corrections, applied to bills or refunded.",
    show: { reference: "Vendor's credit number", postingDate: true },
  },
  purchase_order: {
    label: "Purchase order",
    plural: "Purchase orders",
    path: "/purchases/orders",
    issueLabel: "Save and issue",
    description: "Orders to vendors. Nothing posts until goods are received or the vendor bills.",
    show: { expiryDate: true, terms: true, reference: "Vendor quote", notes: true, shipping: true },
  },
} satisfies Record<string, PurchaseKindConfig>;

export type PurchaseKind = keyof typeof PURCHASE_KINDS;
