/**
 * ISO 4217 currencies and their minor units. The minor units are the
 * precision every amount in that currency is stored and posted at; an amount
 * with more places is refused, never silently rounded.
 */
import { Decimal, type DecimalInput, type RoundingMode } from "./decimal";

export interface CurrencyInfo {
  code: string;
  name: string;
  minorUnits: number;
  symbol: string;
}

// code, name, minor units, symbol
const TABLE: [string, string, number, string][] = [
  ["AED", "UAE Dirham", 2, "د.إ"],
  ["AFN", "Afghani", 2, "؋"],
  ["ALL", "Lek", 2, "L"],
  ["AMD", "Armenian Dram", 2, "֏"],
  ["ANG", "Netherlands Antillean Guilder", 2, "ƒ"],
  ["AOA", "Kwanza", 2, "Kz"],
  ["ARS", "Argentine Peso", 2, "$"],
  ["AUD", "Australian Dollar", 2, "A$"],
  ["AWG", "Aruban Florin", 2, "ƒ"],
  ["AZN", "Azerbaijan Manat", 2, "₼"],
  ["BAM", "Convertible Mark", 2, "KM"],
  ["BBD", "Barbados Dollar", 2, "$"],
  ["BDT", "Taka", 2, "৳"],
  ["BGN", "Bulgarian Lev", 2, "лв"],
  ["BHD", "Bahraini Dinar", 3, "BD"],
  ["BIF", "Burundi Franc", 0, "FBu"],
  ["BMD", "Bermudian Dollar", 2, "$"],
  ["BND", "Brunei Dollar", 2, "$"],
  ["BOB", "Boliviano", 2, "Bs"],
  ["BRL", "Brazilian Real", 2, "R$"],
  ["BSD", "Bahamian Dollar", 2, "$"],
  ["BTN", "Ngultrum", 2, "Nu."],
  ["BWP", "Pula", 2, "P"],
  ["BYN", "Belarusian Ruble", 2, "Br"],
  ["BZD", "Belize Dollar", 2, "$"],
  ["CAD", "Canadian Dollar", 2, "C$"],
  ["CDF", "Congolese Franc", 2, "FC"],
  ["CHF", "Swiss Franc", 2, "CHF"],
  ["CLF", "Unidad de Fomento", 4, "UF"],
  ["CLP", "Chilean Peso", 0, "$"],
  ["CNY", "Yuan Renminbi", 2, "¥"],
  ["COP", "Colombian Peso", 2, "$"],
  ["CRC", "Costa Rican Colon", 2, "₡"],
  ["CUP", "Cuban Peso", 2, "$"],
  ["CVE", "Cabo Verde Escudo", 2, "$"],
  ["CZK", "Czech Koruna", 2, "Kč"],
  ["DJF", "Djibouti Franc", 0, "Fdj"],
  ["DKK", "Danish Krone", 2, "kr"],
  ["DOP", "Dominican Peso", 2, "$"],
  ["DZD", "Algerian Dinar", 2, "دج"],
  ["EGP", "Egyptian Pound", 2, "E£"],
  ["ERN", "Nakfa", 2, "Nfk"],
  ["ETB", "Ethiopian Birr", 2, "Br"],
  ["EUR", "Euro", 2, "€"],
  ["FJD", "Fiji Dollar", 2, "$"],
  ["FKP", "Falkland Islands Pound", 2, "£"],
  ["GBP", "Pound Sterling", 2, "£"],
  ["GEL", "Lari", 2, "₾"],
  ["GHS", "Ghana Cedi", 2, "₵"],
  ["GIP", "Gibraltar Pound", 2, "£"],
  ["GMD", "Dalasi", 2, "D"],
  ["GNF", "Guinean Franc", 0, "FG"],
  ["GTQ", "Quetzal", 2, "Q"],
  ["GYD", "Guyana Dollar", 2, "$"],
  ["HKD", "Hong Kong Dollar", 2, "HK$"],
  ["HNL", "Lempira", 2, "L"],
  ["HTG", "Gourde", 2, "G"],
  ["HUF", "Forint", 2, "Ft"],
  ["IDR", "Rupiah", 2, "Rp"],
  ["ILS", "New Israeli Sheqel", 2, "₪"],
  ["INR", "Indian Rupee", 2, "₹"],
  ["IQD", "Iraqi Dinar", 3, "ع.د"],
  ["IRR", "Iranian Rial", 2, "﷼"],
  ["ISK", "Iceland Krona", 0, "kr"],
  ["JMD", "Jamaican Dollar", 2, "$"],
  ["JOD", "Jordanian Dinar", 3, "JD"],
  ["JPY", "Yen", 0, "¥"],
  ["KES", "Kenyan Shilling", 2, "KSh"],
  ["KGS", "Som", 2, "с"],
  ["KHR", "Riel", 2, "៛"],
  ["KMF", "Comorian Franc", 0, "CF"],
  ["KRW", "Won", 0, "₩"],
  ["KWD", "Kuwaiti Dinar", 3, "KD"],
  ["KYD", "Cayman Islands Dollar", 2, "$"],
  ["KZT", "Tenge", 2, "₸"],
  ["LAK", "Lao Kip", 2, "₭"],
  ["LBP", "Lebanese Pound", 2, "ل.ل"],
  ["LKR", "Sri Lanka Rupee", 2, "Rs"],
  ["LRD", "Liberian Dollar", 2, "$"],
  ["LSL", "Loti", 2, "L"],
  ["LYD", "Libyan Dinar", 3, "LD"],
  ["MAD", "Moroccan Dirham", 2, "DH"],
  ["MDL", "Moldovan Leu", 2, "L"],
  ["MGA", "Malagasy Ariary", 2, "Ar"],
  ["MKD", "Denar", 2, "ден"],
  ["MMK", "Kyat", 2, "K"],
  ["MNT", "Tugrik", 2, "₮"],
  ["MOP", "Pataca", 2, "MOP$"],
  ["MRU", "Ouguiya", 2, "UM"],
  ["MUR", "Mauritius Rupee", 2, "₨"],
  ["MVR", "Rufiyaa", 2, "Rf"],
  ["MWK", "Malawi Kwacha", 2, "MK"],
  ["MXN", "Mexican Peso", 2, "MX$"],
  ["MYR", "Malaysian Ringgit", 2, "RM"],
  ["MZN", "Mozambique Metical", 2, "MT"],
  ["NAD", "Namibia Dollar", 2, "$"],
  ["NGN", "Naira", 2, "₦"],
  ["NIO", "Cordoba Oro", 2, "C$"],
  ["NOK", "Norwegian Krone", 2, "kr"],
  ["NPR", "Nepalese Rupee", 2, "₨"],
  ["NZD", "New Zealand Dollar", 2, "NZ$"],
  ["OMR", "Rial Omani", 3, "﷼"],
  ["PAB", "Balboa", 2, "B/."],
  ["PEN", "Sol", 2, "S/"],
  ["PGK", "Kina", 2, "K"],
  ["PHP", "Philippine Peso", 2, "₱"],
  ["PKR", "Pakistan Rupee", 2, "₨"],
  ["PLN", "Zloty", 2, "zł"],
  ["PYG", "Guarani", 0, "₲"],
  ["QAR", "Qatari Rial", 2, "﷼"],
  ["RON", "Romanian Leu", 2, "lei"],
  ["RSD", "Serbian Dinar", 2, "дин"],
  ["RUB", "Russian Ruble", 2, "₽"],
  ["RWF", "Rwanda Franc", 0, "FRw"],
  ["SAR", "Saudi Riyal", 2, "﷼"],
  ["SBD", "Solomon Islands Dollar", 2, "$"],
  ["SCR", "Seychelles Rupee", 2, "₨"],
  ["SDG", "Sudanese Pound", 2, "£"],
  ["SEK", "Swedish Krona", 2, "kr"],
  ["SGD", "Singapore Dollar", 2, "S$"],
  ["SHP", "Saint Helena Pound", 2, "£"],
  ["SLE", "Leone", 2, "Le"],
  ["SOS", "Somali Shilling", 2, "Sh"],
  ["SRD", "Surinam Dollar", 2, "$"],
  ["SSP", "South Sudanese Pound", 2, "£"],
  ["STN", "Dobra", 2, "Db"],
  ["SVC", "El Salvador Colon", 2, "₡"],
  ["SYP", "Syrian Pound", 2, "£"],
  ["SZL", "Lilangeni", 2, "L"],
  ["THB", "Baht", 2, "฿"],
  ["TJS", "Somoni", 2, "SM"],
  ["TMT", "Turkmenistan New Manat", 2, "m"],
  ["TND", "Tunisian Dinar", 3, "DT"],
  ["TOP", "Pa’anga", 2, "T$"],
  ["TRY", "Turkish Lira", 2, "₺"],
  ["TTD", "Trinidad and Tobago Dollar", 2, "$"],
  ["TWD", "New Taiwan Dollar", 2, "NT$"],
  ["TZS", "Tanzanian Shilling", 2, "TSh"],
  ["UAH", "Hryvnia", 2, "₴"],
  ["UGX", "Uganda Shilling", 0, "USh"],
  ["USD", "US Dollar", 2, "$"],
  ["UYU", "Peso Uruguayo", 2, "$U"],
  ["UZS", "Uzbekistan Sum", 2, "so'm"],
  ["VES", "Bolívar Soberano", 2, "Bs.S"],
  ["VND", "Dong", 0, "₫"],
  ["VUV", "Vatu", 0, "VT"],
  ["WST", "Tala", 2, "WS$"],
  ["XAF", "CFA Franc BEAC", 0, "FCFA"],
  ["XCD", "East Caribbean Dollar", 2, "EC$"],
  ["XOF", "CFA Franc BCEAO", 0, "CFA"],
  ["XPF", "CFP Franc", 0, "₣"],
  ["YER", "Yemeni Rial", 2, "﷼"],
  ["ZAR", "Rand", 2, "R"],
  ["ZMW", "Zambian Kwacha", 2, "ZK"],
  ["ZWG", "Zimbabwe Gold", 2, "ZiG"],
];

