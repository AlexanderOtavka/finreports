/**
 * The backend adapter: the only code that knows which ledger holds the transactions.
 * Everything outside `adapters/` works with these backend-neutral shapes.
 */

export interface BackendAccount {
  id: string;
  name: string;
  type: string;
}

export interface BackendTxn {
  /** Stable id of this transaction (split) in the backend; what `setCategory` takes. */
  externalId: string;
  groupId: string | null;
  /** ISO date (YYYY-MM-DD) the money moved, in the household's time zone. */
  date: string;
  /** Signed: negative is money out of `account`. */
  amount: number;
  currency: string;
  type: "withdrawal" | "deposit" | "transfer";
  pending: boolean;
  /** Cleaned merchant name, if the backend has one. */
  merchant: string | null;
  /** The description as the backend shows it (often the raw bank text). */
  description: string;
  accountId: string | null;
  accountName: string | null;
  /** The other side: payee, payer, or the other account of a transfer. */
  counterparty: string | null;
  /** Plaid's personal finance category, as SCREAMING_SNAKE primary/detailed. */
  plaid: { primary: string; detailed: string } | null;
  /** The backend's category name, if any. */
  category: string | null;
  /** `category` is the one the backend's importer derived from `plaid`, untouched since. */
  categoryFromPlaid: boolean;
  /** When the backend last changed this transaction (ISO timestamp), if it says. */
  updatedAt: string | null;
  /** A posted transaction that replaces this earlier pending one. */
  replacesExternalId?: string | null;
}

export interface ChangeSet {
  txns: BackendTxn[];
  /** External ids the backend no longer has. */
  removed: string[];
  /** Opaque; passed back to the next `listChanges`. */
  cursor: string;
  /**
   * Set when `txns` is the complete list of transactions dated on or after this day: any
   * mirrored transaction from that day on that is missing has been deleted.
   */
  completeFrom: string | null;
}

export interface BackendAdapter {
  readonly name: string;
  listAccounts(): Promise<BackendAccount[]>;
  /** Category names the backend knows. */
  listCategories(): Promise<string[]>;
  /**
   * Transactions created or changed since `cursor` (everything when null). `full` asks for a
   * complete listing, so deletions can be noticed.
   */
  listChanges(cursor: string | null, options: { full: boolean }): Promise<ChangeSet>;
  /** Sets the category of one transaction; the backend creates the category if needed. */
  setCategory(externalId: string, categoryName: string): Promise<void>;
}
