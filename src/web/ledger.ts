import { startTransition, useCallback, useMemo, useRef, useState } from "react";
import type { BuilderDto, RuleDto, TxnDto } from "../shared/api.js";
import { withGift } from "../shared/gift.js";
import { merchantKey } from "../shared/merchant.js";
import { evaluate, ruleActions, type RuleDefinition } from "../shared/rules.js";

/**
 * What the app shows, as the server last said it, with the changes made here still on their
 * way on top.
 *
 * A change is shown at once (`apply`) and queued; the queue sends one at a time, in order, so a
 * change to a rule made a moment ago reaches the server after the rule. Once the server takes a
 * change, it is folded into what the server has said (with the ids the server gave); if it
 * refuses one, the change is dropped, and the screen is as it was without it. When the queue is
 * empty, a quiet refresh swaps the guesses here for the server's own answers.
 *
 * Rules made here get a temporary id (negative) until the server gives them theirs; `idOf`
 * turns one into the other, so a change queued behind a new rule finds it.
 */
export interface LedgerState {
  txns: TxnDto[] | null;
  rules: RuleDto[] | null;
  builder: BuilderDto | null;
}

/** A temporary id → the server's, once it is known. */
export type IdOf = (id: number) => number;

export interface Change {
  /** What it is, for the message if the server refuses it ("rule for Trader Joe's"). */
  label: string;
  /** The change, over any state: shown at once, and again over every newer state. */
  apply(state: LedgerState, idOf: IdOf): LedgerState;
  /**
   * Sends it. May return the change as the server made it, to fold into the server's state;
   * otherwise `apply` is.
   */
  send(idOf: IdOf): Promise<((state: LedgerState, idOf: IdOf) => LedgerState) | void>;
}

interface Pending {
  seq: number;
  change: Change;
}

export function useLedger(onRefused: (label: string, err: Error) => void, onSettled: () => void) {
  const [confirmed, setConfirmed] = useState<LedgerState>({ txns: null, rules: null, builder: null });
  const [pending, setPending] = useState<Pending[]>([]);
  const ids = useRef(new Map<number, number>());
  const temps = useRef(new Map<number, number>());
  const nextTemp = useRef(-1);
  const seq = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const inFlight = useRef(0);
  /** Bumped whenever the server takes a change: a refresh started before then is out of date. */
  const generation = useRef(0);
  const confirmedRef = useRef(confirmed);
  confirmedRef.current = confirmed;
  const callbacks = useRef({ onRefused, onSettled });
  callbacks.current = { onRefused, onSettled };

  const idOf = useCallback<IdOf>((id) => ids.current.get(id) ?? id, []);

  const state = useMemo(() => pending.reduce((s, p) => p.change.apply(s, idOf), confirmed), [confirmed, pending, idOf]);

  const commit = useCallback(
    (change: Change) => {
      const entry = { seq: seq.current++, change };
      inFlight.current += 1;
      setPending((p) => [...p, entry]);
      queue.current = queue.current.then(async () => {
        try {
          const made = (await change.send(idOf)) ?? change.apply.bind(change);
          generation.current += 1;
          // One render: the change leaves the queue as it lands in the server's state.
          setConfirmed((c) => made(c, idOf));
        } catch (err) {
          callbacks.current.onRefused(change.label, err as Error);
        } finally {
          setPending((p) => p.filter((e) => e !== entry));
          inFlight.current -= 1;
          if (inFlight.current === 0) callbacks.current.onSettled();
        }
      });
    },
    [idOf],
  );

  /** A new temporary id, for a rule the server has not numbered yet. */
  const tempId = useCallback(() => nextTemp.current--, []);
  /**
   * Records the server's id for a temporary one. A rule that was already there (the server
   * edited it rather than make another) keeps its own key.
   */
  const resolved = useCallback((temp: number, id: number) => {
    ids.current.set(temp, id);
    if (!confirmedRef.current.rules?.some((r) => r.id === id)) temps.current.set(id, temp);
  }, []);
  /** The same key for a rule before and after the server numbers it (for lists and animations). */
  const keyOf = useCallback((id: number) => temps.current.get(id) ?? id, []);

  /**
   * The server's state: what a load or a refresh brought. Out of date if the server took a
   * change while it was on its way (returns false; another refresh follows that change).
   */
  const receive = useCallback((patch: Partial<LedgerState>, since?: number) => {
    if (since !== undefined && since !== generation.current) return false;
    startTransition(() => setConfirmed((c) => ({ ...c, ...patch })));
    return true;
  }, []);

  const stamp = useCallback(() => generation.current, []);
  /** What the server has said, as of now. */
  const server = useCallback(() => confirmedRef.current, []);
  const busy = useCallback(() => inFlight.current > 0, []);

  return { state, confirmed, pending: pending.length, commit, tempId, resolved, keyOf, receive, stamp, busy, server };
}

