/**
 * Runs reports over transactions held in memory: the web app runs them on every change of the
 * report, range, accounts or drill path, from the same list of every transaction, so the chart
 * and the list under it always describe the same selection.
 */
import type { Breadcrumb, CategoryDto, ReportData, ReportRow, TxnDto } from "../shared/api.js";
import type { ReportContext, ReportDefinition, ReportTxn } from "./types.js";

/** `txn` with its category's place in the tree and its spending. */
export function toReportTxn(txn: TxnDto, categories: ReadonlyMap<string, CategoryDto>): ReportTxn {
  const c = txn.categoryId ? categories.get(txn.categoryId) : undefined;
  const top = c ? (c.parentId ? categories.get(c.parentId) : c) : undefined;
  const kind = c?.kind ?? "expense";
  return {
    ...txn,
    topId: top?.id ?? "uncategorized",
    topName: top?.name ?? "Uncategorized",
    leafId: c?.id ?? "uncategorized",
    leafName: !c ? "Uncategorized" : c.parentId ? c.name : `${c.name} (unspecified)`,
    kind,
    spend: txn.type === "transfer" || kind !== "expense" ? 0 : -txn.amount,
  };
}

/** The transactions the report counts in the range and accounts, before any drilling. */
export function inScope(report: ReportDefinition, txns: ReportTxn[], ctx: ReportContext): ReportTxn[] {
  const accounts = ctx.accounts ? new Set(ctx.accounts) : null;
  return txns.filter(
    (t) => t.date >= ctx.from && t.date <= ctx.to && (!accounts || (t.accountId !== null && accounts.has(t.accountId))) && report.baseFilter(t),
  );
}

/** Clamps the drill path to the report's depth. */
export function normalizePath(report: ReportDefinition, path: string[]): string[] {
  return path.slice(0, report.levels.length);
}

/** `txns` under the first `depth` keys of `path`. */
function under(report: ReportDefinition, txns: ReportTxn[], path: string[], depth: number): ReportTxn[] {
  let out = txns;
  for (let i = 0; i < depth; i += 1) {
    const level = report.levels[i]!;
    out = out.filter((t) => level.key(t) === path[i]);
  }
  return out;
}

/**
 * The chart data for the drill path, over `scoped` (from `inScope`). With a key tapped at every
 * level, the last level stays on screen with that key selected.
 */
export function runReport(report: ReportDefinition, scoped: ReportTxn[], drillPath: string[]): ReportData {
  const path = normalizePath(report, drillPath);
  const level = Math.min(path.length, report.levels.length - 1);
  const rows = report.levels[level]!.rows(under(report, scoped, path, level));
  const breadcrumbs: Breadcrumb[] = [{ key: null, label: report.rootLabel }];
  for (let i = 0; i < path.length; i += 1) {
    const labelRows = i === level ? rows : report.levels[i]!.rows(under(report, scoped, path, i));
    breadcrumbs.push({ key: path[i]!, label: labelRows.find((r) => r.key === path[i])?.label ?? path[i]! });
  }
  return {
    reportId: report.id,
    level,
    levels: report.levels.length,
    canDrill: level < report.levels.length - 1,
    breadcrumbs,
    rows,
    total: Math.round(rows.reduce((sum, r) => sum + r.value, 0) * 100) / 100,
  };
}

/** The transactions behind the drill path, over `scoped` (from `inScope`), newest first. */
export function selection(report: ReportDefinition, scoped: ReportTxn[], drillPath: string[]): ReportTxn[] {
  const path = normalizePath(report, drillPath);
  return under(report, scoped, path, path.length).sort((a, b) => (a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1));
}

/**
 * One row per key: the spending summed, the label the most common one among its transactions.
 * Rows that spent nothing or less (all refunds) are left out; the biggest come first.
 */
export function sumRows(txns: ReportTxn[], key: (t: ReportTxn) => string, label: (t: ReportTxn) => string): ReportRow[] {
  const groups = new Map<string, { value: number; labels: Map<string, number> }>();
  for (const t of txns) {
    const k = key(t);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { value: 0, labels: new Map() }));
    g.value += t.spend;
    const l = label(t);
    g.labels.set(l, (g.labels.get(l) ?? 0) + 1);
  }
  const rows: ReportRow[] = [];
  for (const [k, g] of groups) {
    const value = Math.round(g.value * 100) / 100;
    if (value <= 0) continue;
    // The most common label; ties go to the first in alphabetical order.
    const [best] = [...g.labels].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    rows.push({ key: k, label: best![0], value });
  }
  return rows.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
}
