import { merchantKey } from "../shared/merchant.js";
import type { BackendAdapter } from "./adapters/types.js";
import { CategoryIndex, ensureBackendCategories } from "./categories.js";
import { inTransaction, type Db } from "./db.js";
import { applyRulesToPending } from "./rules.js";
import type { TxnRow } from "./txns.js";
import type { BackendTxn } from "./adapters/types.js";

export interface SyncStats {
  full: boolean;
  received: number;
  inserted: number;
  updated: number;
  deleted: number;
  ruleChanges: number;
  pushed: number;
  pushFailed: number;
}

interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

interface SyncState {
  cursor: string | null;
  lastFullAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

/** Columns the backend owns; a change to any of them sends the row back through the rules. */
const RULE_INPUTS = ["merchant", "description", "account_name", "amount"] as const;

/**
 * Keeps `txn` in step with the backend: pull changes through the adapter, upsert them, run
 * the rules over what is new or changed, and write locally decided categories back.
 */
export class SyncService {
  private running: Promise<SyncStats> | null = null;
  private pushing: Promise<{ pushed: number; failed: number }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly adapter: BackendAdapter,
    private readonly log: Logger,
    private readonly options: { intervalMs: number; fullIntervalMs: number; now?: () => Date },
  ) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async state(): Promise<SyncState> {
    const res = await this.db.query<{ value: SyncState }>("SELECT value FROM app_state WHERE key = $1", [this.stateKey()]);
    return res.rows[0]?.value ?? { cursor: null, lastFullAt: null, lastSyncAt: null, lastError: null };
  }

  private stateKey(): string {
    return `sync:${this.adapter.name}`;
  }

