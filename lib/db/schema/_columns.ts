/**
 * Column helpers shared by every schema file.
 *
 * Amounts are Postgres numerics read and written as strings; they become
 * Decimals in code (lib/money/decimal.ts) and never pass through a float.
 *
 * Every organization-owned table has `org_id`, and every reference from one
 * organization-owned row to another is a composite foreign key on
 * (org_id, id). The database itself therefore refuses a row that points into
 * another organization — the application's own scoping is the first check,
 * not the only one. `tests/db/tenancy.test.ts` fails if a table breaks this.
 */
import { numeric, timestamp, uuid, date, text } from "drizzle-orm/pg-core";

/** A monetary amount: up to 4 decimal places (the largest ISO minor units). */
export const money = (name: string) => numeric(name, { precision: 24, scale: 4 });
/** A unit price or unit cost, which may carry more places than the currency. */
export const unitAmount = (name: string) => numeric(name, { precision: 28, scale: 8 });
/** A quantity. */
export const quantity = (name: string) => numeric(name, { precision: 20, scale: 6 });
/** An exchange rate: base-currency units per one foreign unit. */
export const fxRate = (name: string) => numeric(name, { precision: 28, scale: 12 });
/** A percentage or tax rate as a fraction (0.0725 = 7.25%). */
export const rate = (name: string) => numeric(name, { precision: 12, scale: 8 });

export const id = () => uuid("id").primaryKey().defaultRandom();
export const orgId = () => uuid("org_id").notNull();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
export const ts = (name: string) => timestamp(name, { withTimezone: true });
export const day = (name: string) => date(name, { mode: "string" });
export const currencyCode = (name: string) => text(name);
