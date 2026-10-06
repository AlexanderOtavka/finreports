/**
 * The contract every report file implements. A report is code: a query per drill level
 * against the `report_txn` view (the backend-neutral `txn` mirror joined to the category
 * tree), the filter that selects the transactions behind the current selection, and an
 * ECharts option built from the query's rows. The server runs `query`/`transactions`; the
 * web app runs `chart`. Nothing here may import server- or browser-only modules.
 */
import type { EChartsOption } from "echarts";
import type { ReportData, ReportRow } from "../shared/api.js";

export interface ReportContext {
  /** Inclusive ISO dates. */
  from: string;
  to: string;
  /** Keys tapped so far, one per drill level. */
  path: string[];
}

/** Collects bind parameters: `p(value)` returns the placeholder (`$3`) for `value`. */
export interface Params {
  p(value: unknown): string;
}

export interface DrillLevel {
  /** Breadcrumb/legend noun for this level, e.g. "Category". */
  name: string;
  /**
   * SQL returning `key`, `label`, `value` (and any extra columns the chart wants) for this
   * level. `where` already holds the date range, the report's `baseFilter`, and the filters
   * of the keys tapped above this level: select `FROM report_txn t WHERE ${where}`.
   */
  query(where: string, ctx: ReportContext, params: Params): string;
  /**
   * WHERE condition (over `report_txn`, aliased `t`) for the transactions behind `key` at
   * this level. ANDed with the conditions of the levels above and the date range.
   */
  filter(key: string, params: Params): string;
}

export interface ChartTheme {
  dark: boolean;
  text: string;
  textMuted: string;
  surface: string;
  grid: string;
  /** The "everything else" color of folded rows. */
  other: string;
  /** A gray to shade from where a category has no hue of its own. */
  neutral: string;
  /** Color for a row key, stable for the lifetime of the current view. */
  colorFor(key: string, index: number): string;
  /**
   * The fixed color of a top-level category, the same in every report, range and drill level;
   * null for the small categories past the eighth hue (draw them as `other`).
   */
  categoryColor(topId: string): string | null;
  /**
   * A shade of `base` for the row `key` ranked `index`, stable for the lifetime of the
   * current view; slot 0 is `base` itself. Null for rows ranked past the seventh, which
   * charts fold into one `other` mark.
   */
  shadeOf(base: string, key: string, index: number): string | null;
  formatMoney(value: number): string;
}

/** Where a tap takes the app: a report, a date range, and a drill path. */
export interface ReportLink {
  reportId: string;
  from: string;
  to: string;
  path: string[];
}

export type RangePreset = "30d" | "3m" | "6m" | "12m" | "ytd";

export interface ReportDefinition {
  id: string;
  title: string;
  /** Short name for the report switcher. */
  shortTitle: string;
  /** Date range the report opens with. */
  defaultRange: RangePreset;
  description: string;
  /** Breadcrumb label of the top level. */
  rootLabel: string;
  /** Condition every transaction in this report satisfies (e.g. "is spending"). */
  baseFilter: string;
  levels: DrillLevel[];
  chart(data: ReportData, theme: ChartTheme, selectedKey: string | null): EChartsOption;
  /**
   * Instead of drilling, a tap on `key` (in the chart or the ranked list) opens another view,
   * e.g. a month of the monthly report opens the category report for that month.
   */
  link?(key: string, ctx: ReportContext): ReportLink;
  /**
   * The rows of the ranked list under the chart, when they are not the chart's rows (a stacked
   * chart lists its series, as its legend). Defaults to `data.rows`.
   */
  listRows?(data: ReportData): ReportRow[];
  /** Row label shown in the ranked list under the chart. Defaults to `row.label`. */
  rowLabel?(row: ReportRow): string;
  /**
   * Swatch color of a row in the ranked list; must match the row's mark in the chart.
   * Defaults to `theme.colorFor(row.key, index)`.
   */
  rowColor?(data: ReportData, row: ReportRow, index: number, theme: ChartTheme): string;
}
