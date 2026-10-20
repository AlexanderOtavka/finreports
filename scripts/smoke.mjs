#!/usr/bin/env node
/**
 * Headless-browser smoke test of the real server: BACKEND=sample, a throwaway PostgreSQL,
 * the dev auth bypass, and Chromium driven by playwright-core, at a phone and a desktop
 * viewport. It walks the whole flow (load → search the transactions → tap a slice →
 * subcategories and filtered list → tap a subcategory → open a transaction → recategorize →
 * "always" rule → preview → apply → chart and list update → decision log export → a merchant's
 * transactions from the sheet → the rules builder: a group, its proposed rule, saved) and fails
 * on any console error, page error,
 * failed request, or HTTP error. Screenshots of every step go to smoke-output/<viewport>/.
 *
 * Needs: a build (`npm run build`), initdb/pg_ctl and chromium on PATH, e.g.
 *   nix develop -c npm run smoke
 * CHROMIUM_PATH overrides the browser; SMOKE_VIEWPORTS=phone limits the run.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "smoke-output");
const BYPASS = "i-understand-this-disables-login";
// The built service worker: each run changes it to look like a new build, and it is put back.
const swPath = join(root, "dist/web/sw.js");
let swSource = null;

const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  // Added to the Home Screen of an iPhone 15: the whole screen, under the status bar and above
  // the home indicator (the safe area).
  installed: { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, safeArea: { top: 59, bottom: 34 } },
  // An 11-inch iPad Air in portrait, the app added to the Home Screen.
  ipad: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, safeArea: { top: 24, bottom: 20 } },
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
      NAV_LINKS: JSON.stringify([
        { label: "Ledger", url: "/" },
        { label: "Bank sync", url: "https://bank-sync.example.com/", newTab: true },
      ]),
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
 * A report's data as the app computes it: the built report code, over every transaction.
 * `ctx` is `{ from, to, path }`.
 */
async function reportData(page, base, reportId, ctx) {
  const dist = (file) => import(pathToFileURL(join(root, "dist/server/reports", file)).href);
  const [{ findReport }, { inScope, runReport, toReportTxn }] = await Promise.all([dist("index.js"), dist("run.js")]);
  const json = async (path) => (await page.request.get(`${base}/reports/api/${path}`)).json();
  const [txns, categories] = await Promise.all([json("transactions"), json("categories")]);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const report = findReport(reportId);
  return runReport(report, inScope(report, txns.map((t) => toReportTxn(t, byId)), ctx), ctx.path);
}

/**
 * Taps the donut slice for `key`. ECharts draws on a canvas, so this computes where the slice
 * is: slices run clockwise from 12 o'clock in row order, at radius 52%-82% of half the smaller
 * side. Shown are the categories with a hue (the eight biggest of all time) or, further down,
 * the first seven rows; the rest fold into one slice at the end.
 */
