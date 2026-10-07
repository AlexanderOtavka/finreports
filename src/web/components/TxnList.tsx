import { useDeferredValue, useEffect, useMemo, useRef } from "react";
import type { TxnDto } from "../../shared/api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatMoney } from "../format.js";
import { highlightParts, parseQuery, TxnSearch } from "../search.js";

interface Props {
  items: TxnDto[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  categories: CategoryTree;
  /** Ids just changed by the user, briefly highlighted. */
  flash: Set<number>;
  /** The search box's text, or null while it is closed. */
  search: string | null;
  /** What the list is already narrowed to (the drill path and range), which search keeps. */
  scope: string;
  onSearch(query: string | null): void;
  onLoadMore(): void;
  onOpen(txn: TxnDto): void;
}

function provenanceLabel(p: string): { text: string; title: string } | null {
  if (p === "manual") return { text: "You", title: "Categorized by you" };
  if (p.startsWith("rule:")) return { text: "Rule", title: `Categorized by rule #${p.slice(5)}` };
  if (p === "backend") return { text: "Ledger", title: "Categorized in the ledger" };
  return null; // Plaid's guess: the default, unmarked
}

/** `text` with the parts that match a search term marked. */
function Hl({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  return (
    <>
      {highlightParts(text, terms).map((p, i) => (p.match ? <mark key={i}>{p.text}</mark> : p.text))}
    </>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <circle cx="6.75" cy="6.75" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10.3 10.3 14.5 14.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function TxnList({ items, total, loading, hasMore, categories, flash, search, scope, onSearch, onLoadMore, onOpen }: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const section = useRef<HTMLElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const searching = search !== null;

  // Typing stays snappy on a long list: the filter catches up a frame behind the keystrokes.
  const query = useDeferredValue(search ?? "");
  const terms = useMemo(() => parseQuery(query), [query]);
  const index = useMemo(() => (searching ? new TxnSearch(items, categories) : null), [searching, items, categories]);
  const shown = useMemo(() => (index && terms.length ? index.filter(terms) : items), [index, terms, items]);
  const filtering = searching && terms.length > 0;

  // The bar opens in place, under the chart. Opened empty, it takes the typing; opened with a
  // query (a merchant from the sheet), it leaves the keyboard down and the page where it was.
  const wasSearching = useRef(searching);
  useEffect(() => {
    if (searching && !wasSearching.current && !search) input.current?.focus();
    wasSearching.current = searching;
  }, [searching, search]);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || searching) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
    }, { rootMargin: "400px" });
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, items.length, searching]);

  const header = searching ? (
    <div className="txn-search" role="search">
      <span className="txn-search-icon">
        <SearchIcon />
      </span>
      <input
        ref={input}
        type="search"
        className="txn-search-input"
        placeholder="Merchant, date, category…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onSearch(null);
        }}
        aria-label="Search transactions"
        autoComplete="off"
        enterKeyHint="search"
        data-testid="txn-search"
      />
      <button type="button" className="txn-search-close" onClick={() => onSearch(null)} aria-label="Close search" data-testid="txn-search-close">
        ×
      </button>
    </div>
  ) : (
    <h2 className="section-title">
      <span>
        Transactions <span className="muted">· {total.toLocaleString("en-US")}</span>
      </span>
      <button type="button" className="txn-search-open" onClick={() => onSearch("")} aria-label="Search transactions" title="Search transactions" data-testid="txn-search-open">
        <SearchIcon />
      </button>
    </h2>
  );

  if (!searching && !loading && items.length === 0) {
    return (
      <section className="txns" aria-label="Transactions" ref={section}>
        {header}
        <p className="empty">No transactions in this selection.</p>
      </section>
    );
  }

  let lastDate = "";
  return (
    <section className={`txns${searching ? " searching" : ""}`} aria-label="Transactions" ref={section}>
      <div className="txns-head">
        {header}
        {searching && (
          <p className="txn-search-status" aria-live="polite" data-testid="txn-search-status">
            {filtering ? (
              <>
                <strong data-testid="txn-search-count">{shown.length.toLocaleString("en-US")}</strong> of {items.length.toLocaleString("en-US")}
                {hasMore ? `, loading the other ${(total - items.length).toLocaleString("en-US")}…` : ""} in{" "}
              </>
            ) : hasMore ? (
              `Loading all ${total.toLocaleString("en-US")} transactions in `
            ) : (
              `Searching all ${total.toLocaleString("en-US")} transactions in `
            )}
            <span className="txn-search-scope" data-testid="txn-search-scope">{scope}</span>
          </p>
        )}
      </div>
      {filtering && shown.length === 0 && !hasMore && <p className="empty">No transactions match “{query}”.</p>}
      <ul className="txn-list" data-testid="txn-list">
        {shown.map((t) => {
          const showDate = t.date !== lastDate;
          lastDate = t.date;
          const prov = provenanceLabel(t.provenance);
          const inflow = t.amount > 0;
          const flow = t.type === "transfer" ? "transfer" : inflow ? "inflow" : "outflow";
          const category = categories.name(t.categoryId);
          const dateLabel = formatDate(t.date);
          const amount = `${inflow ? "+" : ""}${formatMoney(Math.abs(t.amount))}`;
          // A term found only in a field the row does not show: show that field.
          const hits = filtering && index ? index.hiddenMatches(t, terms, [t.merchant, category, dateLabel, amount]) : [];
          return (
            <li key={t.id} className={showDate ? "with-date" : undefined}>
              {showDate && (
                <div className="txn-date">
                  <Hl text={dateLabel} terms={terms} />
                </div>
              )}
              <button
                type="button"
                className={`txn${flash.has(t.id) ? " flash" : ""}`}
                onClick={() => onOpen(t)}
                data-testid="txn"
                data-txn-id={t.id}
              >
                <span className="txn-main">
                  <span className="txn-merchant">
                    <Hl text={t.merchant} terms={terms} />
                  </span>
                  <span className="txn-meta">
                    <span className="txn-cat">
                      <Hl text={category} terms={terms} />
                    </span>
                    {prov && (
                      <span className={`prov prov-${prov.text.toLowerCase()}`} title={prov.title}>
                        {prov.text}
                      </span>
                    )}
                    {t.pending && <span className="prov prov-pending">Pending</span>}
                  </span>
                  {hits.map((f) => (
                    <span key={f.label} className="txn-hit" data-testid="txn-hit">
                      <span className="txn-hit-label">{f.label}</span> <Hl text={f.value} terms={terms} />
                    </span>
                  ))}
                </span>
                <span className={`txn-amount ${flow}`}>
                  <Hl text={amount} terms={terms} />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && !searching && (
        <div ref={sentinel} className="load-more">
          <button type="button" className="btn-quiet" onClick={() => onLoadMore()} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