  private async saveState(state: SyncState): Promise<void> {
    await this.db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [this.stateKey(), JSON.stringify(state)],
    );
  }

  /** One sync; concurrent callers share the run in progress. */
  run(options: { full?: boolean } = {}): Promise<SyncStats> {
    if (!this.running) {
      this.running = this.runOnce(options.full ?? false).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async runOnce(forceFull: boolean): Promise<SyncStats> {
    const state = await this.state();
    const now = this.now();
    const full =
      forceFull ||
      !state.cursor ||
      !state.lastFullAt ||
      now.getTime() - new Date(state.lastFullAt).getTime() >= this.options.fullIntervalMs;
    try {
      const changes = await this.adapter.listChanges(state.cursor, { full });
      const stats = await inTransaction(this.db, async (client) => {
        await ensureBackendCategories(
          client,
          changes.txns.flatMap((t) => (t.category ? [t.category] : [])),
        );
        const categories = await CategoryIndex.load(client);
        const existing = new Map(
          (await client.query<TxnRow>("SELECT * FROM txn WHERE backend = $1", [this.adapter.name])).rows.map((r) => [
            r.external_id,
            r,
          ]),
        );
        let inserted = 0;
        let updated = 0;
        for (const b of changes.txns) {
          const result = await this.upsert(client, b, existing, categories);
          if (result === "inserted") inserted += 1;
          if (result === "updated") updated += 1;
        }
        let deleted = 0;
        if (changes.removed.length > 0) {
          const res = await client.query(
            "UPDATE txn SET deleted_at = now() WHERE backend = $1 AND external_id = ANY($2) AND deleted_at IS NULL",
            [this.adapter.name, changes.removed],
          );
          deleted += res.rowCount ?? 0;
        }
        if (changes.completeFrom) {
          const res = await client.query(
            `UPDATE txn SET deleted_at = now()
             WHERE backend = $1 AND date >= $2 AND deleted_at IS NULL AND NOT (external_id = ANY($3))`,
            [this.adapter.name, changes.completeFrom, changes.txns.map((t) => t.externalId)],
          );
          deleted += res.rowCount ?? 0;
        }
        const ruleChanges = await applyRulesToPending(client, categories);
        return { inserted, updated, deleted, ruleChanges };
      });
      await this.saveState({
        cursor: changes.cursor,
        lastFullAt: full ? now.toISOString() : state.lastFullAt,
        lastSyncAt: now.toISOString(),
        lastError: null,
      });
      const pushed = await this.pushDirty();
      const result: SyncStats = { full, received: changes.txns.length, ...stats, pushed: pushed.pushed, pushFailed: pushed.failed };
      this.log.info({ sync: result }, "sync finished");
      return result;
    } catch (err) {
      await this.saveState({ ...state, lastError: (err as Error).message }).catch(() => undefined);
      throw err;
    }
  }

  private async upsert(
    client: import("pg").PoolClient,
    b: BackendTxn,
    existing: Map<string, TxnRow>,
    categories: CategoryIndex,
  ): Promise<"inserted" | "updated" | "unchanged"> {
    const fromBackend = {
      categoryId: b.categoryFromPlaid ? categories.idForPlaid(b.plaid) : categories.idForName(b.category),
      provenance: b.category === null ? "none" : b.categoryFromPlaid ? "plaid" : "backend",
    };
    const fields = {
      group_id: b.groupId,
      date: b.date,
      amount: b.amount,
      currency: b.currency,
      type: b.type,
      pending: b.pending,
      merchant: b.merchant,
      merchant_key: merchantKey(b.merchant, b.description),
      description: b.description,
      account_id: b.accountId,
      account_name: b.accountName,
      counterparty: b.counterparty,
      plaid_primary: b.plaid?.primary ?? null,
      plaid_detailed: b.plaid?.detailed ?? null,
      website: b.website ?? null,
      latitude: b.location?.lat ?? null,
      longitude: b.location?.lon ?? null,
      notes: b.notes ?? null,
      tags: b.tags ?? [],
      backend_updated_at: b.updatedAt,
    };
    const row = existing.get(b.externalId);

    if (!row) {
      let category = { id: fromBackend.categoryId, provenance: fromBackend.provenance, dirty: false, needsRules: true };
      // A posted transaction inherits the decision made on its pending authorization.
      const replaced = b.replacesExternalId ? existing.get(b.replacesExternalId) : undefined;
      if (replaced && (replaced.category_provenance === "manual" || replaced.category_provenance.startsWith("rule:"))) {
        category = {
          id: replaced.category_id,
          provenance: replaced.category_provenance,
          dirty: (replaced.category_id ? categories.nameFor(replaced.category_id) : null) !== b.category,
          needsRules: replaced.category_provenance !== "manual",
        };
      }
      const res = await client.query<TxnRow>(
        `INSERT INTO txn (backend, external_id, group_id, date, amount, currency, type, pending, merchant,
           merchant_key, description, account_id, account_name, counterparty, plaid_primary, plaid_detailed,
           backend_updated_at, backend_category, category_id, category_provenance, category_set_at,
           backend_dirty, needs_rules, website, latitude, longitude, notes, tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),$21,$22,$23,$24,$25,$26,$27)
         RETURNING *`,
        [
          this.adapter.name,
          b.externalId,
          fields.group_id,
          fields.date,
          fields.amount,
          fields.currency,
          fields.type,
          fields.pending,
          fields.merchant,
          fields.merchant_key,
          fields.description,
          fields.account_id,
          fields.account_name,
          fields.counterparty,
          fields.plaid_primary,
          fields.plaid_detailed,
          fields.backend_updated_at,
          b.category,
          category.id,
          category.provenance,
          category.dirty,
          category.needsRules,
          fields.website,
          fields.latitude,
          fields.longitude,
          fields.notes,
          fields.tags,
        ],
      );
      existing.set(b.externalId, res.rows[0]!);
      return "inserted";
    }

    const changed = (Object.keys(fields) as Array<keyof typeof fields>).filter((k) => {
      const now = fields[k];
      const was = row[k as keyof TxnRow];
      if (k === "backend_updated_at") {
        const wasIso = was instanceof Date ? was.toISOString() : was;
        return (typeof now === "string" ? new Date(now).toISOString() : null) !== (wasIso ?? null);
      }
      if (k === "tags") return JSON.stringify(now) !== JSON.stringify(was);
      return now !== was;
    });
    // The backend's category moved and it was not us: someone or something there chose it.
    const backendRecategorized = !row.backend_dirty && b.category !== row.backend_category;
    if (changed.length === 0 && !backendRecategorized && !row.deleted_at) return "unchanged";

    const needsRules = row.needs_rules || backendRecategorized || changed.some((k) => (RULE_INPUTS as readonly string[]).includes(k));
    await client.query(
      `UPDATE txn SET group_id=$2, date=$3, amount=$4, currency=$5, type=$6, pending=$7, merchant=$8,
         merchant_key=$9, description=$10, account_id=$11, account_name=$12, counterparty=$13,
         plaid_primary=$14, plaid_detailed=$15, backend_updated_at=$16, synced_at=now(), deleted_at=NULL,
         needs_rules=$17, website=$18, latitude=$19, longitude=$20, notes=$21, tags=$22
         ${backendRecategorized ? ", backend_category=$23, category_id=$24, category_provenance=$25, category_set_at=now()" : ""}
       WHERE id=$1`,
      [
        row.id,
        fields.group_id,
        fields.date,
        fields.amount,
        fields.currency,
        fields.type,
        fields.pending,
        fields.merchant,
        fields.merchant_key,
        fields.description,
        fields.account_id,
        fields.account_name,
        fields.counterparty,
        fields.plaid_primary,
        fields.plaid_detailed,
        fields.backend_updated_at,
        needsRules,
        fields.website,
        fields.latitude,
        fields.longitude,
        fields.notes,
        fields.tags,
        ...(backendRecategorized ? [b.category, fromBackend.categoryId, fromBackend.provenance] : []),
      ],
    );
    return "updated";
  }

  /**
   * Writes locally decided categories to the backend. A failure leaves the row dirty for
   * the next round; a row changed again while its write was in flight stays dirty too.
   */
  pushDirty(): Promise<{ pushed: number; failed: number }> {
    if (!this.pushing) {
      this.pushing = this.pushOnce().finally(() => {
        this.pushing = null;
      });
    }
    return this.pushing;
  }

  private async pushOnce(): Promise<{ pushed: number; failed: number }> {
    let pushed = 0;
    let failed = 0;
    const res = await this.db.query<{ id: number; external_id: string; category_id: string; name: string }>(
      `SELECT t.id, t.external_id, t.category_id, c.name
       FROM txn t JOIN category c ON c.id = t.category_id
       WHERE t.backend_dirty AND t.backend = $1 AND t.deleted_at IS NULL
       ORDER BY t.id LIMIT 1000`,
      [this.adapter.name],
    );
    for (const row of res.rows) {
      try {
        await this.adapter.setCategory(row.external_id, row.name);
        await this.db.query(
          "UPDATE txn SET backend_dirty = false, backend_category = $2 WHERE id = $1 AND category_id = $3",
          [row.id, row.name, row.category_id],
        );
        pushed += 1;
      } catch (err) {
        failed += 1;
        this.log.warn({ txn: row.id, err: (err as Error).message }, "category write-through failed; will retry");
      }
    }
    return { pushed, failed };
  }

  /** Runs `run()` every interval until `stop()`. */
  start(): void {
    this.stopped = false;
    const tick = async () => {
      try {
        await this.run();
      } catch (err) {
        this.log.error({ err: (err as Error).message }, "sync failed");
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.options.intervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => undefined);
    await this.pushing?.catch(() => undefined);
  }
}
