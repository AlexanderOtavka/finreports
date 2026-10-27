import { useEffect, useMemo, useRef, useState } from "react";
import type { RuleDto, RulePreviewCounts, TxnDto } from "../../shared/api.js";
import { giftRule, giftRuleParts, type RuleDefinition } from "../../shared/rules.js";
import { api } from "../api.js";
import type { CategoryTree } from "../categories.js";
import { formatDate, formatRange, today } from "../format.js";
import { ruleTitle } from "../rules-text.js";
import { Amount } from "./builder-parts.js";
import { useSheet } from "./sheet.js";

interface Props {
  /** The gift rule to change; none for a new one. */
  rule?: { rule: RuleDto; definition: RuleDefinition };
  categories: CategoryTree;
  /** For a rule: the gifts it has marked. */
  applied?: TxnDto[];
  onClose(): void;
  onSave(definition: RuleDefinition): void;
  onDelete?(): void;
}

/** Days after today a new gift rule runs to, at first: time for the purchase to come in. */
const DEFAULT_DAYS = 14;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * A gift rule, new or to change: the dates a purchase will come in on and, to tell it from the
 * others in those dates, what its merchant or description contains. What it matches is marked
 * as a gift: still counted everywhere, but its merchant kept out of the lists, charts and
 * search. The Rules tab shows only its dates; what it matches and what it marked are in here.
 */
