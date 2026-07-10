# Fortnite Creative Analytics

Competitive intelligence for companies and serious Fortnite Creative / UEFN
island creators, built on Epic's public Ecosystem Data API. Think Social
Blade for islands: a leaderboard, per-island history, movers, and creator
portfolios — for a market where creators get paid real money based on these
exact numbers, and can otherwise only see their *own* island's stats.

Live: **https://fortnite-creator-analytics.vercel.app**

## Why this exists

Epic pays UEFN/Creative creators via engagement payouts and direct item
sales, and creators can only see their *own* island's stats in the Creator
Portal. Epic also runs a public, unauthenticated API
(`api.fortnite.com/ecosystem/v1`) that exposes engagement metrics for every
public, discoverable island — including your competitors'. Nobody was
capturing it.

**The core fact this whole project is built around:** that API does not
actually return history. Every metric bucket comes back `null` except the
single most recent one — confirmed by direct testing against the live API.
Epic is not backfilling anything. The only way to ever have historical data
for an island is to have been polling it at the time. There is no way to
retroactively backfill a missed period, for this tool or any competitor.
**Every day this crawler isn't running is data that no one, ever, can get
back.**

## Architecture

Two halves, because a crawler that polls hundreds of thousands of islands
and a public dashboard have fundamentally different runtime requirements:

- **The crawler is a long-running process** (run it locally or on a small
  VPS — not Vercel, whose serverless functions are request-scoped and can't
  run a loop for hours). It polls Epic's API once a day (`src/main.js`),
  writes to local JSONL files as its own source of truth (fast, zero
  install risk, trivial to inspect by hand), and mirrors every change to
  Supabase Postgres (`src/supabaseSync.js`) so the data is centrally
  queryable.

  Daily is the right cadence *for what we currently poll*, not a hard limit
  of the API. `fetchLatestMetrics()` requests the **`day`** bucket, whose
  latest reading only rolls over once per day — and `addSnapshot()` dedups
  on `capturedAt`, so polling more often would write literally nothing new.
  Epic also exposes **`hour`** and **`minute`** buckets on the same endpoint,
  which *do* update more frequently; we simply don't fetch them yet. That's
  the natural basis for a faster-refresh tier (see "Known limitations").
- **The dashboard/API is deployed to Vercel** (`api/index.js`) and reads
  exclusively from Supabase (`src/supabaseStore.js`) — it never touches the
  crawler's local files, and it's what the public URL above actually serves.

`src/server.js` (the Express app with all the routes) is shared by both:
locally it's handed the in-memory `Store`, on Vercel it's handed
`SupabaseStore` — same method names on both, so the routes don't know or
care which one they're talking to.

## What's actually here

- `src/fortniteApi.js` — API client (retry/backoff, timeout, null-safe
  parsing of the mostly-null metric payloads)
- `src/store.js` — local append-only JSONL storage, loaded into memory on
  boot; the crawler's own source of truth
- `src/crawler.js` — catalog discovery (cursor pagination) + tiered metrics
  polling: **hot** islands (already showed live data) get repolled every
  cycle, **unknown** islands (never polled) get a steady share of the
  remaining budget, **cold** islands (polled before, never showed anything —
  most islands, in practice) only get rechecked on 1 in every N cycles, to
  catch revivals without wasting budget reconfirming they're still dead
- `src/main.js` — long-running entrypoint: starts the HTTP server and the
  daily crawl loop together (`--no-crawl` serves the dashboard only, reading
  live from Supabase, so it can run beside another crawling process)
- `src/supabaseClient.js` / `src/supabaseSync.js` — write-through mirror of
  the crawler's local state into Supabase, best-effort (a Supabase hiccup
  never blocks the actual crawl)
- `src/supabaseStore.js` — SQL-backed read (and light on-demand write, for
  `/api/lookup`) implementation of the same interface `Store` exposes, used
  by the Vercel deployment
- `src/server.js` — Express API (leaderboard, search, island detail,
  history, movers, creator leaderboard, tags, browse) — storage-agnostic
- `src/loadEnv.js` — minimal `.env.local` loader (no `dotenv` dependency)
- `api/index.js` + `vercel.json` — the Vercel entrypoint and routing config
- `db/schema.sql` — Postgres schema: tables plus the SQL views that do
  aggregation (movers, creator leaderboard, tag counts, browse) in the
  database instead of pulling the whole catalog into a serverless function
- `public/` — vanilla HTML/CSS/JS dashboard, no build step, no CDN
  dependency (charts are hand-rolled SVG so the page never breaks on a
  flaky third-party script load)
- `scripts/crawl-once.js` — manual one-off crawl: runs a single cycle and
  exits, with `--catalog-only` / `--skip-catalog` to run the two phases
  separately. Used for the initial full-catalog baseline sweep (see below)
  and for testing. Syncs to Supabase incrementally as it goes.
- `scripts/migrate-to-supabase.js` — one-time backfill of local data into
  a fresh Supabase database
