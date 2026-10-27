import { isDeepStrictEqual } from "node:util";
import type { RuleDto, UiContext } from "../shared/api.js";
import { merchantKey } from "../shared/merchant.js";
import { evaluate, ruleActions, ruleDefinitionSchema, type RuleDefinition } from "../shared/rules.js";
import type { CategoryIndex } from "./categories.js";
import type { Queryable } from "./db.js";
import { appendDecision } from "./decisions.js";
import { HttpError } from "./errors.js";
import { backendSubject, merchantSettable, snapshot, toSubject, type TxnRow } from "./txns.js";

/**
 * The rules engine. Rules are versioned data (`rule` + `rule_version`); the newest active
 * rule that matches a transaction wins. Rules never touch a `manual` category. After a sync
 * they also leave `backend` categories alone (someone chose those in the backend); an
 * explicit backfill, which a person asks for, does not.
 *
 * Merchants first, then categories: the newest matching rule that sets a merchant sets it, and
 * then the newest matching rule that sets a category (looking at the merchant just set) sets
 * that. So a rule from the rules builder names an imported transaction, and a later "always
 * categorize <that merchant>" rule reaches it too. Rules never change a merchant set by hand
 * (`manual`), and after a sync leave one changed in the backend (`edited`) alone.
 *
 * Gift rules mark what they match as a gift: the app keeps its merchant out of lists, charts and
 * search. A gift marked or unmarked by hand (`manual`) stays as it is.
 */
export interface ActiveRule {
  id: number;
  version: number;
  definition: RuleDefinition;
}

export async function loadActiveRules(db: Queryable): Promise<ActiveRule[]> {
  const res = await db.query<{ id: number; version: number; definition: unknown }>(
    `SELECT r.id, v.version, v.definition
     FROM rule r JOIN rule_version v ON v.rule_id = r.id AND v.version = r.current_version
     WHERE r.deleted_at IS NULL
     ORDER BY r.id DESC`,
  );
  const out: ActiveRule[] = [];
  for (const row of res.rows) {
    const parsed = ruleDefinitionSchema.safeParse(row.definition);
    if (parsed.success) out.push({ id: row.id, version: row.version, definition: parsed.data });
  }
  return out;
}

/** The active rule, or a 404. */
async function findRule(db: Queryable, ruleId: number): Promise<ActiveRule> {
  const found = (await loadActiveRules(db)).find((r) => r.id === ruleId);
  if (!found) throw new HttpError(404, "no such rule");
  return found;
}

/**
 * The active rules, newest first, with how many transactions each has set the
 * category or the merchant of, or marked as gifts (and still has: a person or a newer rule may
 * have changed them since).
 */
export async function listRules(db: Queryable): Promise<RuleDto[]> {
  const res = await db.query<{
    id: number;
    version: number;
    definition: unknown;
    created_at: Date;
    updated_at: Date;
    applied: number;
    categorized: number;
    named: number;
    gifted: number;
  }>(
    `WITH hits AS (
       SELECT id, category_provenance AS provenance, 'category' AS what FROM txn
       WHERE deleted_at IS NULL AND category_provenance LIKE 'rule:%'
       UNION ALL
       SELECT id, merchant_provenance, 'merchant' FROM txn
       WHERE deleted_at IS NULL AND merchant_provenance LIKE 'rule:%' AND merchant IS NOT NULL
       UNION ALL
       SELECT id, gift_provenance, 'gift' FROM txn
       WHERE deleted_at IS NULL AND gift_provenance LIKE 'rule:%' AND gift
     ), counts AS (
       SELECT substr(provenance, 6)::int AS rule_id, count(DISTINCT id)::int AS applied,
         count(*) FILTER (WHERE what = 'category')::int AS categorized,
         count(*) FILTER (WHERE what = 'merchant')::int AS named,
         count(*) FILTER (WHERE what = 'gift')::int AS gifted
       FROM hits GROUP BY 1
     )
     SELECT r.id, v.version, v.definition, r.created_at, r.updated_at,
       coalesce(c.applied, 0) AS applied, coalesce(c.categorized, 0) AS categorized, coalesce(c.named, 0) AS named,
       coalesce(c.gifted, 0) AS gifted
     FROM rule r JOIN rule_version v ON v.rule_id = r.id AND v.version = r.current_version
     LEFT JOIN counts c ON c.rule_id = r.id
     WHERE r.deleted_at IS NULL ORDER BY r.id DESC`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    version: r.version,
    definition: r.definition,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    applied: r.applied,
    categorized: r.categorized,
    named: r.named,
    gifted: r.gifted,
  }));
}

