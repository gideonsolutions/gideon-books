/**
 * Sales-side records that are not documents themselves: payment links that
 * let a customer pay an invoice through a connected provider's checkout.
 */

import { foreignKey, index, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { createdAt, currencyCode, id, money, orgId, ts } from "./_columns";
import { integrationConnections, organizations } from "./core";
import { documents } from "./commerce";

/**
 * A checkout for one invoice at one provider. The `token` addresses the
 * sandbox's local checkout page; for a real provider `url` is its hosted
 * checkout. Paid when the provider's webhook says so.
 */
export const paymentLinks = pgTable(
  "payment_links",
  {
    id: id(),
    orgId: orgId().references(() => organizations.id),
    documentId: uuid("document_id").notNull(),
    connectionId: uuid("connection_id").notNull(),
    provider: text("provider").notNull(),
    token: text("token").notNull(),
    providerSessionId: text("provider_session_id"),
    url: text("url").notNull(),
    currency: currencyCode("currency").notNull(),
    amount: money("amount").notNull(),
    status: text("status", { enum: ["open", "paid", "expired", "cancelled"] }).notNull().default("open"),
    createdBy: uuid("created_by"),
    createdAt: createdAt(),
    paidAt: ts("paid_at"),
  },
  (t) => [
    unique("payment_links_token_uq").on(t.token),
    unique("payment_links_org_id_uq").on(t.orgId, t.id),
    index("payment_links_doc_idx").on(t.orgId, t.documentId),
    foreignKey({ columns: [t.orgId, t.documentId], foreignColumns: [documents.orgId, documents.id] }),
    foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [integrationConnections.orgId, integrationConnections.id] }),
  ],
);


