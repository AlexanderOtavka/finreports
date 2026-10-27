import type { TxnDto } from "../shared/api.js";
import { merchantDisplay } from "../shared/merchant.js";
import type { RuleSubject } from "../shared/rules.js";

/** A `txn` row as selected with `SELECT *`. */
export interface TxnRow {
  id: number;
  backend: string;
  external_id: string;
  group_id: string | null;
  date: string;
  amount: number;
  currency: string;
  type: "withdrawal" | "deposit" | "transfer";
  pending: boolean;
  /** The merchant shown and matched on: the backend's, or one a rule filled in. */
  merchant: string | null;
  merchant_key: string;
  description: string;
  account_id: string | null;
  account_name: string | null;
  counterparty: string | null;
  plaid_primary: string | null;
  plaid_detailed: string | null;
  website: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  tags: string[];
  backend_category: string | null;
  category_id: string | null;
  category_provenance: string;
  category_set_at: Date | null;
  backend_dirty: boolean;
  needs_rules: boolean;
  backend_updated_at: Date | null;
  first_seen_at: Date;
  synced_at: Date;
  deleted_at: Date | null;
  /** The merchant as the backend last reported it; null when it has none. */
  backend_merchant: string | null;
  /** `backend`, `edited`, `manual` or `rule:<id>`. */
  merchant_provenance: string;
  merchant_dirty: boolean;
  /** Marked as a gift: the app keeps its merchant out of lists, charts and search. */
  gift: boolean;
  /** `none`, `manual` or `rule:<id>`. */
  gift_provenance: string;
}

export function toDto(row: TxnRow): TxnDto {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    merchant: merchantDisplay(row.merchant, row.description),
    merchantKey: row.merchant_key,
    description: row.description,
    accountId: row.account_id,
    accountName: row.account_name,
    // Only when it says more than the merchant name does.
    counterparty: row.counterparty && row.counterparty !== row.merchant ? row.counterparty : null,
    type: row.type,
    pending: row.pending,
    plaidPrimary: row.plaid_primary,
    plaidDetailed: row.plaid_detailed,
    website: row.website,
    location: location(row),
    notes: row.notes,
    tags: row.tags,
    categoryId: row.category_id,
    provenance: row.category_provenance,
    merchantSource: row.merchant === null ? "none" : row.merchant_provenance,
    gift: row.gift,
    giftSource: row.gift_provenance,
  };
}

function location(row: TxnRow): { lat: number; lon: number } | null {
  return row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lon: row.longitude } : null;
}

export function toSubject(row: TxnRow): RuleSubject {
  return { merchant: row.merchant, description: row.description, accountName: row.account_name, amount: row.amount, date: row.date };
}

/** The transaction as the backend has it, before any rule filled in its merchant. */
export function backendSubject(row: TxnRow): RuleSubject {
  return { ...toSubject(row), merchant: row.backend_merchant };
}

/**
 * Whether a rule may set this transaction's merchant. Never one a person set here, and never a
 * transfer's, which has none. After a sync (`afterSync`), not one someone changed in the
 * backend either; an explicit backfill, which a person asks for, may.
 */
export function merchantSettable(row: TxnRow, afterSync: boolean): boolean {
  if (row.type === "transfer" || row.merchant_provenance === "manual") return false;
  return !(afterSync && row.merchant_provenance === "edited");
}

/**
 * Everything about a transaction a model would need to learn the decision, as it stood
 * when the decision was made. Stored in `decision_event.txn_snapshot`.
 */
export function snapshot(row: TxnRow): Record<string, unknown> {
  return {
    id: row.id,
    backend: row.backend,
    externalId: row.external_id,
    date: row.date,
    amount: row.amount,
    currency: row.currency,
    type: row.type,
    pending: row.pending,
    merchant: row.merchant,
    backendMerchant: row.backend_merchant,
    merchantProvenance: row.merchant_provenance,
    merchantDisplay: merchantDisplay(row.merchant, row.description),
    merchantKey: row.merchant_key,
    description: row.description,
    accountId: row.account_id,
    accountName: row.account_name,
    counterparty: row.counterparty,
    plaidPrimary: row.plaid_primary,
    plaidDetailed: row.plaid_detailed,
    website: row.website,
    location: location(row),
    notes: row.notes,
    tags: row.tags,
    backendCategory: row.backend_category,
    categoryId: row.category_id,
    categoryProvenance: row.category_provenance,
    gift: row.gift,
    giftProvenance: row.gift_provenance,
  };
}
