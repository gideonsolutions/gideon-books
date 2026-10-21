/**
 * The synthetic accounting dataset (docs/verification.md).
 *
 * Four months (January–April of `year`) of a small products business,
 * "Harbor & Pine Supply": owner contribution and draw, equipment bought on a
 * bill, stock bought at two prices and sold at average cost, a return at
 * original cost, sales tax collected and remitted, a foreign-currency
 * customer with a realized exchange loss and a period-end revaluation, a
 * partial payment, a card payment with a processor fee and its payout, a
 * customer deposit applied to an invoice and partly refunded, a write-off,
 * a stock shrinkage adjustment, an unpaid invoice and unpaid bills at the
 * end, and January and February closed.
 *
 * The expected results are worked out by hand in
 * tests/verification/expected.ts — independently of this code — and the
 * verification test checks the application's figures against them.
 *
 * The demonstration company loads the same data.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Ctx } from "@/lib/context";
import { getDb, withTransaction } from "@/lib/db/client";
import { accounts } from "@/lib/db/schema/ledger";
import { documentLines as docLines } from "@/lib/db/schema/commerce";
import { createContact, listPaymentTerms } from "@/lib/contacts/contacts";
import { createItem } from "@/lib/items/items";
import { addTaxRate, createJurisdiction, saveTaxCode } from "@/lib/tax/config";
import { addManualRate } from "@/lib/fx/rates";
import { postRevaluation, runAutoReversals } from "@/lib/fx/revaluation";
import { postManualEntry } from "@/lib/ledger/journals";
import { issueDocument, saveDraft, writeOffInvoice, type DocumentInput } from "@/lib/commerce/documents";
import { applyCredit, recordPayment } from "@/lib/commerce/payments";
import { recordTaxRemittance } from "@/lib/tax/remittance";
import { closePeriod, ensureFiscalYear, periodFor } from "@/lib/ledger/periods";
import { postEntry } from "@/lib/ledger/posting";
import { issueStock, defaultLocationId } from "@/lib/inventory/stock";
import { systemAccountId } from "@/lib/ledger/accounts";
import { Decimal } from "@/lib/money/decimal";
import { capitalizeAsset, createAsset } from "@/lib/assets/assets";
import { postRun, prepareRun } from "@/lib/assets/depreciation";
import { createImport, postImport } from "@/lib/payroll/imports";
import { recordLiabilityPayment, recordNetPay } from "@/lib/payroll/settlements";
import { commitImport } from "@/lib/banking/imports";
import { categorizeTransaction, matchTransactions, unmatchedLines } from "@/lib/banking/transactions";
import { completeReconciliation, reconciliationLinesFor, setCleared, startReconciliation } from "@/lib/banking/reconcile";
import { bankTransactions } from "@/lib/db/schema/banking";


export interface DatasetRefs {
  year: number;
  contacts: Record<string, string>;
  items: Record<string, string>;
  documents: Record<string, string>;
  payments: Record<string, string>;
}

async function accountId(ctx: Ctx, code: string): Promise<string> {
  const [a] = await getDb()
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, ctx.orgId), eq(accounts.code, code)));
  if (!a) throw new Error(`dataset: no account ${code}`);
  return a.id;
}

export async function loadSyntheticDataset(ctx: Ctx, opts: { year?: number; closePeriods?: boolean } = {}): Promise<DatasetRefs> {
  const Y = opts.year ?? defaultDatasetYear();
  const d = (md: string) => `${Y}-${md}`;
  const refs: DatasetRefs = { year: Y, contacts: {}, items: {}, documents: {}, payments: {} };
  const terms = await listPaymentTerms(getDb(), ctx.orgId);
  const net30 = terms.find((t) => t.daysDue === 30)?.id ?? null;
  const net15 = terms.find((t) => t.daysDue === 15)?.id ?? null;
  await withTransaction((tx) => ensureFiscalYear(tx, ctx.org, d("01-01")));

  const A = {
    checking: await accountId(ctx, "1000"),
    clearing: await accountId(ctx, "1060"),
    equipment: await accountId(ctx, "1500"),
    contributions: await accountId(ctx, "3100"),
    draws: await accountId(ctx, "3200"),
    rent: await accountId(ctx, "6550"),
    office: await accountId(ctx, "6500"),
    service: await accountId(ctx, "4100"),
  };

  // ── Reference data ────────────────────────────────────────────────────────
  const nc = await createJurisdiction(ctx, { name: "North Carolina (demo)", code: "NC" });
  await addTaxRate(ctx, { jurisdictionId: nc.id, name: "State rate", rate: "4.75", effectiveFrom: d("01-01"), sourceNote: "Synthetic demonstration rate" });
  const ncCode = await saveTaxCode(ctx, { name: "NC sales tax", components: [{ jurisdictionId: nc.id }] });

  const c = async (key: string, input: Parameters<typeof createContact>[1]) => {
    refs.contacts[key] = (await createContact(ctx, input)).id;
  };
  await c("bluewater", { displayName: "Bluewater Cafe", isCustomer: true, email: "accounts@bluewater.example", paymentTermsId: net30 });
  await c("maison", { displayName: "Maison Laurent SARL", isCustomer: true, currency: "EUR", email: "compta@maison-laurent.example", paymentTermsId: net30 });
  await c("harborview", { displayName: "Harborview Hotel", isCustomer: true, email: "ap@harborview.example", paymentTermsId: net30 });
  await c("gullpoint", { displayName: "Gull Point Marina", isCustomer: true, paymentTermsId: net15 });
  await c("coastal", { displayName: "Coastal Equipment Co.", isVendor: true });
  await c("northwind", { displayName: "Northwind Wholesale", isVendor: true, paymentTermsId: net30, is1099: false });
  await c("pacific", { displayName: "Pacific Office Supply", isVendor: true, paymentTermsId: net30 });
  await c("landlord", { displayName: "Harbor Properties LLC", isVendor: true });

  refs.items.widget = (await createItem(ctx, { kind: "stock", name: "Widget", sku: "WID-1", salePrice: "20.00", purchaseCost: "8.00", saleTaxCodeId: ncCode.id })).id;
  refs.items.consulting = (await createItem(ctx, { kind: "service", name: "Consulting", salePrice: "1000.00", incomeAccountId: A.service })).id;

  await addManualRate(ctx, { currency: "EUR", rateDate: d("02-03"), rate: "1.10", note: "Synthetic demonstration rate" });
  await addManualRate(ctx, { currency: "EUR", rateDate: d("02-28"), rate: "1.08", note: "Synthetic demonstration rate" });

  const issue = async (key: string, input: DocumentInput) => {
    const draft = await saveDraft(ctx, input);
    refs.documents[key] = (await issueDocument(ctx, draft.id)).id;
    return refs.documents[key]!;
  };
  const pay = async (key: string, input: Parameters<typeof recordPayment>[1]) => {
    refs.payments[key] = (await recordPayment(ctx, input)).id;
    return refs.payments[key]!;
  };

  // ── January ───────────────────────────────────────────────────────────────
  await postManualEntry(ctx, {
    entryDate: d("01-02"),
    description: "Owner's opening capital contribution",
    lines: [
      { accountId: A.checking, debit: "50000.00" },
      { accountId: A.contributions, credit: "50000.00" },
    ],
  });
  await issue("B1", { kind: "bill", contactId: refs.contacts.coastal!, issueDate: d("01-03"), reference: "CE-5512", lines: [{ description: "Delivery van shelving and forklift", quantity: "1", unitPrice: "12000.00", accountId: A.equipment }] });
  await issue("B2", { kind: "bill", contactId: refs.contacts.northwind!, issueDate: d("01-05"), reference: "NW-1001", lines: [{ itemId: refs.items.widget!, quantity: "100", unitPrice: "8.00" }] });
  const [b1Line] = await getDb().select().from(docLines).where(and(eq(docLines.orgId, ctx.orgId), eq(docLines.documentId, refs.documents.B1!)));
  const asset = await createAsset(ctx, {
    name: "Warehouse shelving and forklift",
    category: "Equipment",
    acquisitionDate: d("01-03"),
    inServiceDate: d("01-03"),
    cost: "12000.00",
    residualValue: "0",
    usefulLifeMonths: 60,
    method: "straight_line",
    acquisitionType: "document_line",
    sourceDocumentLineId: b1Line!.id,
  });
  await capitalizeAsset(ctx, asset.id);
  refs.documents.ASSET = asset.id;
  await pay("VP1", { kind: "vendor_payment", contactId: refs.contacts.coastal!, paymentDate: d("01-15"), accountId: A.checking, amount: "12000.00", method: "check", reference: "1001", allocations: [{ itemType: "document", itemId: refs.documents.B1!, amount: "12000.00" }] });
  await issue("B3", { kind: "bill", contactId: refs.contacts.northwind!, issueDate: d("01-20"), reference: "NW-1009", lines: [{ itemId: refs.items.widget!, quantity: "50", unitPrice: "11.00" }] });
  await issue("INV1", { kind: "invoice", contactId: refs.contacts.bluewater!, issueDate: d("01-25"), lines: [{ itemId: refs.items.widget!, quantity: "40", unitPrice: "20.00", taxCodeId: ncCode.id }] });
  for (const md of ["01-31", "02-28", "03-31", "04-30"]) {
    await issue(`RENT-${md}`, { kind: "expense", contactId: refs.contacts.landlord!, issueDate: d(md), cashAccountId: A.checking, reference: `Rent ${md.slice(0, 2)}`, lines: [{ description: "Warehouse rent", quantity: "1", unitPrice: "1500.00", accountId: A.rent }] });
  }

  // ── February ──────────────────────────────────────────────────────────────
  await issue("INV2", { kind: "invoice", contactId: refs.contacts.maison!, issueDate: d("02-03"), lines: [{ itemId: refs.items.consulting!, quantity: "1", unitPrice: "1000.00" }] });
  await pay("CP1", { kind: "customer_payment", contactId: refs.contacts.bluewater!, paymentDate: d("02-10"), accountId: A.checking, amount: "500.00", method: "check", allocations: [{ itemType: "document", itemId: refs.documents.INV1!, amount: "500.00" }] });
  const [inv1Line] = await getDb().select().from(docLines).where(and(eq(docLines.orgId, ctx.orgId), eq(docLines.documentId, refs.documents.INV1!)));
  await issue("CN1", { kind: "credit_note", contactId: refs.contacts.bluewater!, issueDate: d("02-15"), sourceDocumentId: refs.documents.INV1!, lines: [{ itemId: refs.items.widget!, quantity: "5", unitPrice: "20.00", taxCodeId: ncCode.id, returnOfLineId: inv1Line!.id }] });
  await applyCredit(ctx, { debit: { type: "document", id: refs.documents.INV1! }, credit: { type: "document", id: refs.documents.CN1! }, amount: "104.75", date: d("02-15") });
  await issue("INV5", { kind: "invoice", contactId: refs.contacts.gullpoint!, issueDate: d("02-20"), lines: [{ description: "Dock inventory count", quantity: "1", unitPrice: "150.00", accountId: A.service }] });
  await pay("VP2", {
    kind: "vendor_payment",
    contactId: refs.contacts.northwind!,
    paymentDate: d("02-26"),
    accountId: A.checking,
    amount: "1100.00",
    method: "ach",
    allocations: [
      { itemType: "document", itemId: refs.documents.B2!, amount: "800.00" },
      { itemType: "document", itemId: refs.documents.B3!, amount: "300.00" },
    ],
  });
  await postRevaluation(ctx, d("02-28"));

  // ── March ─────────────────────────────────────────────────────────────────
  await runAutoReversals(ctx.orgId, d("03-01"));
  await pay("CP2", { kind: "customer_payment", contactId: refs.contacts.maison!, paymentDate: d("03-05"), accountId: A.checking, currency: "EUR", amount: "1000.00", accountAmount: "1050.00", method: "wire", allocations: [{ itemType: "document", itemId: refs.documents.INV2!, amount: "1000.00" }] });
  await pay("CP3", { kind: "customer_payment", contactId: refs.contacts.bluewater!, paymentDate: d("03-10"), accountId: A.clearing, amount: "233.25", feeAmount: "7.06", method: "card", allocations: [{ itemType: "document", itemId: refs.documents.INV1!, amount: "233.25" }] });
  await postManualEntry(ctx, {
    entryDate: d("03-12"),
    description: "Card processor payout",
    lines: [
      { accountId: A.checking, debit: "226.19" },
      { accountId: A.clearing, credit: "226.19" },
    ],
  });
  await pay("DEP1", { kind: "customer_deposit", contactId: refs.contacts.harborview!, paymentDate: d("03-15"), accountId: A.checking, amount: "1000.00", method: "check" });
  await recordTaxRemittance(ctx, { jurisdictionId: nc.id, date: d("03-20"), amount: "33.25", paidFromAccountId: A.checking, periodStart: d("01-01"), periodEnd: d("02-28"), reference: "NC-E500 Jan–Feb" });
  await issue("INV3", { kind: "invoice", contactId: refs.contacts.harborview!, issueDate: d("03-25"), lines: [{ itemId: refs.items.widget!, quantity: "30", unitPrice: "22.00", taxCodeId: ncCode.id }] });
  await applyCredit(ctx, { debit: { type: "document", id: refs.documents.INV3! }, credit: { type: "payment", id: refs.payments.DEP1! }, amount: "691.35", date: d("03-25") });
  await postManualEntry(ctx, {
    entryDate: d("03-31"),
    description: "Owner's draw",
    lines: [
      { accountId: A.draws, debit: "2000.00" },
      { accountId: A.checking, credit: "2000.00" },
    ],
  });

  await payrollRun(ctx, d, A.checking);

  // ── April ─────────────────────────────────────────────────────────────────
  await issue("B4", { kind: "bill", contactId: refs.contacts.pacific!, issueDate: d("04-02"), reference: "POS-77", lines: [{ description: "Office supplies", quantity: "1", unitPrice: "240.00", accountId: A.office }] });
  await issue("INV4", { kind: "invoice", contactId: refs.contacts.bluewater!, issueDate: d("04-10"), lines: [{ itemId: refs.items.widget!, quantity: "10", unitPrice: "20.00", taxCodeId: ncCode.id }] });
  await shrinkage(ctx, refs.items.widget!, d("04-15"), "2", "Annual count: two damaged widgets");
  await pay("RF1", { kind: "customer_refund", contactId: refs.contacts.harborview!, paymentDate: d("04-25"), accountId: A.checking, amount: "108.65", method: "check", allocations: [{ itemType: "payment", itemId: refs.payments.DEP1!, amount: "108.65" }] });
  await writeOffInvoice(ctx, refs.documents.INV5!, { date: d("04-30"), reason: "Customer closed for the season; not collectible" });

  // Depreciation, January to April (straight line, 12,000 over 60 months = 200 a month).
  for (const md of ["01-31", "02-28", "03-31", "04-30"]) {
    const run = await prepareRun(ctx, d(md));
    await postRun(ctx, run.id);
  }

  await bankStatement(ctx, d, A.checking);

  if (opts.closePeriods !== false) {
    for (const md of ["01-15", "02-15"]) {
      const p = await periodFor(getDb(), ctx.orgId, d(md));
      if (p && p.status === "open") await closePeriod(ctx, p.id, { reason: "Month-end close (synthetic dataset)", acknowledgeWarnings: true });
    }
  }
  return refs;
}

/**
 * One payroll run (March), imported in the documented generic CSV format:
 * gross 3,000.00; withholdings 300.00 + 186.00 + 43.50 = 529.50; employer
 * taxes 186.00 + 43.50 + 18.00 = 247.50; net pay 2,470.50 — paid the same day,
 * and the 777.00 of liabilities remitted on 04-15.
 */
