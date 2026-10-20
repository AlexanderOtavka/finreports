# finreports

Interactive, phone-first reports on top of your transaction ledger, with quick recategorizing,
merchant rules, and an append-only log of every categorization decision, ready to export as
training data for a smarter rules engine. It works with [Firefly III](https://www.firefly-iii.org/)
today, behind a backend interface small enough to swap for another ledger.

```
Plaid / SimpleFIN / …  →  Firefly (ledger)  ⇄  backend adapter  ⇄  finreports + PostgreSQL  →  PWA at /reports/
```

Tap a slice of the spending donut to drill into its subcategories, then a subcategory for its
merchants. The monthly report stacks each month's bar by category and drills the same way:
tap a category under the chart to stack the bars by its subcategories over the same months
(groceries against restaurants), then a subcategory for its merchants. Tap a month to open the
donut for just that month, at the same drill path. The transactions behind the selection scroll below the chart. Tap
one to recategorize it, or to "always categorize" that merchant: a rule, previewed against
past transactions and optionally applied to them.

The magnifier above the transactions searches them, right in the browser: every word has to
match some field (merchant, date as `2026-09-14`, `9/14`, `Sep 14` or `Monday`, category,
amount, the bank's raw description, account, notes, tags, website), so `trader sep` is
Trader Joe's in September. `"Quoted words"` stay together, and a number is a whole number
(`20` is the 20th or $20, not 2025). Matches are highlighted; a word found only in a field
the list does not show (a note, a tag) brings that field up under the row. Search keeps the
chart's range and drill path (it says which, under the bar). The list's header adds up what it lists, all
of it or the matches: the net, then money in − money out when there is some of each, so a
search for a card shows its refunds next to its charges. In a transaction, the merchant's
name searches the list for that merchant, in place, and "Look up" searches the web for it (DuckDuckGo), for the merchants nobody recognizes. Plaid's
website and location for the merchant, and the ledger's notes and tags, are shown there too.

The **Rules** tab fills in what imported history lacks. A bank's CSV statement, imported
into the ledger, has only a raw description: no merchant and no category, so neither the
reports nor the merchant rules can place it. The tab lists the transactions missing a merchant,
a category, or both, grouped by description (`TRADER JOE'S #558` and `#561` are one group),
with how many, how much and when, and how many are grouped and how many are left over. Each
group comes with the merchants it looks like: merchants whose transactions have both a
merchant and a category, and whose own (Plaid) descriptions resemble the group's, with a
confidence and the evidence (their descriptions, a few of their transactions). Tap a group for
its proposed rule: the description → that merchant and that category, both editable, with
what it would change. Saved, it fills in the past transactions and every new one that matches,
and writes the merchant and the category back to the ledger.

Every report counts all accounts until you check only some of them (the button by the date
range), to see one credit card's spending or leave one out. The choice is kept in the URL
(`accounts=…`) and sticks through report tabs, ranges, drill-downs and the back button; only
loading a URL without it shows all accounts again.

A category keeps its color in every chart, range and drill level: the eight biggest
top-level categories of all time take the eight palette hues, in order (the smaller ones are
gray and fold into "Other"). Subcategories and merchants are shades of their category's hue.
The biggest one wears the hue itself, and the rest alternate lighter and darker so that
neighboring slices stand apart.

The chart and the list are computed from scratch from the report, range, accounts and drill
path, every time any of them changes: the same view always looks the same, however you got
there.

## Quick start

With [Nix](https://nixos.org/download) and flakes:

```bash
nix flake check               # build, typecheck, unit tests, and a headless-browser smoke test
nix develop -c npm ci         # then see "Development" below
```

Run the image against your own PostgreSQL and Firefly:

```bash
docker run -p 8080:8080 \
  -e DATABASE_URL=postgresql://finreports:…@db:5432/finreports \
  -e FIREFLY_INTERNAL_URL=http://firefly:8080 -e FIREFLY_TOKEN=… \
  -e PUBLIC_ORIGIN=https://firefly.example.com \
  -e OAUTH_CLIENT_ID=… -e OAUTH_CLIENT_SECRET=… -e ALLOWED_EMAILS=you@example.com \
  ghcr.io/alexanderotavka/finreports:latest
```

finreports serves everything under `/reports` and logs in through Firefly's OAuth, so it is
meant to share Firefly's origin behind a reverse proxy that routes `/reports/` to it. Create
a confidential OAuth client in Firefly (Options → Profile → OAuth) with the redirect URL
`<PUBLIC_ORIGIN>/reports/auth/callback`, and a personal access token for the sync.

## How it works

- **Backend adapters** (`src/server/adapters/`) are the only code that knows which ledger holds
  the transactions. `firefly` uses Firefly III's REST API (never its tables); `sample` serves a
  generated dataset. Writing a new backend means implementing `BackendAdapter`
  (`adapters/types.ts`): list accounts and categories, list transactions changed since a
  cursor, set a transaction's category, and set its merchant (Firefly's payee: the
  destination account of a withdrawal, the source of a deposit).
- **Database** (`migrations/`, plain SQL, applied at startup):
  - `txn`: normalized mirror of the backend's transactions, one row per split, with the
    category's **provenance**: `plaid` (the importer's guess from Plaid), `backend` (someone
    or something in the ledger chose it), `rule:<id>`, `manual`, or `none`. Also the
    merchant's website and location (the Plaid connector writes Plaid's into Firefly's
    external URL and latitude/longitude), and the ledger's notes and tags. The merchant has a
    provenance too: the backend's (`backend_merchant`, null when it has none, as for a CSV
    import's "(no name)" payee) or one a rule filled in (`rule:<id>`).
  - `category`: the tree (two levels), seeded from Plaid's primary/detailed taxonomy. Firefly's
    categories are flat, so the tree lives here; top-level names are the names the Plaid
    connector writes, so Firefly's categories map back by name.
  - `rule` + `rule_version`: rules as JSON (`src/shared/rules.ts`), every version kept.
  - `decision_event`: append-only (triggers refuse UPDATE, DELETE and TRUNCATE).
  - `report_txn`: the transactions with their category's place in the tree and their
    spending, for the server's own queries (the reports compute the same in the browser).
