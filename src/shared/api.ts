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

export interface RecategorizeRequest {
  categoryId: string;
  uiContext?: UiContext;
  /** Create an "always categorize this merchant as X" rule at the same time. */
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
}