async function payrollRun(ctx: Ctx, d: (md: string) => string, checking: string) {
  const csv = [
    "run_id,pay_date,period_start,period_end,employee_id,employee_name,gross:regular,withholding:federal_income_tax,withholding:social_security,withholding:medicare,employer_tax:social_security,employer_tax:medicare,employer_tax:futa,net_pay",
    `HP-${d("03-31").slice(0, 7)},${d("03-31")},${d("03-01")},${d("03-31")},E1,Robin Park,3000.00,300.00,186.00,43.50,186.00,43.50,18.00,2470.50`,
  ].join("\n");
  const imp = await createImport(ctx, { adapter: "generic_csv", fileName: "payroll-march.csv", content: csv });
  const run = await postImport(ctx, imp.id);
  await recordNetPay(ctx, run.id, { date: d("03-31"), bankAccountId: checking, reference: "Direct deposit batch" });
  await recordLiabilityPayment(ctx, { runId: run.id, liabilityAccountId: await systemAccountIdFor(ctx, "payroll_liabilities"), date: d("04-15"), bankAccountId: checking, amount: "777.00", reference: "EFTPS" });
}

async function systemAccountIdFor(ctx: Ctx, key: Parameters<typeof systemAccountId>[2]) {
  return withTransaction((tx) => systemAccountId(tx, ctx.orgId, key));
}

