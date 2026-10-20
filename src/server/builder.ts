import type { BuilderCandidateDto, BuilderDto, BuilderGroupDto, BuilderTxnDto } from "../shared/api.js";
import { descriptionKey, merchantDisplay, normalizeText } from "../shared/merchant.js";
import type { Queryable } from "./db.js";
import type { TxnRow } from "./txns.js";

/**
 * The rules builder: transactions missing a merchant or a category (an imported bank statement
 * has neither), grouped by their `descriptionKey`, each group with the merchants whose
 * transactions look most like it. A merchant's transactions that have both a merchant and a
 * category are the source of a proposed rule: "description reduces to <key> → this merchant,
 * this category" (`descriptionKeyRule`).
 *
 * Grouping is plain equality of keys. Matching a group to a merchant is fuzzy, two ways, and
 * the better one counts:
 * - the description: the Dice coefficient of the character trigrams of the group's key and of
 *   each of the merchant's own description keys (spaces dropped, so "trader joe s" and
 *   "trader joes" are the same), and
 * - the name: how much of the merchant's name is words of the group's key, and how much of the
 *   key it covers ("uber eats" names "uber eats" better than "uber" does), scaled down a
 *   little, since a name is weaker evidence than a description.
 */

/** Transactions listed per group. */
export const BUILDER_TXN_LIMIT = 20;
/** Below this, a merchant is not proposed. */
export const MIN_CONFIDENCE = 0.5;
const MAX_CANDIDATES = 3;
/** A name found in the description counts for a little less than a matching description. */
const NAME_WEIGHT = 0.9;
/** Words that say nothing about who the merchant is. */
const STOPWORDS = new Set(["the", "and", "&", "of", "inc", "llc", "co"]);

