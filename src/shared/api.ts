/** JSON shapes exchanged between the server and the web app. */
import type { CategoryKind } from "./taxonomy.js";

export interface CategoryDto {
  id: string;
  parentId: string | null;
  name: string;
  kind: CategoryKind;
  sort: number;
}

export interface TxnDto {
  id: number;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  merchantKey: string;
  description: string;
  accountId: string | null;
  accountName: string | null;
  /** The payee or payer as the ledger names it, when that differs from `merchant`. */
  counterparty: string | null;
  type: "withdrawal" | "deposit" | "transfer";
  pending: boolean;
  plaidPrimary: string | null;
  plaidDetailed: string | null;
  /** The merchant's website, `https://…`. */
  website: string | null;
  /** Where the purchase happened. */
  location: { lat: number; lon: number } | null;
  notes: string | null;
  tags: string[];
  categoryId: string | null;
  /** `plaid`, `backend`, `manual`, `rule:<id>`, or `none`. */
  provenance: string;
  /**
   * Where `merchant` comes from: `none` (there is none; it is the cleaned description), the
   * backend's import (`backend`), someone changing it there (`edited`), `manual`, or `rule:<id>`.
   */
  merchantSource: string;
}

/** An account transactions move money in or out of (an asset account, in Firefly's terms). */
export interface AccountDto {
  id: string;
  name: string;
}

export interface Breadcrumb {
  key: string | null;
  label: string;
}

export interface ReportRow {
  key: string;
  label: string;
  value: number;
  [extra: string]: unknown;
}

export interface ReportData {
  reportId: string;
  level: number;
  levels: number;
  /** Whether a datum at this level can be tapped to drill further. */
  canDrill: boolean;
  breadcrumbs: Breadcrumb[];
  rows: ReportRow[];
  total: number;
}

export interface UiContext {
  reportId?: string;
  drillPath?: string[];
  from?: string;
  to?: string;
  surface?: string;
}

/** A person's change to one transaction; at least one of the three. */
export interface RecategorizeRequest {
  /** Its category, from now on `manual`. */
  categoryId?: string;
  /** Its merchant, from now on `manual`. */
  merchant?: string;
  /** A rule to save at the same time (and, with `applyToPast`, apply to past transactions). */
  rule?: { definition: unknown; applyToPast: boolean };
  uiContext?: UiContext;
  /** Older apps: an "always categorize this merchant as X" rule. */
  merchantRule?: { applyToPast: boolean };
}

export interface RecategorizeResponse {
  txn: TxnDto;
  rule?: { id: number; version: number; backfilled: number };
}

export interface RulePreview {
  count: number;
  sample: TxnDto[];
}

export interface RuleDto {
  id: number;
  version: number;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
}

/** A link to another app, shown in the top bar (`NAV_LINKS`). */
export interface NavLink {
  label: string;
  url: string;
  newTab?: boolean;
}

export interface SessionDto {
  email: string;
  csrfToken: string;
  devBypass: boolean;
  navLinks: NavLink[];
}

export interface SuggestionsDto {
  /** Categories most likely for this transaction, best first. */
  likely: string[];
  /** Categories recently chosen by hand, most recent first. */
  recent: string[];
  /**
   * For a transaction missing a merchant or a category: the merchants it looks like, best
   * first, as in the rules builder.
   */
  candidates: BuilderCandidateDto[];
}

export interface RulePreviewCounts extends RulePreview {
  /** Of `count`, how many would get the rule's merchant. */
  merchantCount: number;
  /** Of `count`, how many would get the rule's category. */
  categoryCount: number;
}

/** A transaction as the rules builder shows it. */
export interface BuilderTxnDto {
  id: number;
  date: string;
  amount: number;
  description: string;
  /** The merchant, only when there really is one (not a cleaned-up description). */
  merchant: string | null;
  accountName: string | null;
  categoryId: string | null;
  provenance: string;
}

/**
 * A merchant whose transactions look like a group's, proposed as the source of its merchant
 * and category.
 */
export interface BuilderCandidateDto {
  merchant: string;
  /** The category most of the merchant's transactions are in. */
  categoryId: string;
  /** 0 to 1. */
  confidence: number;
  /**
   * What the confidence rests on: one of the merchant's descriptions reduces to the group's
   * (`same`) or looks like it (`similar`), or the merchant's name is in the group's (`name`).
   */
  reason: "same" | "similar" | "name";
  /** The merchant's transactions, and how many of them are in `categoryId`. */
  sourceCount: number;
  categoryCount: number;
  /** The merchant's descriptions most like the group's, best first. */
  evidence: Array<{ description: string; similarity: number; count: number }>;
  /** Some of the merchant's transactions, newest first. */
  examples: BuilderTxnDto[];
}

/** Transactions missing a merchant or a category whose descriptions reduce to the same key. */
export interface BuilderGroupDto {
  /** `descriptionKey` of every description in the group: what the proposed rule matches. */
  key: string;
  /** The key as a merchant name, for when no candidate has a better one. */
  label: string;
  size: number;
  /** Signed sum: negative is money out. */
  total: number;
  from: string;
  to: string;
  missingCategory: number;
  missingMerchant: number;
  /** The most common descriptions, most common first. */
  descriptions: Array<{ description: string; count: number }>;
  accounts: string[];
  /** The category most of the group's own categorized transactions are in, if any are. */
  ownCategory: { categoryId: string; count: number } | null;
  /** Best first; empty when nothing looks like the group. */
  candidates: BuilderCandidateDto[];
  /** Newest first, at most `BUILDER_TXN_LIMIT`. */
  txns: BuilderTxnDto[];
}

export interface BuilderDto {
  totals: {
    /** Transactions (not transfers) missing a merchant, a category, or both. */
    deficient: number;
    missingCategory: number;
    missingMerchant: number;
    missingBoth: number;
    /** Groups of two or more, and the transactions in them. */
    groups: number;
    grouped: number;
    /** Transactions with no other like them. */
    singles: number;
    /** Transactions in groups with at least one candidate. */
    withCandidate: number;
  };
  /** Groups of two or more first (biggest first), then the single transactions. */
  groups: BuilderGroupDto[];
}

export interface SaveRuleResponse {
  id: number;
  version: number;
  action: "rule_create" | "rule_update";
  /** Past transactions the rule changed. */
  backfilled: number;
}
