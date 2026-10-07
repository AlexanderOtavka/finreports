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
  };
}

function location(row: TxnRow): { lat: number; lon: number } | null {
  return row.latitude !== null && row.longitude !== null ? { lat: row.latitude, lon: row.longitude } : null;
}

export function toSubject(row: TxnRow): RuleSubject {
  return { merchant: row.merchant, description: row.description, accountName: row.account_name, amount: row.amount };
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
  };
}
