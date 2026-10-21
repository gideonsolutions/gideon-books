/**
 * Expected results of the synthetic dataset (lib/demo/dataset.ts), worked
 * out by hand from the transactions — not by running the application. Each
 * figure shows its arithmetic. Account codes are the "products" template's.
 *
 * Transactions (year Y):
 *  T1  01-02 owner contribution 50,000.00 (Dr 1000 / Cr 3100)
 *  T2  01-03 bill B1 equipment 12,000.00 (Dr 1500 / Cr 2000)
 *  T3  01-05 bill B2 100 widgets @ 8.00 = 800.00 (Dr 1300 / Cr 2000); stock 100 @ 8.00
 *  T4  01-15 pay B1 12,000.00 from 1000
 *  T5  01-20 bill B3 50 widgets @ 11.00 = 550.00; stock 150 units, 1,350.00, average 9.00
 *  T6  01-25 INV1 40 widgets @ 20.00 = 800.00 + 4.75% tax 38.00 = 838.00; COGS 40 × 9.00 = 360.00;
 *          stock 110 units, 990.00
 *  T7  rent 1,500.00 paid from 1000 on 01-31, 02-28, 03-31, 04-30 = 6,000.00
 *  T8  02-03 INV2 Maison €1,000.00 at 1.10 = 1,100.00 service income
 *  T9  02-10 Bluewater pays 500.00 on INV1 (open 338.00)
 *  T10 02-15 CN1 return 5 widgets @ 20.00 = 100.00 + tax 4.75 = 104.75, applied to INV1 (open 233.25);
 *          stock back at original cost 5 × 9.00 = 45.00 → 115 units, 1,035.00
 *  T11 02-20 INV5 Gull Point 150.00 service
 *  T12 02-26 pay Northwind 1,100.00: B2 800.00 + B3 300.00 (B3 open 250.00)
 *  T13 02-28 revalue €1,000 at 1.08 = 1,080.00: AR −20.00, unrealized FX +20.00; reversed 03-01
 *  T14 03-05 Maison pays €1,000.00, 1,050.00 received (rate 1.05); invoice carried at 1,100.00 →
 *          realized FX loss 50.00
 *  T15 03-10 Bluewater pays 233.25 by card into 1060 with fee 7.06 (1060 +226.19, 6150 +7.06)
 *  T16 03-12 payout 226.19 from 1060 to 1000
 *  T17 03-15 Harborview deposit 1,000.00 into 1000 (Cr 2300)
 *  T18 03-20 sales tax remitted 33.25 (= 38.00 − 4.75) from 1000
 *  T19 03-25 INV3 30 widgets @ 22.00 = 660.00 + tax 31.35 = 691.35; COGS 30 × 9.00 = 270.00
 *          (stock 85 units, 765.00); deposit applied 691.35 (deposit open 308.65)
 *  T20 03-31 owner draw 2,000.00
 *  T21 04-02 bill B4 office supplies 240.00 (unpaid)
 *  T22 04-10 INV4 10 widgets @ 20.00 = 200.00 + tax 9.50 = 209.50 (unpaid); COGS 90.00 → 75 units, 675.00
 *  T23 04-15 shrinkage 2 widgets × 9.00 = 18.00 → 73 units, 657.00
 *  T24 04-25 refund 108.65 of Harborview's deposit (deposit open 200.00)
 *  T25 04-30 write off INV5 150.00 to bad debt
 *  T26 the equipment (B1) is registered as an asset: straight line, 60 months, no residual value,
 *          full month in the in-service month → 200.00 a month, January–April 800.00 (Dr 6600 / Cr 1590)
 *  T27 03-31 payroll: gross 3,000.00 (Dr 6400); employer taxes 186.00 + 43.50 + 18.00 = 247.50 (Dr 6410);
 *          withholdings 300.00 + 186.00 + 43.50 = 529.50; liabilities 529.50 + 247.50 = 777.00 (Cr 2400);
 *          net pay 2,470.50 (Cr 2410), paid from 1000 the same day; 777.00 remitted from 1000 on 04-15
 *  T28 April statement imported for 1000: everything matches the books except a 25.00 service fee,
 *          categorized to 6900; 1000 reconciled through 04-30
 *  January and February closed.
 */