/**
 * The transactions an active rule has set the category or the merchant of, or marked as gifts,
 * newest first.
 */
export async function ruleTransactions(db: Queryable, ruleId: number): Promise<TxnRow[]> {
  await findRule(db, ruleId);
  const res = await db.query<TxnRow>(
    `SELECT * FROM txn
     WHERE deleted_at IS NULL
       AND (category_provenance = $1 OR (merchant_provenance = $1 AND merchant IS NOT NULL) OR (gift_provenance = $1 AND gift))
     ORDER BY date DESC, id DESC`,
    [`rule:${ruleId}`],
  );
  return res.rows;
}

/**
 * Whether `rule` matches `row`. A rule that sets the merchant looks at the transaction as the
 * backend has it, so that filling in the merchant never changes what the rule matches, and
 * leaves transfers alone. So does a gift rule: a transfer is not a purchase.
 */
export function matches(rule: { definition: RuleDefinition }, row: TxnRow): boolean {
  const actions = ruleActions(rule.definition);
  if (actions.gift && row.type === "transfer") return false;
  if (actions.merchant === null) return evaluate(rule.definition.when, toSubject(row));
  // A rule naming a merchant is about purchases and refunds; a transfer has no merchant.
  return row.type !== "transfer" && evaluate(rule.definition.when, backendSubject(row));
}

/** After a sync: the newest rule that sets a merchant and matches, if a rule may set it. */
export function merchantMatch(rules: ActiveRule[], row: TxnRow): ActiveRule | undefined {
  if (!merchantSettable(row, true)) return undefined;
  return rules.find((r) => ruleActions(r.definition).merchant !== null && matches(r, row));
}

/** The newest rule that sets a known category and matches. */
export function categoryMatch(rules: ActiveRule[], row: TxnRow, categories: CategoryIndex): ActiveRule | undefined {
  return rules.find((r) => {
    const target = ruleActions(r.definition).categoryId;
    return target !== null && categories.has(target) && matches(r, row);
  });
}

/** The newest gift rule that matches, unless the gift was marked or unmarked by hand. */
export function giftMatch(rules: ActiveRule[], row: TxnRow): ActiveRule | undefined {
  if (row.gift_provenance === "manual") return undefined;
  return rules.find((r) => ruleActions(r.definition).gift && matches(r, row));
}

export function parseDefinition(raw: unknown, categories: CategoryIndex): RuleDefinition {
  const parsed = ruleDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `invalid rule: ${parsed.error.issues[0]?.message ?? "bad definition"}`);
  const { categoryId } = ruleActions(parsed.data);
  if (categoryId !== null && !categories.has(categoryId)) throw new HttpError(400, "rule targets an unknown category");
  return parsed.data;
}

/** A transaction a backfill would change, and what about it. */
export interface BackfillCandidate {
  row: TxnRow;
  /** The merchant it would get, when that is a change. */
  merchant: string | null;
  /** The category it would get, when that is a change. */
  categoryId: string | null;
  /** Whether it would be marked as a gift. */
  gift: boolean;
}

