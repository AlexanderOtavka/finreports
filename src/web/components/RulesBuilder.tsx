import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BuilderDto, BuilderGroupDto, RuleDto, TxnDto, UiContext } from "../../shared/api.js";
import { ruleActions, ruleDefinitionSchema, type RuleDefinition } from "../../shared/rules.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatMoney, formatRange } from "../format.js";
import { ruleCounts } from "../ledger.js";
import { describePredicate, ruleTitle } from "../rules-text.js";
import { amountForms, dateForms, parseQuery, Search, type HiddenField } from "../search.js";
import { Amount, confidenceLabel } from "./builder-parts.js";
import { RuleSheet, type SheetSubject } from "./RuleSheet.js";
import { Hl, SearchIcon } from "./search-parts.js";

interface Props {
  categories: CategoryTree;
  /** As shown: the server's, with the changes still on their way. */
  txns: TxnDto[] | null;
  rules: RuleDto[] | null;
  builder: BuilderDto | null;
  /** Why there is nothing to show yet, if something went wrong. */
  error: string | null;
  onRetry(): void;
  /** The same key for a rule before and after the server numbers it. */
  keyOf(id: number): number;
  /** Makes a rule; returns the key of the rule it lands in. */
  onCreate(definition: RuleDefinition, applyToPast: boolean, uiContext: UiContext): number;
  onUpdate(id: number, definition: RuleDefinition, applyToPast: boolean, uiContext: UiContext): void;
  onDelete(id: number): void;
}

type Filter = "all" | "merchant" | "category" | "rules";

/** How many of a group's transactions a filter counts (all of them, for "all"). */
const missing = (filter: Filter, g: BuilderGroupDto) => (filter === "merchant" ? g.missingMerchant : filter === "category" ? g.missingCategory : g.size);

const UI_CONTEXT = { surface: "rules-builder" };

/** Groups shown in "All" until "N more": the biggest, above the rules. */
const TOP = 3;
/** Groups shown at first in a filter or a search, and added with each "N more". */
const PAGE = 30;

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface RuleItem {
  rule: RuleDto;
  definition: RuleDefinition;
}

/** A hidden field found by a search, under the row's visible ones. */
function Hits({ hits, terms }: { hits: HiddenField[]; terms: string[] }) {
  return (
    <>
      {hits.slice(0, 3).map((f, i) => (
        <span key={`${f.label}${i}`} className="txn-hit" data-testid="rules-hit">
          <span className="txn-hit-label">{f.label}</span> <Hl text={f.value} terms={terms} />
        </span>
      ))}
    </>
  );
}

/** What a group's row shows, as text: what search highlights, and what it need not repeat. */
function groupShown(g: BuilderGroupDto, categories: CategoryTree): string[] {
  const best = g.candidates[0];
  return [
    g.label,
    g.descriptions[0]!.description,
    best?.merchant ?? "",
    best ? categories.name(best.categoryId) : "",
    formatMoney(Math.abs(g.total)),
    g.missingMerchant > 0 ? "No merchant" : "",
    g.missingCategory > 0 ? "No category" : "",
  ];
}

function ruleShown(r: RuleItem, categories: CategoryTree): string[] {
  const then = ruleActions(r.definition);
  return [ruleTitle(r.definition), `When ${describePredicate(r.definition.when)}`, then.merchant ?? "", categories.path(then.categoryId)];
}

/**
 * One page, top to bottom: what still needs a rule (transactions missing a merchant or a
 * category, grouped by description, each with the merchant it looks most like), then the rules
 * there are. Making a rule from a group sends the group down into the rules.
 */
