import { useState } from "react";
import type { AccountDto } from "../../shared/api.js";

interface Props {
  accounts: AccountDto[];
  /** The checked account ids, or null for all of them. */
  selected: string[] | null;
  onChange(selected: string[] | null): void;
}

/**
 * Which accounts the reports count: all by default, or any non-empty subset. Picking every
 * account again goes back to "all" (null), so a new account shows up without asking.
 */
export function AccountFilter({ accounts, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  if (accounts.length < 2) return null;

  const checked = new Set(selected ?? accounts.map((a) => a.id));
  const set = (ids: Set<string>) => onChange(ids.size === accounts.length ? null : accounts.filter((a) => ids.has(a.id)).map((a) => a.id));
  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (next.size > 0) set(next);
  };

  const summary =
    selected === null
      ? "All accounts"
      : checked.size === 1
        ? (accounts.find((a) => checked.has(a.id))?.name ?? "1 account")
        : `${checked.size} of ${accounts.length} accounts`;

  return (
    <div className="account-filter">
      <button
        type="button"
        className={`chip account-chip${selected ? " selected" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="accounts-toggle"
      >
        {summary} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="account-list" role="group" aria-label="Accounts" data-testid="accounts">
          <li>
            <label>
              <input type="checkbox" checked={selected === null} disabled={selected === null} onChange={() => onChange(null)} />
              <span className="account-name">All accounts</span>
            </label>
          </li>
          {accounts.map((a) => (
            <li key={a.id}>
              <label>
                <input
                  type="checkbox"
                  checked={checked.has(a.id)}
                  // At least one account stays checked.
                  disabled={checked.size === 1 && checked.has(a.id)}
                  onChange={() => toggle(a.id)}
                  data-testid="account-checkbox"
                  data-account={a.id}
                />
                <span className="account-name">{a.name}</span>
              </label>
              <button type="button" className="btn-quiet account-only" onClick={() => set(new Set([a.id]))} aria-label={`Only ${a.name}`}>
                only
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
