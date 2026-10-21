/**
 * Request bodies of the REST API, validated with zod and also used to
 * generate the OpenAPI document (lib/api/openapi.ts). Amounts are decimal
 * strings ("1234.50"), never JSON numbers, so nothing passes through a float.
 */
import { z } from "zod";
import { ACCOUNT_SUBTYPES } from "@/lib/db/schema/ledger";
import { DOCUMENT_KINDS, PAYMENT_KINDS } from "@/lib/db/schema/commerce";

export const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/, 'A decimal string, e.g. "12.50".');
export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date, YYYY-MM-DD.");
export const Id = z.string().uuid();
const opt = <T extends z.ZodTypeAny>(t: T) => t.nullish();

const Dims = {
  projectId: opt(Id),
  classId: opt(Id),
  departmentId: opt(Id),
  locationId: opt(Id),
  fundId: opt(Id),
  trustComponent: opt(z.enum(["principal", "income"])),
  beneficiaryId: opt(Id),
};

export const AccountBody = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(120),
  subtype: z.enum(ACCOUNT_SUBTYPES),
  parentId: opt(Id),
  description: opt(z.string().max(1000)),
  currency: opt(z.string().length(3)),
  cashFlowSection: opt(z.enum(["cash", "operating", "investing", "financing", "none"])),
});

export const JournalEntryBody = z.object({
  entryDate: DateStr,
  description: z.string().min(1).max(1000),
  reference: opt(z.string().max(100)),
  isAdjusting: z.boolean().optional(),
  autoReverseOn: opt(DateStr),
  lines: z
    .array(
      z.object({
        accountId: Id,
        debit: opt(Decimal),
        credit: opt(Decimal),
        description: opt(z.string().max(500)),
        contactId: opt(Id),
        currency: opt(z.string().length(3)),
        fxRate: opt(Decimal),
        ...Dims,
      }),
    )
    .min(2)
    .max(500),
});

export const ReverseBody = z.object({ date: DateStr, reason: z.string().min(3).max(500) });

export const AddressBody = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().max(60).optional(),
});

export const ContactBody = z.object({
  displayName: z.string().min(1).max(200),
  companyName: opt(z.string().max(200)),
  isCustomer: z.boolean().optional(),
  isVendor: z.boolean().optional(),
  isEmployee: z.boolean().optional(),
  isBeneficiary: z.boolean().optional(),
  email: opt(z.string().email()),
  phone: opt(z.string().max(50)),
  website: opt(z.string().max(200)),
  currency: opt(z.string().length(3)),
  paymentTermsId: opt(Id),
  billingAddress: opt(AddressBody),
  shippingAddress: opt(AddressBody),
  taxExempt: z.boolean().optional(),
  taxExemptionReason: opt(z.string().max(500)),
  taxExemptionCertificate: opt(z.string().max(200)),
  is1099: z.boolean().optional(),
  notes: opt(z.string().max(5000)),
});

export const ItemBody = z.object({
  kind: z.enum(["service", "non_stock", "stock"]),
  sku: opt(z.string().max(64)),
  name: z.string().min(1).max(200),
  description: opt(z.string().max(2000)),
  unit: opt(z.string().max(20)),
  salePrice: opt(Decimal),
  purchaseCost: opt(Decimal),
  incomeAccountId: opt(Id),
  expenseAccountId: opt(Id),
  inventoryAccountId: opt(Id),
  saleTaxCodeId: opt(Id),
  purchaseTaxCodeId: opt(Id),
  reorderLevel: opt(Decimal),
  reorderQuantity: opt(Decimal),
});