export function RulesBuilder({ categories, txns, rules, builder, error, onRetry, keyOf, onCreate, onUpdate, onDelete }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  /** How many groups to draw; null for the default (the top few in "All", a page otherwise). */
  const [limit, setLimit] = useState<number | null>(null);
  /** The search box's text, or null while it is closed. */
  const [search, setSearch] = useState<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<SheetSubject | null>(null);

  // Only the rules this app can read; a newer kind would be listed by a newer app.
  const items = useMemo<RuleItem[]>(
    () =>
      (rules ?? []).flatMap((rule) => {
        const parsed = ruleDefinitionSchema.safeParse(rule.definition);
        return parsed.success ? [{ rule, definition: parsed.data }] : [];
      }),
    [rules],
  );
  const counts = useMemo(() => ruleCounts(txns), [txns]);
  /** Each rule's transactions now, newest first. */
  const appliedBy = useMemo(() => {
    const out = new Map<number, TxnDto[]>();
    const add = (id: number, t: TxnDto) => (out.get(id) ?? out.set(id, []).get(id)!).push(t);
    for (const t of txns ?? []) {
      const cat = t.provenance.startsWith("rule:") ? Number(t.provenance.slice(5)) : null;
      const mer = t.merchantSource.startsWith("rule:") ? Number(t.merchantSource.slice(5)) : null;
      if (cat !== null) add(cat, t);
      if (mer !== null && mer !== cat) add(mer, t);
    }
    return out;
  }, [txns]);
  const none = { applied: 0, named: 0, categorized: 0 };

  // --- Search: both lists at once, as the transactions' search works ----------------------

  const searching = search !== null;
  // Typing stays snappy: the lists catch up a frame behind the keystrokes.
  const query = useDeferredValue(search ?? "");
  const terms = useMemo(() => parseQuery(query), [query]);
  const filtering = searching && terms.length > 0;
  // Searching looks through everything; the filters are for browsing.
  const view: Filter = searching ? "all" : filter;

  const groupIndex = useMemo(
    () =>
      searching && builder
        ? new Search(builder.groups, (g) => ({
            shown: [...groupShown(g, categories), ...dateForms(g.from), ...dateForms(g.to), ...amountForms(g.total), categories.parentName(g.candidates[0]?.categoryId ?? null) ?? ""],
            hidden: [
              ...g.descriptions.slice(1).map((d) => ({ label: "Description", value: d.description })),
              { label: "Account", value: g.accounts.join(", ") },
              { label: "Looks like", value: g.candidates.slice(1).map((c) => c.merchant).join(", ") },
              { label: "Merchant", value: [...new Set(g.txns.map((t) => t.merchant).filter(Boolean))].join(", ") },
            ],
          }), (g) => g.total)
        : null,
    [searching, builder, categories],
  );
  const ruleIndex = useMemo(
    () =>
      searching
        ? new Search(items, (r) => ({
            shown: ruleShown(r, categories),
            hidden: [...new Set((appliedBy.get(r.rule.id) ?? []).map((t) => t.description))].map((d) => ({ label: "Applied to", value: d })),
          }))
        : null,
    [searching, items, categories, appliedBy],
  );

  const groups = useMemo(() => {
    if (!builder) return [];
    if (filtering && groupIndex) return groupIndex.filter(terms);
    return builder.groups.filter((g) => missing(view, g) > 0);
  }, [builder, view, filtering, groupIndex, terms]);
  const shownRules = useMemo(() => (filtering && ruleIndex ? ruleIndex.filter(terms) : items), [filtering, ruleIndex, terms, items]);

  // Opened, the bar takes the typing.
  useEffect(() => {
    if (searching) searchInput.current?.focus();
  }, [searching]);
  const closeSearch = () => {
    setSearch(null);
    setLimit(null);
  };

  // --- A new rule flies from its group into the rules --------------------------------------

  const flight = useRef<{ ghost: HTMLElement; from: DOMRect; key: number } | null>(null);
  const [launches, setLaunches] = useState(0);

  const launch = (groupKey: string, ruleKey: number) => {
    const el = document.querySelector<HTMLElement>(`[data-testid=builder-group][data-key="${CSS.escape(groupKey)}"]`);
    if (!el || reducedMotion()) return;
    const from = el.getBoundingClientRect();
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-testid");
    ghost.classList.add("flight-ghost");
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    document.body.appendChild(ghost);
    flight.current = { ghost, from, key: ruleKey };
    setLaunches((n) => n + 1);
  };

  // After the render that took the group out and put the rule in: fly to the rule if it is on
  // screen, otherwise to the Rules filter, which counts it.
  useLayoutEffect(() => {
    const f = flight.current;
    if (!f) return;
    flight.current = null;
    const row = document.querySelector<HTMLElement>(`[data-rule-key="${f.key}"]`);
    const pill = document.querySelector<HTMLElement>("[data-testid=builder-filter-rules]");
    const rowBox = row?.getBoundingClientRect();
    const onScreen = rowBox && rowBox.top >= 0 && rowBox.bottom <= window.innerHeight;
    const target = onScreen ? row! : pill;
    if (!target) {
      f.ghost.remove();
      return;
    }
    const to = target.getBoundingClientRect();
    const anim = f.ghost.animate(
      [
        { transform: "none", opacity: 1 },
        {
          transform: `translate(${to.left - f.from.left}px, ${to.top - f.from.top}px) scale(${to.width / f.from.width}, ${to.height / f.from.height})`,
          opacity: onScreen ? 0.6 : 0.15,
        },
      ],
      { duration: 520, easing: "cubic-bezier(.55, 0, .25, 1)", fill: "forwards" },
    );
    anim.onfinish = () => {
      f.ghost.remove();
      const cls = onScreen ? "landed" : "bump";
      target.classList.remove(cls);
      void target.offsetWidth; // start the animation again if it just ran
      target.classList.add(cls);
      target.addEventListener("animationend", () => target.classList.remove(cls), { once: true });
    };
  }, [launches]);

  // --- The sheet -------------------------------------------------------------------------

  const close = () => setOpen(null);
  const saveRule = (definition: RuleDefinition, applyToPast: boolean) => {
    const subject = open;
    setOpen(null);
    if (subject?.kind === "group") {
      const key = onCreate(definition, applyToPast, UI_CONTEXT);
      launch(subject.group.key, key);
    } else if (subject?.kind === "rule") {
      onUpdate(subject.rule.id, definition, applyToPast, { surface: "rules-list" });
    }
  };
  const deleteRule = () => {
    if (open?.kind === "rule") onDelete(open.rule.id);
    setOpen(null);
  };
  const applied = open?.kind === "rule" ? (appliedBy.get(open.rule.id) ?? []) : undefined;

  // --- Rendering -------------------------------------------------------------------------

  if (!builder || !rules) {
    return (
      <section className="card builder-card" aria-busy={!error}>
        <p className={`empty${error ? " error" : ""}`}>{error ?? "Loading…"}</p>
        {error && (
          <div className="load-more">
            <button type="button" className="btn-quiet" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </section>
    );
  }

  const sum = (f: Filter) => builder.groups.reduce((s, g) => s + missing(f, g), 0);
  const filters: Array<{ id: Filter; label: string; n?: number }> = [
    { id: "all", label: "All" },
    { id: "merchant", label: "No merchant", n: sum("merchant") },
    { id: "category", label: "No category", n: sum("category") },
    { id: "rules", label: "Rules", n: items.length },
  ];
  const showGroups = view !== "rules";
  const showRules = view === "all" || view === "rules";
  const collapsible = view === "all" && !filtering;
  const shownCount = limit ?? (collapsible ? TOP : PAGE);
  const drawn = groups.slice(0, shownCount);
  const toFill = groups.reduce((s, g) => s + missing(view, g), 0);
  const matched = groups.reduce((s, g) => s + (g.candidates.length > 0 ? missing(view, g) : 0), 0);
  const setTotal = items.reduce((s, r) => s + (counts.get(r.rule.id) ?? none).applied, 0);

  return (
    <>
      {searching ? (
        <div className="rules-searchbar" role="search">
          <div className="txn-search">
            <span className="txn-search-icon">
              <SearchIcon />
            </span>
            <input
              ref={searchInput}
              type="search"
              className="txn-search-input"
              placeholder="Merchant, description, category…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setLimit(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") closeSearch();
              }}
              aria-label="Search what needs a rule and the rules"
              autoComplete="off"
              enterKeyHint="search"
              data-testid="rules-search"
            />
            <button type="button" className="txn-search-close" onClick={closeSearch} aria-label="Close search" data-testid="rules-search-close">
              ×
            </button>
          </div>
          <p className="txn-search-status" aria-live="polite" data-testid="rules-search-status" data-query={query}>
            {filtering ? (
              <>
                <strong data-testid="rules-search-groups">{groups.length.toLocaleString("en-US")}</strong> of {builder.groups.length.toLocaleString("en-US")} to fill in ·{" "}
                <strong data-testid="rules-search-rules">{shownRules.length.toLocaleString("en-US")}</strong> of {count(items.length, "rule")}
              </>
            ) : (
              `Searching ${count(builder.groups.length, "group")} to fill in and ${count(items.length, "rule")}`
            )}
          </p>
        </div>
      ) : (
        <div className="rules-filters">
          <div className="range-bar" role="group" aria-label="Show">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`chip${filter === f.id ? " selected" : ""}`}
              aria-pressed={filter === f.id}
              onClick={() => {
                setFilter(f.id);
                setLimit(null);
                window.scrollTo({ top: 0 });
              }}
              data-testid={`builder-filter-${f.id}`}
            >
              {f.label}
              {f.n !== undefined && <span className="chip-count">{f.n.toLocaleString("en-US")}</span>}
            </button>
          ))}
          </div>
          <button type="button" className="txn-search-open rules-search-open" onClick={() => setSearch("")} aria-label="Search" title="Search" data-testid="rules-search-open">
            <SearchIcon />
          </button>
        </div>
      )}

      {showGroups && (
        <section className="card rules-section" aria-labelledby="needs-rule" data-testid="builder-summary">
          <header className="rules-section-head">
            <h2 id="needs-rule">Needs a rule</h2>
            {toFill > 0 && (
              <span className="muted">
                <span data-testid="builder-deficient">{toFill.toLocaleString("en-US")}</span> transactions · {matched.toLocaleString("en-US")} with a match
              </span>
            )}
          </header>
          {drawn.length === 0 ? (
            <p className="empty">{filtering ? `Nothing to fill in matches “${query}”.` : "All filled in."}</p>
          ) : (
            <ul className="builder-list" data-testid="builder-groups">
              {drawn.map((g) => {
                const best = g.candidates[0];
                return (
                  <li key={g.key}>
                    <button type="button" className="builder-group" onClick={() => setOpen({ kind: "group", group: g })} data-testid="builder-group" data-key={g.key}>
                      <span className="builder-group-head">
                        <span className="builder-group-label">
                          <Hl text={g.label} terms={terms} />
                        </span>
                        <span className="builder-group-total">
                          <Amount value={g.total} />
                        </span>
                      </span>
                      <span className="builder-group-meta">
                        {count(g.size, "transaction")} · {g.from === g.to ? formatDate(g.from) : formatRange(g.from, g.to)}
                      </span>
                      <span className="builder-group-desc" title="Descriptions from the bank">
                        <Hl text={g.descriptions[0]!.description} terms={terms} />
                        {g.descriptions.length > 1 && <span className="muted"> · +{g.descriptions.length - 1} more</span>}
                      </span>
                      <span className="builder-group-tags">
                        {g.missingMerchant > 0 && <span className="prov prov-missing">No merchant{g.missingMerchant < g.size ? ` ${g.missingMerchant}` : ""}</span>}
                        {g.missingCategory > 0 && <span className="prov prov-missing">No category{g.missingCategory < g.size ? ` ${g.missingCategory}` : ""}</span>}
                      </span>
                      {best ? (
                        <span className="builder-match" data-testid="builder-match">
                          <span className="builder-arrow" aria-hidden="true">→</span>
                          <strong>
                            <Hl text={best.merchant} terms={terms} />
                          </strong>
                          <span className="muted">
                            {" · "}
                            <Hl text={categories.name(best.categoryId)} terms={terms} />
                          </span>
                          <span className={`confidence confidence-${confidenceLabel(best.confidence)}`} title="How sure the match is">
                            {Math.round(best.confidence * 100)}%
                          </span>
                        </span>
                      ) : (
                        <span className="builder-match muted">No match: name it</span>
                      )}
                      {filtering && groupIndex && <Hits hits={groupIndex.hiddenMatches(g, terms, groupShown(g, categories))} terms={terms} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {(groups.length > drawn.length || (collapsible && limit !== null)) && (
            <div className="load-more">
              {groups.length > drawn.length && (
                <button type="button" className="btn-quiet" onClick={() => setLimit(shownCount + PAGE)} data-testid="builder-more">
                  {(groups.length - drawn.length).toLocaleString("en-US")} more
                </button>
              )}
              {collapsible && limit !== null && (
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setLimit(null);
                    document.getElementById("needs-rule")?.scrollIntoView({ block: "nearest" });
                  }}
                  data-testid="builder-fewer"
                >
                  Show fewer
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {showRules && (
        <section className="card rules-section" aria-labelledby="rules-head" data-testid="rules-summary">
          <header className="rules-section-head">
            <h2 id="rules-head">Rules</h2>
            {items.length > 0 && <span className="muted">{count(setTotal, "transaction")} set</span>}
          </header>
          {items.length === 0 ? (
            <p className="empty">None yet. Tap a group above to make one.</p>
          ) : (
            <>
              {shownRules.length === 0 ? (
                <p className="empty">No rule matches “{query}”.</p>
              ) : (
                <ul className="builder-list" data-testid="rules-list">
                  {shownRules.map((r) => {
                    const then = ruleActions(r.definition);
                    const c = counts.get(r.rule.id) ?? none;
                    const key = keyOf(r.rule.id);
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={`builder-group${r.rule.id < 0 ? " saving" : ""}`}
                          onClick={() => setOpen({ kind: "rule", rule: r.rule, definition: r.definition })}
                          data-testid="rule-item"
                          data-rule-id={r.rule.id}
                          data-rule-key={key}
                        >
                          <span className="builder-group-head">
                            <span className="builder-group-label">
                              <Hl text={ruleTitle(r.definition)} terms={terms} />
                            </span>
                            <span className="builder-group-total muted" data-testid="rule-applied">
                              {c.applied.toLocaleString("en-US")}
                            </span>
                          </span>
                          <span className="builder-group-meta">
                            <Hl text={`When ${describePredicate(r.definition.when)}`} terms={terms} />
                          </span>
                          <span className="builder-match">
                            <span className="builder-arrow" aria-hidden="true">→</span>
                            {then.merchant && (
                              <strong>
                                <Hl text={then.merchant} terms={terms} />
                              </strong>
                            )}
                            {then.merchant && then.categoryId && <span className="muted"> · </span>}
                            {then.categoryId && (
                              <span>
                                <Hl text={categories.path(then.categoryId)} terms={terms} />
                              </span>
                            )}
                          </span>
                          {(c.named > 0 || c.categorized > 0) && (
                            <span className="builder-group-tags">
                              {c.named > 0 && <span className="prov prov-rule">Named {c.named.toLocaleString("en-US")}</span>}
                              {c.categorized > 0 && <span className="prov prov-rule">Categorized {c.categorized.toLocaleString("en-US")}</span>}
                            </span>
                          )}
                          {filtering && ruleIndex && <Hits hits={ruleIndex.hiddenMatches(r, terms, ruleShown(r, categories))} terms={terms} />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {open && (
        <RuleSheet
          subject={open}
          categories={categories}
          uiContext={UI_CONTEXT}
          applied={applied}
          onClose={close}
          onSaveRule={saveRule}
          onDeleteRule={deleteRule}
        />
      )}
    </>
  );
}
