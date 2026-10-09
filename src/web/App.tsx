import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OTHER_KEY } from "../reports/category-drilldown.js";
import { findReport, REPORTS } from "../reports/index.js";
import { inScope, runReport, selection, toReportTxn } from "../reports/run.js";
import type { RangePreset } from "../reports/types.js";
import type { AccountDto, RecategorizeRequest, SessionDto, TxnDto } from "../shared/api.js";
import { api, ApiError, type ReportQuery } from "./api.js";
import { CategoryTree } from "./categories.js";
import { AccountFilter } from "./components/AccountFilter.js";
import { Chart } from "./components/Chart.js";
import { RecategorizeSheet } from "./components/RecategorizeSheet.js";
import { TxnList } from "./components/TxnList.js";
import { formatMoneyShort, formatRange, isPreset, presetRange, RANGE_LABELS, RANGE_TITLES, today } from "./format.js";
import { chartTheme, useDarkMode } from "./theme.js";

// ---------------------------------------------------------------------------------------
// URL state: the report, range and drill path live in the query string, so reload, share and
// the back button (one step up the drill-down) all work. A preset range is kept as its name
// (`range=30d`), so the link still means "the last 30 days" tomorrow; only a custom range is
// kept as dates (`from`, `to`).
//
// The account filter (`accounts=a,b`, absent for all) is read from the URL only when the page
// loads: from then on it sticks, through report tabs, links between reports, and the back
// button, until it is changed with the filter itself.

interface ViewState extends ReportQuery {
  /** The preset the dates come from, or null for a custom range. */
  range: RangePreset | null;
}

const presetView = (range: RangePreset) => ({ range, ...presetRange(range) });

function readUrl(): ViewState {
  const params = new URLSearchParams(window.location.search);
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
    accounts: params.has("accounts") ? (params.get("accounts") ?? "").split(",").filter(Boolean).map(decodeURIComponent) : null,
  };
}

function writeUrl(v: ViewState, push: boolean) {
  const params = new URLSearchParams({ r: v.reportId, ...(v.range ? { range: v.range } : { from: v.from, to: v.to }) });
  if (v.path.length) params.set("p", v.path.map(encodeURIComponent).join("/"));
  if (v.accounts) params.set("accounts", v.accounts.map(encodeURIComponent).join(","));
  const url = `${window.location.pathname}?${params}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

// ---------------------------------------------------------------------------------------

/** Ranked rows shown before "Show all", so the transactions start near the fold on a phone. */
const COLLAPSED_ROWS = 5;

/** After a drill from further down the page, bring the chart back into view. */
function revealChart() {
  const card = document.querySelector(".chart-card");
  if (card && card.getBoundingClientRect().top < 0) card.scrollIntoView({ block: "start" });
}

interface Toast {
  id: number;
  text: string;
  error?: boolean;
}

export function App() {
  const [session, setSession] = useState<SessionDto | null>(null);
  const [categories, setCategories] = useState<CategoryTree | null>(null);
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [accounts, setAccounts] = useState<AccountDto[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(readUrl);
  /** Every transaction, null until they arrive. The chart and the list are computed from them. */
  const [txns, setTxns] = useState<TxnDto[] | null>(null);
  const [openTxn, setOpenTxn] = useState<TxnDto | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [showAllRows, setShowAllRows] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const dark = useDarkMode();

  const report = findReport(view.reportId) ?? REPORTS[0]!;

  useEffect(() => {
    Promise.all([api.session(), api.categories(), api.categoryOrder(), api.accounts(), api.transactions()])
      .then(([s, c, order, accts, all]) => {
        setCategoryOrder(order);
        setAccounts(accts);
        setSession(s);
        setCategories(new CategoryTree(c));
        setTxns(all);
      })
      .catch((err: Error) => {
        if (!(err instanceof ApiError && err.status === 401)) setFatal(err.message);
      });
  }, []);

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

  // An on-screen keyboard (iOS) shrinks only the visual viewport: the page scrolls under it while
  // the sticky headers stay at the top of the layout viewport, up behind the browser's bar. The
  // visible part's offset into the layout viewport, as --vv-top, brings them down to where the
  // eye is. Not while pinch-zoomed, where the headers stay with the page.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement.style;
    const update = () => root.setProperty("--vv-top", `${vv.scale > 1.01 ? 0 : Math.max(0, Math.round(vv.offsetTop))}px`);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // --- Rendering -------------------------------------------------------------------------

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
      <header className="topbar" ref={topbar}>
        <div className="navbar">
          <h1 className="brand">
            <a href={view.accounts ? `/reports/?${new URLSearchParams({ accounts: view.accounts.map(encodeURIComponent).join(",") })}` : "/reports/"}>
              <span>
                <b>Finance</b> reports
              </span>
            </a>
          </h1>
          {session?.devBypass && <span className="dev-badge" title="DEV_AUTH_BYPASS is on">dev</span>}
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
        </div>
        <nav className="tabs" aria-label="Reports">
          {REPORTS.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`tab${r.id === report.id ? " active" : ""}`}
              aria-current={r.id === report.id ? "page" : undefined}
              onClick={() => {
                navigate({ reportId: r.id, ...presetView(r.defaultRange), path: [], accounts: view.accounts });
                window.scrollTo({ top: 0 });
              }}
              data-testid={`report-${r.id}`}
            >
              {r.shortTitle}
            </button>
          ))}
        </nav>
      </header>

      <div className="page">
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

      {toast && (
        <div className={`toast${toast.error ? " error" : ""}`} role="status" data-testid="toast" key={toast.id}>
          {toast.text}
        </div>
      )}
    </main>
  );
}
