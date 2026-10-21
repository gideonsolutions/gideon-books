# Money, precision and rounding

## Exact decimals

Amounts are exact decimals end to end: `numeric` columns in PostgreSQL,
strings in transit and in JSON, and `Decimal` (`lib/money/decimal.ts`, a
BigInt with a scale) in code — in the browser too, so a form shows exactly
what the server will post. A JavaScript `number` is never used for an amount;
`Decimal.from` refuses non-integer numbers.

## Precision

Each currency has its ISO 4217 minor units (USD 2, JPY 0, BHD 3, CLF 4). An
amount entered or posted with more places than its currency allows is
**refused**, not rounded. Unit prices (8 places), quantities (6), exchange
rates (12) and tax rates (8) carry more precision; amounts derived from them
are rounded once, as below.

## Where rounding happens, and how

All rounding is **half away from zero** ("half-up": 2.345 → 2.35, −2.345 →
−2.35) at the currency's minor units, unless stated.

| Calculation | Rule |
|---|---|
| Line amount | quantity × unit price, rounded once |
| Line discount | line amount × discount rate, rounded once; the net is the difference |
| Document discount | percent of the eligible lines (rounded once) or a fixed amount, spread over item lines by **largest remainder**, so the shares add up to the discount exactly |
| Sales tax, per-line rounding (default) | each component on each line rounded once; compound components tax the net plus the *rounded* taxes before them |
| Sales tax, per-document rounding | each rate's exact tax summed over the document, rounded once, spread back to lines by largest remainder |
| Tax-inclusive prices | net = gross ÷ (1 + effective rate), rounded; taxes computed on that net; the net absorbs the difference so net + tax = the price |
| Currency conversion | each line's foreign amount × rate, rounded per line; a conversion difference (at most half a minor unit per converted line) posts to **Rounding Differences** |
| Document totals | sums of the rounded lines, so documents always foot |
| Partial settlement of a foreign item | base relieved = carried base × amount ÷ open amount, rounded; the final settlement relieves exactly what remains |
| Cash-basis recognition | pro rata, rounded, remainder on the largest line; the settlement that clears a document recognizes exactly what remains |
| Inventory issue | total value × quantity issued ÷ quantity on hand, rounded; issuing the last unit takes all remaining value |
| Allocation (splits, discounts) | largest remainder: parts always sum to the whole |

The organization chooses per-line or per-document tax rounding under
Settings (use what the taxing authority requires).
