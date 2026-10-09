/**
 * The contract every report file implements. A report is code: how to group transactions at
 * each drill level, which transactions it counts at all, and an ECharts option built from the
 * grouped rows. The web app holds every transaction and runs all of it (`run.ts`) on every
 * change of the report, range, accounts or drill path, so a chart is a pure function of
 * those. Nothing here may import server- or browser-only modules.
 */
import type { EChartsOption } from "echarts";
import type { ReportData, ReportRow, TxnDto } from "../shared/api.js";
import type { CategoryKind } from "../shared/taxonomy.js";

/** A transaction as reports see it: with its category's place in the tree, and what it spent. */
export interface ReportTxn extends TxnDto {
  /** The top-level category, `uncategorized` for none. */
  topId: string;
  topName: string;
  /** The category itself; a top-level category used directly is named "<name> (unspecified)". */
  leafId: string;
  leafName: string;
  kind: CategoryKind;
  /** Money out as a positive number, refunds negative, zero for transfers and income. */
  spend: number;
}

export interface ReportContext {
  /** Inclusive ISO dates. */
  from: string;
  to: string;
  /** Keys tapped so far, one per drill level. */
  path: string[];
  /** Only transactions in these accounts; absent or null for all. */
  accounts?: string[] | null;
}

export interface DrillLevel {
  /** Breadcrumb/legend noun for this level, e.g. "Category". */
  name: string;
  /** The key `txn` files under at this level: tapping that key narrows to the transactions with it. */
  key(txn: ReportTxn): string;
  /**
   * The rows of this level, `key`, `label`, `value` (and any extra fields the chart wants),
   * from the report's transactions in the range and accounts under the keys tapped above.
   * `sumRows` (run.ts) covers the usual "sum the spending per key".
   */
  rows(txns: ReportTxn[]): ReportRow[];
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
  /** Color for the row ranked `index`: the palette in order, `other` past the seventh. */
  colorFor(index: number): string;
  /**
   * The fixed color of a top-level category, the same in every report, range and drill level;
   * null for the small categories past the eighth hue (draw them as `other`).
   */
  categoryColor(topId: string): string | null;
  /**
   * A shade of `base` for the row ranked `index`; the first is `base` itself. Null for rows
   * ranked past the seventh, which charts fold into one `other` mark.
   */
  shadeOf(base: string, index: number): string | null;
  formatMoney(value: number): string;
}

/** Where a tap takes the app: a report, a date range, and a drill path. */
export interface ReportLink {
  reportId: string;
  from: string;
  to: string;
  path: string[];
}

export type RangePreset = "30d" | "90d" | "6m" | "12m" | "ytd";

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
  /** Whether the report counts `txn` at all (e.g. "is spending"). */
  baseFilter(txn: ReportTxn): boolean;
  levels: DrillLevel[];
  /**
   * The whole chart, from scratch: the chart shows exactly this option and keeps nothing from
   * the last one. Series with the same `id` as one already on screen animate to their new
   * values; a new `id` draws in fresh.
   */
  chart(data: ReportData, theme: ChartTheme, selectedKey: string | null): EChartsOption;
  /**
   * Instead of drilling, a tap on `key` (in the chart or the ranked list) opens another view,
   * e.g. a month of the monthly report opens the category report for that month. Null for a
   * key that drills as usual.
   */
  link?(key: string, ctx: ReportContext): ReportLink | null;
  /**
   * The rows of the ranked list under the chart, when they are not the chart's rows (a stacked
   * chart lists its series, as its legend). Defaults to `data.rows`.
   */
  listRows?(data: ReportData): ReportRow[];
  /** Row label shown in the ranked list under the chart. Defaults to `row.label`. */
  rowLabel?(row: ReportRow): string;
  /**
   * Swatch color of a row in the ranked list; must match the row's mark in the chart.
   * Defaults to `theme.colorFor(index)`.
   */
  rowColor?(data: ReportData, row: ReportRow, index: number, theme: ChartTheme): string;
}
