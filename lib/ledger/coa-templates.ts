/**
 * Chart-of-accounts templates. A new organization starts from one; every
 * account can then be renamed, renumbered, archived or added to. Accounts
 * with a `systemKey` are the ones the application posts to on its own; if a
 * template lacks one, it is created from SYSTEM_ACCOUNT_DEFAULTS the first
 * time it is needed.
 */
import type { AccountSubtype, AccountType } from "@/lib/db/schema/ledger";

export type ControlKind = "receivables" | "payables" | "inventory" | "fixed_assets" | "customer_deposits" | "vendor_prepayments";
export type CashFlowSection = "cash" | "operating" | "investing" | "financing" | "none";

export interface AccountSpec {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  systemKey?: string;
  control?: ControlKind;
  parentCode?: string;
  description?: string;
}

export const SYSTEM_KEYS = [
  "accounts_receivable",
  "accounts_payable",
  "customer_deposits",
  "vendor_prepayments",
  "undeposited_funds",
  "payment_clearing",
  "inventory_asset",
  "cost_of_goods_sold",
  "inventory_adjustments",
  "goods_received_not_invoiced",
  "purchase_price_variance",
  "sales_tax_payable",
  "sales_income",
  "service_income",
  "shipping_income",
  "general_expense",
  "retained_earnings",
  "opening_balance_equity",
  "owner_contributions",
  "owner_draws",
  "realized_fx",
  "unrealized_fx",
  "rounding",
  "bad_debt",
  "payment_fees",
  "reconciliation_discrepancies",
  "fixed_assets",
  "accumulated_depreciation",
  "depreciation_expense",
  "asset_disposal_gain_loss",
  "wages_expense",
  "payroll_tax_expense",
  "benefits_expense",
  "payroll_liabilities",
  "net_pay_clearing",
  "intercompany_receivable",
  "intercompany_payable",
  "net_assets_without_restrictions",
  "net_assets_with_restrictions",
  "trust_principal",
  "trust_income",
  "distributions",
] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

/** What to create when a system account is needed and the chart has none. */
export const SYSTEM_ACCOUNT_DEFAULTS: Record<SystemKey, Omit<AccountSpec, "systemKey">> = {
  accounts_receivable: { code: "1200", name: "Accounts Receivable", type: "asset", subtype: "accounts_receivable", control: "receivables" },
  accounts_payable: { code: "2000", name: "Accounts Payable", type: "liability", subtype: "accounts_payable", control: "payables" },
  customer_deposits: { code: "2300", name: "Customer Deposits", type: "liability", subtype: "customer_deposits", control: "customer_deposits" },
  vendor_prepayments: { code: "1350", name: "Vendor Prepayments", type: "asset", subtype: "prepaid_expense", control: "vendor_prepayments" },
  undeposited_funds: { code: "1050", name: "Undeposited Funds", type: "asset", subtype: "clearing" },
  payment_clearing: { code: "1060", name: "Payment Processor Clearing", type: "asset", subtype: "clearing" },
  inventory_asset: { code: "1300", name: "Inventory", type: "asset", subtype: "inventory", control: "inventory" },
  cost_of_goods_sold: { code: "5000", name: "Cost of Goods Sold", type: "expense", subtype: "cost_of_goods_sold" },
  inventory_adjustments: { code: "5050", name: "Inventory Shrinkage and Adjustments", type: "expense", subtype: "cost_of_goods_sold" },
  goods_received_not_invoiced: { code: "2050", name: "Goods Received Not Invoiced", type: "liability", subtype: "other_current_liability" },
  purchase_price_variance: { code: "5060", name: "Purchase Price Variance", type: "expense", subtype: "cost_of_goods_sold" },
  sales_tax_payable: { code: "2200", name: "Sales Tax Payable", type: "liability", subtype: "sales_tax_payable" },
  sales_income: { code: "4000", name: "Sales", type: "income", subtype: "operating_income" },
  service_income: { code: "4100", name: "Service Income", type: "income", subtype: "operating_income" },
  shipping_income: { code: "4200", name: "Shipping and Delivery Income", type: "income", subtype: "operating_income" },
  general_expense: { code: "6999", name: "Uncategorized Expense", type: "expense", subtype: "operating_expense" },
  retained_earnings: { code: "3900", name: "Retained Earnings", type: "equity", subtype: "retained_earnings" },
  opening_balance_equity: { code: "3950", name: "Opening Balance Equity", type: "equity", subtype: "opening_balance_equity" },
  owner_contributions: { code: "3100", name: "Owner Contributions", type: "equity", subtype: "owner_contributions" },
  owner_draws: { code: "3200", name: "Owner Draws", type: "equity", subtype: "owner_draws" },
  realized_fx: { code: "7100", name: "Realized Exchange Gain/Loss", type: "expense", subtype: "other_expense" },
  unrealized_fx: { code: "7110", name: "Unrealized Exchange Gain/Loss", type: "expense", subtype: "other_expense" },
  rounding: { code: "7190", name: "Rounding Differences", type: "expense", subtype: "other_expense" },
  bad_debt: { code: "6100", name: "Bad Debt", type: "expense", subtype: "operating_expense" },
  payment_fees: { code: "6150", name: "Payment Processing Fees", type: "expense", subtype: "operating_expense" },
  reconciliation_discrepancies: { code: "6990", name: "Reconciliation Discrepancies", type: "expense", subtype: "other_expense" },
  fixed_assets: { code: "1500", name: "Equipment", type: "asset", subtype: "fixed_asset", control: "fixed_assets" },
  accumulated_depreciation: { code: "1590", name: "Accumulated Depreciation", type: "asset", subtype: "accumulated_depreciation", control: "fixed_assets" },
  depreciation_expense: { code: "6600", name: "Depreciation", type: "expense", subtype: "depreciation_expense" },
  asset_disposal_gain_loss: { code: "7200", name: "Gain/Loss on Disposal of Assets", type: "expense", subtype: "other_expense" },
  wages_expense: { code: "6400", name: "Wages and Salaries", type: "expense", subtype: "payroll_expense" },
  payroll_tax_expense: { code: "6410", name: "Payroll Taxes", type: "expense", subtype: "payroll_expense" },
  benefits_expense: { code: "6420", name: "Employee Benefits", type: "expense", subtype: "payroll_expense" },
  payroll_liabilities: { code: "2400", name: "Payroll Liabilities", type: "liability", subtype: "payroll_liability" },
  net_pay_clearing: { code: "2410", name: "Net Pay Clearing", type: "liability", subtype: "payroll_liability" },
  intercompany_receivable: { code: "1400", name: "Due from Related Entities", type: "asset", subtype: "other_current_asset" },
  intercompany_payable: { code: "2500", name: "Due to Related Entities", type: "liability", subtype: "other_current_liability" },
  net_assets_without_restrictions: { code: "3700", name: "Net Assets Without Donor Restrictions", type: "equity", subtype: "net_assets_unrestricted" },
  net_assets_with_restrictions: { code: "3750", name: "Net Assets With Donor Restrictions", type: "equity", subtype: "net_assets_restricted" },
  trust_principal: { code: "3600", name: "Trust Principal", type: "equity", subtype: "trust_principal" },
  trust_income: { code: "3650", name: "Undistributed Trust Income", type: "equity", subtype: "trust_income" },
  distributions: { code: "3660", name: "Distributions to Beneficiaries", type: "equity", subtype: "owner_draws" },
};

