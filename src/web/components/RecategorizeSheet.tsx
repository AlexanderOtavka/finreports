import { useEffect, useMemo, useRef, useState } from "react";
import type { CategoryDto, RecategorizeRequest, SuggestionsDto, TxnDto, UiContext } from "../../shared/api.js";
import { merchantKeyRule } from "../../shared/rules.js";
import { PLAID_TAXONOMY } from "../../shared/taxonomy.js";
import { api } from "../api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatMoney } from "../format.js";

interface Props {
  txn: TxnDto;
  categories: CategoryTree;
  uiContext: UiContext;
  onClose(): void;
  onSave(req: RecategorizeRequest): void;
}

function plaidLabel(primary: string | null, detailed: string | null): string | null {
  if (!primary) return null;
  const p = PLAID_TAXONOMY.find((x) => x.primary === primary);
  const d = p?.detailed.find(([code]) => code === detailed);
  return [p?.name ?? primary, d?.[1]].filter(Boolean).join(" › ");
}

/**
 * The recategorize sheet: suggestions first, then the whole tree (searchable), and the
 * "Always categorize <merchant> as X" toggle with a live count of the past transactions it
 * would change.
 */
export function RecategorizeSheet({ txn, categories, uiContext, onClose, onSave }: Props) {
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SuggestionsDto | null>(null);
  const [always, setAlways] = useState(false);
  const [applyToPast, setApplyToPast] = useState(true);
  const [preview, setPreview] = useState<{ categoryId: string; count: number } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api.suggestions(txn.id).then((s) => live && setSuggestions(s)).catch(() => live && setSuggestions({ likely: [], recent: [] }));
    return () => {
      live = false;
    };
  }, [txn.id]);

  // Close on Escape; keep focus inside the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    sheet.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  useEffect(() => {
    if (!always || !selected) return;
    const ctl = new AbortController();
    setPreviewError(null);
    api
      .previewRule(merchantKeyRule(txn.merchantKey, selected), txn.id, ctl.signal)
      .then((p) => setPreview({ categoryId: selected, count: p.count }))
      .catch((err: Error) => {
        if (err.name !== "AbortError") setPreviewError(err.message);
      });
    return () => ctl.abort();
  }, [always, selected, txn.id, txn.merchantKey]);

  const quick = useMemo(() => {
    if (!suggestions) return [];
    return [...new Set([...suggestions.likely, ...suggestions.recent])].filter((id) => categories.byId.has(id)).slice(0, 8);
  }, [suggestions, categories]);

  const results = useMemo(() => categories.search(query), [categories, query]);
  const previewCount = preview && preview.categoryId === selected ? preview.count : null;
  const target = selected ?? txn.categoryId;
  const merchant = txn.merchant;

  const save = () => {
    if (!selected) return;
    onSave({
      categoryId: selected,
      uiContext: { ...uiContext, surface: "recategorize-sheet" },
      ...(always ? { merchantRule: { applyToPast: applyToPast && (previewCount ?? 0) > 0 } } : {}),
    });
  };

  const option = (c: CategoryDto, sub = false) => (
    <button
      key={c.id}
      type="button"
      role="option"
      aria-selected={selected === c.id}
      className={`cat-option${sub ? " sub" : ""}${selected === c.id ? " selected" : ""}${txn.categoryId === c.id ? " current" : ""}`}
      onClick={() => setSelected(c.id)}
      data-category-id={c.id}
    >
      <span>{c.name}</span>
      {txn.categoryId === c.id && <span className="cat-current">current</span>}
    </button>
  );

  // Plaid's guess is worth showing only once the category has moved away from it.
  const plaidRaw = plaidLabel(txn.plaidPrimary, txn.plaidDetailed);
  const plaid = plaidRaw && plaidRaw !== categories.path(txn.categoryId) ? plaidRaw : null;
  // Spending categories first: they are what gets recategorized.
  const kindOrder = { expense: 0, income: 1, transfer: 2 } as const;
  const tops = [...categories.tops].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.sort - b.sort);

  return (
    <div className="sheet-backdrop" onClick={onClose} data-testid="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        ref={sheet}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-testid="sheet"
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div className="sheet-title-row">
            <h2 id="sheet-title">{merchant}</h2>
            <span className={`sheet-amount${txn.amount > 0 ? " inflow" : ""}`}>
              {txn.amount > 0 ? "+" : ""}
              {formatMoney(Math.abs(txn.amount))}
            </span>
          </div>
          <p className="sheet-sub">
            {formatDate(txn.date)}
            {txn.accountName ? ` · ${txn.accountName}` : ""}
            {txn.pending ? " · Pending" : ""}
          </p>
          <p className="sheet-raw" title="Description from the bank">
            {txn.description}
          </p>
          <p className="sheet-now">
            Now <strong>{categories.path(txn.categoryId)}</strong>
            {plaid && <span className="muted"> · Plaid said {plaid}</span>}
          </p>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          {quick.length > 0 && (
            <section aria-label="Suggested categories">
              <h3 className="sheet-section">Suggested</h3>
              <div className="chips" role="listbox" aria-label="Suggested categories">
                {quick.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={selected === id}
                    className={`chip${selected === id ? " selected" : ""}`}
                    onClick={() => setSelected(id)}
                    data-category-id={id}
                    data-testid="suggestion"
                  >
                    {categories.name(id)}
                    {categories.parentName(id) && <span className="chip-parent">{categories.parentName(id)}</span>}
                  </button>
                ))}
              </div>
            </section>
          )}

          <input
            type="search"
            className="search"
            placeholder="Search all categories"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search categories"
            data-testid="category-search"
          />

          <div className="tree" role="listbox" aria-label="All categories">
            {query
              ? results.length > 0
                ? results.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      role="option"
                      aria-selected={selected === c.id}
                      className={`cat-option${selected === c.id ? " selected" : ""}`}
                      onClick={() => setSelected(c.id)}
                      data-category-id={c.id}
                    >
                      <span>{c.name}</span>
                      {c.parentId && <span className="cat-parent">{categories.name(c.parentId)}</span>}
                    </button>
                  ))
                : <p className="empty">No category matches “{query}”.</p>
              : tops.map((top) => (
                  <div key={top.id} className="tree-group">
                    {option(top)}
                    {(categories.children.get(top.id) ?? []).map((c) => option(c, true))}
                  </div>
                ))}
          </div>
        </div>

        <footer className="sheet-footer">
          <label className="toggle-row">
            <span className="toggle-text">
              Always categorize <strong>{merchant}</strong> as <strong>{selected ? categories.name(selected) : "…"}</strong>
            </span>
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={always}
              onChange={(e) => setAlways(e.target.checked)}
              data-testid="always-toggle"
            />
          </label>
          {always && (
            <div className="rule-preview" data-testid="rule-preview" aria-live="polite">
              {!selected ? (
                <span className="muted">Pick a category to see what this rule would change.</span>
              ) : previewError ? (
                <span className="error">{previewError}</span>
              ) : previewCount === null ? (
                <span className="muted">Counting past transactions…</span>
              ) : previewCount === 0 ? (
                <span className="muted">No past transactions to change; the rule applies to new ones.</span>
              ) : (
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={applyToPast}
                    onChange={(e) => setApplyToPast(e.target.checked)}
                    data-testid="apply-past"
                  />
                  <span>
                    Also change <strong data-testid="preview-count">{previewCount}</strong> past{" "}
                    {previewCount === 1 ? "transaction" : "transactions"}
                    <span className="muted"> (not ones you set by hand)</span>
                  </span>
                </label>
              )}
            </div>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={!selected || (always && previewCount === null && !previewError)}
            onClick={save}
            data-testid="save"
          >
            {!selected
              ? "Pick a category"
              : selected === txn.categoryId && !always
                ? `Confirm ${categories.name(target)}`
                : `Move to ${categories.name(target)}`}
          </button>
        </footer>
      </div>
    </div>
  );
}