- **Sync loop** (`src/server/sync.ts`): every `SYNC_INTERVAL_SECONDS`, pull changes through
  the adapter into `txn`, run the rules over new and changed transactions, and write locally
  decided merchants and categories back through the adapter. A failed write stays queued (`backend_dirty`)
  and is retried. A full listing every `FULL_SYNC_INTERVAL_HOURS` notices deletions.
- **Web app** (`src/web/`): Vite + React + ECharts, built into `dist/web` and served by the
  same Fastify server under `/reports/`. It loads every transaction once (`/api/transactions`,
  gzipped) and runs the reports itself, so a new report, range, set of accounts or drill path
  recomputes the chart and the list from scratch, with no request. Installable as a PWA. It borrows Firefly III's look
  (AdminLTE's blue navbar and boxes) so it sits comfortably next to it.
- **Offline**: a service worker (`src/sw/sw.ts`, built to `/reports/sw.js` with the list of
  the build's files) serves the app's files from a cache, and the page keeps the last data the
  server sent in IndexedDB (`src/web/store.ts`). So the app opens at once from that copy, and
  opens with no network at all, then refreshes from the server in the background, again when
  the network comes back, and when it comes back to the front five minutes or more later. While
  the copy on screen is not the server's latest, the top bar says so: "Updating…", "Offline"
  or "Not updated" with the time of the copy (tap to try again); once the session is over, the
  copy stays on screen and the button at the end of the bar turns into "Log in", with an
  orange dot. Recategorizing needs the server. When a new build has been downloaded (the app
  looks for one on every launch and whenever it comes back to the front), a banner offers to
  reload into it; otherwise the next launch opens it. The copy stays on the device
  when a session times out; the "Log out" button at the end of the top bar ends the session
  and removes it (offline, it removes the copy, and the session ends on its own once idle).

## Categories, rules and provenance

- Tapping a transaction opens the recategorize sheet: suggestions first (what this merchant's
  other transactions are filed under, Plaid's own guess, and recently chosen categories), then
  the whole tree, searchable. Saving makes the category `manual`.
- "Always categorize *Merchant* as X" creates a merchant rule
  (`{"when": {"merchant": {"equals": "<merchant key>"}}, "then": {"categoryId": "…"}}`). The
  sheet previews how many past transactions it would change and, if asked, applies it to them
  (`rule_backfill`). Toggling it again for the same merchant edits that rule (a new version).
- The merchant key is the backend's cleaned merchant name, or the raw description stripped of
  processor prefixes, store numbers and city (`src/shared/merchant.ts`), so that
  `SQ *SUDS WASH AND FOLD 8832 BROOKLYN NY` and `… 1041 …` are one merchant.
- Rules never change a `manual` category. After a sync they also leave `backend` categories
  alone; an explicit backfill, which a person asks for, does not. The newest matching rule wins.
- Rules are data, so richer predicates are added in `src/shared/rules.ts` (schema + evaluator):
  `merchant`, `description`, `descriptionKey`, `account` (`equals`/`contains`), `amount`
  (`min`/`max`), and `all`/`any`/`not`. Schema 1 rules set a category
  (`"then": {"categoryId": …}`); schema 2 rules set a category, a merchant, or both
  (`"then": {"merchant": "Trader Joe's", "categoryId": …}`).
- The rules builder's rules are schema 2:
  `{"schema": 2, "when": {"descriptionKey": {"equals": "trader joes"}}, "then": {"merchant": "Trader Joe's", "categoryId": "food-and-drink.groceries"}}`.
  A description key is the cleaned description without the words that carry a number (store
  numbers, references), so the grouping and the rule agree, and it does not depend on the
  merchant, so the rule still matches once it has filled the merchant in.
- A rule fills in a merchant only where the backend has none (or has only the one a rule wrote
  to it): it never renames a merchant the backend knows, and leaves transfers alone. Merchants
  come first: the newest matching rule that sets a merchant fills it in, then the newest
  matching rule that sets a category (looking at the merchant just filled in) sets that, so
  "Always categorize Trader Joe's" also reaches the imported Trader Joe's statements. A
  merchant filled in by a rule is written back to the backend (`merchant_dirty`, retried like
  a category); a merchant later changed in the backend is the backend's again.

## The decision log

Every manual recategorization and every rule create/update/delete/backfill appends one
`decision_event` row: timestamp, actor (the Firefly login email), action, a full snapshot of
the transaction as it was (merchant, description, amount, account, date, Plaid categories,
prior category and its provenance), old → new category and provenance, old → new merchant
when a rule that sets one is involved, the rule definition and version if any, and the UI
context (report, drill path, date range, or the surface, `rules-builder`). Events written since
merchants can be set say `schemaVersion: 2`. Export it as JSON lines:

```bash
curl -b "REPORTSSESSION=…" https://firefly.example.com/reports/api/decision-events.jsonl
curl … '/reports/api/decision-events.jsonl?after=1234'   # only events after id 1234
```

## Adding a report

Reports are code: one file per report in `src/reports/`, run in the browser over every
transaction (`src/reports/run.ts`).

1. Copy `src/reports/monthly-trend.ts` to `src/reports/<your-report>.ts`.
2. Fill in the `ReportDefinition` (`src/reports/types.ts`):
   - `baseFilter(txn)`: whether the report counts a transaction at all.
   - `levels`: one entry per drill level. `key(txn)` is the key a transaction files under at
     this level (a tap on that key narrows to the transactions with it); `rows(txns)` returns
     the level's rows of `key`, `label`, `value` from the transactions in the range, the
     accounts and under the keys tapped above. `sumRows(txns, key, label)` sums the spending
     per key.
   - `chart(data, theme, selectedKey)`: the whole ECharts option, from scratch; nothing of
     the last one stays. Give each series an `id`: a series with the same id as one on screen
     animates to its new values. Give each datum a `key`, so a tap drills (or, on the last
     level, selects). On a column chart, give the category axis entries a `key` instead
     (`{ value: "Sep", key: "2026-09" }`) and a tap anywhere in the column counts. Colors:
     `theme.categoryColor(topId)` for top-level categories (null for the small ones: use
     `theme.other`), `theme.shadeOf(base, index)` for rows inside one, and
     `theme.colorFor(index)` for anything else. Return the same color from `rowColor` so the
     list under the chart matches.
   - Optional: `link(key, ctx)` makes a tap open another report, range and drill path instead
     of drilling. `listRows(data)` lists other rows under the chart (a stacked chart lists its
     series, as its legend).
3. Add it to `REPORTS` in `src/reports/index.ts`.

A report's transactions (`ReportTxn`) are the list's transactions (`TxnDto`: `id, date,
amount` (signed, negative is money out), `merchant, merchantKey, accountId, categoryId`, …)
plus `spend` (money out as a positive number, refunds negative, zero for transfers and
income), `topId, topName, leafId, leafName, kind`. The breadcrumb, the transaction list under
the chart, and the recategorize sheet come with every report; nothing else needs touching.

## Configuration

All by environment. `X_FILE` variants read the value from a file (for mounted secrets, under
e.g. a mounted Kubernetes Secret).

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `8080`, `0.0.0.0` | Everything is under `/reports`; health at `/reports/-/healthz`. |
| `BACKEND` | `firefly` | `firefly` or `sample`. |
| `DATABASE_URL` or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`/`PGPASSWORD_FILE` | | PostgreSQL; the schema is migrated at startup. |
| `FIREFLY_INTERNAL_URL` | `http://firefly.firefly.svc.cluster.local` | Firefly's API, the OAuth code exchange, and the user lookup. |
| `FIREFLY_TOKEN` / `FIREFLY_TOKEN_FILE` | | Personal access token; required with `BACKEND=firefly`. |
| `FIREFLY_INITIAL_SYNC_DAYS` | `730` | How far back a full sync lists. |
| `PUBLIC_ORIGIN` | | The origin the browser uses, e.g. `https://firefly.example.com`; the OAuth redirect is `<origin>/reports/auth/callback`. Required unless the dev bypass is on. |
| `FIREFLY_PUBLIC_URL` | `PUBLIC_ORIGIN` | Where the browser authorizes (`/oauth/authorize`). |
| `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` / `_FILE` | | The confidential Firefly OAuth client. Required unless the dev bypass is on. |
| `ALLOWED_EMAILS` | | Comma-separated Firefly login emails allowed in (as owner, unblocked). Required. |
| `ALLOWED_HOSTS` | host of `PUBLIC_ORIGIN` | Other Host headers get 421 (health is exempt). |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | `30`, `8` | Session cookie `REPORTSSESSION`, `Path=/reports; Secure; HttpOnly; SameSite=Lax`. |
| `SYNC_INTERVAL_SECONDS`, `FULL_SYNC_INTERVAL_HOURS`, `SYNC_ENABLED` | `300`, `24`, `true` | |
| `NAV_LINKS` | none | Links to other apps in the top bar, as JSON: `[{"label": "Ledger", "url": "/"}, {"label": "Bank sync", "url": "https://bank-sync.example.com", "newTab": true}]`. A URL is `http(s)://…` or a path on this origin; `newTab` is optional. |
| `SAMPLE_SEED`, `SAMPLE_END_DATE` | `235`, today | The sample dataset. |
| `DEV_AUTH_BYPASS` | unset | See below. |
| `LOG_LEVEL` | `info` | |

### Dev-only auth bypass

`DEV_AUTH_BYPASS=i-understand-this-disables-login` logs every request in as `dev@localhost`
and accepts `localhost` as a host. It exists for local development and the smoke tests, and
the service refuses to start with it when `BACKEND=firefly`, when `NODE_ENV=production` (the
image sets that), or when it has any other value. The UI shows a "dev" ribbon in the top-left corner while it is on.

## Login and security

Firefly OAuth (authorization code with PKCE, confidential client): only an unblocked
`owner` with an allowed email gets in, the Firefly token is dropped after the user lookup,
sessions are server-side (only a hash of the cookie is stored) with idle and absolute
timeouts, CSRF tokens live in the session and travel in an `X-CSRF-Token` header, requests
for other hosts get 421, and the CSP allows only this origin.

When the session is over (idle or absolute timeout), the app first logs in again in the
background: while Firefly's own session is alive and the client is approved, the OAuth login
is only redirects, so a `fetch` follows them to a new session and the request is retried. Only
when Firefly would ask for something (its login or approval page) does the app show "Log in".

## Development

`nix develop` gives Node 22, PostgreSQL 17 and (on Linux) Chromium.

```bash
nix develop
npm ci

# Unit tests: a throwaway PostgreSQL is started from PATH (or set TEST_DATABASE_URL).
npm test

# Typecheck and build
npm run typecheck
npm run build

# Run locally against the sample data (needs a PostgreSQL at DATABASE_URL)
BACKEND=sample DEV_AUTH_BYPASS=i-understand-this-disables-login \
  DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres \
  npm start      # http://localhost:8080/reports/
# or, with hot reload of the UI: npm run dev:server, plus npm run dev (proxies the API)
```

### Headless-browser smoke test

```bash
nix develop -c npm run smoke
```

Builds, starts a throwaway PostgreSQL and the real server (`BACKEND=sample`, dev bypass),
and drives Chromium (playwright-core) at a phone (390×844), a desktop (1280×900) and an
installed-app (393×852) viewport: load on the last 30 days → 90 days → Custom (the URL switches from `range=` to
dates) → 1 year → reload offline (the same chart, from the service worker and the kept copy)
and back online → a new build (the banner, and reload into it) → a session that is over
(the same chart, and "Log in") → search the transactions (`trader`, then `trader <month>`, then a word only
in the notes) → tap the Transportation slice → tap the "Taxis and rideshare" slice → open an
Uber Eats order Plaid filed as a ride → pick Restaurants → "Always categorize" → preview count
→ save → the slice shrinks and the list updates → back up the breadcrumb → check the
exported `decision_event` rows and their snapshot → the monthly report → a month → a
merchant → its transaction's website, location and "Look up" → tap the merchant's name: the
list searches for it, with the drill path and range kept, then a year of it → dark mode → only some accounts
(kept through tabs, ranges, links and the back button) → the Rules tab: the counts, the
Trader Joe's statements' group and its match, its proposed rule, saved (the group is gone,
the count drops), and a group with nothing to copy from → log out (the copy on the device
is gone) and back in. Any console
error, page error, failed request, or HTTP error fails it. Screenshots of every step land in
`smoke-output/<viewport>/` (gitignored): look at them. Besides `phone` and `desktop`, the
`installed` run is an iPhone 15 with the app added to the Home Screen: the whole screen, with
the status bar's and home indicator's safe areas. `SMOKE_VIEWPORTS=phone` limits the run;
`CHROMIUM_PATH` picks the browser. `nix flake check` runs it too, in the build sandbox, and CI
uploads its screenshots as the `smoke-screenshots` artifact.

### The sample dataset

`src/server/sample/generate.ts`: a deterministic year for two adults without a car in
Brooklyn: rent, paychecks, OMNY rides and a monthly unlimited, Citi Bike, the occasional Uber
or Lyft, groceries (Trader Joe's, the corner deli, FreshDirect), restaurants, coffee, delivery,
utilities, phone and internet, streaming, two gyms, a cat, four trips, healthcare, Venmo,
credit card payments as transfers, refunds, pending charges that post after the tip, and raw
bank descriptions. Each day comes from its own seeded PRNG, so moving the end date only adds
or drops days. Plaid's categories are attached with realistic, consistent mistakes (Uber Eats
and Citi Bike as rideshare, the cat clinic as a doctor, the laundromat as shopping, Venmo
dinners as transfers): about one transaction in four, most of them small, frequent ones (deli
runs, bike rides) that one merchant rule fixes. Before that year, 90 days of an old card's
history come from its CSV statements, as a ledger's CSV import leaves them (`generateImported`):
the same merchants, described the way that bank writes them, with no merchant, no category and
nothing from Plaid, and a few shops the household no longer goes to.

## Image and CI

`nix build .#container` builds the OCI image (`nix/container.nix`): the service as uid 1000,
fine with a read-only root filesystem and a writable `/tmp`. Load it with
`docker load < result`.

`.github/workflows/ci.yml` runs `nix flake check` on every PR and push, starts the image
read-only against PostgreSQL, and on `main` publishes
`ghcr.io/alexanderotavka/finreports:sha-<commit>` and `:latest`. Pin the digest it prints
in the run summary.

`.github/workflows/update.yml` runs weekly: `nix flake update`, then `npm update` within the
ranges in `package.json`. It opens a PR on `automated/update-deps`, runs CI there, and CI
merges it once everything passes and publishes a new image. The Nix build reads
`package-lock.json` directly (`importNpmLock`), so there is no dependency hash to refresh.
Dependabot keeps the GitHub Actions up to date.

## License

[MIT](LICENSE)
