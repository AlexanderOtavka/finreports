/**
 * Search, all in the browser, for the transactions and for the rules page: the query is split into terms (spaces separate
 * them; "double quotes" keep a phrase together), and a transaction matches when every term is
 * found in at least one of its fields: merchant, raw description, category, account, amount,
 * date (in every way it is commonly written), notes, tags, website, payee. Matching ignores
 * case and accents. A term of only digits is a whole number (`20` is the 20th or $20, not
 * part of 2025); anything else may match inside a word. A term like `>$20`, `<= 5.50` or `≠100`
 * compares the amount, money in or out alike: `>20` is anything over $20.
 */
import type { TxnDto } from "../shared/api.js";
import type { CategoryTree } from "./categories.js";
import { formatDate, formatMoney } from "./format.js";

/**
 * Lower case, without accents: `Devoción` → `devocion`. Keeps the length in code units, so
 * offsets in the folded text are offsets in the original.
 */
function foldChar(c: string): string {
  const f = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return f.length === 1 ? f : c.toLowerCase().length === 1 ? c.toLowerCase() : c;
}

export function fold(s: string): string {
  let out = "";
  for (const c of s) out += foldChar(c);
  return out;
}

const matchers = new Map<string, RegExp>();

/** Where `term` (folded) is in `folded`. */
function matcher(term: string): RegExp {
  let re = matchers.get(term);
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Whole numbers only, and 9 is 09.
    re = /^\d+$/.test(term) ? new RegExp(`(?<!\\d)0*${term.replace(/^0+(?=\d)/, "")}(?!\\d)`, "g") : new RegExp(escaped, "g");
    matchers.set(term, re);
  }
  re.lastIndex = 0;
  return re;
}

const has = (folded: string, term: string): boolean => matcher(term).test(folded);

const OPS = {
  ">": (a: number, b: number) => a > b,
  ">=": (a: number, b: number) => a >= b,
  "<": (a: number, b: number) => a < b,
  "<=": (a: number, b: number) => a <= b,
  "=": (a: number, b: number) => a === b,
  "!=": (a: number, b: number) => a !== b,
};
type Op = keyof typeof OPS;
const OP_ALIASES: Record<string, Op> = { "≥": ">=", "=>": ">=", "≤": "<=", "=<": "<=", "==": "=", "≠": "!=", "<>": "!=" };

/** An operator and a number, with room between them: `>$20`, `<= 1,000`, `≥ 5.50`. */
const COMPARISON = String.raw`(>=|<=|=>|=<|==|!=|<>|[<>=≥≤≠])\s*\$?\s*(\d[\d,]*(?:\.\d*)?|\.\d+)(?![\w.])`;
/** An operator on its own, as while typing one: nothing to look for yet. */
const LONE_OP = /^(?:[<>=!]=?|[≥≤≠]|<>|=>|=<)$/;

/** The amount comparison a term is, as `parseQuery` writes it: `>=20`. */
export function comparison(term: string): { op: Op; value: number } | null {
  const m = /^(>=|<=|!=|[<>=])(\d+(?:\.\d+)?)$/.exec(term);
  return m ? { op: m[1] as Op, value: Number(m[2]) } : null;
}

export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(new RegExp(String.raw`${COMPARISON}|"([^"]*)"?|(\S+)`, "g"))) {
    if (m[1] !== undefined) {
      // Before folding, which would take ≠ apart.
      terms.push(`${OP_ALIASES[m[1]] ?? m[1]}${Number(m[2]!.replaceAll(",", ""))}`);
      continue;
    }
    const term = fold((m[3] ?? m[4] ?? "").trim());
    if (term && !LONE_OP.test(term)) terms.push(term);
  }
  return terms;
}