- `scripts/apply-schema.js` — applies `db/schema.sql` directly via a
  Postgres connection (idempotent, safe to rerun after schema changes)
- `scripts/smoke-test.js` — automated regression tests (`npm test`), using
  Node's built-in test runner, no test-framework dependency

No native/compiled dependencies in the app itself (deliberately avoided
`better-sqlite3` and similar) — `npm install` cannot fail due to a missing
C++ toolchain. (`pg` is a devDependency, used only by the one-off
`scripts/apply-schema.js` admin tool, never by runtime code.)

## Running it

**Local crawler + dashboard:**

```
npm install
npm start          # starts the server on :3742 and the daily crawl loop together
```

Then open http://localhost:3742. Data starts accumulating from the moment
you first run it.

**Dashboard only, no crawler** — safe to run alongside a baseline sweep or
any other crawling process:

```
npm run serve      # == node src/main.js --no-crawl
```

When Supabase is configured this reads live from Postgres, so it reflects a
crawl running in another terminal. Without Supabase it falls back to the
local files as they were when the process booted (and says so on startup) —
the local `Store` loads the catalog into memory once and never reloads.

**One-time full catalog baseline.** Run this once before relying on the
daily loop, so most of the catalog is already classified hot/cold and the
leaderboard isn't limited to whatever a few days of organic discovery
happened to reach.

> **Stop `npm start` first.** `main.js` and `crawl-once.js` each load the
> whole catalog into memory and rewrite `data/islands.json` in full when
> they persist. Run both at once and the last writer wins — silently
> clobbering the other's `lastMetricsPolledAt` bookkeeping. Ctrl+C the
> server (it has a graceful shutdown handler) rather than force-killing it.
>
> Use `npm run serve` (`--no-crawl`) if you want the local dashboard up
> while the sweep runs — it doesn't touch the local files at all.

Run it in two stages, not one command. Catalog discovery is cheap (~100
islands per request) while metrics polling is ~1 request *per island*, and
`crawlOnce` picks its polling candidates *after* discovery finishes — so a
single combined run would discover a pile of new islands and then
immediately try to poll all of them too, making the run length unpredictable:

```
node scripts/crawl-once.js --catalog-only --pages=100000   # stage 1: exhaust the catalog
node scripts/crawl-once.js --skip-catalog --max-metrics=999999   # stage 2: poll everything found
```

`--pages=100000` is just a high ceiling; stage 1 stops on its own when the
pagination cursor runs out. Stage 2 is the long one: observed throughput
against the live API is ~300ms/island once Epic's rate limiting kicks in, so
budget roughly `islands × 0.3s` (at ~185k islands, ~15 hours) and plan to run
it overnight.

Both stages sync to Supabase *periodically while running* (roughly every two
minutes, delta only), not just at the end — a crash at hour 10 of a baseline
sweep doesn't mean Supabase saw none of it. Local JSONL files are the source
of truth regardless, and `scripts/migrate-to-supabase.js` can always replay
them if a sync falls behind.

**Supabase setup** (one-time, for the crawler's Postgres mirror and the
Vercel dashboard):

```
# .env.local: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
# SUPABASE_DB_URL (pooler connection string, for apply-schema.js only)
node scripts/apply-schema.js          # applies db/schema.sql
node scripts/migrate-to-supabase.js   # backfills existing local data, if any
```

Other useful commands:

```
npm test                                       # run the regression suite
npm run crawl -- --pages=8 --max-metrics=250   # small manual crawl
```

Environment variables:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 3742 | local server port |
| `CRAWL_INTERVAL_MS` | 86400000 (24h) | gap between crawl cycles, timed from cycle *start* |
| `STALL_WARNING_MS` | 10800000 (3h) | logs a warning if a cycle runs longer than this - detection only, doesn't intervene |
| `CATALOG_PAGES_PER_CYCLE` | 5 | catalog discovery pages per cycle |
| `MAX_METRICS_PER_CYCLE` | 250000 | effectively unbounded at current catalog size |
| `METRICS_DELAY_MS` | 80 | delay between metrics requests |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | - | required for Supabase sync/reads; app runs fine without them (sync just no-ops) |
| `SUPABASE_DB_URL` | - | only used by `scripts/apply-schema.js`, never at runtime |

## API endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/health` | liveness check |
| `GET /api/stats` | crawl coverage: islands tracked, snapshots collected, last crawl time |
| `GET /api/leaderboard?metric=peakCCU&limit=25` | top islands by the latest captured reading for that metric |
| `GET /api/movers?metric=peakCCU&direction=up&limit=20` | biggest gainers/droppers between an island's two most recent readings |
| `GET /api/creators?limit=25` | per-creator rollup (island count, total metrics, best island) |
| `GET /api/tags?limit=40` | tag frequency across the discovered catalog |
| `GET /api/browse` | paginated/filterable catalog listing (`tag`, `creatorCode`, `hasData`, `sort`, `dir`, `page`, `pageSize`) |
| `GET /api/islands?search=...&limit=25` | search by title / code / creator |
| `GET /api/islands/:code` | metadata + latest snapshot for one island |
| `GET /api/islands/:code/history` | every snapshot this crawler has captured for that island |
| `GET /api/lookup/:code` | on-demand fetch straight from Epic for a specific island, even one the crawler hasn't discovered yet - adds it to the tracked catalog immediately |

