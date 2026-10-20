import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuilderDto, BuilderGroupDto } from "../../shared/api.js";
import { api, isOffline } from "../api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatRange } from "../format.js";
import { Amount, confidenceLabel } from "./builder-parts.js";
import { RuleSheet } from "./RuleSheet.js";

interface Props {
  categories: CategoryTree;
  /** A rule was saved: say so, and bring the transactions up to date. */
  onSaved(text: string): void;
}

type Filter = "all" | "category" | "merchant";

/** Which groups each filter shows, and how many of their transactions it counts. */
const FILTERS: Array<{ id: Filter; label: string; count(g: BuilderGroupDto): number }> = [
  { id: "all", label: "All", count: (g) => g.size },
  { id: "category", label: "No category", count: (g) => g.missingCategory },
  { id: "merchant", label: "No merchant", count: (g) => g.missingMerchant },
];

const UI_CONTEXT = { surface: "rules-builder" };

/** Groups drawn at first, and added with "Show more". */
const PAGE = 30;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The rules builder: transactions missing a merchant or a category, grouped by description,
 * each group with the merchant that looks most like it. Tapping a group opens its proposed rule.
 */
export function RulesBuilder({ categories, onSaved }: Props) {
  const [data, setData] = useState<BuilderDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<BuilderGroupDto | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setError(null);
    api
      .rulesBuilder(signal)
      .then(setData)
      .catch((err: Error) => {
        if (err.name === "AbortError") return;
        setError(isOffline(err) ? "The rules builder needs the server, and you're offline." : err.message);
      });
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const shown = useMemo(() => {
    const { count } = FILTERS.find((f) => f.id === filter)!;
    return data ? data.groups.filter((g) => count(g) > 0) : [];
  }, [data, filter]);

  const closeSheet = useCallback(() => setOpen(null), []);
  const saved = useCallback(
    (text: string) => {
      setOpen(null);
      onSaved(text);
      load();
    },
    [onSaved, load],
  );

  if (error) {
    return (
      <section className="card builder-card">
        <p className="empty error">{error}</p>
        <div className="load-more">
          <button type="button" className="btn-quiet" onClick={() => load()}>
            Try again
          </button>
        </div>
      </section>
    );
  }
  if (!data) {
    return (
      <section className="card builder-card" aria-busy="true">
        <p className="empty">Loading…</p>
      </section>
    );
  }

  const t = data.totals;
  const drawn = shown.slice(0, limit);
  const firstSingle = drawn.findIndex((g) => g.size === 1);

  return (
    <>
      <section className="card builder-card" data-testid="builder-summary">
        <div className="card-head">
          <h2 className="builder-title">Fill in merchants and categories</h2>
          <span className="range-label">
            Transactions missing a merchant or a category, grouped by description, with a rule to copy them from a merchant that has both.
          </span>
        </div>
        {t.deficient === 0 ? (
          <p className="empty">Every transaction has a merchant and a category.</p>
        ) : (
          <dl className="builder-stats">
            <div>
              <dt>To fill in</dt>
              <dd data-testid="builder-deficient">{t.deficient.toLocaleString("en-US")}</dd>
              <dd className="muted">
                {t.missingCategory.toLocaleString("en-US")} no category · {t.missingMerchant.toLocaleString("en-US")} no merchant
              </dd>
            </div>
            <div>
              <dt>In groups</dt>
              <dd data-testid="builder-grouped">{t.grouped.toLocaleString("en-US")}</dd>
              <dd className="muted">
                {count(t.groups, "group")} · {count(t.singles, "left over", "left over")}
              </dd>
            </div>
            <div>
              <dt>With a match</dt>
              <dd data-testid="builder-matched">{t.withCandidate.toLocaleString("en-US")}</dd>
              <dd className="muted">{t.deficient > 0 ? Math.round((t.withCandidate / t.deficient) * 100) : 0}% of them</dd>
            </div>
          </dl>
        )}
        {t.deficient > 0 && (
          <div className="chips builder-filters" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`chip${filter === f.id ? " selected" : ""}`}
                aria-pressed={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setLimit(PAGE);
                }}
                data-testid={`builder-filter-${f.id}`}
              >
                {f.label} · {data.groups.reduce((s, g) => s + f.count(g), 0).toLocaleString("en-US")}
              </button>
            ))}
          </div>
        )}
      </section>

      {drawn.length > 0 && (
        <section className="txns builder-groups" aria-label="Groups">
          <ul className="builder-list" data-testid="builder-groups">
            {drawn.map((g, i) => {
              const best = g.candidates[0];
              return (
                <li key={g.key}>
                  {i === firstSingle && <div className="txn-date">On their own</div>}
                  <button type="button" className="builder-group" onClick={() => setOpen(g)} data-testid="builder-group" data-key={g.key}>
                    <span className="builder-group-head">
                      <span className="builder-group-label">{g.label}</span>
                      <span className="builder-group-total">
                        <Amount value={g.total} />
                      </span>
                    </span>
                    <span className="builder-group-meta">
                      {count(g.size, "transaction")} · {g.from === g.to ? formatDate(g.from) : formatRange(g.from, g.to)}
                    </span>
                    <span className="builder-group-desc" title="Descriptions from the bank">
                      {g.descriptions[0]!.description}
                      {g.descriptions.length > 1 && <span className="muted"> · +{g.descriptions.length - 1} more</span>}
                    </span>
                    <span className="builder-group-tags">
                      {g.missingCategory > 0 && <span className="prov prov-missing">No category {g.missingCategory < g.size ? g.missingCategory : ""}</span>}
                      {g.missingMerchant > 0 && <span className="prov prov-missing">No merchant {g.missingMerchant < g.size ? g.missingMerchant : ""}</span>}
                    </span>
                    {best ? (
                      <span className="builder-match" data-testid="builder-match">
                        <span className="builder-arrow" aria-hidden="true">→</span>
                        <strong>{best.merchant}</strong>
                        <span className="muted"> · {categories.name(best.categoryId)}</span>
                        <span className={`confidence confidence-${confidenceLabel(best.confidence)}`} title="How sure the match is">
                          {Math.round(best.confidence * 100)}%
                        </span>
                      </span>
                    ) : (
                      <span className="builder-match muted">No merchant like it yet: name it yourself</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {shown.length > drawn.length && (
            <div className="load-more">
              <button type="button" className="btn-quiet" onClick={() => setLimit((n) => n + PAGE)}>
                Show more ({(shown.length - drawn.length).toLocaleString("en-US")})
              </button>
            </div>
          )}
        </section>
      )}

      {open && <RuleSheet subject={{ kind: "group", group: open }} categories={categories} uiContext={UI_CONTEXT} onClose={closeSheet} onSaved={saved} />}
    </>
  );
}
