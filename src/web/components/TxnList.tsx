import { useEffect, useRef } from "react";
import type { TxnDto } from "../../shared/api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatMoney } from "../format.js";

interface Props {
  items: TxnDto[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  categories: CategoryTree;
  /** Ids just changed by the user, briefly highlighted. */
  flash: Set<number>;
  onLoadMore(): void;
  onOpen(txn: TxnDto): void;
}

function provenanceLabel(p: string): { text: string; title: string } | null {
  if (p === "manual") return { text: "You", title: "Categorized by you" };
  if (p.startsWith("rule:")) return { text: "Rule", title: `Categorized by rule #${p.slice(5)}` };
  if (p === "backend") return { text: "Ledger", title: "Categorized in the ledger" };
  return null; // Plaid's guess: the default, unmarked
}

export function TxnList({ items, total, loading, hasMore, categories, flash, onLoadMore, onOpen }: Props) {
  const sentinel = useRef<HTMLDivElement>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMoreRef.current();
    }, { rootMargin: "400px" });
    io.observe(node);
    return () => io.disconnect();
  }, [hasMore, items.length]);

  if (!loading && items.length === 0) {
    return <p className="empty">No transactions in this selection.</p>;
  }

  let lastDate = "";
  return (
    <section className="txns" aria-label="Transactions">
      <h2 className="section-title">
        Transactions <span className="muted">· {total.toLocaleString("en-US")}</span>
      </h2>
      <ul className="txn-list" data-testid="txn-list">
        {items.map((t) => {
          const showDate = t.date !== lastDate;
          lastDate = t.date;
          const prov = provenanceLabel(t.provenance);
          const inflow = t.amount > 0;
          return (
            <li key={t.id} className={showDate ? "with-date" : undefined}>
              {showDate && <div className="txn-date">{formatDate(t.date)}</div>}
              <button
                type="button"
                className={`txn${flash.has(t.id) ? " flash" : ""}`}
                onClick={() => onOpen(t)}
                data-testid="txn"
                data-txn-id={t.id}
              >
                <span className="txn-main">
                  <span className="txn-merchant">{t.merchant}</span>
                  <span className="txn-meta">
                    <span className="txn-cat">{categories.name(t.categoryId)}</span>
                    {prov && (
                      <span className={`prov prov-${prov.text.toLowerCase()}`} title={prov.title}>
                        {prov.text}
                      </span>
                    )}
                    {t.pending && <span className="prov prov-pending">Pending</span>}
                  </span>
                </span>
                <span className={`txn-amount${inflow ? " inflow" : ""}`}>
                  {inflow ? "+" : ""}
                  {formatMoney(Math.abs(t.amount))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div ref={sentinel} className="load-more">
          <button type="button" className="btn-quiet" onClick={onLoadMore} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </section>
  );
}
