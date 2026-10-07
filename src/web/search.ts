/**
 * Transaction search, all in the browser: the query is split into terms (spaces separate
 * them; "double quotes" keep a phrase together), and a transaction matches when every term is
 * found in at least one of its fields: merchant, raw description, category, account, amount,
 * date (in every way it is commonly written), notes, tags, website, payee. Matching ignores
 * case and accents. A term of only digits is a whole number (`20` is the 20th or $20, not
 * part of 2025); anything else may match inside a word.
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

export function parseQuery(query: string): string[] {
  const terms: string[] = [];
  for (const m of query.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const term = fold((m[1] ?? m[2] ?? "").trim());
    if (term) terms.push(term);
  }
  return terms;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });
const LONG = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

/** The date as people type it: 2026-09-14, 9/14/2026, Sep 14, September 14, 2026, Monday. */
function dateForms(iso: string): string[] {
  const d = new Date(`${iso}T00:00:00Z`);
  const [y, m, day] = iso.split("-");
  return [iso, `${Number(m)}/${Number(day)}/${y}`, `${m}/${day}/${y}`, formatDate(iso), LONG.format(d), WEEKDAY.format(d)];
}

function amountForms(t: TxnDto): string[] {
  const abs = Math.abs(t.amount);
  return [formatMoney(abs), abs.toFixed(2), t.amount.toFixed(2)];
}

/** A field the list does not show, worth showing when a term is found only there. */
export interface HiddenField {
  label: string;
  value: string;
}

interface Indexed {
  txn: TxnDto;
  /** Everything searchable, folded, one field per line. */
  haystack: string;
  hidden: HiddenField[];
}

export class TxnSearch {
  private readonly index: Indexed[];
  private readonly byId = new Map<number, Indexed>();

  constructor(txns: TxnDto[], categories: CategoryTree) {
    this.index = txns.map((t) => {
      const hidden: HiddenField[] = [
        { label: "Description", value: t.description },
        { label: "Account", value: t.accountName ?? "" },
        { label: "Payee", value: t.counterparty ?? "" },
        { label: "Notes", value: t.notes ?? "" },
        { label: "Tags", value: t.tags.join(", ") },
        { label: "Website", value: t.website?.replace(/^https?:\/\/(www\.)?/, "") ?? "" },
        { label: "Plaid", value: t.plaidDetailed?.toLowerCase().replaceAll("_", " ") ?? "" },
      ].filter((f) => f.value);
      const shown = [
        t.merchant,
        categories.name(t.categoryId),
        categories.parentName(t.categoryId) ?? "",
        ...dateForms(t.date),
        ...amountForms(t),
        t.pending ? "pending" : "",
        t.type,
      ];
      const entry = { txn: t, haystack: fold([...shown, ...hidden.map((f) => f.value)].join("\n")), hidden };
      this.byId.set(t.id, entry);
      return entry;
    });
  }

  /** The transactions with every term, in list order. */
  filter(terms: string[]): TxnDto[] {
    if (terms.length === 0) return this.index.map((x) => x.txn);
    return this.index.filter((x) => terms.every((term) => has(x.haystack, term))).map((x) => x.txn);
  }

  /**
   * The hidden fields that hold a term the visible ones (merchant, category, date, amount)
   * lack, so the list can show why a transaction matched.
   */
  hiddenMatches(txn: TxnDto, terms: string[], visible: string[]): HiddenField[] {
    const entry = this.byId.get(txn.id);
    if (!entry) return [];
    const seen = fold(visible.join("\n"));
    const missing = terms.filter((term) => !has(seen, term));
    return entry.hidden.filter((f) => missing.some((term) => has(fold(f.value), term)));
  }
}

/** `text` cut into plain and matched pieces, for highlighting. */
export function highlightParts(text: string, terms: string[]): Array<{ text: string; match: boolean }> {
  if (terms.length === 0 || !text) return [{ text, match: false }];
  const folded = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
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