export const DocumentBody = z.object({
  kind: z.enum(DOCUMENT_KINDS),
  contactId: Id,
  issueDate: DateStr,
  postingDate: opt(DateStr),
  dueDate: opt(DateStr),
  expiryDate: opt(DateStr),
  paymentTermsId: opt(Id),
  currency: opt(z.string().length(3)),
  fxRate: opt(Decimal),
  taxInclusive: z.boolean().optional(),
  discountType: opt(z.enum(["percent", "amount"])),
  discountValue: opt(Decimal),
  reference: opt(z.string().max(100)),
  memo: opt(z.string().max(5000)),
  notes: opt(z.string().max(5000)),
  cashAccountId: opt(Id),
  inventoryLocationId: opt(Id),
  isReimbursement: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        lineType: z.enum(["item", "shipping"]).optional(),
        itemId: opt(Id),
        description: opt(z.string().max(2000)),
        quantity: opt(Decimal),
        unitPrice: opt(Decimal),
        discountPercent: opt(Decimal),
        accountId: opt(Id),
        taxCodeId: opt(Id),
        serviceDate: opt(DateStr),
        inventoryLocationId: opt(Id),
        billableCustomerId: opt(Id),
        ...Dims,
      }),
    )
    .min(1)
    .max(1000),
  /** Issue (post) immediately after saving. */
  issue: z.boolean().optional(),
});

export const VoidBody = z.object({ date: opt(DateStr), reason: z.string().min(3).max(500) });

export const PaymentBody = z.object({
  kind: z.enum(PAYMENT_KINDS),
  contactId: Id,
  paymentDate: DateStr,
  accountId: Id,
  currency: opt(z.string().length(3)),
  amount: Decimal,
  fxRate: opt(Decimal),
  accountAmount: opt(Decimal),
  feeAmount: opt(Decimal),
  feeAccountId: opt(Id),
  method: z.enum(["check", "ach", "wire", "card", "cash", "provider", "other"]).optional(),
  reference: opt(z.string().max(100)),
  memo: opt(z.string().max(1000)),
  allocations: z.array(z.object({ itemType: z.enum(["document", "payment"]), itemId: Id, amount: Decimal })).max(500).optional(),
});

export const PeriodCloseBody = z.object({ reason: opt(z.string().max(500)), acknowledgeWarnings: z.boolean().optional() });
export const PeriodReopenBody = z.object({ reason: z.string().min(5).max(500) });

export const ExchangeRateBody = z.object({ currency: z.string().length(3), rateDate: DateStr, rate: Decimal, note: opt(z.string().max(200)) });

// ── Imports ─────────────────────────────────────────────────────────────────

export const BankCsvMapping = z.object({
  delimiter: z.string().nullable(),
  hasHeader: z.boolean(),
  skipRows: z.number().int().min(0),
  dateColumn: z.number().int().min(0),
  dateFormat: z.enum(["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "M/D/YY", "DD.MM.YYYY", "YYYY/MM/DD"]),
  amountMode: z.enum(["single", "debit_credit"]),
  amountColumn: z.number().int().nullable(),
  debitColumn: z.number().int().nullable(),
  creditColumn: z.number().int().nullable(),
  invertSign: z.boolean(),
  decimalComma: z.boolean(),
  descriptionColumn: z.number().int().min(0),
  payeeColumn: z.number().int().nullable(),
  referenceColumn: z.number().int().nullable(),
  balanceColumn: z.number().int().nullable(),
});

export const BankImportBody = z.object({
  accountId: z.string().uuid(),
  fileName: z.string().min(1).max(200),
  /** The CSV text, as exported by the bank. */
  text: z.string().min(1).max(5_000_000),
  /** Column mapping; omitted, it is guessed from the header. */
  mapping: BankCsvMapping.optional(),
  /** Validate and report duplicates without importing. */
  preview: z.boolean().optional(),
  includeDuplicateRows: z.array(z.number().int()).optional(),
});

export const PayrollImportBody = z.object({
  /** generic_csv or generic_json (docs/payroll-import-format.md). */
  adapter: z.enum(["generic_csv", "generic_json"]),
  fileName: z.string().min(1).max(200),
  content: z.string().min(1).max(5_000_000),
  /** Post the run if it validates (otherwise it waits for review). */
  post: z.boolean().optional(),
});

