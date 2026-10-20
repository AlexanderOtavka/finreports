import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OTHER_KEY } from "../reports/category-drilldown.js";
import { findReport, REPORTS } from "../reports/index.js";
import { inScope, runReport, selection, toReportTxn } from "../reports/run.js";
import type { RangePreset } from "../reports/types.js";
import type { AccountDto, RecategorizeRequest, TxnDto } from "../shared/api.js";
import { api, ApiError, isOffline, login, type ReportQuery } from "./api.js";
import { CategoryTree } from "./categories.js";
import { AccountFilter } from "./components/AccountFilter.js";
import { Chart } from "./components/Chart.js";
import { RecategorizeSheet } from "./components/RecategorizeSheet.js";
import { RulesBuilder } from "./components/RulesBuilder.js";
import { TxnList } from "./components/TxnList.js";
import { formatMoneyShort, formatRange, formatSyncTime, isPreset, presetRange, RANGE_LABELS, RANGE_TITLES, today } from "./format.js";
import { clearSnapshot, loadSnapshot, saveSnapshot, type Snapshot } from "./store.js";
import { useUpdateReady } from "./sw-client.js";
import { chartTheme, useDarkMode } from "./theme.js";

// ---------------------------------------------------------------------------------------
// URL state: the report, range and drill path live in the query string, so reload, share and
// the back button (one step up the drill-down) all work. A preset range is kept as its name
// (`range=30d`), so the link still means "the last 30 days" tomorrow; only a custom range is
// kept as dates (`from`, `to`).
//
// The rules builder is a tab like the reports (`r=rules-builder`), with no range or drill path.
//
// The account filter (`accounts=a,b`, absent for all) is read from the URL only when the page
// loads: from then on it sticks, through report tabs, links between reports, and the back
// button, until it is changed with the filter itself.

interface ViewState extends ReportQuery {
  /** The preset the dates come from, or null for a custom range. */
  range: RangePreset | null;
}

const presetView = (range: RangePreset) => ({ range, ...presetRange(range) });

/** The rules builder's place among the report tabs. */
const BUILDER = "rules-builder";

function readUrl(): ViewState {
  const params = new URLSearchParams(window.location.search);
  const accounts = params.has("accounts") ? (params.get("accounts") ?? "").split(",").filter(Boolean).map(decodeURIComponent) : null;
  if (params.get("r") === BUILDER) return { reportId: BUILDER, ...presetView(REPORTS[0]!.defaultRange), path: [], accounts };
  const report = findReport(params.get("r") ?? "") ?? REPORTS[0]!;
  const valid = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const range = params.get("range");
  const from = valid(params.get("from"));
  const to = valid(params.get("to"));
  const dates = isPreset(range) ? presetView(range) : from && to ? { range: null, from, to } : presetView(report.defaultRange);
  return {
    reportId: report.id,
    ...dates,
    path: (params.get("p") ?? "").split("/").filter(Boolean).map(decodeURIComponent),
    accounts,
  };
}