export function GiftSheet({ rule, categories, applied, onClose, onSave, onDelete }: Props) {
  const parts = rule ? giftRuleParts(rule.definition) : null;
  const [from, setFrom] = useState(parts?.from ?? today());
  const [to, setTo] = useState(parts?.to ?? addDays(today(), DEFAULT_DAYS));
  const [contains, setContains] = useState(parts?.contains ?? "");
  const [name, setName] = useState(rule?.definition.name ?? "");
  const [preview, setPreview] = useState<{ key: string; counts: RulePreviewCounts } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  useSheet(sheet, onClose);

  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const definition = useMemo(() => (valid ? giftRule({ from, to, contains, name }) : null), [valid, from, to, contains, name]);
  const key = JSON.stringify(definition);
  const edited = !rule || key !== JSON.stringify(rule.definition);

  // What it would mark now, a moment after the last edit.
  useEffect(() => {
    if (!definition) return;
    const ctl = new AbortController();
    setPreviewError(null);
    const timer = setTimeout(() => {
      api
        .previewRule(definition, undefined, ctl.signal)
        .then((counts) => setPreview({ key, counts }))
        .catch((err: Error) => {
          if (err.name !== "AbortError") setPreviewError(err.message);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // key stands for definition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const counts = preview && preview.key === key ? preview.counts : null;

  const text = contains.trim();
  const title = rule ? (rule.definition.name ?? ruleTitle(rule.definition)) : "New gift rule";

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
        data-testid="gift-sheet"
      >
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div className="sheet-title-row">
            <h2 id="sheet-title" className="sheet-merchant">
              <span className="sheet-merchant-text">
                <GiftIcon /> {title}
              </span>
            </h2>
          </div>
          <p className="sheet-sub">
            Hides the merchant of a purchase in these dates from the lists, charts and search. It still counts, marked{" "}
            <span className="prov prov-gift">Gift</span>
          </p>
          <p className="sheet-sub">The Rules tab shows only its dates. What it matches stays in here.</p>
          <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="sheet-body">
          <section aria-labelledby="gift-dates-label">
            <h3 className="sheet-section" id="gift-dates-label">
              Dates
            </h3>
            <div className="gift-dates">
              <label>
                <span className="muted">From</span>
                <input type="date" className="search sheet-input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} data-testid="gift-from" />
              </label>
              <label>
                <span className="muted">To</span>
                <input type="date" className="search sheet-input" value={to} min={from} onChange={(e) => setTo(e.target.value)} data-testid="gift-to" />
              </label>
            </div>
            <p className="sheet-hint">{valid ? (from === to ? `On ${formatDate(from)}` : formatRange(from, to)) : "The first date comes before the last."}</p>
          </section>

          <section aria-labelledby="gift-contains-label">
            <h3 className="sheet-section" id="gift-contains-label">
              Merchant or description contains
            </h3>
            <input
              type="text"
              className="search sheet-input"
              value={contains}
              onChange={(e) => setContains(e.target.value)}
              placeholder="Etsy (optional)"
              aria-labelledby="gift-contains-label"
              maxLength={100}
              autoComplete="off"
              data-testid="gift-contains"
            />
            <p className="sheet-hint">
              {text ? (
                <>
                  Purchases whose merchant or description contains “{text}”
                </>
              ) : (
                "Empty: every purchase in these dates"
              )}
            </p>
          </section>

          <section aria-labelledby="gift-name-label">
            <h3 className="sheet-section" id="gift-name-label">
              What for
            </h3>
            <input
              type="text"
              className="search sheet-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Mom's birthday (optional)"
              aria-labelledby="gift-name-label"
              maxLength={200}
              autoComplete="off"
              data-testid="gift-name"
            />
          </section>

          {rule && (
            <section aria-labelledby="gift-applied-label" className="sheet-applied">
              <h3 className="sheet-section" id="gift-applied-label">
                Marked{applied && applied.length > 0 ? ` ${plural(applied.length, "gift")}` : ""}
              </h3>
              {!applied || applied.length === 0 ? (
                <p className="sheet-note" data-testid="applied-none">
                  Nothing yet. The purchase is marked when it comes in.
                </p>
              ) : (
                <ul className="sheet-txns" data-testid="applied-txns">
                  {applied.map((x) => (
                    <li key={x.id} data-testid="applied-txn">
                      <span className="sheet-txn-main">
                        <span className="sheet-txn-head">
                          <strong>{x.merchant}</strong>
                          <span className="muted"> · {categories.name(x.categoryId)}</span>
                        </span>
                        <span className="mono">{x.description}</span>
                        <span className="muted">
                          {formatDate(x.date)}
                          {x.accountName ? ` · ${x.accountName}` : ""}
                        </span>
                      </span>
                      <Amount value={x.amount} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <footer className="sheet-footer">
          {definition && edited && (
            <div className="rule-preview" data-testid="rule-preview" aria-live="polite">
              {previewError ? (
                <span className="error">{previewError}</span>
              ) : !counts ? (
                <span className="muted">Counting…</span>
              ) : counts.giftCount === 0 ? (
                <span className="muted">Nothing to mark yet. Marks the purchase when it comes in.</span>
              ) : (
                <span>
                  Marks <strong data-testid="preview-count">{counts.giftCount}</strong> {counts.giftCount === 1 ? "purchase" : "purchases"} already in
                  {counts.giftCount > 1 && !text && <span className="muted"> (every purchase in these dates)</span>}
                </span>
              )}
            </div>
          )}
          <button type="button" className="btn-primary" disabled={!definition || !edited} onClick={() => definition && onSave(definition)} data-testid="gift-save">
            {rule ? (edited ? "Save gift rule" : "No changes") : "Create gift rule"}
          </button>
          {rule && (
            <button
              type="button"
              className="btn-quiet btn-danger"
              onClick={() => (confirmDelete ? onDelete?.() : setConfirmDelete(true))}
              data-testid="delete-rule"
            >
              {confirmDelete ? "Tap again to delete (its gifts stay gifts)" : "Delete gift rule"}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

/** A wrapped present. */
export function GiftIcon() {
  return (
    <svg className="gift-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path
        d="M2 6.5h12v2.5H2zM3 9v5h10V9M8 6.5V14M8 6.5C6.5 6.5 4.6 5.9 4.6 4.4c0-1.6 2.3-1.7 3.4 2.1M8 6.5c1.5 0 3.4-.6 3.4-2.1 0-1.6-2.3-1.7-3.4 2.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
