import type { RecategorizeRequest, RecategorizeResponse, SuggestionsDto } from "../shared/api.js";
import { merchantKey } from "../shared/merchant.js";
import { merchantRule } from "../shared/rules.js";
import { CategoryIndex } from "./categories.js";
import { inTransaction, type Db, type Queryable } from "./db.js";
import { appendDecision } from "./decisions.js";
import { HttpError } from "./errors.js";
import { candidatesForTxn } from "./builder.js";
import { applyRulesToPending, parseDefinition, saveRule } from "./rules.js";
import { snapshot, toDto, type TxnRow } from "./txns.js";

/**
 * A person changes a transaction: its category (from now on `manual`: rules never touch it
 * again), its merchant (`manual` too), or both; and, optionally, saves a rule for the
 * transactions like it at the same time. The decision is logged with a snapshot. All of it in
 * one database transaction; the write-through to the backend follows (see
 * SyncService.pushDirty).
 */
export async function recategorize(
  db: Db,
  txnId: number,
  req: RecategorizeRequest,
  actor: string,
): Promise<RecategorizeResponse> {
  return inTransaction(db, async (client) => {
    const categories = await CategoryIndex.load(client);
    if (req.categoryId !== undefined && !categories.has(req.categoryId)) throw new HttpError(400, "unknown category");
    const found = await client.query<TxnRow>("SELECT * FROM txn WHERE id = $1 AND deleted_at IS NULL FOR UPDATE", [txnId]);
    const before = found.rows[0];
    if (!before) throw new HttpError(404, "no such transaction");
    const merchant = req.merchant?.trim();
    if (merchant !== undefined && before.type === "transfer") throw new HttpError(400, "a transfer has no merchant");
    // Parsed before anything changes, so a bad rule changes nothing.
    const rule = req.rule ? parseDefinition(req.rule.definition, categories) : null;
    if (req.merchantRule && req.categoryId === undefined) throw new HttpError(400, "a merchant rule needs a category");

    if (req.categoryId !== undefined) {
      await client.query(
        `UPDATE txn SET category_id = $2, category_provenance = 'manual', category_set_at = now(),
           backend_dirty = ($3::text IS DISTINCT FROM backend_category), needs_rules = false
         WHERE id = $1`,
        [txnId, req.categoryId, categories.nameFor(req.categoryId)],
      );
    }
    if (merchant !== undefined) {
      // With no category chosen, the category rules get a look at the new merchant.
      await client.query(
        `UPDATE txn SET merchant = $2, merchant_key = $3, merchant_provenance = 'manual',
           merchant_dirty = ($2::text IS DISTINCT FROM backend_merchant), needs_rules = needs_rules OR $4
         WHERE id = $1`,
        [txnId, merchant, merchantKey(merchant, before.description), req.categoryId === undefined],
      );
    }
    if (req.categoryId !== undefined || merchant !== undefined) {
      await appendDecision(client, {
        actor,
        action: req.categoryId !== undefined ? "recategorize" : "rename",
        txnId,
        txnSnapshot: snapshot(before),
        oldCategoryId: before.category_id,
        oldProvenance: before.category_provenance,
        newCategoryId: req.categoryId ?? before.category_id,
        newProvenance: req.categoryId !== undefined ? "manual" : before.category_provenance,
        ...(merchant !== undefined ? { oldMerchant: before.merchant, newMerchant: merchant } : {}),
        uiContext: req.uiContext,
      });
    }

    const response: Partial<RecategorizeResponse> = {};
    const definition = rule ?? (req.merchantRule ? merchantRule(before.merchant, before.description, req.categoryId!) : null);
    if (definition) {
      const saved = await saveRule(client, {
        definition,
        applyToPast: req.rule?.applyToPast ?? req.merchantRule?.applyToPast ?? false,
        actor,
        uiContext: req.uiContext,
        sourceTxn: before,
        categories,
      });
      response.rule = { id: saved.id, version: saved.version, backfilled: saved.backfilled };
    }
    if (merchant !== undefined && req.categoryId === undefined) await applyRulesToPending(client, categories);
    const after = await client.query<TxnRow>("SELECT * FROM txn WHERE id = $1", [txnId]);
    return { txn: toDto(after.rows[0]!), ...response };
  });
}

/**
 * Categories to offer first for a transaction: what this merchant's other transactions are
 * filed under (confirmed labels count more), then Plaid's own guess; and, separately, the
 * categories most recently chosen by hand. For a transaction missing a merchant or a category,
 * also the merchants it looks like, to copy them from.
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
  return {
    likely: unique(likely),
    recent: unique(recent.rows.map((r) => r.new_category_id)),
    candidates: await candidatesForTxn(db, row),
  };
}