function writeUrl(v: ViewState, push: boolean) {
  const builder = v.reportId === BUILDER;
  const params = new URLSearchParams({ r: v.reportId, ...(builder ? {} : v.range ? { range: v.range } : { from: v.from, to: v.to }) });
  if (v.path.length) params.set("p", v.path.map(encodeURIComponent).join("/"));
  if (v.accounts) params.set("accounts", v.accounts.map(encodeURIComponent).join(","));
  const url = `${window.location.pathname}?${params}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------------------

/**
 * Next to the title while the data on screen is not the server's latest. Signed out, the
 * button at the end of the bar says it instead: it turns into "Log in".
 */
function SyncStatus({ state, fetchedAt, onRetry }: { state: Exclude<SyncState, "fresh" | "signed-out">; fetchedAt: number | null; onRetry(): void }) {
  // The time is left out where the top bar is narrow; the title still has it.
  const asOf = fetchedAt ? <span className="sync-time"> · {formatSyncTime(fetchedAt)}</span> : null;
  const title = (what: string) => (fetchedAt ? `${what}; showing data from ${formatSyncTime(fetchedAt)}` : what);
  return (
    <span className={`sync-status ${state}`} role="status" data-testid="sync-status" data-state={state}>
      {state === "updating" ? (
        "Updating…"
      ) : state === "offline" ? (
        <button type="button" onClick={onRetry} title={title("Offline: try again")}>
          Offline{asOf}
        </button>
      ) : (
        <button type="button" onClick={onRetry} title={title("Could not update: try again")}>
          Not updated{asOf}
        </button>
      )}
    </span>
  );
}

/** Ranked rows shown before "Show all", so the transactions start near the fold on a phone. */
const COLLAPSED_ROWS = 5;

/** After a drill from further down the page, bring the chart back into view. */
function revealChart() {
  const card = document.querySelector(".chart-card");
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
}

/** Back in the app after this long, the data is refreshed. */
const STALE_AFTER_MS = 5 * 60_000;

/**
 * How the data on screen relates to the server's: just fetched (`fresh`), or the last copy
 * kept on this device while a refresh runs (`updating`) or after one failed for want of a
 * network (`offline`) or of a session (`signed-out`), or for another reason (`error`).
 */
type SyncState = "updating" | "fresh" | "offline" | "signed-out" | "error";

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

export function App() {
  const [session, setSession] = useState<Snapshot["session"] | null>(null);
  const [categories, setCategories] = useState<CategoryTree | null>(null);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(readUrl);
  /** Every transaction, null until they arrive. The chart and the list are computed from them. */
  const [txns, setTxns] = useState<TxnDto[] | null>(null);
  /** When the data on screen came from the server, and how it stands now. */
  const [sync, setSync] = useState<{ state: SyncState; fetchedAt: number | null }>({ state: "updating", fetchedAt: null });
  const [openTxn, setOpenTxn] = useState<TxnDto | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [showAllRows, setShowAllRows] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  /** After logging out: whether the server ended the session too (it may be out of reach). */
  const [loggedOut, setLoggedOut] = useState<{ serverEnded: boolean } | null>(null);
  const dark = useDarkMode();
  const updateReady = useUpdateReady();
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const report = findReport(view.reportId) ?? REPORTS[0]!;
  const onBuilder = view.reportId === BUILDER;

  // --- Data: the copy kept on this device at once, then the server's ----------------------

  const show = useCallback((snap: Snapshot) => {
    setCategoryOrder(snap.categoryOrder);
    setAccounts(snap.accounts);
    setSession(snap.session);
    setCategories(new CategoryTree(snap.categories));
    setTxns(snap.txns);
  }, []);

  /** Resolves once the kept copy is on screen, or known not to exist. */
  const kept = useRef<Promise<Snapshot | null> | null>(null);
  const fetchedAt = useRef<number | null>(null);
  const refreshing = useRef(false);
  /** The transactions last kept on this device. */
  const savedTxns = useRef<TxnDto[] | null>(null);
  /** Once logged out, nothing is fetched or kept again. */
  const loggedOutRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current || loggedOutRef.current) return;
    refreshing.current = true;
    setSync((s) => ({ ...s, state: "updating" }));
    try {
      const { session: { csrfToken: _, ...s }, ...data } = await api.snapshot();
      fetchedAt.current = Date.now();
      show({ ...data, session: s, fetchedAt: fetchedAt.current });
      setSync({ state: "fresh", fetchedAt: fetchedAt.current });
    } catch (err) {
      // Nothing to show without the server: log in, or say what went wrong.
      if (!fetchedAt.current && !(await kept.current)) {
        if (err instanceof ApiError && err.status === 401) login();
        else setFatal((err as Error).message);
        return;
      }
      const state = isOffline(err) ? "offline" : err instanceof ApiError && err.status === 401 ? "signed-out" : "error";
      setSync((s) => ({ ...s, state }));
    } finally {
      refreshing.current = false;
    }
  }, [show]);

  useEffect(() => {
    kept.current = loadSnapshot()
      .catch(() => null)
      .then((snap) => {
        // The server may have answered first.
        if (!snap || fetchedAt.current) return snap;
        show(snap);
        savedTxns.current = snap.txns; // already kept
        setSync((s) => (s.fetchedAt ? s : { ...s, fetchedAt: snap.fetchedAt }));
        return snap;
      });
    void refresh();
    // Again when the network is back, and when the app comes back to the front a while later
    // (an installed app is resumed, not reloaded).
    const onOnline = () => void refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - (fetchedAt.current ?? 0) > STALE_AFTER_MS) void refresh();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [show, refresh]);

  // Keep what is on screen for next time: after a refresh, and after a change saved here.
  useEffect(() => {
    if (loggedOutRef.current || !txns || !categories || !session || !sync.fetchedAt || sync.state === "updating" || txns === savedTxns.current) return;
    savedTxns.current = txns;
    saveSnapshot({ session, categories: categories.all, categoryOrder, accounts, txns, fetchedAt: sync.fetchedAt }).catch(() => undefined);
  }, [txns, categories, session, categoryOrder, accounts, sync]);

  const currentView = useRef(view);
  currentView.current = view;
  useEffect(() => {
    writeUrl(view, false);
    const onPop = () => {
      // Back and forward move through reports, ranges and drill paths, not account filters.
      const next = { ...readUrl(), accounts: currentView.current.accounts };
      writeUrl(next, false);
      setView(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // Only on mount: later changes go through navigate().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((next: ViewState, push = true) => {
    writeUrl(next, push);
    setView(next);
    setShowAllRows(false);
  }, []);

  // Accounts the link names that no longer exist are dropped; none left, or every one, is all.
  useEffect(() => {
    if (!accounts.length || !view.accounts) return;
    const known = accounts.filter((a) => view.accounts!.includes(a.id)).map((a) => a.id);
    const next = known.length === 0 || known.length === accounts.length ? null : known;
    if (JSON.stringify(next) !== JSON.stringify(view.accounts)) navigate({ ...view, accounts: next }, false);
  }, [accounts, view, navigate]);

  // The custom dates are only open on a custom range: a preset (picked, a report tab's default,
  // or reached with the back button) closes them.
  useEffect(() => {
    if (view.range) setCustomOpen(false);
  }, [view.range]);

  // The chart and the list, from scratch on every change of the view (report, range, accounts,
  // drill path) or of the transactions: no request, and nothing kept from the last view.
  const reportTxns = useMemo(() => (txns && categories ? txns.map((t) => toReportTxn(t, categories.byId)) : null), [txns, categories]);
  const { data, listTxns } = useMemo(() => {
    if (!reportTxns) return { data: null, listTxns: [] };
    const scoped = inScope(report, reportTxns, view);
    return { data: runReport(report, scoped, view.path), listTxns: selection(report, scoped, view.path) };
  }, [report, reportTxns, view]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Drilling --------------------------------------------------------------------------

  const selectedKey = data && !data.canDrill ? (view.path[data.level] ?? null) : null;

  const onSelect = useCallback(
    (key: string) => {
      if (!data || key === OTHER_KEY) {
        if (key === OTHER_KEY) setShowAllRows(true);
        return;
      }
      const link = report.link?.(key, view);
      if (link) {
        // Same dates: keep the preset in the link.
        navigate({ ...link, accounts: view.accounts, range: link.from === view.from && link.to === view.to ? view.range : null });
        window.scrollTo({ top: 0 });
        return;
      }
      const base = view.path.slice(0, data.level);
      if (!data.canDrill && view.path[data.level] === key) {
        navigate({ ...view, path: base }); // tap the selected slice again: clear the selection
      } else {
        navigate({ ...view, path: [...base, key] });
      }
      revealChart();
    },
    [data, view, navigate, report],
  );

  const theme = useMemo(() => chartTheme(dark, categoryOrder), [dark, categoryOrder]);
  const option = useMemo(() => (data ? report.chart(data, theme, selectedKey) : null), [data, report, theme, selectedKey]);

  // --- Recategorizing --------------------------------------------------------------------

  const uiContext = useMemo(
    () => ({ reportId: report.id, drillPath: view.path, from: view.from, to: view.to }),
    [report.id, view],
  );

  const onSave = useCallback(
    async (req: RecategorizeRequest) => {
      const txn = openTxn;
      if (!txn || !categories || !txns) return;
      setOpenTxn(null);
      // Optimistic: the chart and the list show the new category at once (and, with a
      // backfilled rule, so does every transaction from the same merchant not set by hand).
      const before = txns;
      const touched = new Set<number>([txn.id]);
      setTxns((list) =>
        list!.map((t) => {
          if (t.id === txn.id) return { ...t, categoryId: req.categoryId, provenance: "manual" };
          if (req.merchantRule?.applyToPast && t.merchantKey === txn.merchantKey && t.provenance !== "manual") {
            touched.add(t.id);
            return { ...t, categoryId: req.categoryId, provenance: "rule:new" };
          }
          return t;
        }),
      );
      setFlash(touched);
      try {
        const res = await api.recategorize(txn.id, req);
        const name = categories.name(req.categoryId);
        const extra = res.rule
          ? res.rule.backfilled > 0
            ? ` · rule saved, ${res.rule.backfilled} past ${res.rule.backfilled === 1 ? "transaction" : "transactions"} updated`
            : " · rule saved"
          : "";
        setToast({ id: Date.now(), text: `${txn.merchant} → ${name}${extra}` });
        // The server's word on the transaction; with a rule, on all of them (the rule may reach
        // further than the guess above). The optimistic list stays until then.
        setTxns((list) => list!.map((t) => (t.id === res.txn.id ? res.txn : t)));
        if (res.rule) {
          api
            .transactions()
            .then(setTxns)
            .catch((err: Error) => setToast({ id: Date.now(), text: err.message, error: true }));
        }
      } catch (err) {
        setTxns(before);
        setToast({ id: Date.now(), text: `Not saved: ${(err as Error).message}`, error: true });
      } finally {
        setTimeout(() => setFlash(new Set()), 1600);
      }
    },
    [openTxn, categories, txns],
  );

  const closeSheet = useCallback(() => setOpenTxn(null), []);

  // A rule from the rules builder changed merchants and categories on the server: say what,
  // and bring the transactions (the reports' and the copy on this device) up to date.
  const onRuleSaved = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    api
      .transactions()
      .then(setTxns)
      .catch((err: Error) => setToast({ id: Date.now(), text: err.message, error: true }));
  }, []);

  // Log out: the server's session ends, and the copy of the data on this device goes, even when
  // the server is out of reach (its session then ends on its own once idle).
  const logOut = useCallback(async () => {
    loggedOutRef.current = true;
    let serverEnded = true;
    try {
      await api.logout();
    } catch (err) {
      serverEnded = err instanceof ApiError && err.status === 401;
    }
    await clearSnapshot().catch(() => undefined);
    setOpenTxn(null);
    setTxns(null);
    setLoggedOut({ serverEnded });
  }, []);

  // The merchant's name in the sheet: that merchant's transactions within the current range
  // and drill path, which stay as they are, chart and all.
  const searchMerchant = useCallback((txn: TxnDto) => {
    setOpenTxn(null);
    setSearch(`"${txn.merchant}"`);
  }, []);

  // The top bar's height (safe area, navbar, tabs) as --topbar-h: the transactions' header
  // sticks right under it, and the page leaves room to scroll that header up to it.
  const topbar = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = topbar.current;
    if (!node) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${node.getBoundingClientRect().height}px`));
    ro.observe(node);
    return () => ro.disconnect();
  }, [fatal]);

  // --- Rendering -------------------------------------------------------------------------

  if (loggedOut) {
    return (
      <main className="app">
        <header className="topbar">
          <div className="navbar">
            <h1 className="brand">
              <a href="/reports/">
                <span>
                  <b>Fin</b> reports
                </span>
              </a>
            </h1>
          </div>
        </header>
        <section className="card logged-out" data-testid="logged-out">
          <h1>Logged out</h1>
          <p>Your transactions are no longer kept on this device.</p>
          {!loggedOut.serverEnded && (
            <p className="muted">The server could not be reached to end the session there; it ends on its own once idle.</p>
          )}
          <button type="button" className="btn-primary" onClick={login} data-testid="login-again">
            Log in again
          </button>
        </section>
      </main>
    );
  }

  if (fatal) {
    return (
      <main className="app">
        <p className="error">Could not load: {fatal}</p>
      </main>
    );
  }

  const rows = data ? (report.listRows ? report.listRows(data) : data.rows) : [];
  const total = data?.total ?? 0;
  const visibleRows = showAllRows ? rows : rows.slice(0, COLLAPSED_ROWS);

  return (
    <main className="app">
      {session?.devBypass && (
        <div className="dev-ribbon" data-testid="dev-ribbon">
          <span>dev</span>
        </div>
      )}
      <header className="topbar" ref={topbar}>
        <div className="navbar">
          <h1 className="brand">
            <a href={view.accounts ? `/reports/?${new URLSearchParams({ accounts: view.accounts.map(encodeURIComponent).join(",") })}` : "/reports/"}>
              <span>
                <b>Fin</b> reports
              </span>
            </a>
          </h1>
          {txns && sync.state !== "fresh" && sync.state !== "signed-out" && (
            <SyncStatus state={sync.state} fetchedAt={sync.fetchedAt} onRetry={() => void refresh()} />
          )}
          {session && session.navLinks.length > 0 && (
            <nav className="nav-links" aria-label="Other apps">
              {session.navLinks.map((l) => (
                <a
                  key={`${l.label}|${l.url}`}
                  href={l.url}
                  {...(l.newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  data-testid="nav-link"
                >
                  {l.label}
                </a>
              ))}
            </nav>
          )}
          {sync.state === "signed-out" ? (
            // The session is over: the data on screen stays, and this is the way to update it.
            <button
              type="button"
              className="account-button login"
              onClick={login}
              title={`Signed out: log in to update${sync.fetchedAt ? `; showing data from ${formatSyncTime(sync.fetchedAt)}` : ""}`}
              data-testid="login"
            >
              <span className="account-icon">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <path d="M10 2.5h2.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10M5.5 11l3-3-3-3M8.5 8H2" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="account-dot" aria-hidden="true" />
              </span>
              <span className="account-text">Log in</span>
            </button>
          ) : (
            <button type="button" className="account-button" onClick={() => void logOut()} title="Log out, and remove your data from this device" data-testid="logout">
              <span className="account-icon">
                <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
                  <path d="M6 2.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H6M10.5 11 13.5 8l-3-3M13.5 8H6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span className="account-text">Log out</span>
            </button>
          )}
        </div>
        <nav className="tabs" aria-label="Reports">
          {REPORTS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`tab${!onBuilder && r.id === report.id ? " active" : ""}`}
              aria-current={!onBuilder && r.id === report.id ? "page" : undefined}
              onClick={() => {
                navigate({ reportId: r.id, ...presetView(r.defaultRange), path: [], accounts: view.accounts });
                window.scrollTo({ top: 0 });
              }}
              data-testid={`report-${r.id}`}
            >
              {r.shortTitle}
            </button>
          ))}
          <button
            type="button"
            className={`tab${onBuilder ? " active" : ""}`}
            aria-current={onBuilder ? "page" : undefined}
            onClick={() => {
              navigate({ ...view, reportId: BUILDER, path: [] });
              window.scrollTo({ top: 0 });
            }}
            title="Fill in missing merchants and categories with rules"
            data-testid={`report-${BUILDER}`}
          >
            Rules
          </button>
        </nav>
      </header>

      <div className="page">
      {onBuilder ? (
        <div className="builder">{categories ? <RulesBuilder categories={categories} onSaved={onRuleSaved} /> : <p className="empty">Loading…</p>}</div>
      ) : (
      <>
      <AccountFilter accounts={accounts} selected={view.accounts} onChange={(next) => navigate({ ...view, accounts: next }, false)}>
      <div className="range-bar" role="group" aria-label="Date range">
        {(Object.keys(RANGE_LABELS) as RangePreset[]).map((p) => (
          <button
            key={p}
            type="button"
            className={`chip${view.range === p ? " selected" : ""}`}
            onClick={() => navigate({ ...view, ...presetView(p), path: [] }, false)}
            data-testid={`range-${p}`}
            title={RANGE_TITLES[p]}
            aria-label={RANGE_TITLES[p]}
          >
            {RANGE_LABELS[p]}
          </button>
        ))}
        <button
          type="button"
          className={`chip${view.range ? "" : " selected"}`}
          onClick={() => {
            // From here on the range is these dates, not a preset, and the URL says so.
            if (!customOpen && view.range) navigate({ ...view, range: null }, false);
            setCustomOpen((o) => !o);
          }}
          data-testid="range-custom"
        >
          Custom
        </button>
      </div>
      </AccountFilter>
      {customOpen && (
        <div className="custom-range">
          <label>
            From
            <input
              type="date"
              value={view.from}
              max={view.to}
              onChange={(e) => e.target.value && navigate({ ...view, range: null, from: e.target.value, path: [] }, false)}
            />
          </label>
          <label>
            To
            <input
              type="date"
              value={view.to}
              min={view.from}
              max={today()}
              onChange={(e) => e.target.value && navigate({ ...view, range: null, to: e.target.value, path: [] }, false)}
            />
          </label>
        </div>
      )}

      <div className="content">
      <section className="card chart-card" aria-busy={!data}>
        <div className="card-head">
          <nav className="crumbs" aria-label="Drill path" data-testid="breadcrumbs">
            {(data?.breadcrumbs ?? [{ key: null, label: report.rootLabel }]).map((b, i, all) => {
              const last = i === all.length - 1;
              return (
                <span key={`${i}-${b.key}`} className="crumb">
                  {last ? (
                    <span aria-current="location" className="crumb-current">{b.label}</span>
                  ) : (
                    <button type="button" className="crumb-link" onClick={() => navigate({ ...view, path: view.path.slice(0, i) })}>
                      {b.label}
                    </button>
                  )}
                  {!last && <span className="crumb-sep" aria-hidden="true">›</span>}
                </span>
              );
            })}
          </nav>
          <span className="range-label" data-testid="range-label" data-from={view.from} data-to={view.to}>
            {formatRange(view.from, view.to)}
          </span>
        </div>

        {option && data && data.rows.length > 0 ? (
          <Chart option={option} height={280} onSelect={onSelect} label={`${report.title}: ${data.breadcrumbs.map((b) => b.label).join(" › ")}`} />
        ) : (
          <div className="chart-empty">{data ? "Nothing spent in this range." : "Loading…"}</div>
        )}

        {rows.length > 0 && (
          <>
            <ul className="ranked" data-testid="ranked">
              {visibleRows.map((r, i) => {
                const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
                return (
                  <li key={r.key}>
                    <button
                      type="button"
                      className={`ranked-row${selectedKey === r.key ? " selected" : ""}`}
                      onClick={() => onSelect(r.key)}
                      data-key={r.key}
                      data-testid="ranked-row"
                    >
                      <span className="swatch" style={{ background: data && report.rowColor ? report.rowColor(data, r, i, theme) : theme.colorFor(i) }} aria-hidden="true" />
                      <span className="ranked-label">{report.rowLabel ? report.rowLabel(r) : r.label}</span>
                      <span className="ranked-value">{formatMoneyShort(r.value)}</span>
                      <span className="ranked-share">{share}%</span>
                      {data?.canDrill && <span className="chev" aria-hidden="true">›</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
            {rows.length > COLLAPSED_ROWS && (
              <button type="button" className="btn-quiet show-all" onClick={() => setShowAllRows((s) => !s)}>
                {showAllRows ? "Show fewer" : `Show all ${rows.length}`}
              </button>
            )}
          </>
        )}
      </section>

      {categories && (
        <TxnList
          // A new selection starts the list again from its first page.
          key={JSON.stringify([report.id, view.from, view.to, view.accounts, view.path])}
          items={listTxns}
          loading={!data}
          categories={categories}
          flash={flash}
          search={search}
          scope={`${data?.breadcrumbs.at(-1)?.label ?? report.rootLabel} · ${formatRange(view.from, view.to)}`}
          onSearch={setSearch}
          onOpen={setOpenTxn}
        />
      )}
      </div>
      </>
      )}
      </div>

      {openTxn && categories && (
        <RecategorizeSheet
          txn={openTxn}
          categories={categories}
          uiContext={uiContext}
          onClose={closeSheet}
          onSave={onSave}
          onSearchMerchant={searchMerchant}
        />
      )}

      {updateReady && !updateDismissed && (
        <div className="update-banner" role="status" data-testid="update-banner">
          <span>New version available</span>
          <button type="button" className="update-reload" onClick={() => window.location.reload()} data-testid="update-reload">
            Reload
          </button>
          <button type="button" className="update-dismiss" onClick={() => setUpdateDismissed(true)} aria-label="Later">
            ×
          </button>
        </div>
      )}

      {toast && (
        <div className={`toast${toast.error ? " error" : ""}`} role="status" data-testid="toast" key={toast.id}>
          {toast.text}
        </div>
      )}
    </main>
  );
}
