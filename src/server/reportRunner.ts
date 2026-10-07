import type { Breadcrumb, ReportData, ReportRow, TxnPage } from "../shared/api.js";
import type { Params, ReportContext, ReportDefinition } from "../reports/types.js";
import type { Queryable } from "./db.js";
import { toDto, type TxnRow } from "./txns.js";

/** Bind parameters, with the date range always `$1`/`$2`. */
class ParamList implements Params {
  readonly values: unknown[];
  constructor(ctx: ReportContext) {
    this.values = [ctx.from, ctx.to];
  }
  p = (value: unknown): string => {
    this.values.push(value);
    return `$${this.values.length}`;
  };
}

/**
 * WHERE clause for drill level `level`: dates, the accounts, the report's base filter, the
 * taps above.
 */
function whereFor(report: ReportDefinition, ctx: ReportContext, level: number, params: Params): string {
  const parts = ["t.date BETWEEN $1::date AND $2::date", `(${report.baseFilter})`];
  if (ctx.accounts) parts.push(`t.account_id = ANY(${params.p(ctx.accounts)}::text[])`);
  ctx.path.slice(0, level).forEach((key, i) => parts.push(`(${report.levels[i]!.filter(key, params)})`));
  return parts.join(" AND ");
}

async function levelRows(db: Queryable, report: ReportDefinition, ctx: ReportContext, level: number): Promise<ReportRow[]> {
  const params = new ParamList(ctx);
  const sql = report.levels[level]!.query(whereFor(report, ctx, level, params), ctx, params);
  const res = await db.query<ReportRow>(sql, params.values);
  return res.rows.map((r) => ({ ...r, value: Number(r.value) }));
}

/** Clamps the drill path to the report's depth. */
export function normalizePath(report: ReportDefinition, path: string[]): string[] {
  return path.slice(0, report.levels.length);
}

/**
 * The chart data for the current drill state. With a key tapped at every level, the last
 * level stays on screen with that key selected.
 */
export async function runReport(db: Queryable, report: ReportDefinition, ctx: ReportContext): Promise<ReportData> {
  const path = normalizePath(report, ctx.path);
  const c = { ...ctx, path };
  const level = Math.min(path.length, report.levels.length - 1);
  const rows = await levelRows(db, report, c, level);
  const breadcrumbs: Breadcrumb[] = [{ key: null, label: report.rootLabel }];
  for (let i = 0; i < path.length; i += 1) {
    const labelRows = i === level ? rows : await levelRows(db, report, c, i);
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

/** The transactions behind the current selection, newest first, keyset-paginated. */
export async function reportTransactions(
  db: Queryable,
  report: ReportDefinition,
  ctx: ReportContext,
  page: { cursor: string | null; limit: number },
): Promise<TxnPage> {
  const path = normalizePath(report, ctx.path);
  const c = { ...ctx, path };
  const params = new ParamList(c);
  const where = whereFor(report, c, path.length, params);
  const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM report_txn t WHERE ${where}`, params.values);

  let keyset = "";
  if (page.cursor) {
    const [date, id] = page.cursor.split("|");
    if (date && id && /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d+$/.test(id)) {
      keyset = ` AND (x.date, x.id) < (${params.p(date)}::date, ${params.p(Number(id))}::bigint)`;
    }
  }
  const limit = params.p(page.limit + 1);
  const res = await db.query<TxnRow>(
    `SELECT x.* FROM txn x WHERE x.id IN (SELECT t.id FROM report_txn t WHERE ${where})${keyset}
     ORDER BY x.date DESC, x.id DESC LIMIT ${limit}`,
    params.values,
  );
  const rows = res.rows.slice(0, page.limit);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toDto),
    nextCursor: res.rows.length > page.limit && last ? `${last.date}|${last.id}` : null,
    total: count.rows[0]!.n,
  };
}
