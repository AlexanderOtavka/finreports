import { useEffect, useMemo, useRef, useState } from "react";
import type { BuilderCandidateDto, BuilderGroupDto, CategoryDto, RecategorizeRequest, RulePreviewCounts, SuggestionsDto, TxnDto, UiContext } from "../../shared/api.js";
import { descriptionKey } from "../../shared/merchant.js";
import { ruleFor, type Predicate } from "../../shared/rules.js";
import { PLAID_TAXONOMY } from "../../shared/taxonomy.js";
import { api } from "../api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatMoney, formatRange } from "../format.js";
import { Amount, confidenceLabel } from "./builder-parts.js";
import { useSheet } from "./sheet.js";

/** What the sheet is about: one transaction (from a report), or a rules builder group. */
export type SheetSubject = { kind: "txn"; txn: TxnDto } | { kind: "group"; group: BuilderGroupDto };

interface Props {
  subject: SheetSubject;
  categories: CategoryTree;
  uiContext: UiContext;
  onClose(): void;
  /** A transaction's change, for the app to save (and show at once). */
  onSave?(req: RecategorizeRequest): void;
  /** A group's rule is saved; `text` says what it did. */
  onSaved?(text: string): void;
  /** Show every transaction from this transaction's merchant. */
  onSearchMerchant?(txn: TxnDto): void;
}

/** A web search for the merchant, to work out who an unfamiliar one is. */
export const lookUpUrl = (merchant: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(merchant)}`;

const mapUrl = ({ lat, lon }: { lat: number; lon: number }): string =>
  `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;

function plaidLabel(primary: string | null, detailed: string | null): string | null {
  if (!primary) return null;
  const p = PLAID_TAXONOMY.find((x) => x.primary === primary);
  const d = p?.detailed.find(([code]) => code === detailed);
  return [p?.name ?? primary, d?.[1]].filter(Boolean).join(" › ");
}

function reason(c: BuilderCandidateDto): string {
  const n = c.evidence[0]?.count ?? 0;
  const of = `${n} of its ${n === 1 ? "transaction" : "transactions"}`;
  if (c.reason === "same") return `Same description as ${of}`;
  if (c.reason === "similar") return `Description like ${of}`;
  return "Its name is in the description";
}

