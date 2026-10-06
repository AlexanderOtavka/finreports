import { kebab, PLAID_TAXONOMY, primaryName } from "../../shared/taxonomy.js";
import type { BackendAccount, BackendAdapter, BackendTxn, ChangeSet } from "./types.js";

/**
 * The Firefly III backend, over its REST API only (https://api-docs.firefly-iii.org/).
 *
 * - Transactions are groups of splits; each split (transaction journal) is one `BackendTxn`,
 *   keyed by its journal id.
 * - Changes: Firefly has no "changed since" listing, so incremental syncs search with
 *   `updated_at_after:<day before the cursor>` and a full sync lists every transaction from
 *   `initialSyncDays` ago. Firefly reports no deletions, so only a full sync notices them.
 * - Plaid's category comes from the Plaid connector: the Firefly category it sets is named
 *   after Plaid's primary category, and the detailed one is kept as a
 *   `plaid-detailed-cat-<detailed>` tag.
 * - Writing a category is `PUT /api/v1/transactions/{group}` with every split of the group
 *   (Firefly drops splits left out of an update) and `apply_rules: false`, so Firefly's own
 *   rules do not fight this service's.
 */
export interface FireflyOptions {
  baseUrl: string;
  token: string;
  initialSyncDays: number;
  fetch?: typeof fetch;
  now?: () => Date;
  pageSize?: number;
  /** Prefix of the connector's detailed-category tags. */
  detailedTagPrefix?: string;
  timeoutMs?: number;
}

interface FireflySplit {
  transaction_journal_id: string;
  type: string;
  date: string;
  amount: string;
  description: string;
  currency_code?: string | null;
  source_id?: string | null;
  source_name?: string | null;
  source_type?: string | null;
  destination_id?: string | null;
  destination_name?: string | null;
  destination_type?: string | null;
  category_name?: string | null;
  tags?: string[] | null;
}

interface FireflyGroup {
  id: string;
  attributes: {
    updated_at?: string | null;
    created_at?: string | null;
    transactions: FireflySplit[];
  };
}

interface FireflyArray<T> {
  data: T[];
  meta?: { pagination?: { total_pages?: number; current_page?: number } };
}

interface Cursor {
  v: 1;
  updatedAt: string | null;
}

const NO_PAYEE = new Set(["(no name)", "unknown", "(cash)", "(unknown destination account)", "(unknown source account)"]);

export class FireflyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FireflyAdapter implements BackendAdapter {
  readonly name = "firefly";
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly tagPrefix: string;