export function trigrams(key: string): Set<string> {
  const s = ` ${key.replace(/ /g, "")} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return out;
}

export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (large.has(g)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

const words = (text: string): string[] => normalizeText(text).split(" ").filter((w) => w && !STOPWORDS.has(w));

/**
 * How well a merchant's name is found in a group's key: the share of the name's words that are
 * in the key, times (half plus half the share of the key's words they cover).
 */
export function nameScore(merchant: string, key: string): number {
  const name = words(merchant);
  const keyWords = new Set(words(key));
  if (name.length === 0 || keyWords.size === 0) return 0;
  const found = name.filter((w) => keyWords.has(w)).length;
  return (found / name.length) * (0.5 + (0.5 * found) / keyWords.size);
}

/** Whether a transaction is missing a merchant or a category. Transfers have neither, by design. */
export const isDeficient = (row: TxnRow): boolean => row.type !== "transfer" && (row.merchant === null || row.category_id === null);

function toBuilderTxn(row: TxnRow): BuilderTxnDto {
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    description: row.description,
    merchant: row.merchant,
    accountName: row.account_name,
    categoryId: row.category_id,
    provenance: row.category_provenance,
  };
}

/** Confirmed categories count for more, as in the recategorize sheet's suggestions. */
const weight = (row: TxnRow): number =>
  row.category_provenance === "manual" ? 5 : row.category_provenance.startsWith("rule:") ? 3 : 1;

/** The category with the most weight among `rows`, and how many of them are in it. */
function topCategory(rows: TxnRow[]): { categoryId: string; count: number } | null {
  const tally = new Map<string, { weight: number; count: number }>();
  for (const r of rows) {
    if (!r.category_id) continue;
    const t = tally.get(r.category_id) ?? { weight: 0, count: 0 };
    t.weight += weight(r);
    t.count += 1;
    tally.set(r.category_id, t);
  }
  let best: { categoryId: string; weight: number; count: number } | null = null;
  for (const [categoryId, t] of tally) {
    if (!best || t.weight > best.weight || (t.weight === best.weight && categoryId < best.categoryId)) best = { categoryId, ...t };
  }
  return best && { categoryId: best.categoryId, count: best.count };
}

interface SourceKey {
  key: string;
  grams: Set<string>;
  /** Newest first. */
  rows: TxnRow[];
}

/** A merchant with transactions that have both a merchant and a category. */
interface Source {
  merchant: string;
  rows: TxnRow[];
  keys: SourceKey[];
  category: { categoryId: string; count: number };
}

function sources(rows: TxnRow[]): Source[] {
  const byMerchant = new Map<string, TxnRow[]>();
  for (const r of rows) {
    if (r.type === "transfer" || r.merchant === null || r.category_id === null) continue;
    const list = byMerchant.get(r.merchant) ?? [];
    list.push(r);
    byMerchant.set(r.merchant, list);
  }
  const out: Source[] = [];
  for (const [merchant, list] of byMerchant) {
    const byKey = new Map<string, TxnRow[]>();
    for (const r of list) {
      const k = descriptionKey(r.description);
      const l = byKey.get(k) ?? [];
      l.push(r);
      byKey.set(k, l);
    }
    // A merchant with a reference number in every description has as many keys as charges; the
    // most common ones are enough to compare with.
    const keys = [...byKey]
      .sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([key, l]) => ({ key, grams: trigrams(key), rows: l }));
    out.push({ merchant, rows: list, keys, category: topCategory(list)! });
  }
  return out;
}

/** The merchants most like a group, best first. */
export function candidatesFor(key: string, all: Source[]): BuilderCandidateDto[] {
  const grams = trigrams(key);
  const scored: BuilderCandidateDto[] = [];
  for (const src of all) {
    const sims = src.keys.map((k) => ({ k, similarity: k.key === key ? 1 : dice(grams, k.grams) })).sort((a, b) => b.similarity - a.similarity);
    const bestDescription = sims[0]?.similarity ?? 0;
    const byName = NAME_WEIGHT * nameScore(src.merchant, key);
    const confidence = Math.max(bestDescription, byName);
    if (confidence < MIN_CONFIDENCE) continue;
    const reason = bestDescription >= byName ? (bestDescription === 1 ? "same" : "similar") : "name";
    const evidence = sims
      .filter((s) => s.similarity >= MIN_CONFIDENCE / 2)
      .slice(0, 3)
      .map((s) => ({ description: s.k.rows[0]!.description, similarity: round(s.similarity), count: s.k.rows.length }));
    const exampleRows = (sims[0] && sims[0].similarity >= MIN_CONFIDENCE ? sims[0].k.rows : src.rows).slice(0, 3);
    scored.push({
      merchant: src.merchant,
      categoryId: src.category.categoryId,
      confidence: round(confidence),
      reason,
      sourceCount: src.rows.length,
      categoryCount: src.category.count,
      evidence,
      examples: exampleRows.map(toBuilderTxn),
    });
  }
  return scored.sort((a, b) => b.confidence - a.confidence || b.sourceCount - a.sourceCount).slice(0, MAX_CANDIDATES);
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** The groups and their candidates, from every live transaction (newest first). */
export function buildGroups(rows: TxnRow[]): BuilderDto {
  const all = sources(rows);
  const byKey = new Map<string, TxnRow[]>();
  let missingCategory = 0;
  let missingMerchant = 0;
  let missingBoth = 0;
  for (const r of rows) {
    if (!isDeficient(r)) continue;
    if (r.category_id === null) missingCategory += 1;
    if (r.merchant === null) missingMerchant += 1;
    if (r.category_id === null && r.merchant === null) missingBoth += 1;
    const k = descriptionKey(r.description);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }

  const groups: BuilderGroupDto[] = [...byKey].map(([key, list]) => {
    const descriptions = new Map<string, number>();
    for (const r of list) descriptions.set(r.description, (descriptions.get(r.description) ?? 0) + 1);
    const dates = list.map((r) => r.date).sort();
    return {
      key,
      label: merchantDisplay(null, list[0]!.description),
      size: list.length,
      total: Math.round(list.reduce((s, r) => s + Math.round(r.amount * 100), 0)) / 100,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      missingCategory: list.filter((r) => r.category_id === null).length,
      missingMerchant: list.filter((r) => r.merchant === null).length,
      descriptions: [...descriptions]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 3)
        .map(([description, count]) => ({ description, count })),
      accounts: [...new Set(list.map((r) => r.account_name).filter((a): a is string => a !== null))].sort(),
      ownCategory: topCategory(list),
      candidates: candidatesFor(key, all),
      txns: list.slice(0, BUILDER_TXN_LIMIT).map(toBuilderTxn),
    };
  });
  groups.sort(
    (a, b) =>
      Number(b.size > 1) - Number(a.size > 1) ||
      b.size - a.size ||
      Math.abs(b.total) - Math.abs(a.total) ||
      (a.key < b.key ? -1 : 1),
  );

  const multi = groups.filter((g) => g.size > 1);
  return {
    totals: {
      deficient: groups.reduce((s, g) => s + g.size, 0),
      missingCategory,
      missingMerchant,
      missingBoth,
      groups: multi.length,
      grouped: multi.reduce((s, g) => s + g.size, 0),
      singles: groups.length - multi.length,
      withCandidate: groups.filter((g) => g.candidates.length > 0).reduce((s, g) => s + g.size, 0),
    },
    groups,
  };
}

export async function rulesBuilder(db: Queryable): Promise<BuilderDto> {
  const res = await db.query<TxnRow>("SELECT * FROM txn WHERE deleted_at IS NULL ORDER BY date DESC, id DESC");
  return buildGroups(res.rows);
}

/** The merchants a transaction missing a merchant or a category looks like; none otherwise. */
export async function candidatesForTxn(db: Queryable, row: TxnRow): Promise<BuilderCandidateDto[]> {
  if (!isDeficient(row)) return [];
  const res = await db.query<TxnRow>(
    `SELECT * FROM txn
     WHERE deleted_at IS NULL AND type <> 'transfer' AND merchant IS NOT NULL AND category_id IS NOT NULL
     ORDER BY date DESC, id DESC`,
  );
  return candidatesFor(descriptionKey(row.description), sources(res.rows));
}