/** Where a transaction's merchant comes from, in words. */
function merchantSourceLabel(source: string | undefined): string {
  if (source === undefined) return "From the ledger";
  if (source === "none") return "No merchant: this is the bank's description, cleaned up";
  if (source === "manual") return "Named by you";
  if (source === "edited") return "Renamed in the ledger";
  if (source.startsWith("rule:")) return `Named by rule #${source.slice(5)}`;
  return "From the ledger";
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The sheet for changing a transaction, or a group of them in the rules builder: the same
 * sheet, the same choices, from top to bottom.
 *
 * - Copy from: merchants that look like it, with the evidence (only when something is missing).
 * - Merchant: rename it.
 * - Category: suggestions, search, or browse the whole tree.
 * - Rule: do the same for every transaction like it (by merchant or by description), with a
 *   live count of what it would change now. Always on for a group: the rule is the point.
 */
export function RuleSheet({ subject, categories, uiContext, onClose, onSave, onSaved, onSearchMerchant }: Props) {
  const txn = subject.kind === "txn" ? subject.txn : null;
  const group = subject.kind === "group" ? subject.group : null;
  const key = txn ? descriptionKey(txn.description) : group!.key;

  const [suggestions, setSuggestions] = useState<SuggestionsDto | null>(null);
  const candidates = group?.candidates ?? suggestions?.candidates ?? [];
  const first = group?.candidates[0];

  const [choice, setChoice] = useState<number | null>(first ? 0 : null);
  const [merchant, setMerchant] = useState(txn ? txn.merchant : (first?.merchant ?? group!.label));
  const [renaming, setRenaming] = useState(group ? group.missingMerchant > 0 : false);
  const [selected, setSelected] = useState<string | null>(group ? (first?.categoryId ?? group.ownCategory?.categoryId ?? null) : null);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [ruleOn, setRuleOn] = useState(group !== null);
  const [match, setMatch] = useState<"merchant" | "description">(txn && txn.merchantSource !== "none" ? "merchant" : "description");
  const [applyToPast, setApplyToPast] = useState(true);
  const [preview, setPreview] = useState<{ key: string; counts: RulePreviewCounts } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useSheet(sheet, onClose);

  useEffect(() => {
    if (!txn) return;
    let live = true;
    api
      .suggestions(txn.id)
      .then((s) => live && setSuggestions({ ...s, candidates: s.candidates ?? [] }))
      .catch(() => live && setSuggestions({ likely: [], recent: [], candidates: [] }));
    return () => {
      live = false;
    };
    // One request per transaction opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txn?.id]);

  const name = merchant.trim();
  /** The merchant this saves (on the transaction, and in the rule), if it sets one. */
  const newMerchant = renaming && name ? name : null;
  const merchantChange = txn ? newMerchant !== null && (newMerchant !== txn.merchant || txn.merchantSource === "none") : newMerchant !== null;
  const ruleCategory = selected ?? txn?.categoryId ?? null;
  const when: Predicate = match === "merchant" && txn ? { merchant: { equals: txn.merchantKey } } : { descriptionKey: { equals: key } };
  const definition = useMemo(
    () => (ruleOn ? ruleFor(when, { merchant: newMerchant, categoryId: ruleCategory }) : null),
    // `when` is new every render; what it is made of is here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ruleOn, match, key, txn?.merchantKey, newMerchant, ruleCategory],
  );
  const definitionKey = JSON.stringify(definition);

  // What the rule would change now, a moment after the last edit.
  useEffect(() => {
    if (!definition) return;
    const ctl = new AbortController();
    setPreviewError(null);
    const timer = setTimeout(() => {
      api
        .previewRule(definition, txn?.id, ctl.signal)
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
  }, [definitionKey, txn?.id]);
  const counts = preview && preview.key === definitionKey ? preview.counts : null;

  const pick = (i: number | null) => {
    setChoice(i);
    const c = i === null ? undefined : candidates[i];
    if (!c) return;
    setMerchant(c.merchant);
    setRenaming(true);
    setSelected(c.categoryId);
  };

  const undoRename = () => {
    setRenaming(false);
    setMerchant(txn ? txn.merchant : (first?.merchant ?? group!.label));
  };

  // The categories worth a tap: the merchants it looks like, the group's own, this merchant's
  // other transactions and Plaid's guess, and the ones recently chosen by hand.
  const quick = useMemo(() => {
    const ids = [
      ...candidates.map((c) => c.categoryId),
      ...(group?.ownCategory ? [group.ownCategory.categoryId] : []),
      ...(suggestions?.likely ?? []),
      ...(suggestions?.recent ?? []),
    ];
    return [...new Set(ids)].filter((id) => categories.byId.has(id)).slice(0, 8);
  }, [candidates, group, suggestions, categories]);
  const results = useMemo(() => categories.search(query), [categories, query]);

  const waitingForPreview = definition !== null && counts === null && previewError === null;
  const nothingToDo = txn ? selected === null && !merchantChange && definition === null : definition === null;

  const save = async () => {
    const past = applyToPast && (counts?.count ?? 0) > 0;
    if (txn) {
      onSave?.({
        ...(selected !== null ? { categoryId: selected } : {}),
        ...(merchantChange ? { merchant: newMerchant! } : {}),
        ...(definition ? { rule: { definition, applyToPast: past } } : {}),
        uiContext: { ...uiContext, surface: "recategorize-sheet" },
      });
      return;
    }
    if (!definition) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await api.saveRule(definition, past, { ...uiContext, surface: "rules-builder" });
      const what = [newMerchant, ruleCategory ? categories.name(ruleCategory) : null].filter(Boolean).join(", ");
      onSaved?.(`Rule saved: ${what}` + (res.backfilled > 0 ? ` · ${plural(res.backfilled, "transaction")} updated` : ""));
    } catch (err) {
      setSaveError((err as Error).message);
      setSaving(false);
    }
  };

  const buttonLabel = saving
    ? "Saving…"
    : group
      ? "Create rule"
      : nothingToDo
        ? "Pick a category, or rename"
        : selected !== null && !merchantChange && !definition
          ? selected === txn!.categoryId
            ? `Confirm ${categories.name(selected)}`
            : `Move to ${categories.name(selected)}`
          : "Save";

  const option = (c: CategoryDto, sub = false) => (
    <button
      key={c.id}
      type="button"
      role="option"
      aria-selected={selected === c.id}
      className={`cat-option${sub ? " sub" : ""}${selected === c.id ? " selected" : ""}${txn?.categoryId === c.id ? " current" : ""}`}
      onClick={() => setSelected(c.id)}
      data-category-id={c.id}
    >
      <span>{c.name}</span>
      {txn?.categoryId === c.id && <span className="cat-current">current</span>}
    </button>
  );
  // Spending categories first: they are what gets recategorized.
  const kindOrder = { expense: 0, income: 1, transfer: 2 } as const;
  const tops = [...categories.tops].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.sort - b.sort);

  // Plaid's guess is worth showing only once the category has moved away from it.
  const plaidRaw = txn ? plaidLabel(txn.plaidPrimary, txn.plaidDetailed) : null;
  const plaid = txn && plaidRaw && plaidRaw !== categories.path(txn.categoryId) ? plaidRaw : null;
  const title = txn ? txn.merchant : group!.label;
  const canRename = txn ? txn.type !== "transfer" : true;

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
        data-kind={subject.kind}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div className="sheet-title-row">
            <h2 id="sheet-title" className="sheet-merchant">
              {txn && onSearchMerchant ? (
                <button
                  type="button"
                  className="sheet-merchant-link"
                  onClick={() => onSearchMerchant(txn)}
                  title={`All transactions from ${title}`}
                  data-testid="merchant-search"
                >
                  {title}
                </button>
              ) : (
                <span className="sheet-merchant-text">{title}</span>
              )}
              <a
                className="sheet-lookup"
                href={lookUpUrl(title)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Look up ${title} on DuckDuckGo`}
                data-testid="merchant-lookup"
              >
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
                  <path d="M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Look up
              </a>
            </h2>
            {txn ? (
              <span className={`sheet-amount ${txn.type === "transfer" ? "transfer" : txn.amount > 0 ? "inflow" : "outflow"}`}>
                {txn.amount > 0 ? "+" : ""}
                {formatMoney(Math.abs(txn.amount))}
              </span>
            ) : (
              <span className="sheet-amount">
                <Amount value={group!.total} />
              </span>
            )}
          </div>
          {txn ? (
            <>
              <p className="sheet-sub">
                {formatDate(txn.date)}
                {txn.accountName ? ` · ${txn.accountName}` : ""}
                {txn.pending ? " · Pending" : ""}
              </p>
              <p className="sheet-raw" title="Description from the bank">
                {txn.description}
              </p>
              {(txn.counterparty || txn.website || txn.location || txn.notes || txn.tags.length > 0) && (
                <dl className="sheet-details" data-testid="txn-details">
                  {txn.counterparty && (
                    <>
                      <dt>Payee</dt>
                      <dd>{txn.counterparty}</dd>
                    </>
                  )}
                  {txn.website && (
                    <>
                      <dt>Website</dt>
                      <dd>
                        <a href={txn.website} target="_blank" rel="noopener noreferrer">
                          {txn.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
                        </a>
                      </dd>
                    </>
                  )}
                  {txn.location && (
                    <>
                      <dt>Location</dt>
                      <dd>
                        <a href={mapUrl(txn.location)} target="_blank" rel="noopener noreferrer" data-testid="txn-location">
                          Show on map
                        </a>
                      </dd>
                    </>
                  )}
                  {txn.notes && (
                    <>
                      <dt>Notes</dt>
                      <dd className="sheet-notes">{txn.notes}</dd>
                    </>
                  )}
                  {txn.tags.length > 0 && (
                    <>
                      <dt>Tags</dt>
                      <dd>
                        {txn.tags.map((t) => (
                          <span key={t} className="prov sheet-tag">
                            {t}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
              )}
            </>
          ) : (
            <>
              <p className="sheet-sub">
                {plural(group!.size, "transaction")} · {group!.from === group!.to ? formatDate(group!.from) : formatRange(group!.from, group!.to)}
                {group!.accounts.length > 0 ? ` · ${group!.accounts.join(", ")}` : ""}
              </p>
              <ul className="sheet-descs" title="Descriptions from the bank">
                {group!.descriptions.map((d) => (
                  <li key={d.description} className="sheet-raw">
                    {d.description}
                    {d.count > 1 && <span className="muted"> ×{d.count}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          {candidates.length > 0 && (
            <section aria-labelledby="sheet-copy">
              <h3 className="sheet-section" id="sheet-copy">
                Looks like
              </h3>
              <div className="candidates" role="radiogroup" aria-labelledby="sheet-copy">
                {candidates.map((c, i) => (
                  <button
                    key={c.merchant}
                    type="button"
                    role="radio"
                    aria-checked={choice === i}
                    className={`candidate${choice === i ? " selected" : ""}`}
                    onClick={() => pick(choice === i && txn ? null : i)}
                    data-testid="candidate"
                  >
                    <span className="candidate-head">
                      <strong>{c.merchant}</strong>
                      <span className="muted candidate-cat">{categories.name(c.categoryId)}</span>
                      <span className={`confidence confidence-${confidenceLabel(c.confidence)}`} title="How sure the match is">
                        {Math.round(c.confidence * 100)}%
                      </span>
                    </span>
                    {choice === i && (
                      <span className="candidate-detail">
                        <span className="muted">
                          {reason(c)} · {c.categoryCount} of its {c.sourceCount} in {categories.path(c.categoryId)}
                        </span>
                        <ul className="candidate-evidence" aria-label="Its descriptions most like this one">
                          {c.evidence.map((e) => (
                            <li key={e.description}>
                              <span className="mono">{e.description}</span>
                              <span className="muted">
                                {" "}
                                ×{e.count} · {Math.round(e.similarity * 100)}%
                              </span>
                            </li>
                          ))}
                        </ul>
                        <ul className="candidate-examples" aria-label={`Some of ${c.merchant}'s transactions`}>
                          {c.examples.map((x) => (
                            <li key={x.id}>
                              <span className="muted">{formatDate(x.date)}</span> <span className="mono">{x.description}</span> <Amount value={x.amount} />
                            </li>
                          ))}
                        </ul>
                      </span>
                    )}
                  </button>
                ))}
                {group && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={choice === null}
                    className={`candidate${choice === null ? " selected" : ""}`}
                    onClick={() => pick(null)}
                    data-testid="candidate-own"
                  >
                    <span className="candidate-head">
                      <strong>None of these</strong>
                    </span>
                  </button>
                )}
              </div>
            </section>
          )}
          {group && candidates.length === 0 && (
            <p className="sheet-note" data-testid="no-candidates">
              No merchant with a category looks like this group: name it yourself.
              {group.ownCategory && ` ${group.ownCategory.count} of its own are in ${categories.name(group.ownCategory.categoryId)}.`}
            </p>
          )}

          {canRename && (
            <section aria-labelledby="sheet-merchant-label">
              <h3 className="sheet-section" id="sheet-merchant-label">
                Merchant
              </h3>
              <input
                type="text"
                className="search sheet-input"
                value={merchant}
                onChange={(e) => {
                  setMerchant(e.target.value);
                  setRenaming(true);
                }}
                placeholder="Merchant name"
                aria-labelledby="sheet-merchant-label"
                maxLength={200}
                autoComplete="off"
                data-testid="merchant-input"
              />
              <p className="sheet-hint">
                {txn && merchantChange ? (
                  <>
                    Renamed from <strong>{txn.merchant}</strong>{" "}
                    <button type="button" className="link-button" onClick={undoRename} data-testid="merchant-undo">
                      Undo
                    </button>
                  </>
                ) : txn ? (
                  merchantSourceLabel(txn.merchantSource)
                ) : renaming ? (
                  <>
                    {group!.missingMerchant > 0 ? `${group!.missingMerchant} of them have no merchant` : "They all have a merchant: this renames them"}{" "}
                    <button type="button" className="link-button" onClick={undoRename} data-testid="merchant-undo">
                      Leave the merchant alone
                    </button>
                  </>
                ) : (
                  "Leaving the merchant alone"
                )}
              </p>
            </section>
          )}

          <section aria-labelledby="sheet-category-label">
            <h3 className="sheet-section" id="sheet-category-label">
              Category
              {txn && (
                <span className="sheet-section-note">
                  {" "}
                  · now {categories.path(txn.categoryId)}
                  {plaid && <> · Plaid said {plaid}</>}
                </span>
              )}
            </h3>
            {quick.length > 0 && (
              <div className="chips" role="listbox" aria-label="Suggested categories">
                {quick.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="option"
                    aria-selected={selected === id}
                    className={`chip${selected === id ? " selected" : ""}`}
                    onClick={() => setSelected(selected === id && group ? null : id)}
                    data-category-id={id}
                    data-testid="suggestion"
                  >
                    {categories.name(id)}
                    {categories.parentName(id) && <span className="chip-parent">{categories.parentName(id)}</span>}
                  </button>
                ))}
              </div>
            )}
            {selected && !quick.includes(selected) && (
              <p className="sheet-hint">
                Picked <strong>{categories.path(selected)}</strong>
              </p>
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
            {query ? (
              <div className="tree" role="listbox" aria-label="Categories found">
                {results.length > 0 ? (
                  results.map((c) => (
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
                ) : (
                  <p className="empty">No category matches “{query}”.</p>
                )}
              </div>
            ) : browsing ? (
              <div className="tree" role="listbox" aria-label="All categories">
                {tops.map((top) => (
                  <div key={top.id} className="tree-group">
                    {option(top)}
                    {(categories.children.get(top.id) ?? []).map((c) => option(c, true))}
                  </div>
                ))}
              </div>
            ) : (
              <button type="button" className="btn-quiet browse-all" onClick={() => setBrowsing(true)} data-testid="browse-categories">
                Browse all categories
              </button>
            )}
          </section>

          <section aria-labelledby="sheet-rule-label" className="sheet-rule">
            {txn ? (
              <label className="toggle-row">
                <span className="toggle-text sheet-section" id="sheet-rule-label">
                  Do this for every transaction like it
                </span>
                <input type="checkbox" role="switch" className="switch" checked={ruleOn} onChange={(e) => setRuleOn(e.target.checked)} data-testid="always-toggle" />
              </label>
            ) : (
              <h3 className="sheet-section" id="sheet-rule-label">
                Rule
              </h3>
            )}
            {ruleOn && (
              <>
                {txn && (
                  <div className="chips match-options" role="radiogroup" aria-label="Transactions like it are the ones">
                    {txn.merchantSource !== "none" && (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={match === "merchant"}
                        className={`chip${match === "merchant" ? " selected" : ""}`}
                        onClick={() => setMatch("merchant")}
                        data-testid="match-merchant"
                      >
                        Same merchant
                        <span className="chip-parent">{txn.merchant}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={match === "description"}
                      className={`chip${match === "description" ? " selected" : ""}`}
                      onClick={() => setMatch("description")}
                      data-testid="match-description"
                    >
                      Same description
                      <span className="chip-parent">{key}</span>
                    </button>
                  </div>
                )}
                <p className="rule-summary" data-testid="rule-summary">
                  When {match === "merchant" && txn ? <>the merchant is <strong>{txn.merchant}</strong></> : <>the description reduces to <code>{key}</code></>}
                  {definition ? (
                    <>
                      {newMerchant && (
                        <>
                          , name it <strong>{newMerchant}</strong>
                        </>
                      )}
                      {ruleCategory && (
                        <>
                          {newMerchant ? " and file" : ", file"} it under <strong>{categories.path(ruleCategory)}</strong>
                        </>
                      )}
                      .
                    </>
                  ) : (
                    <span className="muted">: pick a category or a merchant name for it to set.</span>
                  )}
                </p>
              </>
            )}
          </section>

          {group && (
            <details className="sheet-group-txns">
              <summary>The {plural(group.size, "transaction")}</summary>
              <ul className="sheet-txns" data-testid="group-txns">
                {group.txns.map((x) => (
                  <li key={x.id}>
                    <span className="sheet-txn-main">
                      <span className="mono">{x.description}</span>
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
            </details>
          )}
        </div>

        <footer className="sheet-footer">
          {definition && (
            <div className="rule-preview" data-testid="rule-preview" aria-live="polite">
              {previewError ? (
                <span className="error">{previewError}</span>
              ) : !counts ? (
                <span className="muted">Counting what the rule would change…</span>
              ) : counts.count === 0 ? (
                <span className="muted">Nothing else to change now; the rule applies to new transactions.</span>
              ) : (
                <label className="check-row">
                  <input type="checkbox" checked={applyToPast} onChange={(e) => setApplyToPast(e.target.checked)} data-testid="apply-past" />
                  <span>
                    Also change <strong data-testid="preview-count">{counts.count}</strong> past {counts.count === 1 ? "transaction" : "transactions"}
                    <span className="muted">
                      {" "}
                      (
                      {[counts.merchantCount > 0 ? `${counts.merchantCount} renamed` : null, counts.categoryCount > 0 ? `${counts.categoryCount} recategorized` : null]
                        .filter(Boolean)
                        .join(", ")}
                      ; never what you set by hand)
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}
          {saveError && <p className="error sheet-error">Not saved: {saveError}</p>}
          <button type="button" className="btn-primary" disabled={nothingToDo || waitingForPreview || saving} onClick={() => void save()} data-testid="save">
            {buttonLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
