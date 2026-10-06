import { isDeepStrictEqual } from "node:util";
import type { RuleDto, UiContext } from "../shared/api.js";
import { evaluate, ruleDefinitionSchema, type RuleDefinition } from "../shared/rules.js";
import type { CategoryIndex } from "./categories.js";
import type { Queryable } from "./db.js";
import { appendDecision } from "./decisions.js";
import { HttpError } from "./errors.js";
import { snapshot, toSubject, type TxnRow } from "./txns.js";

/**
 * The rules engine. Rules are versioned data (`rule` + `rule_version`); the newest active
 * rule that matches a transaction wins. Rules never touch a `manual` category. After a sync
 * they also leave `backend` categories alone (someone chose those in the backend); an
 * explicit backfill, which a person asks for, does not.
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

export async function listRules(db: Queryable): Promise<RuleDto[]> {
  const res = await db.query<{ id: number; version: number; definition: unknown; created_at: Date; updated_at: Date }>(
    `SELECT r.id, v.version, v.definition, r.created_at, r.updated_at
     FROM rule r JOIN rule_version v ON v.rule_id = r.id AND v.version = r.current_version
     WHERE r.deleted_at IS NULL ORDER BY r.id DESC`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    version: r.version,
    definition: r.definition,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export function firstMatch(rules: ActiveRule[], row: TxnRow): ActiveRule | undefined {
  const subject = toSubject(row);
  return rules.find((r) => evaluate(r.definition.when, subject));
}

export function parseDefinition(raw: unknown, categories: CategoryIndex): RuleDefinition {
  const parsed = ruleDefinitionSchema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `invalid rule: ${parsed.error.issues[0]?.message ?? "bad definition"}`);
  if (!categories.has(parsed.data.then.categoryId)) throw new HttpError(400, "rule targets an unknown category");
  return parsed.data;
}

/** Transactions a backfill of `definition` would change: matching, not manual, not already there. */
export async function backfillCandidates(
  db: Queryable,
  definition: RuleDefinition,
  options: { excludeTxnId?: number; forUpdate?: boolean } = {},
): Promise<TxnRow[]> {
  const res = await db.query<TxnRow>(
    `SELECT * FROM txn
     WHERE deleted_at IS NULL AND category_provenance <> 'manual'
       AND category_id IS DISTINCT FROM $1 AND id <> $2
     ORDER BY date DESC, id DESC
     ${options.forUpdate ? "FOR UPDATE" : ""}`,
    [definition.then.categoryId, options.excludeTxnId ?? -1],
  );
  return res.rows.filter((row) => evaluate(definition.when, toSubject(row)));
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

export async function backfill(
  db: Queryable,
  rule: { id: number; version: number; definition: RuleDefinition },
  ctx: { actor: string; uiContext?: UiContext; excludeTxnId?: number; categories: CategoryIndex },
): Promise<number> {
  const rows = await backfillCandidates(db, rule.definition, { excludeTxnId: ctx.excludeTxnId, forUpdate: true });
  const newProvenance = `rule:${rule.id}`;
  for (const row of rows) {
    await setFromRule(db, row, rule, rule.definition.then.categoryId, ctx.categories);
    await appendDecision(db, {
      actor: ctx.actor,
      action: "rule_backfill",
      txnId: row.id,
      txnSnapshot: snapshot(row),
      oldCategoryId: row.category_id,
      oldProvenance: row.category_provenance,
      newCategoryId: rule.definition.then.categoryId,
      newProvenance,
      ruleId: rule.id,
      ruleVersion: rule.version,
      ruleDefinition: rule.definition,
      uiContext: ctx.uiContext,
    });
  }
  return rows.length;
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
    const found = (await loadActiveRules(db)).find((r) => r.id === ruleId);
    if (!found) throw new HttpError(404, "no such rule");
    previous = found.definition;
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
    oldCategoryId: previous?.then.categoryId ?? null,
    newCategoryId: input.definition.then.categoryId,
    newProvenance: `rule:${ruleId}`,
    ruleId,
    ruleVersion: version,
    ruleDefinition: input.definition,
    uiContext: input.uiContext,
  });
  const backfilled = input.applyToPast
    ? await backfill(
        db,
        { id: ruleId, version, definition: input.definition },
        { actor: input.actor, uiContext: input.uiContext, excludeTxnId: input.sourceTxn?.id, categories: input.categories },
      )
    : 0;
  return { id: ruleId, version, action, backfilled };
}

export async function deleteRule(db: Queryable, ruleId: number, actor: string, uiContext?: UiContext): Promise<void> {
  const rule = (await loadActiveRules(db)).find((r) => r.id === ruleId);
  if (!rule) throw new HttpError(404, "no such rule");
  await db.query("UPDATE rule SET deleted_at = now(), updated_at = now() WHERE id = $1", [ruleId]);
  await appendDecision(db, {
    actor,
    action: "rule_delete",
    oldCategoryId: rule.definition.then.categoryId,
    ruleId,
    ruleVersion: rule.version,
    ruleDefinition: rule.definition,
    uiContext,
  });
}

/**
 * Runs the rules over new and changed transactions (`needs_rules`). Returns how many
 * changed category.
 */
export async function applyRulesToPending(db: Queryable, categories: CategoryIndex): Promise<number> {
  const rules = await loadActiveRules(db);
  const pending = await db.query<TxnRow>("SELECT * FROM txn WHERE needs_rules AND deleted_at IS NULL ORDER BY id");
  let changed = 0;
  for (const row of pending.rows) {
    const protectedLabel = row.category_provenance === "manual" || row.category_provenance === "backend";
    const rule = protectedLabel ? undefined : firstMatch(rules, row);
    const target = rule?.definition.then.categoryId;
    if (rule && target && categories.has(target) && (row.category_id !== target || row.category_provenance !== `rule:${rule.id}`)) {
      await setFromRule(db, row, rule, target, categories);
      changed += 1;
    }
  }
  await db.query("UPDATE txn SET needs_rules = false WHERE needs_rules AND id = ANY($1)", [pending.rows.map((r) => r.id)]);
  return changed;
}
