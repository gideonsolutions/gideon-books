/** Where a record lives in the application, for links from entries, reports and the audit log. */
export function sourceHref(base: string, sourceType: string | null | undefined, sourceId: string | null | undefined, kind?: string | null): string | null {
  if (!sourceType || !sourceId) return null;
  switch (sourceType) {
    case "document":
      return `${base}/documents/${sourceId}`;
    case "payment":
      return `${base}/payments/${sourceId}`;
    case "settlement":
      return `${base}/settlements/${sourceId}`;
    case "bank_transaction":
      return `${base}/banking/transactions/${sourceId}`;
    case "reconciliation":
      return `${base}/banking/reconciliations/${sourceId}`;
    case "asset":
    case "asset_disposal":
      return `${base}/assets/${sourceId}`;
    case "depreciation_run":
      return `${base}/assets/depreciation/${sourceId}`;
    case "payroll_run":
      return `${base}/payroll/${sourceId}`;
    case "purchase_receipt":
      return `${base}/purchases/goods-received/${sourceId}`;
    case "stock_adjustment":
    case "stock_transfer":
      return `${base}/inventory/movements/${sourceId}`;
    case "sales_tax_remittance":
    case "sales_tax_adjustment":
      return `${base}/accounting/sales-tax`;
    case "journal_entry":
      return `${base}/accounting/journal/${sourceId}`;
    default:
      void kind;
      return null;
  }
}
