import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { REPORTS } from "../reports/index.js";
import type { AccountDto, SessionDto } from "../shared/api.js";
import { recategorize, suggestions } from "./actions.js";
import type { BackendAdapter } from "./adapters/types.js";
import { registerAuth } from "./auth.js";
import { CategoryIndex, createCategory, listCategories } from "./categories.js";
import type { Config } from "./config.js";
import { appRoot, inTransaction, type Db } from "./db.js";
import { exportJsonl } from "./decisions.js";
import { HttpError } from "./errors.js";
import { backfillCandidates, deleteRule, listRules, parseDefinition, saveRule } from "./rules.js";
import type { SyncService } from "./sync.js";
import { toDto, type TxnRow } from "./txns.js";

const BASE = "/reports";
const gzipAsync = promisify(gzip);

const uiContext = z
  .object({
    reportId: z.string().max(100).optional(),
    drillPath: z.array(z.string().max(200)).max(10).optional(),
    from: z.string().max(20).optional(),
    to: z.string().max(20).optional(),
    surface: z.string().max(100).optional(),
  })
  .strict()
  .optional();
const recategorizeBody = z
  .object({
    categoryId: z.string().min(1).max(200),
    uiContext,
    merchantRule: z.object({ applyToPast: z.boolean() }).strict().optional(),
  })
  .strict();
const ruleBody = z.object({ definition: z.unknown(), applyToPast: z.boolean().default(false), uiContext }).strict();
const previewBody = z.object({ definition: z.unknown(), excludeTxnId: z.number().int().optional() }).strict();
const categoryBody = z.object({ name: z.string().min(1).max(80), parentId: z.string().max(200).nullable().default(null) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new HttpError(400, `invalid request: ${issue?.path.join(".") || "body"} ${issue?.message ?? ""}`.trim());
  }
  return res.data;
}

export interface AppDeps {
  config: Config;
  db: Db;
  adapter: BackendAdapter;
  sync: SyncService;
}