/**
 * April's bank statement for checking: imported as CSV, every transaction
 * matched to what is already in the books except a 25.00 service fee, which
 * is categorized; then the account is reconciled through 04-30.
 */
async function bankStatement(ctx: Ctx, d: (md: string) => string, checking: string) {
  const lines = await unmatchedLines(getDb(), ctx, checking, { from: d("04-01"), to: d("04-30"), limit: 100 });
  const rows = ["Date,Description,Amount"];
  for (const l of lines) rows.push(`${l.entryDate},"${(l.description ?? "Transaction").replace(/"/g, "'")}",${Decimal.from(l.amount).toFixed(2)}`);
  rows.push(`${d("04-30")},Monthly service fee,-25.00`);
  const batch = await commitImport(ctx, {
    accountId: checking,
    fileName: "checking-april.csv",
    text: rows.join("\n"),
    mapping: {
      delimiter: ",",
      hasHeader: true,
      skipRows: 0,
      dateColumn: 0,
      dateFormat: "YYYY-MM-DD",
      descriptionColumn: 1,
      amountMode: "single",
      amountColumn: 2,
      debitColumn: null,
      creditColumn: null,
      invertSign: false,
      decimalComma: false,
      payeeColumn: null,
      referenceColumn: null,
      balanceColumn: null,
    },
  });
  const txns = await getDb().select().from(bankTransactions).where(and(eq(bankTransactions.orgId, ctx.orgId), eq(bankTransactions.batchId, batch.id)));
  for (const t of txns) {
    if (t.description === "Monthly service fee") {
      await categorizeTransaction(ctx, t.id, { splits: [{ accountId: await accountId(ctx, "6900"), amount: "25.00", description: "Bank service fee" }] });
      continue;
    }
    const line = lines.find((l) => l.entryDate === t.postedDate && Decimal.from(l.amount).eq(t.amount));
    if (line) {
      lines.splice(lines.indexOf(line), 1);
      await matchTransactions(ctx, { bankTransactionIds: [t.id], journalLineIds: [line.lineId] });
    }
  }
  // Reconcile everything through April 30 at the book balance.
  const r = await getDb().execute<{ b: string }>(sql`
    select coalesce(sum(l.base_amount), 0)::text as b from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id
    where l.org_id = ${ctx.orgId} and l.account_id = ${checking} and e.status = 'posted' and e.entry_date <= ${d("04-30")}`);
  const rec = await startReconciliation(ctx, { accountId: checking, statementDate: d("04-30"), statementBalance: Decimal.from(r.rows[0]!.b).toFixed(2) });
  const recLines = await reconciliationLinesFor(getDb(), ctx, rec);
  await setCleared(ctx, rec.id, recLines.map((l) => l.lineId));
  await completeReconciliation(ctx, rec.id);
}

/** Stock shrinkage: issue at average cost against inventory adjustments. */
async function shrinkage(ctx: Ctx, itemId: string, date: string, qty: string, reason: string) {
  await withTransaction(async (tx) => {
    const loc = await defaultLocationId(tx, ctx);
    const move = await issueStock(tx, ctx, { itemId, locationId: loc, date, quantity: qty, kind: "adjustment", source: { sourceType: "stock_adjustment", reason } });
    const value = Decimal.from(move.value).neg();
    const inv = await systemAccountId(tx, ctx.orgId, "inventory_asset");
    const adj = await systemAccountId(tx, ctx.orgId, "inventory_adjustments");
    await postEntry(tx, ctx, {
      kind: "inventory",
      entryDate: date,
      description: reason,
      sourceType: "stock_adjustment",
      sourceId: move.id,
      allowControlAccounts: true,
      lines: [
        { accountId: adj, amount: value.toString(), itemId, quantity: qty, description: reason },
        { accountId: inv, amount: value.neg().toString(), itemId, quantity: Decimal.from(qty).neg().toString(), description: reason },
      ],
    });
  });
}

/** The most recent January–April that is fully in the past. */
export function defaultDatasetYear(now: Date = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 4 ? y : y - 1;
}


