import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OTHER_KEY } from "../reports/category-drilldown.js";
import { findReport, REPORTS } from "../reports/index.js";
import type { RangePreset } from "../reports/types.js";
import type { RecategorizeRequest, ReportData, SessionDto, TxnDto } from "../shared/api.js";
import { api, ApiError, type ReportQuery } from "./api.js";
import { CategoryTree } from "./categories.js";
import { Chart } from "./components/Chart.js";
import { RecategorizeSheet } from "./components/RecategorizeSheet.js";
import { TxnList } from "./components/TxnList.js";
import { formatMoneyShort, formatRange, isPreset, presetRange, RANGE_LABELS, RANGE_TITLES, today } from "./format.js";
import { chartTheme, ColorMemory, useDarkMode } from "./theme.js";

// ---------------------------------------------------------------------------------------
// URL state: the report, range and drill path live in the query string, so reload, share and
// the back button (one step up the drill-down) all work. A preset range is kept as its name
// (`range=30d`), so the link still means "the last 30 days" tomorrow; only a custom range is
// kept as dates (`from`, `to`).

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
  };
}

function writeUrl(v: ViewState, push: boolean) {
  const params = new URLSearchParams({ r: v.reportId, ...(v.range ? { range: v.range } : { from: v.from, to: v.to }) });
  if (v.path.length) params.set("p", v.path.map(encodeURIComponent).join("/"));
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
  const [fatal, setFatal] = useState<string | null>(null);
  const [view, setView] = useState<ViewState>(readUrl);
  const [loaded, setData] = useState<ReportData | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [txns, setTxns] = useState<TxnDto[]>([]);
  const [txnTotal, setTxnTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [txnLoading, setTxnLoading] = useState(true);
  const [openTxn, setOpenTxn] = useState<TxnDto | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState<Set<number>>(new Set());
  const [showAllRows, setShowAllRows] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);
  const [search, setSearch] = useState<string | null>(null);
  const dark = useDarkMode();
  const colors = useRef(new ColorMemory());

  const report = findReport(view.reportId) ?? REPORTS[0]!;
  // Until the new report loads, the last one's data does not fit this report's chart and list.
  const data = loaded?.reportId === report.id ? loaded : null;

  useEffect(() => {
    Promise.all([api.session(), api.categories(), api.categoryOrder()])
      .then(([s, c, order]) => {
        setCategoryOrder(order);
        setSession(s);
        setCategories(new CategoryTree(c));
      })
      .catch((err: Error) => {
        if (!(err instanceof ApiError && err.status === 401)) setFatal(err.message);
      });
  }, []);

  useEffect(() => {
    writeUrl(view, false);
    const onPop = () => setView(readUrl());
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

  // The custom dates are only open on a custom range: a preset (picked, a report tab's default,
  // or reached with the back button) closes them.
  useEffect(() => {
    if (view.range) setCustomOpen(false);
  }, [view.range]);

  // Load the chart and the first page of transactions whenever the view changes; a refresh
  // (after a recategorization) reloads both without blanking the screen.
  const loadedCount = useRef(0);
  loadedCount.current = txns.length;
  const lastViewKey = useRef("");
  useEffect(() => {
    if (!session) return;
    const ctl = new AbortController();
    // A preset turned custom shows the same data, so it does not count as a new view.
    const viewKey = JSON.stringify({ ...view, range: undefined });
    const isRefresh = viewKey === lastViewKey.current;
    lastViewKey.current = viewKey;
    if (!isRefresh) {
      setDataLoading(true);
      setTxnLoading(true);
    }
    const handle = (err: Error) => {
      if (err.name === "AbortError") return;
      setToast({ id: Date.now(), text: err.message, error: true });
    };
    api
      .report(view, ctl.signal)
      .then((d) => {
        setData(d);
        setDataLoading(false);
      })
      .catch(handle);
    api
      .transactions(view, null, ctl.signal, isRefresh ? Math.max(60, loadedCount.current) : 60)
      .then((page) => {
        setTxns(page.items);
        setTxnTotal(page.total);
        setCursor(page.nextCursor);
        setTxnLoading(false);
      })
      .catch(handle);
    return () => ctl.abort();
  }, [session, view, refreshTick]);

  const loadMore = useCallback((limit?: number) => {
    if (!cursor || txnLoading) return;
    setTxnLoading(true);
    api
      .transactions(view, cursor, undefined, limit)
      .then((page) => {
        setTxns((prev) => [...prev, ...page.items.filter((t) => !prev.some((p) => p.id === t.id))]);
        setCursor(page.nextCursor);
        setTxnLoading(false);
      })
      .catch((err: Error) => {
        setTxnLoading(false);
        setToast({ id: Date.now(), text: err.message, error: true });
      });
  }, [cursor, txnLoading, view]);

  // Search runs in the browser, over every transaction in the selection: while it is open,
  // load the rest in big pages.
  useEffect(() => {
    if (search !== null && cursor && !txnLoading) loadMore(500);
  }, [search, cursor, txnLoading, loadMore]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.error ? 6000 : 4000);
    return () => clearTimeout(t);
  }, [toast]);

  // --- Drilling --------------------------------------------------------------------------

  const level = data?.level ?? 0;
  const selectedKey = data && !data.canDrill ? (view.path[data.level] ?? null) : null;

  const onSelect = useCallback(
    (key: string) => {
      if (!data || key === OTHER_KEY) {
        if (key === OTHER_KEY) setShowAllRows(true);
        return;
      }
      if (report.link) {
        // Same dates (a category over the whole range): keep the preset in the link.
        const link = report.link(key, view);
        navigate({ ...link, range: link.from === view.from && link.to === view.to ? view.range : null });
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

  // Colors stick to their keys while the view (report, level, path, range) stays put.
  const viewId = `${report.id}:${level}:${view.path.slice(0, level).join("/")}:${view.from}:${view.to}`;
  const theme = useMemo(() => chartTheme(dark, viewId, colors.current, categoryOrder), [dark, viewId, categoryOrder]);
  const option = useMemo(() => (data ? report.chart(data, theme, selectedKey) : null), [data, report, theme, selectedKey]);

  // --- Recategorizing --------------------------------------------------------------------

  const uiContext = useMemo(
    () => ({ reportId: report.id, drillPath: view.path, from: view.from, to: view.to }),
    [report.id, view],
  );

  const onSave = useCallback(
    async (req: RecategorizeRequest) => {
      const txn = openTxn;
      if (!txn || !categories) return;
      setOpenTxn(null);
      // Optimistic: the list shows the new category at once (and, with a backfilled rule,
      // so does every listed transaction from the same merchant that is not set by hand).
      const before = txns;
      const touched = new Set<number>([txn.id]);
      setTxns((list) =>
        list.map((t) => {
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
        // The chart and the list reload from the server; the optimistic list stays until then.
        setRefreshTick((n) => n + 1);
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

  // The merchant's name in the sheet: every transaction from that merchant in this range,
  // whatever its category, so the drill path goes.
  const searchMerchant = useCallback(
    (txn: TxnDto) => {
      setOpenTxn(null);
      setSearch(`"${txn.merchant}"`);
      if (view.path.length) navigate({ ...view, path: [] });
    },
    [view, navigate],
  );

  // The sticky search bar sits right under the sticky top bar.
  const topbar = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = topbar.current;
    if (!node) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--topbar-h", `${node.offsetHeight}px`));
    ro.observe(node);
    return () => ro.disconnect();
  }, [fatal]);

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
            <a href="/reports/">
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
                navigate({ reportId: r.id, ...presetView(r.defaultRange), path: [] });
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
      <section className="card chart-card" aria-busy={dataLoading}>
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
          <Chart
            option={option}
            height={280}
            onSelect={onSelect}
            label={`${report.title}: ${data?.breadcrumbs.map((b) => b.label).join(" › ")}`}
            view={viewId}
          />
        ) : (
          <div className="chart-empty">{dataLoading ? "Loading…" : "Nothing spent in this range."}</div>
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
                      <span className="swatch" style={{ background: data && report.rowColor ? report.rowColor(data, r, i, theme) : theme.colorFor(r.key, i) }} aria-hidden="true" />
                      <span className="ranked-label">{report.rowLabel ? report.rowLabel(r) : r.label}</span>
                      <span className="ranked-value">{formatMoneyShort(r.value)}</span>
                      <span className="ranked-share">{share}%</span>
                      {(data?.canDrill || report.link) && <span className="chev" aria-hidden="true">›</span>}
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
          items={txns}
          total={txnTotal}
          loading={txnLoading}
          hasMore={cursor !== null}
          categories={categories}
          flash={flash}
          search={search}
          onSearch={setSearch}
          onLoadMore={loadMore}
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