export const EXPECTED_ACCRUAL_BALANCES: Record<string, string> = {
  // 50,000 − 12,000 − 6,000 + 500 − 1,100 + 1,050 + 226.19 + 1,000 − 33.25 − 2,000 − 108.65 − 2,470.50 − 777.00 − 25.00
  "1000": "28261.79",
  // +226.19 − 226.19
  "1060": "0.00",
  // 838 + 1,100 − 500 − 104.75 − 20 + 20 − 1,100 − 233.25 + 691.35 − 691.35 + 209.50 + 150 − 150 = INV4 open
  "1200": "209.50",
  // 800 + 550 − 360 + 45 − 270 − 90 − 18
  "1300": "657.00",
  "1500": "12000.00",
  // 4 × 200.00
  "1590": "-800.00",
  // −12,000 + 12,000 − 800 − 550 + 1,100 − 240 = −(B3 250 + B4 240)
  "2000": "-490.00",
  // −38 + 4.75 + 33.25 − 31.35 − 9.50
  "2200": "-40.85",
  // −1,000 + 691.35 + 108.65
  "2300": "-200.00",
  "3100": "-50000.00",
  "3200": "2000.00",
  // −800 + 100 − 660 − 200
  "4000": "-1560.00",
  // −1,100 − 150
  "4100": "-1250.00",
  // 360 − 45 + 270 + 90
  "5000": "675.00",
  "5050": "18.00",
  "6100": "150.00",
  "6150": "7.06",
  "6400": "3000.00",
  "6410": "247.50",
  "6500": "240.00",
  "6550": "6000.00",
  "6600": "800.00",
  "6900": "25.00",
  "7100": "50.00",
  // +20 − 20
  "7110": "0.00",
  // 777.00 accrued, 777.00 remitted
  "2400": "0.00",
  // 2,470.50 accrued, 2,470.50 paid
  "2410": "0.00",
};

/** Income − expenses: (1,560 + 1,250) − (675 + 18 + 150 + 7.06 + 3,000 + 247.50 + 240 + 6,000 + 800 + 25 + 50) */
export const EXPECTED_NET_INCOME_ACCRUAL = "-8402.56";

/**
 * Cash basis (docs/accounting/cash-basis.md): a document is recognized as cash
 * settles it; a settlement between two documents (a credit note or write-off
 * applied to an invoice) moves no cash and is left out.
 *  - INV1: cash 500.00 and 233.25 settle it (the credit note's 104.75 is not cash) → sales −700.00, tax −33.25
 *  - INV2 settled by cash → service −1,100; realized FX 50 as posted
 *  - INV3 settled by the deposit (cash received earlier) → sales −660, tax −31.35
 *  - INV4 unpaid → nothing
 *  - INV5 settled only by the write-off → nothing (no income, no bad debt)
 *  - B1 paid → equipment 12,000 (balance sheet); B2 paid → inventory 800; B3 paid 300 of 550 → inventory 300; B4 unpaid → nothing
 *  - stock movements, rent, fees, owner equity, deposits and refunds as posted
 *  - payroll, depreciation and the categorized bank fee as posted
 */
export const EXPECTED_CASH_BALANCES: Record<string, string> = {
  "1000": "28261.79",
  "1060": "0.00",
  // receivables do not exist on the cash basis; payment-side items are fully applied
  "1200": "0.00",
  // 800 + 300 recognized purchases − 360 + 45 − 270 − 90 − 18 (= accrual 657 − unpaid 250)
  "1300": "407.00",
  "1500": "12000.00",
  "1590": "-800.00",
  "2000": "0.00",
  // −38 + 4.75 + 33.25 − 31.35 (INV4's 9.50 not yet received)
  "2200": "-31.35",
  "2300": "-200.00",
  "3100": "-50000.00",
  "3200": "2000.00",
  // −700 − 660
  "4000": "-1360.00",
  // INV2 only
  "4100": "-1100.00",
  "5000": "675.00",
  "5050": "18.00",
  "6100": "0.00",
  "6150": "7.06",
  "6400": "3000.00",
  "6410": "247.50",
  "6500": "0.00",
  "6550": "6000.00",
  "6600": "800.00",
  "6900": "25.00",
  "7100": "50.00",
  "7110": "0.00",
  "2400": "0.00",
  "2410": "0.00",
};

/** (1,360 + 1,100) − (675 + 18 + 7.06 + 3,000 + 247.50 + 6,000 + 800 + 25 + 50) */
export const EXPECTED_NET_INCOME_CASH = "-8362.56";

export const EXPECTED_INVENTORY = { widgetQty: "73", widgetValue: "657.00" };

export const EXPECTED_OPEN_ITEMS = {
  /** Bluewater: INV4 209.50 */
  receivables: [{ contact: "bluewater", amount: "209.50" }],
  /** Northwind: B3 250.00; Pacific: B4 240.00 */
  payables: [
    { contact: "northwind", amount: "250.00" },
    { contact: "pacific", amount: "240.00" },
  ],
  /** Harborview's deposit: 1,000 − 691.35 applied − 108.65 refunded */
  deposits: [{ contact: "harborview", amount: "200.00" }],
};

export const EXPECTED_SALES_TAX = {
  /** 800 − 100 + 660 + 200 */
  taxableSales: "1560.00",
  /** 38 − 4.75 + 31.35 + 9.50 */
  taxCollected: "74.10",
  remitted: "33.25",
  /** 74.10 − 33.25 */
  owing: "40.85",
};