function sys(key: SystemKey, overrides: Partial<AccountSpec> = {}): AccountSpec {
  return { ...SYSTEM_ACCOUNT_DEFAULTS[key], systemKey: key, ...overrides };
}

const CORE: AccountSpec[] = [
  { code: "1000", name: "Checking", type: "asset", subtype: "bank" },
  { code: "1010", name: "Savings", type: "asset", subtype: "bank" },
  { code: "1020", name: "Petty Cash", type: "asset", subtype: "cash" },
  sys("undeposited_funds"),
  sys("payment_clearing"),
  sys("accounts_receivable"),
  { code: "1340", name: "Prepaid Expenses", type: "asset", subtype: "prepaid_expense" },
  sys("vendor_prepayments"),
  sys("fixed_assets"),
  sys("accumulated_depreciation"),
  sys("accounts_payable"),
  { code: "2100", name: "Credit Card", type: "liability", subtype: "credit_card" },
  sys("sales_tax_payable"),
  sys("customer_deposits"),
  sys("payroll_liabilities"),
  sys("net_pay_clearing"),
  { code: "2700", name: "Loans Payable", type: "liability", subtype: "long_term_liability" },
  sys("owner_contributions"),
  sys("owner_draws"),
  sys("retained_earnings"),
  sys("opening_balance_equity"),
  sys("service_income"),
  { code: "4900", name: "Interest Income", type: "income", subtype: "other_income" },
  { code: "6000", name: "Advertising and Marketing", type: "expense", subtype: "operating_expense" },
  sys("bad_debt"),
  sys("payment_fees"),
  { code: "6200", name: "Insurance", type: "expense", subtype: "operating_expense" },
  { code: "6250", name: "Interest Expense", type: "expense", subtype: "other_expense" },
  { code: "6300", name: "Legal and Professional Fees", type: "expense", subtype: "operating_expense" },
  { code: "6350", name: "Meals", type: "expense", subtype: "operating_expense" },
  sys("wages_expense"),
  sys("payroll_tax_expense"),
  sys("benefits_expense"),
  { code: "6450", name: "Contract Labor", type: "expense", subtype: "operating_expense" },
  { code: "6500", name: "Office Supplies and Software", type: "expense", subtype: "operating_expense" },
  { code: "6550", name: "Rent", type: "expense", subtype: "operating_expense" },
  sys("depreciation_expense"),
  { code: "6650", name: "Repairs and Maintenance", type: "expense", subtype: "operating_expense" },
  { code: "6700", name: "Taxes and Licenses", type: "expense", subtype: "operating_expense" },
  { code: "6750", name: "Travel", type: "expense", subtype: "operating_expense" },
  { code: "6800", name: "Utilities", type: "expense", subtype: "operating_expense" },
  { code: "6850", name: "Vehicle Expenses", type: "expense", subtype: "operating_expense" },
  { code: "6900", name: "Bank Charges", type: "expense", subtype: "operating_expense" },
  sys("reconciliation_discrepancies"),
  sys("general_expense"),
  sys("realized_fx"),
  sys("unrealized_fx"),
  sys("rounding"),
  sys("asset_disposal_gain_loss"),
];

