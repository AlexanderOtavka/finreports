import type { Db } from "../db.js";
import { generateSample, SAMPLE_ACCOUNTS, type SampleTxn } from "../sample/generate.js";
import { PLAID_TAXONOMY, primaryName } from "../../shared/taxonomy.js";
import type { BackendAccount, BackendAdapter, BackendTxn, ChangeSet } from "./types.js";

/**
 * The `sample` backend: the generated dataset of a car-free household, standing in for a
 * ledger. Like a Plaid-fed ledger, each transaction starts out with the category the importer
 * derived from Plaid's primary category. Category writes are kept in `sample_backend_write`,
 * so they survive restarts and come back on the next sync like a real backend's would.
 */
export interface SampleOptions {
  seed: number;
  /** Last day of data; defaults to today (UTC). */
  endDate?: string;
  /** Override the clock (tests). */
  now?: () => Date;
}

interface Cursor {
  v: 1;
  /** Writes after this instant are changes. */
  at: string;
  /** Days after this one are new. */
  through: string;
}

export class SampleAdapter implements BackendAdapter {
  readonly name = "sample";
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly options: SampleOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  endDate(): string {
    return this.options.endDate ?? this.now().toISOString().slice(0, 10);
  }

  dataset(): SampleTxn[] {
    return generateSample(this.options.seed, this.endDate());
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return SAMPLE_ACCOUNTS.map((a) => ({ id: a.id, name: a.name, type: a.type }));
  }

  async listCategories(): Promise<string[]> {
    const written = await this.db.query<{ name: string }>(
      "SELECT DISTINCT category_name AS name FROM sample_backend_write WHERE category_name IS NOT NULL",
    );
    return [...new Set([...PLAID_TAXONOMY.map((p) => p.name), ...written.rows.map((r) => r.name)])];
  }

  async listChanges(cursorRaw: string | null, options: { full: boolean }): Promise<ChangeSet> {
    const cursor = cursorRaw ? (JSON.parse(cursorRaw) as Cursor) : null;
    const startedAt = this.now().toISOString();
    const data = this.dataset();
    const writes = await this.db.query<{ external_id: string; category_name: string | null; updated_at: Date }>(
      "SELECT external_id, category_name, updated_at FROM sample_backend_write",
    );
    const written = new Map(writes.rows.map((w) => [w.external_id, w]));
    const changedIds = new Set(
      writes.rows.filter((w) => !cursor || w.updated_at.toISOString() > cursor.at).map((w) => w.external_id),
    );

    const pick = (t: SampleTxn): boolean =>
      options.full || !cursor || t.date > cursor.through || t.pending || changedIds.has(t.externalId);

    const txns = data.filter(pick).map((t) => this.toBackend(t, written.get(t.externalId)));
    const removed = data.flatMap((t) => (t.replacesExternalId ? [t.replacesExternalId] : []));
    const full = options.full || !cursor;
    return {
      txns,
      removed,
      cursor: JSON.stringify({ v: 1, at: startedAt, through: this.endDate() } satisfies Cursor),
      completeFrom: full ? (data[0]?.date ?? null) : null,
    };
  }

  async setCategory(externalId: string, categoryName: string): Promise<void> {
    await this.db.query(
      `INSERT INTO sample_backend_write (external_id, category_name, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (external_id) DO UPDATE SET category_name = EXCLUDED.category_name, updated_at = now()`,
      [externalId, categoryName],
    );
  }

  private toBackend(t: SampleTxn, write?: { category_name: string | null; updated_at: Date }): BackendTxn {
    const imported = primaryName(t.plaid.primary);
    const category = write ? write.category_name : imported;
    return {
      externalId: t.externalId,
      groupId: null,
      date: t.date,
      amount: t.amount,
      currency: "USD",
      type: t.type,
      pending: t.pending,
      merchant: t.merchant,
      description: t.description,
      accountId: t.accountId,
      accountName: t.accountName,
      counterparty: t.counterparty,
      website: t.website,
      location: t.location,
      notes: t.notes,
      tags: t.tags,
      plaid: t.plaid,
      category,
      categoryFromPlaid: category !== null && category === imported,
      updatedAt: write ? write.updated_at.toISOString() : `${t.date}T12:00:00.000Z`,
      replacesExternalId: t.replacesExternalId,
    };
  }
}