  constructor(private readonly options: FireflyOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.pageSize = options.pageSize ?? 200;
    this.tagPrefix = options.detailedTagPrefix ?? "plaid-detailed-cat-";
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.options.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.options.token}`,
        Accept: "application/vnd.api+json, application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    if (!res.ok) {
      // Never echo the response body: it can carry transaction details into logs.
      throw new FireflyError(`Firefly ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  private async *pages<T>(path: string): AsyncGenerator<T[]> {
    for (let page = 1; ; page += 1) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await this.request<FireflyArray<T>>("GET", `${path}${sep}limit=${this.pageSize}&page=${page}`);
      yield res.data;
      const total = res.meta?.pagination?.total_pages ?? 1;
      if (page >= total || res.data.length === 0) return;
    }
  }

  async listAccounts(): Promise<BackendAccount[]> {
    const out: BackendAccount[] = [];
    for await (const page of this.pages<{ id: string; attributes: { name: string; type: string } }>(
      "/api/v1/accounts?type=asset",
    )) {
      for (const a of page) out.push({ id: a.id, name: a.attributes.name, type: a.attributes.type });
    }
    return out;
  }

  async listCategories(): Promise<string[]> {
    const out: string[] = [];
    for await (const page of this.pages<{ attributes: { name: string } }>("/api/v1/categories")) {
      for (const c of page) out.push(c.attributes.name);
    }
    return out;
  }

  async listChanges(cursorRaw: string | null, options: { full: boolean }): Promise<ChangeSet> {
    const cursor = cursorRaw ? (JSON.parse(cursorRaw) as Cursor) : null;
    const full = options.full || !cursor?.updatedAt;
    const today = this.now().toISOString().slice(0, 10);
    let path: string;
    let completeFrom: string | null = null;
    if (full) {
      const start = new Date(this.now().getTime() - this.options.initialSyncDays * 86_400_000).toISOString().slice(0, 10);
      path = `/api/v1/transactions?type=all&start=${start}&end=${addDays(today, 7)}`;
      completeFrom = start;
    } else {
      // The operator takes a day; ask from the day before the cursor and let the upsert
      // ignore what has not really changed.
      const since = addDays(cursor!.updatedAt!.slice(0, 10), -1);
      path = `/api/v1/search/transactions?query=${encodeURIComponent(`updated_at_after:${since}`)}`;
    }

    const txns: BackendTxn[] = [];
    let maxUpdated = cursor?.updatedAt ?? null;
    for await (const page of this.pages<FireflyGroup>(path)) {
      for (const group of page) {
        const updatedAt = group.attributes.updated_at ?? null;
        if (updatedAt && (!maxUpdated || updatedAt > maxUpdated)) maxUpdated = updatedAt;
        for (const split of group.attributes.transactions) {
          const txn = this.toBackend(group, split);
          if (txn) txns.push(txn);
        }
      }
    }
    return { txns, removed: [], cursor: JSON.stringify({ v: 1, updatedAt: maxUpdated } satisfies Cursor), completeFrom };
  }

  async setCategory(externalId: string, categoryName: string): Promise<void> {
    const res = await this.request<{ data: FireflyGroup }>("GET", `/api/v1/transaction-journals/${encodeURIComponent(externalId)}`);
    const group = res.data;
    const splits = group.attributes.transactions;
    if (!splits.some((s) => String(s.transaction_journal_id) === externalId)) {
      throw new FireflyError(`journal ${externalId} is not in group ${group.id}`, 404);
    }
    await this.request("PUT", `/api/v1/transactions/${encodeURIComponent(group.id)}`, {
      apply_rules: false,
      fire_webhooks: true,
      transactions: splits.map((s) =>
        String(s.transaction_journal_id) === externalId
          ? { transaction_journal_id: String(s.transaction_journal_id), category_name: categoryName }
          : { transaction_journal_id: String(s.transaction_journal_id) },
      ),
    });
  }

  /** Maps one split; null for kinds that are not money moving (opening balances etc.). */
  toBackend(group: FireflyGroup, split: FireflySplit): BackendTxn | null {
    const type = split.type;
    if (type !== "withdrawal" && type !== "deposit" && type !== "transfer") return null;
    const amount = Math.abs(Number(split.amount));
    const outgoing = type !== "deposit";
    const accountId = (outgoing ? split.source_id : split.destination_id) ?? null;
    const accountName = (outgoing ? split.source_name : split.destination_name) ?? null;
    const counterparty = (outgoing ? split.destination_name : split.source_name) ?? null;
    const payee = counterparty && !NO_PAYEE.has(counterparty.toLowerCase()) ? counterparty : null;
    const plaid = this.plaidFromTags(split.tags ?? [], split.category_name ?? null);
    const category = split.category_name?.trim() ? split.category_name.trim() : null;
    return {
      externalId: String(split.transaction_journal_id),
      groupId: String(group.id),
      date: split.date.slice(0, 10),
      amount: outgoing ? -amount : amount,
      currency: split.currency_code ?? "USD",
      type,
      // The connector imports pending charges and settles them in place on the same journal,
      // so the mirror row (and its decision) carries over; Firefly has no pending flag to read.
      pending: false,
      merchant: type === "transfer" ? null : payee,
      description: split.description,
      accountId: accountId === null ? null : String(accountId),
      accountName,
      counterparty,
      plaid,
      category,
      categoryFromPlaid: plaid !== null && category !== null && category === primaryName(plaid.primary),
      updatedAt: group.attributes.updated_at ?? null,
    };
  }

  /**
   * The connector's tag carries only the detailed half (`groceries`), which a few primaries
   * share (`account-transfer`, `other`...). Prefer the primary the Firefly category names.
   */
  plaidFromTags(tags: string[], categoryName: string | null): { primary: string; detailed: string } | null {
    const tag = tags.find((t) => t.startsWith(this.tagPrefix));
    if (!tag) return null;
    const detailedKebab = tag.slice(this.tagPrefix.length);
    const candidates = PLAID_TAXONOMY.flatMap((p) =>
      p.detailed.filter(([d]) => kebab(d) === detailedKebab).map(([d]) => ({ primary: p.primary, detailed: d, name: p.name })),
    );
    if (candidates.length === 0) return null;
    const best = candidates.find((c) => c.name === categoryName) ?? candidates[0]!;
    return { primary: best.primary, detailed: best.detailed };
  }
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
