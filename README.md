# finreports

Interactive, phone-first reports on top of your transaction ledger, with quick recategorizing,
merchant rules, and an append-only log of every categorization decision, ready to export as
training data for a smarter rules engine. It works with [Firefly III](https://www.firefly-iii.org/)
today, behind a backend interface small enough to swap for another ledger.

```
Plaid / SimpleFIN / …  →  Firefly (ledger)  ⇄  backend adapter  ⇄  finreports + PostgreSQL  →  PWA at /reports/
```

Tap a slice of the spending donut to drill into its subcategories, then a subcategory for its
merchants. The monthly report stacks each month's bar by category; tap a month to open the
donut for just that month. The transactions behind the selection scroll below the chart. Tap
one to recategorize it, or to "always categorize" that merchant: a rule, previewed against
past transactions and optionally applied to them.

The magnifier above the transactions searches them, right in the browser: every word has to
match some field (merchant, date as `2026-09-14`, `9/14`, `Sep 14` or `Monday`, category,
amount, the bank's raw description, account, notes, tags, website), so `trader sep` is
Trader Joe's in September. `"Quoted words"` stay together, and a number is a whole number
(`20` is the 20th or $20, not 2025). Matches are highlighted; a word found only in a field
the list does not show (a note, a tag) brings that field up under the row. Search keeps the
chart's range and drill path (it says which, under the bar). In a transaction, the merchant's
name searches the list for that merchant, in place, and "Look up" searches the web for it (DuckDuckGo), for the merchants nobody recognizes. Plaid's
website and location for the merchant, and the ledger's notes and tags, are shown there too.

Every report counts all accounts until you check only some of them under the range bar, to
see one credit card's spending or leave one out. The choice is kept in the URL
(`accounts=…`) and sticks through report tabs, ranges, drill-downs and the back button; only
loading a URL without it shows all accounts again.

A category keeps its color in every chart, range and drill level: the eight biggest
top-level categories of all time take the eight palette hues, in order (the smaller ones are
gray and fold into "Other"). Subcategories and merchants are shades of their category's hue.
The biggest one wears the hue itself, and the rest alternate lighter and darker so that
neighboring slices stand apart.

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
  cursor, set a transaction's category.
- **Database** (`migrations/`, plain SQL, applied at startup):
  - `txn`: normalized mirror of the backend's transactions, one row per split, with the
    category's **provenance**: `plaid` (the importer's guess from Plaid), `backend` (someone
    or something in the ledger chose it), `rule:<id>`, `manual`, or `none`. Also the
    merchant's website and location (the Plaid connector writes Plaid's into Firefly's
    external URL and latitude/longitude), and the ledger's notes and tags.
  - `category`: the tree (two levels), seeded from Plaid's primary/detailed taxonomy. Firefly's
    categories are flat, so the tree lives here; top-level names are the names the Plaid
    connector writes, so Firefly's categories map back by name.
  - `rule` + `rule_version`: rules as JSON (`src/shared/rules.ts`), every version kept.
  - `decision_event`: append-only (triggers refuse UPDATE, DELETE and TRUNCATE).
  - `report_txn`: the view every report queries.
- **Sync loop** (`src/server/sync.ts`): every `SYNC_INTERVAL_SECONDS`, pull changes through
  the adapter into `txn`, run the rules over new and changed transactions, and write locally
  decided categories back through the adapter. A failed write stays queued (`backend_dirty`)
  and is retried. A full listing every `FULL_SYNC_INTERVAL_HOURS` notices deletions.