/** Whether `amount`, in or out, passes the comparison: in cents, so 0.1 + 0.2 is 0.3. */
function compares(amount: number, { op, value }: { op: Op; value: number }): boolean {
  return OPS[op](Math.round(Math.abs(amount) * 100), Math.round(value * 100));
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The date as people type it: 2026-09-14, 9/14/2026, Sep 14, September 14, 2026, Monday. */
export function dateForms(iso: string): string[] {
  const d = new Date(`${iso}T00:00:00Z`);
  const [y, m, day] = iso.split("-");
  return [iso, `${Number(m)}/${Number(day)}/${y}`, `${m}/${day}/${y}`, formatDate(iso), LONG.format(d), WEEKDAY.format(d)];
}

export function amountForms(amount: number): string[] {
  const abs = Math.abs(amount);
  return [formatMoney(abs), abs.toFixed(2), amount.toFixed(2)];
}

/** A field the list does not show, worth showing when a term is found only there. */
export interface HiddenField {
  label: string;
  value: string;
}

/** What of an item a search looks at: what its row shows, and what it does not. */
export interface Searchable {
  shown: string[];
  hidden: HiddenField[];
}

interface Indexed<T> {
  item: T;
  /** Everything searchable, folded, one field per line. */
  haystack: string;
  hidden: HiddenField[];
  amount: number | null;
}

/** Whether an item has the term; a list without amounts has nothing for `>20` to compare. */
function matches(x: Indexed<unknown>, term: string): boolean {
  const cmp = comparison(term);
  if (cmp) return x.amount !== null && compares(x.amount, cmp);
  return has(x.haystack, term);
}

/** A search over any list, as the transactions' works. */
export class Search<T> {
  private readonly index: Indexed<T>[];
  private readonly byItem = new Map<T, Indexed<T>>();

  /** `amount`, for items that have one, is what `>20` and the like compare. */
  constructor(items: T[], describe: (item: T) => Searchable, amount?: (item: T) => number) {
    this.index = items.map((item) => {
      const { shown, hidden: all } = describe(item);
      const hidden = all.filter((f) => f.value);
      const haystack = fold([...shown, ...hidden.map((f) => f.value)].join("\n"));
      const entry = { item, haystack, hidden, amount: amount ? amount(item) : null };
      this.byItem.set(item, entry);
      return entry;
    });
  }

  get size(): number {
    return this.index.length;
  }

  /** The items with every term, in list order. */
  filter(terms: string[]): T[] {
    if (terms.length === 0) return this.index.map((x) => x.item);
    return this.index.filter((x) => terms.every((term) => matches(x, term))).map((x) => x.item);
  }

  /**
   * The hidden fields that hold a term the visible ones lack, so the list can show why an item
   * matched.
   */
  hiddenMatches(item: T, terms: string[], visible: string[]): HiddenField[] {
    const entry = this.byItem.get(item);
    if (!entry) return [];
    const seen = fold(visible.join("\n"));
    const missing = terms.filter((term) => !comparison(term) && !has(seen, term));
    return entry.hidden.filter((f) => missing.some((term) => has(fold(f.value), term)));
  }
}

export class TxnSearch extends Search<TxnDto> {
  constructor(txns: TxnDto[], categories: CategoryTree) {
    super(txns, (t) => ({
      shown: [
        t.merchant,
        categories.name(t.categoryId),
        categories.parentName(t.categoryId) ?? "",
        ...dateForms(t.date),
        ...amountForms(t.amount),
        t.pending ? "pending" : "",
        t.type,
      ],
      hidden: [
        { label: "Description", value: t.description },
        { label: "Account", value: t.accountName ?? "" },
        { label: "Payee", value: t.counterparty ?? "" },
        { label: "Notes", value: t.notes ?? "" },
        { label: "Tags", value: t.tags.join(", ") },
        { label: "Website", value: t.website?.replace(/^https?:\/\/(www\.)?/, "") ?? "" },
        { label: "Plaid", value: t.plaidDetailed?.toLowerCase().replaceAll("_", " ") ?? "" },
      ],
    }), (t) => t.amount);
  }
}

/** `text` cut into plain and matched pieces, for highlighting. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; match: boolean }> {
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const folded = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    if (comparison(term)) continue;
    // Overlapping matches too: "aa" marks all of "aaa".
    const re = matcher(term);
    for (let m = re.exec(folded); m; m = re.exec(folded)) {
      marked.fill(true, m.index, m.index + m[0].length);
      re.lastIndex = m.index + 1;
    }
  }
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i === text.length || marked[i] !== marked[from]) {
      parts.push({ text: text.slice(from, i), match: marked[from]! });
      from = i;
    }
  }
  return parts;
}