const INVENTORY: AccountSpec[] = [
  sys("inventory_asset"),
  sys("goods_received_not_invoiced"),
  sys("sales_income"),
  sys("shipping_income"),
  sys("cost_of_goods_sold"),
  sys("inventory_adjustments"),
  sys("purchase_price_variance"),
];

export interface CoaTemplate {
  key: string;
  name: string;
  description: string;
  accounts: AccountSpec[];
}

export const COA_TEMPLATES: CoaTemplate[] = [
  {
    key: "services",
    name: "Services business",
    description: "Consultants, agencies, trades and professional practices: service income, no inventory.",
    accounts: CORE,
  },
  {
    key: "products",
    name: "Products and inventory",
    description: "Retail, wholesale and makers: everything in Services plus inventory, cost of goods sold and shipping.",
    accounts: [...CORE, ...INVENTORY],
  },
  {
    key: "nonprofit",
    name: "Nonprofit",
    description: "Contributions, grants and program expenses, with net assets with and without donor restrictions. Use funds for restricted gifts.",
    accounts: [
      ...CORE.filter((a) => !["owner_contributions", "owner_draws", "retained_earnings"].includes(a.systemKey ?? "")),
      sys("net_assets_without_restrictions"),
      sys("net_assets_with_restrictions"),
      sys("retained_earnings", { name: "Change in Net Assets (closed)", code: "3900" }),
      { code: "4010", name: "Contributions", type: "income", subtype: "operating_income" },
      { code: "4020", name: "Grants", type: "income", subtype: "operating_income" },
      { code: "4030", name: "Program Service Revenue", type: "income", subtype: "operating_income" },
      { code: "4040", name: "Special Events", type: "income", subtype: "operating_income" },
      { code: "6010", name: "Program Expenses", type: "expense", subtype: "operating_expense" },
      { code: "6020", name: "Management and General", type: "expense", subtype: "operating_expense" },
      { code: "6030", name: "Fundraising", type: "expense", subtype: "operating_expense" },
    ],
  },
  {
    key: "trust",
    name: "Trust or estate",
    description: "Principal and income kept apart, beneficiaries and distributions. Allocation between principal and income is recorded as entered; it is not determined by the software.",
    accounts: [
      { code: "1000", name: "Fiduciary Checking", type: "asset", subtype: "bank" },
      { code: "1100", name: "Brokerage Account", type: "asset", subtype: "other_current_asset" },
      { code: "1600", name: "Real Property", type: "asset", subtype: "fixed_asset" },
      sys("accounts_payable"),
      sys("trust_principal"),
      sys("trust_income"),
      sys("distributions"),
      sys("retained_earnings"),
      sys("opening_balance_equity"),
      { code: "4100", name: "Interest Income", type: "income", subtype: "operating_income" },
      { code: "4200", name: "Dividend Income", type: "income", subtype: "operating_income" },
      { code: "4300", name: "Rental Income", type: "income", subtype: "operating_income" },
      { code: "4400", name: "Capital Gains and Losses", type: "income", subtype: "other_income" },
      { code: "6100", name: "Fiduciary Fees", type: "expense", subtype: "operating_expense" },
      { code: "6200", name: "Legal and Accounting Fees", type: "expense", subtype: "operating_expense" },
      { code: "6300", name: "Property Expenses", type: "expense", subtype: "operating_expense" },
      { code: "6400", name: "Taxes Paid", type: "expense", subtype: "operating_expense" },
      sys("rounding"),
      sys("realized_fx"),
      sys("unrealized_fx"),
      sys("general_expense"),
      sys("reconciliation_discrepancies"),
    ],
  },
];

export function defaultCashFlowSection(type: AccountType, subtype: AccountSubtype): CashFlowSection {
  switch (subtype) {
    case "bank":
    case "cash":
    case "clearing":
      return "cash";
    case "accumulated_depreciation":
      // Depreciation is added back to net income in operating activities.
      return "operating";
    case "fixed_asset":
    case "other_asset":
      return "investing";
    case "long_term_liability":
    case "owner_equity":
    case "owner_contributions":
    case "owner_draws":
    case "trust_principal":
      return "financing";
    case "retained_earnings":
    case "opening_balance_equity":
      return "none";
    default:
      break;
  }
  if (type === "income" || type === "expense") return "operating";
  if (type === "equity") return "financing";
  return "operating";
}

/** Natural sign of an account type: assets and expenses carry debit balances. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}