export type Ledger = ReturnType<typeof useLedger>;

// --- Changes, shown here before the server makes them -----------------------------------

/** The fields of a transaction a rule looks at. */
const subject = (t: TxnDto) => ({
  merchant: t.merchantSource === "none" ? null : t.merchant,
  description: t.description,
  accountName: t.accountName,
  amount: t.amount,
  date: t.date,
});

/**
 * A rule applied to past transactions, as the server will: never a merchant or a category set
 * by hand, never a transfer's merchant. A gift rule marks gifts, never a transfer, a gift
 * already marked, or one unmarked by hand. Returns the same array when nothing changes.
 */
export function applyRule(txns: TxnDto[], id: number, definition: RuleDefinition): TxnDto[] {
  const then = ruleActions(definition);
  const source = `rule:${id}`;
  let changed = false;
  const out = txns.map((t) => {
    if (then.gift) {
      if (t.gift || t.giftSource === "manual" || t.type === "transfer" || !evaluate(definition.when, subject(t))) return t;
      changed = true;
      return withGift(t, true, source);
    }
    if (!evaluate(definition.when, subject(t))) return t;
    let next = t;
    // As the server's backfill: only what it changes (one already in the category stays as it is).
    if (then.categoryId && t.provenance !== "manual" && t.categoryId !== then.categoryId) {
      next = { ...next, categoryId: then.categoryId, provenance: source };
    }
    if (then.merchant && t.merchantSource !== "manual" && t.type !== "transfer" && (t.merchant !== then.merchant || t.merchantSource === "none")) {
      next = { ...next, merchant: then.merchant, merchantKey: merchantKey(then.merchant, t.description), merchantSource: source };
    }
    if (next !== t) changed = true;
    return next;
  });
  return changed ? out : txns;
}

/**
 * The rule list with a rule saved: a new version of the rule with that id, or of the rule with
 * the same predicate (the server edits that one rather than stacking two), or a new rule first.
 */
export function upsertRule(rules: RuleDto[], id: number, definition: RuleDefinition): RuleDto[] {
  const now = new Date().toISOString();
  const same = JSON.stringify(definition.when);
  const i = rules.findIndex((r) => r.id === id || JSON.stringify((r.definition as RuleDefinition | null)?.when) === same);
  if (i >= 0) {
    const old = rules[i]!;
    const next = [...rules];
    next[i] = { ...old, id: old.id < 0 ? id : old.id, version: old.version + 1, definition, updatedAt: now };
    return next;
  }
  return [{ id, version: 1, definition, createdAt: now, updatedAt: now, applied: 0, categorized: 0, named: 0, gifted: 0 }, ...rules];
}

/**
 * The rules builder with a rule applied to the past: a group all of whose descriptions it
 * matches no longer misses what it sets, and goes once it misses nothing.
 */
export function fillGroups(builder: BuilderDto, definition: RuleDefinition): BuilderDto {
  const then = ruleActions(definition);
  if (then.gift) return builder;
  let changed = false;
  const groups = builder.groups.flatMap((g) => {
    const covered = g.descriptions.every((d) => evaluate(definition.when, { merchant: null, description: d.description, accountName: null, amount: 0 }));
    if (!covered) return [g];
    const missingMerchant = then.merchant ? 0 : g.missingMerchant;
    const missingCategory = then.categoryId ? 0 : g.missingCategory;
    if (missingMerchant === g.missingMerchant && missingCategory === g.missingCategory) return [g];
    changed = true;
    return missingMerchant === 0 && missingCategory === 0 ? [] : [{ ...g, missingMerchant, missingCategory }];
  });
  return changed ? { ...builder, groups } : builder;
}

/** How many transactions each rule has set now, from the transactions themselves. */
export function ruleCounts(txns: TxnDto[] | null): Map<number, RuleCount> {
  const out = new Map<number, RuleCount>();
  const at = (id: number) => {
    let c = out.get(id);
    if (!c) out.set(id, (c = { applied: 0, named: 0, categorized: 0, gifted: 0 }));
    return c;
  };
  for (const t of txns ?? []) {
    const cat = t.provenance.startsWith("rule:") ? Number(t.provenance.slice(5)) : null;
    const mer = t.merchantSource.startsWith("rule:") ? Number(t.merchantSource.slice(5)) : null;
    if (cat !== null) at(cat).categorized += 1;
    if (mer !== null) at(mer).named += 1;
    if (cat !== null) at(cat).applied += 1;
    if (mer !== null && mer !== cat) at(mer).applied += 1;
    const gift = t.gift && t.giftSource.startsWith("rule:") ? Number(t.giftSource.slice(5)) : null;
    if (gift !== null) {
      at(gift).gifted += 1;
      if (gift !== cat && gift !== mer) at(gift).applied += 1;
    }
  }
  return out;
}

export interface RuleCount {
  applied: number;
  named: number;
  categorized: number;
  gifted: number;
}
