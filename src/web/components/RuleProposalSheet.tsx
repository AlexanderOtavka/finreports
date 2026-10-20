import { useEffect, useMemo, useRef, useState } from "react";
import type { BuilderCandidateDto, BuilderGroupDto, RulePreviewCounts } from "../../shared/api.js";
import { descriptionKeyRule } from "../../shared/rules.js";
import { api } from "../api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatRange } from "../format.js";
import { Amount, confidenceLabel } from "./builder-parts.js";
import { useSheet } from "./sheet.js";

interface Props {
  group: BuilderGroupDto;
  categories: CategoryTree;
  onClose(): void;
  /** The rule is saved; `text` says what it did. */
  onSaved(text: string): void;
}

function reason(c: BuilderCandidateDto): string {
  const n = c.evidence[0]?.count ?? 0;
  const of = `${n} of its ${n === 1 ? "transaction" : "transactions"}`;
  if (c.reason === "same") return `Same description as ${of}`;
  if (c.reason === "similar") return `Description like ${of}`;
  return "Its name is in the description";
}

/**
 * A group's proposed rule: pick the merchant to copy from (the best match first), check or
 * change the merchant and the category, see what the rule would change, and save it. The rule
 * matches every description that reduces to the group's key, now and from now on.
 */
export function RuleProposalSheet({ group, categories, onClose, onSaved }: Props) {
  const first = group.candidates[0];
  const [choice, setChoice] = useState<number>(first ? 0 : -1);
  const [merchant, setMerchant] = useState(first?.merchant ?? group.label);
  const [setsMerchant, setSetsMerchant] = useState(group.missingMerchant > 0);
  const [categoryId, setCategoryId] = useState<string | null>(first?.categoryId ?? group.ownCategory?.categoryId ?? null);
  const [setsCategory, setSetsCategory] = useState(true);
  const [query, setQuery] = useState("");
  const [applyToPast, setApplyToPast] = useState(true);
  const [preview, setPreview] = useState<{ key: string; counts: RulePreviewCounts } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useSheet(sheet, onClose);

  const name = merchant.trim();
  const definition = useMemo(
    () =>
      descriptionKeyRule(group.key, {
        ...(setsMerchant && name ? { merchant: name } : {}),
        ...(setsCategory && categoryId ? { categoryId } : {}),
      }),
    [group.key, setsMerchant, name, setsCategory, categoryId],
  );
  const definitionKey = JSON.stringify(definition);
  // Setting the category takes one; the rule sets something.
  const needsCategory = setsCategory && !categoryId;
  const valid = Object.keys(definition.then).length > 0 && !needsCategory;

  // What the rule would change, a moment after the last edit.
  useEffect(() => {
    if (!valid) return;
    const ctl = new AbortController();
    setPreviewError(null);
    const timer = setTimeout(() => {
      api
        .previewRule(definition, undefined, ctl.signal)
        .then((counts) => setPreview({ key: definitionKey, counts }))
        .catch((err: Error) => {
          if (err.name !== "AbortError") setPreviewError(err.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // definitionKey stands for definition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [definitionKey, valid]);

  const counts = preview && preview.key === definitionKey ? preview.counts : null;

  const pick = (i: number) => {
    setChoice(i);
    const c = group.candidates[i];
    if (!c) return;
    setMerchant(c.merchant);
    setCategoryId(c.categoryId);
    setSetsCategory(true);
  };

  // The categories worth a tap: the candidates', and the group's own.
  const quick = useMemo(
    () =>
      [...new Set([...group.candidates.map((c) => c.categoryId), ...(group.ownCategory ? [group.ownCategory.categoryId] : [])])].filter((id) =>
        categories.byId.has(id),
      ),
    [group, categories],
  );
  const results = useMemo(() => categories.search(query).slice(0, 12), [categories, query]);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.saveRule(definition, applyToPast && (counts?.count ?? 0) > 0, { surface: "rules-builder" });
      const what = [setsMerchant && name ? name : null, setsCategory && categoryId ? categories.name(categoryId) : null].filter(Boolean).join(", ");
      onSaved(
        `Rule saved: ${what}` +
          (res.backfilled > 0 ? ` · ${res.backfilled} ${res.backfilled === 1 ? "transaction" : "transactions"} updated` : ""),
      );
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose} data-testid="sheet-backdrop">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="proposal-title"
        ref={sheet}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        data-testid="proposal-sheet"
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div className="sheet-title-row">
            <h2 id="proposal-title" className="sheet-merchant">
              {group.label}
            </h2>
            <span className="sheet-amount">
              <Amount value={group.total} />
            </span>
          </div>
          <p className="sheet-sub">
            {group.size} {group.size === 1 ? "transaction" : "transactions"} ·{" "}
            {group.from === group.to ? formatDate(group.from) : formatRange(group.from, group.to)}
            {group.accounts.length > 0 ? ` · ${group.accounts.join(", ")}` : ""}
          </p>
          <ul className="proposal-descs" title="Descriptions from the bank">
            {group.descriptions.map((d) => (
              <li key={d.description} className="sheet-raw">
                {d.description}
                {d.count > 1 && <span className="muted"> ×{d.count}</span>}
              </li>
            ))}
          </ul>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          <h3 className="sheet-section">Copy from</h3>
          <div className="proposal-candidates" role="radiogroup" aria-label="Copy from">
            {group.candidates.map((c, i) => (
              <button
                key={c.merchant}
                type="button"
                role="radio"
                aria-checked={choice === i}
                className={`candidate${choice === i ? " selected" : ""}`}
                onClick={() => pick(i)}
                data-testid="candidate"
              >
                <span className="candidate-head">
                  <strong>{c.merchant}</strong>
                  <span className={`confidence confidence-${confidenceLabel(c.confidence)}`}>{Math.round(c.confidence * 100)}%</span>
                </span>
                <span className="candidate-cat">
                  {categories.path(c.categoryId)}
                  <span className="muted">
                    {" "}
                    · {c.categoryCount} of {c.sourceCount}
                  </span>
                </span>
                <span className="candidate-why muted">{reason(c)}</span>
                {c.evidence.length > 0 && (
                  <ul className="candidate-evidence">
                    {c.evidence.map((e) => (
                      <li key={e.description}>
                        <span className="candidate-evidence-desc">{e.description}</span>
                        <span className="muted">
                          {" "}
                          ×{e.count} · {Math.round(e.similarity * 100)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {choice === i && c.examples.length > 0 && (
                  <ul className="candidate-examples" aria-label={`Some of ${c.merchant}'s transactions`}>
                    {c.examples.map((x) => (
                      <li key={x.id}>
                        <span className="muted">{formatDate(x.date)}</span> <span className="candidate-example-desc">{x.description}</span>{" "}
                        <Amount value={x.amount} />
                        <span className="muted"> · {categories.name(x.categoryId)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={choice === -1}
              className={`candidate${choice === -1 ? " selected" : ""}`}
              onClick={() => setChoice(-1)}
              data-testid="candidate-own"
            >
              <span className="candidate-head">
                <strong>Name it yourself</strong>
              </span>
              <span className="candidate-why muted">
                {group.candidates.length === 0 ? "No merchant with a category looks like this group. " : ""}
                {group.ownCategory
                  ? `${group.ownCategory.count} of the group's own transactions are in ${categories.name(group.ownCategory.categoryId)}.`
                  : ""}
              </span>
            </button>
          </div>

          <h3 className="sheet-section">The rule</h3>
          <p className="proposal-when">
            When the description reduces to <code data-testid="proposal-key">{group.key}</code>
          </p>
          <label className="toggle-row">
            <span className="toggle-text">Set the merchant</span>
            <input type="checkbox" role="switch" className="switch" checked={setsMerchant} onChange={(e) => setSetsMerchant(e.target.checked)} data-testid="sets-merchant" />
          </label>
          {setsMerchant && (
            <input
              type="text"
              className="search proposal-merchant"
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
              aria-label="Merchant"
              placeholder="Merchant name"
              maxLength={200}
              data-testid="proposal-merchant"
            />
          )}
          <label className="toggle-row proposal-toggle">
            <span className="toggle-text">
              Set the category{setsCategory && categoryId ? <strong> {categories.path(categoryId)}</strong> : null}
            </span>
            <input type="checkbox" role="switch" className="switch" checked={setsCategory} onChange={(e) => setSetsCategory(e.target.checked)} data-testid="sets-category" />
          </label>
          {setsCategory && (
            <>
              {quick.length > 0 && (
                <div className="chips proposal-cats" role="listbox" aria-label="Categories">
                  {quick.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="option"
                      aria-selected={categoryId === id}
                      className={`chip${categoryId === id ? " selected" : ""}`}
                      onClick={() => setCategoryId(id)}
                      data-category-id={id}
                    >
                      {categories.name(id)}
                      {categories.parentName(id) && <span className="chip-parent">{categories.parentName(id)}</span>}
                    </button>
                  ))}
                </div>
              )}
              <input
                type="search"
                className="search"
                placeholder="Search all categories"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search categories"
                data-testid="proposal-category-search"
              />
              {query && (
                <div className="tree" role="listbox" aria-label="Categories found">
                  {results.length > 0 ? (
                    results.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={categoryId === c.id}
                        className={`cat-option${categoryId === c.id ? " selected" : ""}`}
                        onClick={() => {
                          setCategoryId(c.id);
                          setQuery("");
                        }}
                        data-category-id={c.id}
                      >
                        <span>{c.name}</span>
                        {c.parentId && <span className="cat-parent">{categories.name(c.parentId)}</span>}
                      </button>
                    ))
                  ) : (
                    <p className="empty">No category matches “{query}”.</p>
                  )}
                </div>
              )}
            </>
          )}

          <h3 className="sheet-section">In this group</h3>
          <ul className="proposal-txns" data-testid="proposal-txns">
            {group.txns.map((x) => (
              <li key={x.id}>
                <span className="proposal-txn-main">
                  <span className="candidate-example-desc">{x.description}</span>
                  <span className="muted">
                    {formatDate(x.date)}
                    {x.accountName ? ` · ${x.accountName}` : ""} · {x.merchant ?? "no merchant"} · {categories.name(x.categoryId)}
                  </span>
                </span>
                <Amount value={x.amount} />
              </li>
            ))}
            {group.size > group.txns.length && <li className="muted">and {group.size - group.txns.length} more</li>}
          </ul>
        </div>

        <footer className="sheet-footer">
          <div className="rule-preview" data-testid="proposal-preview" aria-live="polite">
            {needsCategory ? (
              <span className="muted">Pick a category, or turn off setting one.</span>
            ) : !valid ? (
              <span className="muted">Set a merchant, a category, or both.</span>
            ) : previewError ? (
              <span className="error">{previewError}</span>
            ) : !counts ? (
              <span className="muted">Counting what it would change…</span>
            ) : counts.count === 0 ? (
              <span className="muted">Nothing to change now; the rule applies to new transactions.</span>
            ) : (
              <label className="check-row">
                <input type="checkbox" checked={applyToPast} onChange={(e) => setApplyToPast(e.target.checked)} data-testid="proposal-apply" />
                <span>
                  Change <strong data-testid="proposal-count">{counts.count}</strong> {counts.count === 1 ? "transaction" : "transactions"} now
                  <span className="muted">
                    {" "}
                    ({[
                      counts.merchantCount > 0 ? `${counts.merchantCount} get the merchant` : null,
                      counts.categoryCount > 0 ? `${counts.categoryCount} the category` : null,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                    {setsCategory ? "; not categories you set by hand" : ""})
                  </span>
                </span>
              </label>
            )}
          </div>
          {saveError && <p className="error proposal-error">Not saved: {saveError}</p>}
          <button type="button" className="btn-primary" disabled={!valid || saving || (!counts && !previewError)} onClick={() => void save()} data-testid="proposal-save">
            {saving ? "Saving…" : needsCategory ? "Pick a category" : "Create rule"}
          </button>
        </footer>
      </div>
    </div>
  );
}