export const CURRENCIES: ReadonlyMap<string, CurrencyInfo> = new Map(
  TABLE.map(([code, name, minorUnits, symbol]) => [code, { code, name, minorUnits, symbol }]),
);

export const CURRENCY_CODES: readonly string[] = TABLE.map(([c]) => c);

export function isCurrency(code: string): boolean {
  return CURRENCIES.has(code);
}

export function currencyInfo(code: string): CurrencyInfo {
  const info = CURRENCIES.get(code);
  if (!info) throw new RangeError(`unknown currency ${code}`);
  return info;
}

export function minorUnits(code: string): number {
  return currencyInfo(code).minorUnits;
}

/**
 * The default rounding for amounts: half away from zero at the currency's
 * minor units. Every place an amount is derived (a line total, a tax, a
 * conversion) rounds once, here, with this mode unless the organization has
 * chosen otherwise for that calculation; see docs/accounting/rounding.md.
 */
export const DEFAULT_ROUNDING: RoundingMode = "half_up";

export function roundMoney(v: DecimalInput, currency: string, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
  return Decimal.from(v).round(minorUnits(currency), mode);
}

/** Parse an amount that must already be at the currency's precision. */
export function parseMoney(v: DecimalInput, currency: string): Decimal {
  const d = Decimal.from(v);
  const mu = minorUnits(currency);
  if (d.decimalPlaces > mu) {
    throw new RangeError(`${d.toString()} has more than ${mu} decimal places for ${currency}`);
  }
  return d.rescale(mu);
}

/** Whether an amount fits its currency's minor units without rounding. */
export function fitsCurrency(v: DecimalInput, currency: string): boolean {
  return Decimal.from(v).decimalPlaces <= minorUnits(currency);
}