async function tapSlice(page, base, reportId, ctx, key, touch) {
  const data = await reportData(page, base, reportId, ctx);
  const hued = (await (await page.request.get(`${base}/reports/api/category-order`)).json()).slice(0, 8);
  const isShown = (r, i) => (data.level === 0 ? hued.includes(r.key) : i < 7);
  const shown = data.rows.filter(isShown);
  const rest = data.rows.filter((r, i) => !isShown(r, i)).reduce((s, r) => s + r.value, 0);
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
  assert(mid !== null, `slice ${key} has a slice of its own`);
  // A new donut sweeps in clockwise: until it has, a tap where a later slice will be hits
  // nothing. Wait for the drawing to stop changing.
  await page.waitForFunction(
    () => {
      const now = document.querySelector("[data-testid=chart] canvas")?.toDataURL();
      const settled = now !== undefined && now === window.__lastChart;
      window.__lastChart = now;
      return settled;
    },
    null,
    { polling: 150 },
  );
  const box = await page.getByTestId("chart").boundingBox();
  const radius = (Math.min(box.width, box.height) / 2) * 0.67;
  const angle = (mid / total) * 2 * Math.PI;
  const x = box.x + box.width / 2 + radius * Math.sin(angle);
  const y = box.y + box.height / 2 - radius * Math.cos(angle);
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

async function runFlow(name, { safeArea, ...options }, chromiumPath, pg) {
  const shots = join(outDir, name);
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const dbName = `smoke_${name}`;
  pg.createDb(dbName);
  const server = await startServer(pg.url(dbName));
  const browser = await chromium.launch({ executablePath: chromiumPath, args: ["--no-sandbox"] });
  const problems = [];
  // While the context is offline on purpose, failing to reach the server is expected.
  let offline = false;
  // Likewise the 401s while the session is made to look over, and the 503s while the server is.
  let signedOut = false;
  let serverDown = false;
  const disconnected = (text) =>
    (offline && /ERR_INTERNET_DISCONNECTED/.test(text)) ||
    (signedOut && /status of 401 \(Unauthorized\)/.test(text)) ||
    (serverDown && /status of 503 \(Service Unavailable\)/.test(text));
  let lastShot = "none yet";
  try {
    const context = await browser.newContext({ ...options, colorScheme: "light", locale: "en-US", timezoneId: "America/New_York" });
    const page = await context.newPage();
    if (safeArea) await (await context.newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
    page.on("console", (msg) => {
      if (msg.type() === "error" && !disconnected(msg.text())) problems.push(`console error: ${msg.text()}`);
    });
    page.on("pageerror", (err) => problems.push(`page error: ${err.message}`));
    page.on("requestfailed", (req) => {
      // Superseded fetches are aborted on purpose when the view changes.
      const error = req.failure()?.errorText ?? "";
      if (error !== "net::ERR_ABORTED" && !disconnected(error)) problems.push(`request failed: ${req.url()} ${error}`);
    });
    page.on("response", (res) => {
      if (res.status() >= 400 && !(signedOut && res.status() === 401) && !(serverDown && res.status() === 503)) problems.push(`HTTP ${res.status()}: ${res.url()}`);
    });
    let step = 0;
    const shot = async (label, { fullPage = false } = {}) => {
      step += 1;
      lastShot = label;
      // A full page is drawn from the top; scrolled, the sticky top bar lands mid-page.
      if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(450); // let chart animations settle
      await page.screenshot({ path: join(shots, `${String(step).padStart(2, "0")}-${label}.png`), fullPage });
    };
    const crumbs = () => page.getByTestId("breadcrumbs").innerText();
    const range = async () => {
      const label = page.getByTestId("range-label");
      return { from: await label.getAttribute("data-from"), to: await label.getAttribute("data-to") };
    };
    const urlParams = () => Object.fromEntries(new URL(page.url()).searchParams);
    const txnTexts = () => page.getByTestId("txn").allInnerTexts();
    // The list filters a frame behind the typing; once it has caught up, the count is final.
    const searched = async () => {
      await page.waitForFunction(() => {
        const status = document.querySelector("[data-testid=txn-search-status]");
        return status && status.getAttribute("data-query") === document.querySelector("[data-testid=txn-search]")?.value;
      });
      return Number((await page.getByTestId("txn-search-count").innerText()).replace(/,/g, ""));
    };

    // 1. Load: the donut and the ranked list render.
    await page.goto(`${server.base}/reports/`);
    await page.getByTestId("chart").locator("canvas").waitFor();
    await page.getByTestId("ranked-row").first().waitFor();
    await page.getByTestId("txn").first().waitFor();
    const navLinks = await page.getByTestId("nav-link").evaluateAll((els) => els.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target")]));
    assert(
      JSON.stringify(navLinks) === JSON.stringify([["Ledger", "/", null], ["Bank sync", "https://bank-sync.example.com/", "_blank"]]),
      `top bar shows the NAV_LINKS (${JSON.stringify(navLinks)})`,
    );
    // A preset range is kept in the URL by name, not as dates.
    const opened = urlParams();
    assert(opened.range === "30d" && !opened.from && !opened.to, `opens on the last 30 days (${page.url()})`);
    await shot("range-30d");
    await page.getByTestId("range-90d").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("range") === "90d");
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("range-90d");
    // "Custom" turns the preset into its dates.
    const ninety = await range();
    await page.getByTestId("range-custom").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has("from"));
    assert(urlParams().from === ninety.from && urlParams().to === ninety.to && !urlParams().range, "custom keeps the dates in the URL");
    await shot("range-custom");
    // Use 12 months so every sample merchant is in range.
    await page.getByTestId("range-12m").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("range") === "12m");
    assert((await range()).from.endsWith("-01"), "12 months start on the 1st");
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("load");

    // 1a. Offline: the service worker has the app's files, and the page a copy of the data, so
    //     a reload with no network draws the same chart at once and says it is offline. Back
    //     online, it updates and says nothing.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.waitForFunction(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open("finreports", 1);
          open.onupgradeneeded = () => open.result.createObjectStore("snapshot");
          open.onerror = () => resolve(false);
          open.onsuccess = () => {
            const get = open.result.transaction("snapshot").objectStore("snapshot").get("data");
            get.onsuccess = () => resolve(Boolean(get.result));
            get.onerror = () => resolve(false);
          };
        }),
    );
    const onlineRows = await page.getByTestId("ranked-row").allInnerTexts();
    offline = true;
    await context.setOffline(true);
    await page.reload();
    await page.getByTestId("ranked-row").first().waitFor();
    await page.locator("[data-testid=sync-status][data-state=offline]").waitFor();
    assert(JSON.stringify(await page.getByTestId("ranked-row").allInnerTexts()) === JSON.stringify(onlineRows), "offline: the same chart");
    assert((await page.getByTestId("txn").count()) > 0, "offline: the transactions are listed");
    await shot("offline");
    await context.setOffline(false);
    offline = false;
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.getByTestId("sync-status").waitFor({ state: "detached" });
    // A new build: the app opened from the cache finds it, and offers to reload into it.
    writeFileSync(swPath, `${swSource}\n// smoke: a new build for ${name}\n`);
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
    await page.getByTestId("update-banner").waitFor();
    await shot("update-ready");
    await page.getByTestId("update-reload").click();
    await page.getByTestId("ranked-row").first().waitFor();
    assert((await page.getByTestId("update-banner").count()) === 0, "the reloaded app is the new build");
    // A slow server: the copy is on screen at once, "Updating…" until the server's arrives.
    await page.route("**/reports/api/transactions", async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await page.reload();
    await page.locator("[data-testid=sync-status][data-state=updating]").waitFor();
    assert(JSON.stringify(await page.getByTestId("ranked-row").allInnerTexts()) === JSON.stringify(onlineRows), "updating: the kept chart");
    await shot("updating");
    await page.getByTestId("sync-status").waitFor({ state: "detached" });
    await page.unrouteAll({ behavior: "wait" });
    // A server that fails: the copy stays, and "Not updated" tries again.
    serverDown = true;
    await page.route("**/reports/api/transactions", (route) => route.fulfill({ status: 503, json: { error: "unavailable" } }));
    await page.reload();
    await page.locator("[data-testid=sync-status][data-state=error]").waitFor();
    await shot("not-updated");
    await page.unrouteAll();
    serverDown = false;
    await page.getByTestId("sync-status").getByRole("button").click();
    await page.getByTestId("sync-status").waitFor({ state: "detached" });
    // A session that is over keeps the copy on screen, with a "Log in" button, rather than
    // leaving for the login page.
    signedOut = true;
    await page.route("**/reports/api/**", (route) => route.fulfill({ status: 401, json: { error: "login required" } }));
    await page.reload();
    await page.getByTestId("login").waitFor();
    assert((await page.getByTestId("sync-status").count()) === 0, "signed out: the Log in button says it, not a status");
    assert(JSON.stringify(await page.getByTestId("ranked-row").allInnerTexts()) === JSON.stringify(onlineRows), "signed out: the same chart");
    await shot("signed-out");
    await page.unrouteAll();
    signedOut = false;
    await page.reload();
    await page.getByTestId("ranked-row").first().waitFor();
    await page.getByTestId("logout").waitFor();
    await page.getByTestId("sync-status").waitFor({ state: "detached" });
    // A session that is over while Firefly's is not: the app logs in again in the background
    // (with the dev bypass, the login is one redirect) and stays as it is, no "Log in".
    signedOut = true;
    let renewed = false;
    await page.route("**/reports/auth/login*", (route) => {
      renewed = true;
      return route.continue();
    });
    await page.route("**/reports/api/**", (route) => (renewed ? route.continue() : route.fulfill({ status: 401, json: { error: "login required" } })));
    await page.reload();
    await page.getByTestId("ranked-row").first().waitFor();
    await page.getByTestId("sync-status").waitFor({ state: "detached" });
    assert(renewed, "renewed: the app logged in again in the background");
    assert((await page.getByTestId("login").count()) === 0, "renewed: no Log in button");
    assert(JSON.stringify(await page.getByTestId("ranked-row").allInnerTexts()) === JSON.stringify(onlineRows), "renewed: the same chart");
    await page.unrouteAll();
    signedOut = false;

    // 1b. Search the transactions: the icon opens a search bar; every word has to match some
    //     field (merchant, date, category, amount, description, notes, tags…), and the matches
    //     are highlighted.
    const listTotal = Number((await page.locator(".section-title .muted").innerText()).replace(/\D/g, ""));
    await page.getByTestId("txn-search-open").click();
    await page.getByTestId("txn-search").waitFor();
    assert(await page.getByTestId("txn-search").evaluate((el) => el === document.activeElement), "the search bar has focus");
    await shot("search-open");
    await page.getByTestId("txn-search").fill("trader");
    const traders = await searched();
    assert(traders > 5 && traders < listTotal, `"trader" narrows the list (${traders} of ${listTotal})`);
    assert((await txnTexts()).every((t) => t.includes("Trader Joe")), "every result is Trader Joe's");
    assert((await page.locator("[data-testid=txn] mark").first().innerText()).toLowerCase() === "trader", "the match is highlighted");
    // A merchant and a month (the oldest, a whole one): both have to match.
    const mon = (await page.locator(".txn-date").last().innerText()).slice(0, 3);
    await page.getByTestId("txn-search").fill(`trader ${mon.toLowerCase()}`);
    const tradersInMonth = await searched();
    assert(tradersInMonth > 0 && tradersInMonth < traders, `"trader ${mon}" narrows it further (${tradersInMonth})`);
    const days = await page.locator(".txn-date").allInnerTexts();
    assert(days.every((d) => d.startsWith(mon)), `all on days in ${mon} (${days})`);
    assert((await txnTexts()).every((t) => t.includes("Trader Joe")), "and all still Trader Joe's");
    // The header adds up the matches (all drawn: one month is under a page).
    const amounts = await page.locator("[data-testid=txn] .txn-amount").allInnerTexts();
    const cents = amounts.reduce((sum, a) => sum + (a.startsWith("+") ? 1 : -1) * Math.round(Number(a.replace(/[^\d.]/g, "")) * 100), 0);
    const net = Number(await page.getByTestId("txn-totals").getAttribute("data-net"));
    assert(amounts.length === tradersInMonth && Math.round(net * 100) === cents, `the net is the matches' sum (${net}, ${cents / 100})`);
    await shot("search-compound", { fullPage: true });
    // A word the row does not show (the cat's name, in the vet visits' notes): the field it is
    // in is shown under the row.
    await page.getByTestId("txn-search").fill("miso");
    assert((await searched()) > 0, "notes are searchable");
    const hits = await page.getByTestId("txn-hit").allInnerTexts();
    assert(hits.length > 0 && hits.every((h) => h.startsWith("Notes") && h.includes("Miso")), `the matching note is shown (${hits})`);
    await shot("search-hidden-field", { fullPage: true });
    await page.getByTestId("txn-search").press("Escape");
    await page.getByTestId("txn-search-open").waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));

    // 2. Tap the Transportation slice: subcategories and a filtered list.
    const r = await range();
    await tapSlice(page, server.base, "spending-by-category", { ...r, path: [] }, "transportation", !!options.hasTouch);
    await page.waitForFunction(() => document.querySelector("[data-testid=breadcrumbs]")?.textContent?.includes("Transportation"));
    await page.locator('[data-testid=ranked-row][data-key="transportation.taxis-and-ride-shares"]').waitFor();
    assert((await crumbs()).includes("All spending"), "breadcrumb root");
    await shot("drill-transportation");

    // 3. Tap the "Taxis and rideshare" slice: its merchants, and the list narrows to it and
    //    shows the Uber Eats orders Plaid filed as rides.
    await tapSlice(page, server.base, "spending-by-category", { ...r, path: ["transportation"] }, "transportation.taxis-and-ride-shares", !!options.hasTouch);
    await page.waitForFunction(() => document.querySelector("[data-testid=breadcrumbs]")?.textContent?.includes("Taxis and rideshare"));
    const eats = page.locator("[data-testid=txn]", { hasText: "Uber Eats" }).first();
    await eats.waitFor();
    await page.locator('[data-testid=ranked-row][data-key="uber eats"]').waitFor();
    const listCats = await page.locator("[data-testid=txn] .txn-cat").allInnerTexts();
    assert(listCats.length > 0 && listCats.every((c) => c === "Taxis and rideshare"), `list filtered to the subcategory (${[...new Set(listCats)]})`);
    const taxisBefore = await reportData(page, server.base, "spending-by-category", { ...r, path: ["transportation"] });
    const taxisValueBefore = taxisBefore.rows.find((x) => x.key === "transportation.taxis-and-ride-shares").value;
    await shot("drill-taxis");

    // 4. Tap an Uber Eats transaction: the sheet opens with suggestions and the tree.
    const eatsId = Number(await eats.getAttribute("data-txn-id"));
    await eats.click();
    await page.getByTestId("sheet").waitFor();
    await page.getByTestId("suggestion").first().waitFor();
    // The merchant's name searches for it; next to it, a web search for who they are.
    const lookup = page.getByTestId("merchant-lookup");
    assert((await lookup.getAttribute("href")) === "https://duckduckgo.com/?q=Uber%20Eats", `look up links to DuckDuckGo (${await lookup.getAttribute("href")})`);
    assert((await lookup.getAttribute("target")) === "_blank", "look up opens a new tab");
    assert((await page.getByTestId("txn-details").innerText()).includes("ubereats.com"), "the sheet shows the merchant's website");
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

    // 6. Save: the toast confirms, Uber Eats leaves the list and the merchants, the slice shrinks.
    await page.getByTestId("save").click();
    await page.getByTestId("toast").waitFor();
    const toast = await page.getByTestId("toast").innerText();
    assert(toast.includes(`${previewCount} past`), `toast reports the backfill (${toast})`);
    await page.waitForFunction(() => ![...document.querySelectorAll("[data-testid=txn]")].some((el) => el.textContent?.includes("Uber Eats")));
    const taxisAfter = await reportData(page, server.base, "spending-by-category", { ...r, path: ["transportation"] });
    const taxisValueAfter = taxisAfter.rows.find((x) => x.key === "transportation.taxis-and-ride-shares").value;
    assert(taxisValueAfter < taxisValueBefore - 100, `taxis shrank (${taxisValueBefore} → ${taxisValueAfter})`);
    await page.waitForFunction(() => !document.querySelector('[data-testid=ranked-row][data-key="uber eats"]'));
    await shot("after-save");
    await page.getByTestId("breadcrumbs").getByRole("button", { name: "Transportation" }).click();
    const shownValue = page.locator('[data-testid=ranked-row][data-key="transportation.taxis-and-ride-shares"] .ranked-value');
    await page.waitForFunction(
      (want) => document.querySelector('[data-testid=ranked-row][data-key="transportation.taxis-and-ride-shares"] .ranked-value')?.textContent === want,
      `$${Math.round(taxisValueAfter).toLocaleString("en-US")}`,
    ).catch(async () => assert(false, `ranked list shows the new total (${await shownValue.innerText()})`));

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

    // 9. The other report: bars stacked by category, listed under the chart as its legend. A
    //    tap on a category in the list stacks the bars by its subcategories; a tap in the last
    //    month's column, above its bar, opens the category donut for that month, at that category.
    //    Leaving a custom range for it selects only its preset and closes the custom dates.
    await page.getByTestId("range-custom").click();
    await page.locator(".custom-range").waitFor();
    await page.getByTestId("report-monthly-trend").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has("range"));
    const chips = await page.locator(".range-bar .chip.selected").evaluateAll((els) => els.map((el) => el.textContent));
    assert(chips.length === 1 && chips[0] !== "Custom", `one range selected after switching report (${chips})`);
    assert(!(await page.locator(".custom-range").count()), "custom dates closed after switching report");
    await page.locator('[data-testid=ranked-row][data-key="rent-and-utilities"]').waitFor();
    await shot("monthly");
    const monthlyRange = page.url();
    await page.locator('[data-testid=ranked-row][data-key="food-and-drink"]').click();
    await page.locator('[data-testid=ranked-row][data-key="food-and-drink.restaurant"]').waitFor();
    assert(urlParams().r === "monthly-trend" && urlParams().p === "food-and-drink", `a category drills the monthly report (${page.url()})`);
    assert(urlParams().range === new URL(monthlyRange).searchParams.get("range"), "the drill keeps the range");
    assert((await crumbs()).includes("Food"), "the breadcrumb names the category");
    await shot("monthly-food");
    const bars = await page.getByTestId("chart").boundingBox();
    await page.mouse.click(bars.x + bars.width - 26, bars.y + 30);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("r") === "spending-by-category");
    assert(urlParams().p === "food-and-drink", `the month opens at the same category (${page.url()})`);
    const month = await range();
    assert(urlParams().from === month.from && urlParams().to === month.to && !urlParams().range, "a month is a custom range in the URL");
    assert(month.from.endsWith("-01") && month.from.slice(0, 7) === month.to.slice(0, 7), `opened one month (${month.from} – ${month.to})`);
    await page.getByTestId("ranked-row").first().waitFor();
    await page.getByTestId("txn").first().waitFor();
    await shot("monthly-to-month");

    // 10. Drill on to a merchant: subcategory, then the biggest merchant narrows the list.
    await page.locator('[data-testid=ranked-row][data-key="food-and-drink.restaurant"]').click();
    await page.waitForFunction(() => document.querySelector("[data-testid=breadcrumbs]")?.textContent?.includes("Restaurants"));
    await page.waitForFunction(() => !document.querySelector('[data-testid=ranked-row][data-key="food-and-drink.restaurant"]'));
    const top = page.getByTestId("ranked-row").first();
    const merchantName = await top.locator(".ranked-label").innerText();
    await top.click();
    await page.locator("[data-testid=ranked-row].selected").waitFor();
    await page.waitForFunction((m) => [...document.querySelectorAll("[data-testid=txn]")].every((el) => el.textContent?.includes(m)), merchantName);
    await shot("merchant");

    // 10b. Back to all the restaurants (tap the selected merchant again), and open a transaction
    //      from one of them: Plaid's website and location for the merchant. Tap the merchant's
    //      name: the sheet closes and the list below the chart searches for that merchant. The
    //      chart, its drill path and the range stay as they were.
    await top.click();
    await page.waitForFunction(() => !document.querySelector("[data-testid=ranked-row].selected"));
    // A sit-down restaurant: Plaid has where it is. Its showing up means the list has reloaded.
    const other = page
      .locator("[data-testid=txn]", { hasText: /Lucali|Roberta's|Olmsted|Fonda|Miriam|Shake Shack|Sweetgreen/ })
      .filter({ hasNotText: merchantName })
      .first();
    await other.waitFor();
    const restaurantsUrl = page.url();
    const restaurantsRows = await page.getByTestId("ranked-row").count();
    const restaurantsTotal = Number((await page.locator(".section-title .muted").innerText()).replace(/\D/g, ""));
    await other.click();
    await page.getByTestId("sheet").waitFor();
    const otherName = await page.getByTestId("merchant-search").innerText();
    const details = await page.getByTestId("txn-details").innerText();
    assert(details.includes("Website") && details.includes("Location"), `the sheet shows the website and location (${details})`);
    assert((await page.getByTestId("txn-location").getAttribute("href")).startsWith("https://www.openstreetmap.org/?mlat="), "location links to a map");
    await shot("sheet-details");
    await page.getByTestId("merchant-search").click();
    await page.getByTestId("sheet").waitFor({ state: "detached" });
    assert((await page.getByTestId("txn-search").inputValue()) === `"${otherName}"`, "the search is the merchant's name");
    const inRestaurants = await searched();
    assert(inRestaurants > 0 && inRestaurants < restaurantsTotal, `the list narrows to ${otherName} (${inRestaurants} of ${restaurantsTotal})`);
    assert((await txnTexts()).every((t) => t.includes(otherName)), `every result is ${otherName}`);
    assert(page.url() === restaurantsUrl, `the drill path and range stay (${page.url()})`);
    assert((await crumbs()).includes("Restaurants"), "the breadcrumb still says Restaurants");
    assert((await page.getByTestId("ranked-row").count()) === restaurantsRows, "the chart still lists every restaurant");
    assert((await page.getByTestId("txn-search-scope").innerText()).startsWith("Restaurants · "), "the search says what it is within");
    await shot("merchant-search", { fullPage: true });
    // The chart's own controls still narrow or widen what the search looks through.
    await page.getByTestId("breadcrumbs").getByRole("button", { name: "All spending" }).click();
    await page.waitForFunction(() => document.querySelector("[data-testid=txn-search-scope]")?.textContent?.startsWith("All spending"));
    const inAll = await searched();
    assert(inAll >= inRestaurants && (await txnTexts()).every((t) => t.includes(otherName)), `${otherName} across all spending (${inAll})`);
    await shot("merchant-search-all-spending", { fullPage: true });

    // 11. Dark mode renders too (with the search still open).
    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByTestId("report-spending-by-category").click();
    await page.getByTestId("ranked-row").first().waitFor();
    await shot("dark");
    // A restaurant from step 10, so it is in range whatever day the sample data ends on.
    await page.getByTestId("txn-search").fill(otherName.toLowerCase());
    assert((await searched()) > 0, `dark: search finds ${otherName}`);
    await page.getByTestId("txn-search").evaluate((el) => el.closest("section").scrollIntoView({ block: "start" }));
    await shot("dark-search");

    // 12. The account filter: only one card, then a second one. It sticks through report tabs,
    //     ranges, links between reports and the back button; a fresh load of a URL without it
    //     shows all accounts again.
    await page.getByTestId("txn-search").fill("");
    const accountsParam = () => new URL(page.url()).searchParams.get("accounts");
    // Next to the range bar where both fit, below it on a phone.
    const rangeBox = await page.locator(".range-bar").boundingBox();
    const toggleBox = await page.getByTestId("accounts-toggle").boundingBox();
    const oneLine = toggleBox.y < rangeBox.y + rangeBox.height;
    assert(oneLine === options.viewport.width >= 768, `account filter ${oneLine ? "beside" : "below"} the range bar at ${options.viewport.width}px`);
    await page.getByTestId("accounts-toggle").click();
    await page.getByTestId("accounts").waitFor();
    await page.getByRole("button", { name: "Only Jordan Rewards Visa ••3308" }).click();
    assert(accountsParam() === "jordan", `only one account in the URL (${page.url()})`);
    assert((await page.getByTestId("accounts-toggle").innerText()).includes("Jordan Rewards Visa"), "the filter names the account");
    assert(await page.locator('[data-testid=account-checkbox][data-account="jordan"]').isDisabled(), "the last checked account cannot be unchecked");
    await page.locator('[data-testid=account-checkbox][data-account="sam"]').check();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("accounts") === "jordan,sam");
    await shot("accounts");
    await page.getByTestId("report-monthly-trend").click();
    await page.getByTestId("ranked-row").first().waitFor();
    assert(accountsParam() === "jordan,sam", "a report tab keeps the accounts");
    await page.getByTestId("range-90d").click();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("range") === "90d");
    assert(accountsParam() === "jordan,sam", "a range keeps the accounts");
    await page.getByTestId("ranked-row").first().click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has("p"));
    assert(accountsParam() === "jordan,sam", "a drill keeps the accounts");
    const monthBars = await page.getByTestId("chart").boundingBox();
    await page.mouse.click(monthBars.x + monthBars.width - 26, monthBars.y + 30);
    await page.waitForFunction(() => new URL(location.href).searchParams.get("r") === "spending-by-category");
    assert(accountsParam() === "jordan,sam", "a link to another report keeps the accounts");
    await page.goBack();
    await page.waitForFunction(() => new URL(location.href).searchParams.get("r") === "monthly-trend");
    assert(accountsParam() === "jordan,sam", "the back button keeps the accounts");
    assert((await page.getByTestId("accounts-toggle").innerText()).includes("2 of 5"), "the filter counts the accounts");
    await page.goto(`${server.base}/reports/?r=spending-by-category&range=12m`);
    await page.getByTestId("ranked-row").first().waitFor();
    assert(accountsParam() === null && (await page.getByTestId("accounts-toggle").innerText()).includes("All accounts"), "a fresh load without the filter shows all accounts");

    // 12b. The rules builder: what is missing a merchant or a category, grouped by description.
    //      The old card's Trader Joe's statements match Plaid's Trader Joe's; its rule fills in
    //      the merchant and the category, and the group is gone. In light mode again.
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByTestId("report-rules-builder").click();
    await page.getByTestId("builder-summary").waitFor();
    await page.getByTestId("builder-group").first().waitFor();
    assert(urlParams().r === "rules-builder" && !urlParams().range, `the builder is in the URL (${page.url()})`);
    const deficientBefore = Number((await page.getByTestId("builder-deficient").innerText()).replace(/,/g, ""));
    assert(deficientBefore > 500, `the builder counts what is missing (${deficientBefore})`);
    assert((await page.locator(".range-bar").count()) === 0, "no range bar in the builder");
    await shot("builder");
    const tj = page.locator('[data-testid=builder-group][data-key="trader joes"]');
    await tj.scrollIntoViewIfNeeded();
    assert((await tj.getByTestId("builder-match").innerText()).includes("Trader Joe's"), "the group matches Trader Joe's");
    await tj.click();
    await page.getByTestId("proposal-sheet").waitFor();
    assert((await page.getByTestId("candidate").first().getAttribute("aria-checked")) === "true", "the best match is picked");
    assert((await page.getByTestId("proposal-merchant").inputValue()) === "Trader Joe's", "the merchant is copied from it");
    await page.getByTestId("proposal-count").waitFor();
    const proposalCount = Number(await page.getByTestId("proposal-count").innerText());
    assert(proposalCount > 5, `the rule would change the group (${proposalCount})`);
    await shot("builder-proposal");
    await page.getByTestId("proposal-save").click();
    await page.getByTestId("proposal-sheet").waitFor({ state: "detached" });
    await page.getByTestId("toast").waitFor();
    const builderToast = await page.getByTestId("toast").innerText();
    assert(builderToast.includes(`${proposalCount} transactions updated`), `the toast says what the rule did (${builderToast})`);
    await page.waitForFunction(() => !document.querySelector('[data-testid=builder-group][data-key="trader joes"]'));
    const deficientAfter = Number((await page.getByTestId("builder-deficient").innerText()).replace(/,/g, ""));
    assert(deficientAfter === deficientBefore - proposalCount, `the count drops by the group (${deficientBefore} → ${deficientAfter})`);
    await shot("builder-after");
    // A group with nothing to copy from: name it yourself.
    await page.locator('[data-testid=builder-group][data-key="key food"]').click();
    await page.getByTestId("proposal-sheet").waitFor();
    assert((await page.getByTestId("candidate-own").getAttribute("aria-checked")) === "true", "no match: name it yourself");
    await shot("builder-no-match");
    await page.keyboard.press("Escape");
    await page.getByTestId("proposal-sheet").waitFor({ state: "detached" });
    // Back to the reports.
    await page.getByTestId("report-spending-by-category").click();
    await page.getByTestId("ranked-row").first().waitFor();

    // 13. Log out: the session ends, and the copy of the data on this device is gone.
    await page.getByTestId("logout").click();
    await page.getByTestId("logged-out").waitFor();
    const keptAfter = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const open = indexedDB.open("finreports", 1);
          open.onsuccess = () => {
            const get = open.result.transaction("snapshot").objectStore("snapshot").get("data");
            get.onsuccess = () => resolve(get.result !== undefined);
          };
        }),
    );
    assert(!keptAfter, "logging out removes the data from the device");
    assert((await page.getByTestId("logged-out").innerText()).includes("no longer kept"), "logged out says the data is gone");
    await shot("logged-out");
    // The dev bypass logs straight back in.
    await page.getByTestId("login-again").click();
    await page.getByTestId("ranked-row").first().waitFor();

    await context.close();
  } catch (err) {
    // CI keeps no screenshots of a failed run: say where it stopped.
    err.stack = `${name}, after screenshot "${lastShot}": ${err.stack}`;
    throw err;
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
  swSource = readFileSync(swPath, "utf8");
  const which_ = (process.env.SMOKE_VIEWPORTS ?? "phone,desktop,installed").split(",").map((s) => s.trim()).filter(Boolean);
  const pg = await startPostgres();
  try {
    for (const name of which_) await runFlow(name, VIEWPORTS[name], chromiumPath, pg);
  } finally {
    pg.stop();
    writeFileSync(swPath, swSource);
  }
}

main().catch((err) => {
  console.error(err.stack ?? err);
  process.exit(1);
});