/**
 * Transactions a backfill of `definition` would change: matching, and either not yet with the
 * merchant it sets or not yet in the category it sets, or not yet a gift (never a merchant, a
 * category or a gift set by hand).
 */
export async function backfillCandidates(
  db: Queryable,
  definition: RuleDefinition,
  options: { excludeTxnId?: number; forUpdate?: boolean } = {},
): Promise<BackfillCandidate[]> {
  const actions = ruleActions(definition);
  const res = await db.query<TxnRow>(
    `SELECT * FROM txn
     WHERE deleted_at IS NULL AND id <> $1
       AND ((category_provenance <> 'manual' AND category_id IS DISTINCT FROM $2) OR $3::text IS NOT NULL
         OR ($4::boolean AND NOT gift AND gift_provenance <> 'manual'))
     ORDER BY date DESC, id DESC
     ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [options.excludeTxnId ?? -1, actions.categoryId, actions.merchant, actions.gift],
  );
  const out: BackfillCandidate[] = [];
  for (const row of res.rows) {
    if (!matches({ definition }, row)) continue;
    const merchant = actions.merchant !== null && merchantSettable(row, false) && row.merchant !== actions.merchant ? actions.merchant : null;
    const categoryId =
      actions.categoryId !== null && row.category_provenance !== "manual" && row.category_id !== actions.categoryId
        ? actions.categoryId
        : null;
    const gift = actions.gift && !row.gift && row.gift_provenance !== "manual";
    if (merchant !== null || categoryId !== null || gift) out.push({ row, merchant, categoryId, gift });
  }
  return out;
}

/** Sets a transaction's category from a rule, marking it for write-through. */
async function setFromRule(
  db: Queryable,
  row: TxnRow,
  rule: { id: number },
  categoryId: string,
  categories: CategoryIndex,
): Promise<void> {
  const name = categories.nameFor(categoryId);
  await db.query(
    `UPDATE txn SET category_id = $2, category_provenance = $3, category_set_at = now(),
       backend_dirty = ($4::text IS DISTINCT FROM backend_category), needs_rules = false
     WHERE id = $1`,
    [row.id, categoryId, `rule:${rule.id}`, name],
  );
}

/**
 * Sets a transaction's merchant from a rule, marking it for write-through. Its merchant
 * key follows, so merchant rules ("always categorize Starbucks as …") reach it from now on;
 * `needsRules` sends it back through them.
 */
async function setMerchantFromRule(
  db: Queryable,
  row: TxnRow,
  rule: { id: number },
  merchant: string,
  needsRules: boolean,
): Promise<TxnRow> {
  const res = await db.query<TxnRow>(
    `UPDATE txn SET merchant = $2, merchant_key = $3, merchant_provenance = $4,
       merchant_dirty = ($2::text IS DISTINCT FROM backend_merchant), needs_rules = $5
     WHERE id = $1 RETURNING *`,
    [row.id, merchant, merchantKey(merchant, row.description), `rule:${rule.id}`, needsRules],
  );
  return res.rows[0]!;
}

/** Marks a transaction as a gift from a rule. Nothing for the backend. */
async function giftFromRule(db: Queryable, row: TxnRow, rule: { id: number }): Promise<void> {
  await db.query("UPDATE txn SET gift = true, gift_provenance = $2 WHERE id = $1", [row.id, `rule:${rule.id}`]);
}

export async function backfill(
  db: Queryable,
  rule: { id: number; version: number; definition: RuleDefinition },
  ctx: { actor: string; uiContext?: UiContext; excludeTxnId?: number; categories: CategoryIndex },
): Promise<number> {
  const candidates = await backfillCandidates(db, rule.definition, { excludeTxnId: ctx.excludeTxnId, forUpdate: true });
  const newProvenance = `rule:${rule.id}`;
  const setsMerchant = ruleActions(rule.definition).merchant !== null;
  for (const { row, merchant, categoryId, gift } of candidates) {
    // A new merchant with no category from this rule: the category rules get a look at it.
    if (merchant !== null) await setMerchantFromRule(db, row, rule, merchant, categoryId === null);
    if (categoryId !== null) await setFromRule(db, row, rule, categoryId, ctx.categories);
    if (gift) await giftFromRule(db, row, rule);
    await appendDecision(db, {
      actor: ctx.actor,
      action: gift && merchant === null && categoryId === null ? "gift" : "rule_backfill",
      txnId: row.id,
      txnSnapshot: snapshot(row),
      oldCategoryId: row.category_id,
      oldProvenance: row.category_provenance,
      newCategoryId: categoryId ?? row.category_id,
      newProvenance: categoryId !== null ? newProvenance : row.category_provenance,
      ...(setsMerchant ? { oldMerchant: row.merchant, newMerchant: merchant ?? row.merchant } : {}),
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleDefinition: rule.definition,
      uiContext: ctx.uiContext,
    });
  }
  return candidates.length;
}

export interface SaveRuleResult {
  id: number;
  version: number;
  action: "rule_create" | "rule_update";
  backfilled: number;
}

/**
 * Creates a rule, or adds a version to the active rule with the same predicate (so toggling
 * "always categorize X" twice edits one rule rather than stacking two). Must run inside a
 * transaction.
 */
export async function saveRule(
  db: Queryable,
  input: {
    definition: RuleDefinition;
    ruleId?: number;
    applyToPast: boolean;
    actor: string;
    uiContext?: UiContext;
    sourceTxn?: TxnRow;
    categories: CategoryIndex;
  },
): Promise<SaveRuleResult> {
  let ruleId = input.ruleId;
  let previous: RuleDefinition | undefined;
  if (ruleId === undefined) {
    const same = (await loadActiveRules(db)).find((r) => isDeepStrictEqual(r.definition.when, input.definition.when));
    if (same) {
      ruleId = same.id;
      previous = same.definition;
    }
  } else {
    previous = (await findRule(db, ruleId)).definition;
  }

  let version: number;
  let action: "rule_create" | "rule_update";
  if (ruleId === undefined) {
    const created = await db.query<{ id: number }>("INSERT INTO rule (created_by) VALUES ($1) RETURNING id", [input.actor]);
    ruleId = created.rows[0]!.id;
    version = 1;
    action = "rule_create";
  } else {
    const bumped = await db.query<{ current_version: number }>(
      "UPDATE rule SET current_version = current_version + 1, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING current_version",
      [ruleId],
    );
    if (!bumped.rows[0]) throw new HttpError(404, "no such rule");
    version = bumped.rows[0].current_version;
    action = "rule_update";
  }
  await db.query("INSERT INTO rule_version (rule_id, version, definition, created_by) VALUES ($1, $2, $3, $4)", [
    ruleId,
    version,
    JSON.stringify(input.definition),
    input.actor,
  ]);
  await appendDecision(db, {
    actor: input.actor,
    action,
    txnId: input.sourceTxn?.id ?? null,
    txnSnapshot: input.sourceTxn ? snapshot(input.sourceTxn) : null,
    oldCategoryId: previous ? ruleActions(previous).categoryId : null,
    newCategoryId: ruleActions(input.definition).categoryId,
    newProvenance: `rule:${ruleId}`,
    oldMerchant: previous ? ruleActions(previous).merchant : null,
    newMerchant: ruleActions(input.definition).merchant,
    ruleId,
    ruleVersion: version,
    ruleDefinition: input.definition,
    uiContext: input.uiContext,
  });
  // A gift rule's gifts follow what it matches now: dates moved, the ones left out are unmarked.
  const unmarked = previous && ruleActions(previous).gift ? await ungiftUnmatched(db, { id: ruleId, version, definition: input.definition }, input) : 0;
  const backfilled = input.applyToPast
    ? await backfill(
        db,
        { id: ruleId, version, definition: input.definition },
        { actor: input.actor, uiContext: input.uiContext, excludeTxnId: input.sourceTxn?.id, categories: input.categories },
      )
    : 0;
  // Merchants just set: the category rules have a look at them now, not at the next sync.
  if (backfilled > 0 && ruleActions(input.definition).merchant !== null) await applyRulesToPending(db, input.categories);
  return { id: ruleId, version, action, backfilled: backfilled + unmarked };
}

/** Unmarks the gifts a gift rule marked that its new version no longer matches. */
async function ungiftUnmatched(
  db: Queryable,
  rule: { id: number; version: number; definition: RuleDefinition },
  ctx: { actor: string; uiContext?: UiContext },
): Promise<number> {
  const marked = await db.query<TxnRow>("SELECT * FROM txn WHERE gift AND gift_provenance = $1 AND deleted_at IS NULL FOR UPDATE", [
    `rule:${rule.id}`,
  ]);
  const gone = ruleActions(rule.definition).gift ? marked.rows.filter((row) => !matches(rule, row)) : marked.rows;
  for (const row of gone) {
    await db.query("UPDATE txn SET gift = false, gift_provenance = 'none' WHERE id = $1", [row.id]);
    await appendDecision(db, {
      actor: ctx.actor,
      action: "ungift",
      txnId: row.id,
      txnSnapshot: snapshot(row),
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleDefinition: rule.definition,
      uiContext: ctx.uiContext,
    });
  }
  return gone.length;
}

/** Deletes a rule. What it set stays, gifts too: deleting a gift rule gives nothing away. */
export async function deleteRule(db: Queryable, ruleId: number, actor: string, uiContext?: UiContext): Promise<void> {
  const rule = await findRule(db, ruleId);
  await db.query("UPDATE rule SET deleted_at = now(), updated_at = now() WHERE id = $1", [ruleId]);
  await appendDecision(db, {
    actor,
    action: "rule_delete",
    oldCategoryId: ruleActions(rule.definition).categoryId,
    oldMerchant: ruleActions(rule.definition).merchant,
    ruleId,
    ruleVersion: rule.version,
    ruleDefinition: rule.definition,
    uiContext,
  });
}

/**
 * Runs the rules over new and changed transactions (`needs_rules`). Returns how many changed
 * merchant or category.
 */
export async function applyRulesToPending(db: Queryable, categories: CategoryIndex): Promise<number> {
  const rules = await loadActiveRules(db);
  const pending = await db.query<TxnRow>("SELECT * FROM txn WHERE needs_rules AND deleted_at IS NULL ORDER BY id");
  let changed = 0;
  for (const row of pending.rows) {
    let current = row;
    const named = merchantMatch(rules, row);
    const merchant = named ? ruleActions(named.definition).merchant : null;
    if (named && merchant !== null && (row.merchant !== merchant || row.merchant_provenance !== `rule:${named.id}`)) {
      current = await setMerchantFromRule(db, row, named, merchant, false);
    }
    const protectedLabel = current.category_provenance === "manual" || current.category_provenance === "backend";
    const rule = protectedLabel ? undefined : categoryMatch(rules, current, categories);
    const target = rule ? ruleActions(rule.definition).categoryId : null;
    const recategorized = rule && target !== null && (current.category_id !== target || current.category_provenance !== `rule:${rule.id}`);
    if (recategorized) await setFromRule(db, current, rule, target, categories);
    // A gift already marked stays as it was marked: another rule never takes it over.
    const gift = current.gift ? undefined : giftMatch(rules, current);
    const gifted = gift !== undefined;
    if (gifted) await giftFromRule(db, current, gift);
    if (current !== row || recategorized || gifted) changed += 1;
  }
  await db.query("UPDATE txn SET needs_rules = false WHERE needs_rules AND id = ANY($1)", [pending.rows.map((r) => r.id)]);
  return changed;
}