- **Web app** (`src/web/`): Vite + React + ECharts, built into `dist/web` and served by the
  same Fastify server under `/reports/`. Installable as a PWA. It borrows Firefly III's look
  (AdminLTE's blue navbar and boxes) so it sits comfortably next to it.

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
  v1 has `merchant`, `description`, `account` (`equals`/`contains`), `amount` (`min`/`max`),
  and `all`/`any`/`not`.

## The decision log

Every manual recategorization and every rule create/update/delete/backfill appends one
`decision_event` row: timestamp, actor (the Firefly login email), action, a full snapshot of
the transaction as it was (merchant, description, amount, account, date, Plaid categories,
prior category and its provenance), old → new category and provenance, the rule definition and
version if any, and the UI context (report, drill path, date range). Export it as JSON lines:

```bash
curl -b "REPORTSSESSION=…" https://firefly.example.com/reports/api/decision-events.jsonl
curl … '/reports/api/decision-events.jsonl?after=1234'   # only events after id 1234
```

## Adding a report

Reports are code: one file per report in `src/reports/`.

1. Copy `src/reports/monthly-trend.ts` to `src/reports/<your-report>.ts`.
2. Fill in the `ReportDefinition` (`src/reports/types.ts`):
   - `baseFilter`: SQL over `report_txn t` that every transaction in the report satisfies.
   - `levels`: one entry per drill level. `query(where)` returns rows of `key`, `label`,
     `value` (`SELECT … FROM report_txn t WHERE ${where} GROUP BY …`); `where` already holds
     the date range, the base filter, and the keys tapped above. `filter(key, { p })` is the
     condition for the transactions behind `key`; bind values with `p(value)`, never by
     pasting them into SQL.
   - `chart(data, theme, selectedKey)`: an ECharts option. Give each datum a `key`, so a tap
     drills (or, on the last level, selects). On a column chart, give the category axis
     entries a `key` instead (`{ value: "Sep", key: "2026-09" }`) and a tap anywhere in the
     column counts. Colors: `theme.categoryColor(topId)` for top-level categories (null for
     the small ones: use `theme.other`), `theme.shadeOf(base, key, index)` for rows inside
     one, and `theme.colorFor(key, index)` for anything else. Return the same color from
     `rowColor` so the list under the chart matches.
   - Optional: `link(key, ctx)` makes a tap open another report, range and drill path instead
     of drilling. `listRows(data)` lists other rows under the chart (a stacked chart lists its
     series, as its legend).
3. Add it to `REPORTS` in `src/reports/index.ts`.

`report_txn` has `id, date, amount` (signed, negative is money out), `spend` (money out as a
positive number, refunds negative, zero for transfers and income), `type, pending, merchant,
description, account_name, category_id, provenance, top_id, top_name, leaf_id, leaf_name,
kind, merchant_key, account_id`. The breadcrumb, the transaction list under the chart, and the recategorize sheet come
with every report; nothing else needs touching.

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
image sets that), or when it has any other value. The UI shows a "dev" badge while it is on.

## Login and security

Firefly OAuth (authorization code with PKCE, confidential client): only an unblocked
`owner` with an allowed email gets in, the Firefly token is dropped after the user lookup,
sessions are server-side (only a hash of the cookie is stored) with idle and absolute
timeouts, CSRF tokens live in the session and travel in an `X-CSRF-Token` header, requests
for other hosts get 421, and the CSP allows only this origin.

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
and drives Chromium (playwright-core) at a phone (390×844) and a desktop (1280×900)
viewport: load on the last 30 days → 90 days → Custom (the URL switches from `range=` to
dates) → 1 year → search the transactions (`trader`, then `trader <month>`, then a word only
in the notes) → tap the Transportation slice → tap the "Taxis and rideshare" slice → open an
Uber Eats order Plaid filed as a ride → pick Restaurants → "Always categorize" → preview count
→ save → the slice shrinks and the list updates → back up the breadcrumb → check the
exported `decision_event` rows and their snapshot → the monthly report → a month → a
merchant → its transaction's website, location and "Look up" → tap the merchant's name: the
list searches for it, with the drill path and range kept, then a year of it → dark mode → only some accounts
(kept through tabs, ranges, links and the back button). Any console
error, page error, failed request, or HTTP error fails it. Screenshots of every step land in
`smoke-output/<viewport>/` (gitignored): look at them. `SMOKE_VIEWPORTS=phone` limits the run;
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
runs, bike rides) that one merchant rule fixes.

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
