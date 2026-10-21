/** The document editor's draft shape, shared by the server pages and the client editor. */

export interface DocLineDraft {
  lineType: "item" | "shipping";
  itemId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent: string;
  accountId: string;
  taxCodeId: string;
  serviceDate: string;
  projectId: string;
  classId: string;
  departmentId: string;
  locationId: string;
  fundId: string;
  inventoryLocationId: string;
  billableCustomerId: string;
  sourceLineId: string;
  returnOfLineId: string;
}

export interface DocumentDraft {
  contactId: string;
  issueDate: string;
  postingDate: string;
  dueDate: string;
  expiryDate: string;
  paymentTermsId: string;
  currency: string;
  fxRate: string;
  taxInclusive: boolean;
  discountType: "" | "percent" | "amount";
  discountValue: string;
  reference: string;
  memo: string;
  notes: string;
  cashAccountId: string;
  inventoryLocationId: string;
  isReimbursement: boolean;
  lines: DocLineDraft[];
}

export const blankLine = (): DocLineDraft => ({
  lineType: "item",
  itemId: "",
  description: "",
  quantity: "1",
  unitPrice: "",
  discountPercent: "",
  accountId: "",
  taxCodeId: "",
  serviceDate: "",
  projectId: "",
  classId: "",
  departmentId: "",
  locationId: "",
  fundId: "",
  inventoryLocationId: "",
  billableCustomerId: "",
  sourceLineId: "",
  returnOfLineId: "",
});
