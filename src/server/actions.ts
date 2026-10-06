import type { RecategorizeRequest, RecategorizeResponse, SuggestionsDto } from "../shared/api.js";
import { merchantRule } from "../shared/rules.js";
import { CategoryIndex } from "./categories.js";
import { inTransaction, type Db, type Queryable } from "./db.js";
import { appendDecision } from "./decisions.js";
import { HttpError } from "./errors.js";
import { saveRule } from "./rules.js";
import { snapshot, toDto, type TxnRow } from "./txns.js";

/**
 * A person sets a transaction's category: the category becomes `manual` (rules never touch
 * it again), the decision is logged with a snapshot, and optionally an "always categorize
 * this merchant as X" rule is created and applied to the past. All of it in one database
 * transaction; the write-through to the backend follows (see SyncService.pushDirty).
 */
export async function recategorize(
  db: Db,
  txnId: number,
  req: RecategorizeRequest,
  actor: string,
): Promise<RecategorizeResponse> {
  return inTransaction(db, async (client) => {
    const categories = await CategoryIndex.load(client);
    if (!categories.has(req.categoryId)) throw new HttpError(400, "unknown category");
    const found = await client.query<TxnRow>("SELECT * FROM txn WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [txnId]);
    const before = found.rows[0];
    if (!before) throw new HttpError(404, "no such transaction");

    const name = categories.nameFor(req.categoryId);
    const updated = await client.query<TxnRow>(
      `UPDATE txn SET category_id = $2, category_provenance = 'manual', category_set_at = now(),
         backend_dirty = ($3::text IS DISTINCT FROM backend_category), needs_rules = false
       WHERE id = $1 RETURNING *`,
      [txnId, req.categoryId, name],
    );
    await appendDecision(client, {
      actor,
      action: "recategorize",
      txnId,
      txnSnapshot: snapshot(before),
      oldCategoryId: before.category_id,
      oldProvenance: before.category_provenance,
      newCategoryId: req.categoryId,
      newProvenance: "manual",
      uiContext: req.uiContext,
    });

    const response: RecategorizeResponse = { txn: toDto(updated.rows[0]!) };
    if (req.merchantRule) {
      const saved = await saveRule(client, {
        definition: merchantRule(before.merchant, before.description, req.categoryId),
        applyToPast: req.merchantRule.applyToPast,
        actor,
        uiContext: req.uiContext,
        sourceTxn: before,
        categories,
      });
      response.rule = { id: saved.id, version: saved.version, backfilled: saved.backfilled };
    }
    return response;
  });
}

/**
 * Categories to offer first for a transaction: what this merchant's other transactions are
 * filed under (confirmed labels count more), then Plaid's own guess; and, separately, the
 * categories most recently chosen by hand.
 */
export async function suggestions(db: Queryable, txnId: number): Promise<SuggestionsDto> {
  const found = await db.query<TxnRow>("SELECT * FROM txn WHERE id = $1", [txnId]);
  const row = found.rows[0];
  if (!row) throw new HttpError(404, "no such transaction");
  const categories = await CategoryIndex.load(db);

  const sameMerchant = await db.query<{ category_id: string }>(
    `SELECT category_id,
            sum(CASE WHEN category_provenance = 'manual' THEN 5
                     WHEN category_provenance LIKE 'rule:%' THEN 3 ELSE 1 END) AS score
     FROM txn
     WHERE merchant_key = $1 AND id <> $2 AND category_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY category_id ORDER BY score DESC, category_id LIMIT 4`,
    [row.merchant_key, row.id],
  );
  const likely: string[] = sameMerchant.rows.map((r) => r.category_id);
  const plaid = row.plaid_primary && row.plaid_detailed
    ? categories.idForPlaid({ primary: row.plaid_primary, detailed: row.plaid_detailed })
    : null;
  if (plaid) likely.push(plaid);

  const recent = await db.query<{ new_category_id: string }>(
    `SELECT new_category_id FROM (
       SELECT new_category_id, max(id) AS last FROM decision_event
       WHERE action = 'recategorize' AND new_category_id IS NOT NULL
       GROUP BY new_category_id
     ) d ORDER BY last DESC LIMIT 8`,
  );
  const unique = (ids: string[]) => [...new Set(ids)].filter((id) => categories.has(id));
  return { likely: unique(likely), recent: unique(recent.rows.map((r) => r.new_category_id)) };
}
