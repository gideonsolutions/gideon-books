/** The bank-feed provider abstraction. */

export interface FeedTransaction {
  /** The provider's stable id for the transaction. */
  id: string;
  /** Posting date (ISO). */
  postedDate: string;
  /** Signed decimal string: positive is money in. */
  amount: string;
  description: string;
  payee: string | null;
  memo: string | null;
  /** The provider's own record, kept verbatim as the import row. */
  raw: unknown;
}

export interface FeedAccount {
  id: string;
  name: string;
  institution: string | null;
  currency: string | null;
  balance: string | null;
  balanceDate: string | null;
  transactions: FeedTransaction[];
}

export interface FeedProvider {
  name: "simplefin" | "sandbox";
  label: string;
  mode: "live" | "sandbox";
  /** Turn what the person pasted into the secret kept (encrypted) for later syncs. */
  connect(setup: string): Promise<{ secret: string; displayName: string }>;
  fetch(secret: string, range: { start: string; end: string }): Promise<{ accounts: FeedAccount[]; warnings: string[] }>;
}
