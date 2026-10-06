import type { Writable } from "node:stream";
import type { UiContext } from "../shared/api.js";
import type { Db, Queryable } from "./db.js";

export type DecisionAction = "recategorize" | "rule_create" | "rule_update" | "rule_delete" | "rule_backfill";

export interface DecisionEvent {
  actor: string;
  action: DecisionAction;
  txnId?: number | null;
  txnSnapshot?: Record<string, unknown> | null;
  oldCategoryId?: string | null;
  oldProvenance?: string | null;
  newCategoryId?: string | null;
  newProvenance?: string | null;
  ruleId?: number | null;
  ruleVersion?: number | null;
  ruleDefinition?: unknown;
  uiContext?: UiContext | null;
}

/** The only write path to `decision_event`: inserts. The table's triggers refuse the rest. */
export async function appendDecision(db: Queryable, e: DecisionEvent): Promise<number> {
  const res = await db.query<{ id: number }>(
    `INSERT INTO decision_event
       (actor, action, txn_id, txn_snapshot, old_category_id, old_provenance, new_category_id,
        new_provenance, rule_id, rule_version, rule_definition, ui_context)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      e.actor,
      e.action,
      e.txnId ?? null,
      e.txnSnapshot ? JSON.stringify(e.txnSnapshot) : null,
      e.oldCategoryId ?? null,
      e.oldProvenance ?? null,
      e.newCategoryId ?? null,
      e.newProvenance ?? null,
      e.ruleId ?? null,
      e.ruleVersion ?? null,
      e.ruleDefinition === undefined ? null : JSON.stringify(e.ruleDefinition),
      JSON.stringify(e.uiContext ?? {}),
    ],
  );
  return res.rows[0]!.id;
}

interface EventRow {
  id: number;
  occurred_at: Date;
  actor: string;
  action: string;
  txn_id: number | null;
  txn_snapshot: unknown;
  old_category_id: string | null;
  old_provenance: string | null;
  new_category_id: string | null;
  new_provenance: string | null;
  rule_id: number | null;
  rule_version: number | null;
  rule_definition: unknown;
  ui_context: unknown;
  schema_version: number;
}

export function eventToJson(r: EventRow): Record<string, unknown> {
  return {
    id: r.id,
    occurredAt: r.occurred_at.toISOString(),
    actor: r.actor,
    action: r.action,
    txnId: r.txn_id,
    txn: r.txn_snapshot,
    oldCategoryId: r.old_category_id,
    oldProvenance: r.old_provenance,
    newCategoryId: r.new_category_id,
    newProvenance: r.new_provenance,
    ruleId: r.rule_id,
    ruleVersion: r.rule_version,
    rule: r.rule_definition,
    uiContext: r.ui_context,
    schemaVersion: r.schema_version,
  };
}

/** Writes every event after `afterId` as JSON lines, oldest first, in batches. */
export async function exportJsonl(db: Db, afterId: number, out: Writable): Promise<number> {
  let last = afterId;
  let count = 0;
  for (;;) {
    const res = await db.query<EventRow>("SELECT * FROM decision_event WHERE id > $1 ORDER BY id LIMIT 1000", [last]);
    if (res.rows.length === 0) break;
    const chunk = res.rows.map((r) => JSON.stringify(eventToJson(r))).join("\n") + "\n";
    if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    count += res.rows.length;
    last = res.rows[res.rows.length - 1]!.id;
  }
  return count;
}