Allowed `metric` values: `peakCCU`, `uniquePlayers`, `minutesPlayed`,
`averageMinutesPerPlayer`, `plays`, `favorites`, `recommendations`,
`retentionD1`, `retentionD7`.

## Verified against the live API (2026-07-09/10)

- No authentication required or accepted.
- `/islands` is cursor-paginated (~100/page); `orderBy`/`limit` query params
  are accepted but don't appear to actually change server-side ordering —
  don't rely on them.
- `/islands/{code}/metrics/{day|hour|minute}` — every bucket is `null`
  except the latest one. A `from` param is accepted but the server rejects
  values older than ~6 days with HTTP 400, and even inside that window nothing
  before the latest bucket is populated.
- Rate limits exist per Epic's docs but the exact numbers aren't published.
  In production, sustained crawling does trip 429s regularly - the crawler's
  retry-with-backoff and circuit breaker (aborts a phase after several
  consecutive failures) handle it, but real-world throughput ends up closer
  to ~300ms/island rather than the nominal per-request delay. This is the
  main reason the crawl cadence moved from continuous back-to-back cycles to
  once a day: the `day` bucket we poll only rolls over daily, so the extra
  requests bought nothing but 429s.
- Real-world catalog composition: only roughly a quarter to a third of
  ever-polled islands turn out to have any live traffic at all: the rest
  404 or come back all-null, permanently. This is exactly what the
  hot/cold/unknown polling tiers in `src/crawler.js` are built around.

## Known limitations (read before you show this to anyone)

- **Engagement-payout estimation is intentionally not implemented.** Epic
  documents the *inputs* to the payout formula (active playtime, retention,
  playtime around Item Shop spend, new/returning player acquisition with a
  75% six-month attribution bonus) but not the weights, and one input —
  spend-linked playtime — is fundamentally unobservable from public data.
  Any tool claiming to show "estimated earnings" from public metrics alone is
  guessing. The honest version of this feature requires creators to
  voluntarily share their real payout numbers so a model can be fit against
  them — that's a real feature, but it needs real usage first, not a
  guessed formula.
- **The catalog has no working sort or "top islands" endpoint.** There is no
  way to ask Epic directly for the most popular islands — the only way to
  find them is to crawl the whole catalog and rank what you find yourself.
  Coverage (and therefore leaderboard quality) is a function of how much of
  the catalog has been crawled.
- **No auth, no accounts, no billing yet.** Everyone who hits the Vercel URL
  sees the same public data. A premium tier (deeper history / faster
  refresh for tracked islands, portfolio tracking across more islands and
  creators, exports/API access) is the intended direction but isn't built:
  no user accounts, no Stripe integration, no gating logic exists yet.
  Worth knowing when that gets designed: "faster refresh" is *technically*
  available today — `fetchLatestMetrics()` hardcodes the `day` bucket, and
  Epic's same endpoint also serves `hour` and `minute`. Polling those for a
  small set of paid-tier islands is a bounded, additive change, not a
  rearchitecture.
- **The crawler's local store rewrites `islands.json` in full on every
  persist.** At ~185k islands that's a ~70MB serialize-and-rewrite, and the
  whole catalog is held in memory. Persistence is throttled to at most once
  a minute (rather than every N polls) so that churn doesn't scale with
  catalog size, but this is still the component that will need replacing
  first — the crawler writing straight to Postgres, with local JSONL kept
  only as a crash buffer, is the obvious next step. Supabase is already the
  read path for everything user-facing, so this is contained to the crawler.
- **Metric semantics are Epic's, not independently verified against a
  creator's actual Creator Portal numbers.** The field names and values match
  what Epic's API documentation describes, but nobody has cross-checked, say,
  `uniquePlayers` against a real creator's own dashboard to confirm Epic's
  definitions match intuition (e.g. whether it's deduped across the whole
  window or per-bucket).

## On "zero bugs"

Every piece of logic that's easy to get subtly wrong — dedup on repeated
identical readings, catalog re-scans not clobbering polling bookkeeping,
corrupt-file recovery, malformed-line handling, the null-filtering metric
parser, and the hot/cold/unknown polling tiers — has an automated regression
test in `scripts/smoke-test.js` (17 tests), and the whole pipeline has been
run end-to-end against the real live API, not mocks, with the resulting data
inspected by hand. That's meaningfully more scrutiny than most MVPs get. It
is not the same claim as "zero bugs" — no one can honestly make that claim
about any nontrivial software, and I'm not going to pretend otherwise.
What's true: nothing found in this build was left unfixed.
