#!/usr/bin/env node
/**
 * Headless-browser smoke test of the real server: BACKEND=sample, a throwaway PostgreSQL,
 * the dev auth bypass, and Chromium driven by playwright-core, at a phone and a desktop
 * viewport. It walks the whole flow (load → tap a slice → subcategories and filtered list →
 * tap a subcategory → open a transaction → recategorize → "always" rule → preview → apply →
 * chart and list update → decision log export) and fails on any console error, page error,
 * failed request, or HTTP error. Screenshots of every step go to smoke-output/<viewport>/.
 *
 * Needs: a build (`npm run build`), initdb/pg_ctl and chromium on PATH, e.g.
 *   nix develop -c npm run smoke
 * CHROMIUM_PATH overrides the browser; SMOKE_VIEWPORTS=phone limits the run.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "smoke-output");
const BYPASS = "i-understand-this-disables-login";

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
};

function which(cmd) {
  try {
    return execFileSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(fn, what, timeoutMs = 30_000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not yet
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

async function startPostgres() {
  const dir = mkdtempSync(join(tmpdir(), "finreports-smoke-"));
  const port = await freePort();
  execFileSync("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "--no-sync"], { stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", join(dir, "data"), "-l", join(dir, "log"), "-o", `-k ${dir} -p ${port} -h 127.0.0.1 -c fsync=off`, "-w", "start"], {
    stdio: "ignore",
  });
  return {
    url: (db) => `postgresql://postgres@127.0.0.1:${port}/${db}`,
    createDb: (name) => execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", name]),
    stop: () => {
      try {
        execFileSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function startServer(databaseUrl) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(root, "dist/server/server/main.js")], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      BACKEND: "sample",
      DEV_AUTH_BYPASS: BYPASS,
      DATABASE_URL: databaseUrl,
      PORT: String(port),
      HOST: "127.0.0.1",
      LOG_LEVEL: "warn",
      SYNC_INTERVAL_SECONDS: "3600",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  const base = `http://localhost:${port}`;
  await waitFor(async () => (await fetch(`${base}/reports/-/healthz`)).ok, "server health");
  // The first sync runs right after start; wait until the mirror is filled.
  await waitFor(async () => {
    const s = await (await fetch(`${base}/reports/api/status`)).json();
    return s.lastSyncAt && s.txns > 1000;
  }, "first sync");
  return { base, stop: () => new Promise((r) => (child.once("exit", r), child.kill("SIGTERM"))) };
}

/**
 * Taps the donut slice for `key`. ECharts draws on a canvas, so this computes where the slice
 * is: slices run clockwise from 12 o'clock in row order, the first seven shown and the rest
 * folded into one, at radius 52%-82% of half the smaller side.
 */