export async function buildApp({ config, db, adapter, sync }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel, redact: ["req.headers.cookie", "req.headers.authorization", "req.headers['x-csrf-token']"] },
    trustProxy: false,
    bodyLimit: 256 * 1024,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, "request failed");
    return reply.code(500).send({ error: "internal error" });
  });

  registerAuth(app, config, db);

  app.get(`${BASE}/-/healthz`, async () => {
    await db.query("SELECT 1");
    return { ok: true };
  });

  const actor = (req: { user?: { email: string } }) => req.user!.email;

  app.get(`${BASE}/api/session`, async (req): Promise<SessionDto> => ({
    email: req.user!.email,
    csrfToken: req.user!.csrfToken,
    devBypass: config.auth.devBypass,
    navLinks: config.navLinks,
  }));

  app.get(`${BASE}/api/status`, async () => {
    const state = await sync.state();
    const counts = await db.query<{ txns: number; dirty: number }>(
      "SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS txns, count(*) FILTER (WHERE backend_dirty)::int AS dirty FROM txn",
    );
    return {
      backend: adapter.name,
      lastSyncAt: state.lastSyncAt,
      lastFullSyncAt: state.lastFullAt,
      lastError: state.lastError,
      ...counts.rows[0],
    };
  });

  app.post(`${BASE}/api/sync`, async () => sync.run());

  app.get(`${BASE}/api/reports`, async () => REPORTS.map((r) => ({ id: r.id, title: r.title, description: r.description })));

  // Every transaction: the web app runs the reports over them itself, so a new report, range,
  // set of accounts or drill path needs no request. By far the biggest response, so it is
  // compressed here rather than counting on a proxy to do it.
  app.get(`${BASE}/api/transactions`, async (req, reply) => {
    const res = await db.query<TxnRow>("SELECT * FROM txn WHERE deleted_at IS NULL ORDER BY date DESC, id DESC");
    const json = JSON.stringify(res.rows.map(toDto));
    reply.type("application/json; charset=utf-8").header("vary", "accept-encoding");
    if (!/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) return reply.send(json);
    return reply.header("content-encoding", "gzip").send(await gzipAsync(json));
  });

  app.get(`${BASE}/api/categories`, async () => listCategories(db));

  // The accounts behind the mirrored transactions, named as in their latest one: the choices
  // of the account filter.
  app.get(`${BASE}/api/accounts`, async (): Promise<AccountDto[]> => {
    const res = await db.query<AccountDto>(
      `SELECT account_id AS id, (array_agg(coalesce(account_name, account_id) ORDER BY date DESC, id DESC))[1] AS name
       FROM txn WHERE deleted_at IS NULL AND account_id IS NOT NULL
       GROUP BY account_id ORDER BY 2, 1`,
    );
    return res.rows;
  });

  // Top-level categories by all-time spending, biggest first: the order the web app hands out
  // category hues in, so a category keeps its color in every chart and date range.
  app.get(`${BASE}/api/category-order`, async (): Promise<string[]> => {
    const res = await db.query<{ top_id: string }>(
      `SELECT t.top_id FROM report_txn t WHERE t.spend <> 0
       GROUP BY t.top_id HAVING sum(t.spend) > 0 ORDER BY sum(t.spend) DESC, t.top_id`,
    );
    return res.rows.map((r) => r.top_id);
  });

  app.post(`${BASE}/api/categories`, async (req, reply) => {
    const body = parse(categoryBody, req.body);
    return reply.code(201).send(await createCategory(db, body));
  });

  app.get<{ Params: { id: string } }>(`${BASE}/api/transactions/:id`, async (req) => {
    const res = await db.query("SELECT * FROM txn WHERE id = $1", [Number(req.params.id) || 0]);
    if (!res.rows[0]) throw new HttpError(404, "no such transaction");
    return toDto(res.rows[0]);
  });

  app.get<{ Params: { id: string } }>(`${BASE}/api/transactions/:id/suggestions`, async (req) =>
    suggestions(db, Number(req.params.id) || 0),
  );

  app.post<{ Params: { id: string } }>(`${BASE}/api/transactions/:id/category`, async (req) => {
    const body = parse(recategorizeBody, req.body);
    const result = await recategorize(db, Number(req.params.id) || 0, body, actor(req));
    // Write through to the backend in the background; failures are retried by the sync loop.
    void sync.pushDirty().catch((err) => req.log.warn({ err: (err as Error).message }, "write-through failed"));
    return result;
  });

  app.get(`${BASE}/api/rules`, async () => listRules(db));

  app.post(`${BASE}/api/rules/preview`, async (req) => {
    const body = parse(previewBody, req.body);
    const definition = parseDefinition(body.definition, await CategoryIndex.load(db));
    const rows = await backfillCandidates(db, definition, { excludeTxnId: body.excludeTxnId });
    return { count: rows.length, sample: rows.slice(0, 5).map(toDto) };
  });

  app.post(`${BASE}/api/rules`, async (req, reply) => {
    const body = parse(ruleBody, req.body);
    const result = await inTransaction(db, async (client) => {
      const categories = await CategoryIndex.load(client);
      return saveRule(client, {
        definition: parseDefinition(body.definition, categories),
        applyToPast: body.applyToPast,
        actor: actor(req),
        uiContext: body.uiContext,
        categories,
      });
    });
    void sync.pushDirty().catch(() => undefined);
    return reply.code(result.action === "rule_create" ? 201 : 200).send(result);
  });

  app.put<{ Params: { id: string } }>(`${BASE}/api/rules/:id`, async (req) => {
    const body = parse(ruleBody, req.body);
    const result = await inTransaction(db, async (client) => {
      const categories = await CategoryIndex.load(client);
      return saveRule(client, {
        ruleId: Number(req.params.id) || 0,
        definition: parseDefinition(body.definition, categories),
        applyToPast: body.applyToPast,
        actor: actor(req),
        uiContext: body.uiContext,
        categories,
      });
    });
    void sync.pushDirty().catch(() => undefined);
    return result;
  });

  app.delete<{ Params: { id: string } }>(`${BASE}/api/rules/:id`, async (req) => {
    await inTransaction(db, (client) => deleteRule(client, Number(req.params.id) || 0, actor(req), { surface: "api" }));
    return { ok: true };
  });

  app.get<{ Querystring: { after?: string } }>(`${BASE}/api/decision-events.jsonl`, async (req, reply) => {
    const after = Number(req.query.after ?? 0);
    if (!Number.isInteger(after) || after < 0) throw new HttpError(400, "after must be a non-negative integer");
    const stream = new PassThrough();
    reply
      .type("application/x-ndjson; charset=utf-8")
      .header("Content-Disposition", 'attachment; filename="decision-events.jsonl"');
    exportJsonl(db, after, stream)
      .then(() => stream.end())
      .catch((err) => {
        req.log.error({ err }, "export failed");
        stream.destroy(err as Error);
      });
    return reply.send(stream);
  });

  // The web app.
  const webRoot = config.webRoot ?? join(appRoot(), "dist", "web");
  if (existsSync(join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: `${BASE}/`,
      index: ["index.html"],
      wildcard: true,
      // No ETag or Last-Modified: both come from size and mtime, and the Nix store pins every
      // mtime to 1970, so a new index.html of the same length (fingerprinted names are) would
      // revalidate as 304 and browsers would keep running the build they first cached.
      // Fingerprinted assets never revalidate, and index.html is small enough to resend.
      etag: false,
      lastModified: false,
      setHeaders(reply, path) {
        // Vite fingerprints everything under assets/; the rest (index.html) must revalidate.
        reply.header(
          "Cache-Control",
          path.startsWith(join(webRoot, "assets")) ? "public, max-age=31536000, immutable" : "no-cache",
        );
      },
    });
  } else {
    app.log.warn({ webRoot }, "no built web app; serving the API only");
  }
  app.get(BASE, async (_req, reply) => reply.redirect(`${BASE}/`));

  return app;
}