async function tapSlice(page, base, query, key, touch) {
  const data = await (await page.request.get(`${base}/reports/api/reports/${query.reportId}/data?${new URLSearchParams(query.params)}`)).json();
  const shown = data.rows.slice(0, 7);
  const rest = data.rows.slice(7).reduce((s, r) => s + r.value, 0);
  const total = shown.reduce((s, r) => s + r.value, 0) + rest;
  let start = 0;
  let mid = null;
  for (const r of shown) {
    if (r.key === key) {
      mid = start + r.value / 2;
      break;
    }
    start += r.value;
  }
  assert(mid !== null, `slice ${key} is one of the first seven`);
  const box = await page.getByTestId("chart").boundingBox();
  const radius = (Math.min(box.width, box.height) / 2) * 0.67;
  const angle = (mid / total) * 2 * Math.PI;
  const x = box.x + box.width / 2 + radius * Math.sin(angle);
  const y = box.y + box.height / 2 - radius * Math.cos(angle);
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function runFlow(name, options, chromiumPath, pg) {
  const shots = join(outDir, name);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const dbName = `smoke_${name}`;
  pg.createDb(dbName);
  const server = await startServer(pg.url(dbName));
  const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
  const problems = [];
  try {
    const context = await browser.newContext({ ...options, colorScheme: "light", locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") problems.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("requestfailed", (req) => {
      // Superseded fetches are aborted on purpose when the view changes.
      if (req.failure()?.errorText !== "net::ERR_ABORTED") problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });
    let step = 0;
    const shot = async (label) => {
      step += 1;
      await page.waitForTimeout(450); // let chart animations settle
      await page.screenshot({ path: join(shots, `${String(step).padStart(2, "0")}-${label}.png`), fullPage: false });
    };
    const crumbs = () => page.getByTestId("breadcrumbs").innerText();
    const range = async () => {
      const u = new URL(page.url());
      return { from: u.searchParams.get("from"), to: u.searchParams.get("to") };
    };

    // 1. Load: the donut and the ranked list render.
    await page.goto(`${server.base}/reports/`);
    await page.getByTestId("chart").locator("canvas").waitFor();
    await page.getByTestId("ranked-row").first().waitFor();
    await page.getByTestId("txn").first().waitFor();
    // Use 12 months so every sample merchant is in range.
    await page.getByTestId("range-12m").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("from")?.endsWith("-01"));
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("load");

    // 2. Tap the Transportation slice: subcategories and a filtered list.
    const r = await range();
    await tapSlice(page, server.base, { reportId: "spending-by-category", params: { ...r } }, "transportation", !!options.hasTouch);
    await page.waitForFunction(() => document.querySelector("[data-testid=breadcrumbs]")?.textContent?.includes("Transportation"));
    await page.locator('[data-testid=ranked-row][data-key="transportation.taxis-and-ride-shares"]').waitFor();
    assert((await crumbs()).includes("All spending"), "breadcrumb root");
    await shot("drill-transportation");

    // 3. Tap the "Taxis and rideshare" slice: the list narrows to it, and shows the
    //    Uber Eats orders Plaid filed as rides.
    await tapSlice(page, server.base, { reportId: "spending-by-category", params: { ...r, path: "transportation" } }, "transportation.taxis-and-ride-shares", !!options.hasTouch);
    await page.waitForFunction(() => document.querySelector("[data-testid=breadcrumbs]")?.textContent?.includes("Taxis and rideshare"));
    const eats = page.locator("[data-testid=txn]", { hasText: "Uber Eats" }).first();
    await eats.waitFor();
    const listCats = await page.locator("[data-testid=txn] .txn-cat").allInnerTexts();
    assert(listCats.length > 0 && listCats.every((c) => c === "Taxis and rideshare"), `list filtered to the subcategory (${[...new Set(listCats)]})`);
    const taxisBefore = await (await page.request.get(`${server.base}/reports/api/reports/spending-by-category/data?${new URLSearchParams({ ...r, path: "transportation" })}`)).json();
    const taxisValueBefore = taxisBefore.rows.find((x) => x.key === "transportation.taxis-and-ride-shares").value;
    await shot("drill-taxis");

    // 4. Tap an Uber Eats transaction: the sheet opens with suggestions and the tree.
    const eatsId = Number(await eats.getAttribute("data-txn-id"));
    await eats.click();
    await page.getByTestId("sheet").waitFor();
    await page.getByTestId("suggestion").first().waitFor();
    await shot("sheet");

    // 5. Pick Restaurants via search, toggle "always", wait for the preview count.
    await page.getByTestId("category-search").fill("restaur");
    await page.locator('[data-testid=sheet] .tree [data-category-id="food-and-drink.restaurant"]').click();
    await page.getByTestId("always-toggle").check();
    await page.getByTestId("preview-count").waitFor();
    const previewCount = Number(await page.getByTestId("preview-count").innerText());
    assert(previewCount > 10, `preview count is meaningful (${previewCount})`);
    assert(await page.getByTestId("apply-past").isChecked(), "apply to past is on by default");
    await shot("rule-preview");

    // 6. Save: the toast confirms, Uber Eats leaves the list, the slice shrinks.
    await page.getByTestId("save").click();
    await page.getByTestId("toast").waitFor();
    const toast = await page.getByTestId("toast").innerText();
    assert(toast.includes(`${previewCount} past`), `toast reports the backfill (${toast})`);
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-testid=txn]")].some((el) => el.textContent?.includes("Uber Eats")));
    const taxisAfter = await (await page.request.get(`${server.base}/reports/api/reports/spending-by-category/data?${new URLSearchParams({ ...r, path: "transportation" })}`)).json();
    const taxisValueAfter = taxisAfter.rows.find((x) => x.key === "transportation.taxis-and-ride-shares").value;
    assert(taxisValueAfter < taxisValueBefore - 100, `taxis shrank (${taxisValueBefore} → ${taxisValueAfter})`);
    const shownValue = await page.locator('[data-testid=ranked-row][data-key="transportation.taxis-and-ride-shares"] .ranked-value').innerText();
    assert(shownValue === `$${Math.round(taxisValueAfter).toLocaleString("en-US")}`, `ranked list shows the new total (${shownValue})`);
    await shot("after-save");

    // 7. Back up to the top level with the breadcrumb: Food and Drink grew.
    await page.getByTestId("breadcrumbs").getByRole("button", { name: "All spending" }).click();
    await page.locator('[data-testid=ranked-row][data-key="food-and-drink"]').waitFor();
    await shot("back-to-top");

    // 8. The decision log has the recategorization, the rule, and every backfilled change.
    const res = await page.request.get(`${server.base}/reports/api/decision-events.jsonl`);
    assert(res.ok(), "export responds");
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    const actions = events.map((e) => e.action);
    assert(actions[0] === "recategorize" && actions[1] === "rule_create", `event order (${actions.slice(0, 3)})`);
    assert(actions.filter((a) => a === "rule_backfill").length === previewCount, "one rule_backfill per previewed transaction");
    const first = events[0];
    assert(first.txnId === eatsId, "event names the tapped transaction");
    assert(first.txn.merchant === "Uber Eats" && first.txn.plaidDetailed === "TAXIS_AND_RIDE_SHARES", "snapshot has merchant and Plaid category");
    assert(typeof first.txn.amount === "number" && first.txn.description.includes("UBER") && first.txn.accountName, "snapshot has amount, description, account");
    assert(first.oldCategoryId === "transportation.taxis-and-ride-shares" && first.oldProvenance === "plaid", "old category and provenance");
    assert(first.newCategoryId === "food-and-drink.restaurant" && first.newProvenance === "manual", "new category and provenance");
    assert(first.uiContext.reportId === "spending-by-category", "ui context report");
    assert(JSON.stringify(first.uiContext.drillPath) === JSON.stringify(["transportation", "transportation.taxis-and-ride-shares"]), "ui context drill path");
    assert(events[1].rule?.when?.merchant?.equals === "uber eats", "rule definition logged");

    // 9. The other report: monthly bars, tap a month.
    await page.getByTestId("report-monthly-trend").click();
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("monthly");
    await page.getByTestId("ranked-row").last().click();
    await page.waitForFunction(() => (document.querySelector("[data-testid=breadcrumbs]")?.textContent ?? "").includes("›"));
    await page.getByTestId("txn").first().waitFor();
    await shot("monthly-drill");

    // 10. Dark mode renders too.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByTestId("report-spending-by-category").click();
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("dark");

    await context.close();
  } finally {
    await browser.close();
    await server.stop();
  }
  if (problems.length) throw new Error(`${name}: ${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  console.log(`${name}: ok (screenshots in ${shots})`);
}

async function main() {
  const chromiumPath = process.env.CHROMIUM_PATH || which("chromium") || which("chromium-browser") || which("google-chrome");
  if (!chromiumPath) throw new Error("no Chromium: set CHROMIUM_PATH or put chromium on PATH (nix shell nixpkgs#chromium)");
  if (!existsSync(join(root, "dist/server/server/main.js")) || !existsSync(join(root, "dist/web/index.html"))) {
    throw new Error("no build: run `npm run build` first");
  }
  const which_ = (process.env.SMOKE_VIEWPORTS ?? "phone,desktop").split(",").map((s) => s.trim()).filter(Boolean);
  const pg = await startPostgres();
  try {
    for (const name of which_) await runFlow(name, VIEWPORTS[name], chromiumPath, pg);
  } finally {
    pg.stop();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
