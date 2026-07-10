# Fortnite Creative Analytics

Competitive intelligence for Fortnite Creative / UEFN island creators, built
on Epic's public Ecosystem Data API. Think Social Blade for islands: a
leaderboard, per-island history, and search — for a market where the creators
themselves get paid real money based on these exact numbers.

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

## What's actually here

- `src/fortniteApi.js` — API client (retry/backoff, timeout, null-safe
  parsing of the mostly-null metric payloads)
- `src/store.js` — append-only JSONL storage, loaded into memory on boot
- `src/crawler.js` — catalog discovery (cursor pagination) + metrics polling
  (least-recently-polled-first, so coverage is fair and new islands get their
  first reading quickly)
- `src/server.js` — Express API (leaderboard, search, island detail, history)
- `src/main.js` — single entrypoint: starts the HTTP server and the crawl
  loop together
- `public/` — vanilla HTML/CSS/JS dashboard, no build step, no CDN
  dependency (charts are hand-rolled SVG so the page never breaks on a
  flaky third-party script load)
- `scripts/crawl-once.js` — manual one-off crawl for testing
- `scripts/smoke-test.js` — automated regression tests (`npm test`), using
  Node's built-in test runner, no test-framework dependency

No native/compiled dependencies anywhere (deliberately avoided
`better-sqlite3` and similar) — `npm install` cannot fail due to a missing
C++ toolchain.

## Running it

```
npm install
npm start          # starts the server on :3742 and begins crawling immediately
```

Then open http://localhost:3742.

Data starts accumulating from the moment you first run it — a fresh install
has zero history and builds up from there in real time as the crawler polls.

Other useful commands:

```
npm test                                  # run the regression suite
npm run crawl -- --pages=8 --max-metrics=250   # one-off manual crawl
```

Environment variables (optional): `PORT` (default 3742),
`CRAWL_INTERVAL_MS` (default 600000 / 10 minutes).

## API endpoints

| Endpoint | What it returns |
|---|---|
| `GET /api/health` | liveness check |
| `GET /api/stats` | crawl coverage: islands tracked, snapshots collected, last crawl time |
| `GET /api/leaderboard?metric=peakCCU&limit=25` | top islands by the latest captured reading for that metric |
| `GET /api/islands?search=...&limit=25` | search by title / code / creator |
| `GET /api/islands/:code` | metadata + latest snapshot for one island |
| `GET /api/islands/:code/history` | every snapshot this crawler has captured for that island |

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
- A real end-to-end crawl (8 catalog pages, 1000 islands discovered, 310
  polled for metrics) completed with **zero errors**: 112–154 islands had
  live data, the rest 404'd or returned all-null (dead/inactive islands —
  most published islands get no traffic, which matches what you'd expect for
  a long-tail creator platform).
- Rate limits exist per Epic's docs but the exact numbers aren't published.
  The crawler is deliberately conservative (a ~200ms delay between metrics
  requests, retry-with-backoff on 429/5xx, and a circuit breaker that aborts
  a phase after several consecutive failures) rather than tuned for maximum
  throughput. If you have room to go faster, `metricsDelayMs` in
  `crawlOnce()`'s options is the knob.

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
  the catalog has been crawled, which grows every cycle but starts small.
- **In-memory JSONL storage is an MVP choice, not a permanent one.** It's
  simple, has zero install risk, and is trivial to inspect by hand — but it
  loads the entire dataset into memory on boot and rewrites `islands.json` in
  full on every save. Fine for low tens of thousands of islands; will need a
  real database (Postgres/SQLite) before this scales past that.
- **Metric semantics are Epic's, not independently verified against a
  creator's actual Creator Portal numbers.** The field names and values match
  what Epic's API documentation describes, but nobody has cross-checked, say,
  `uniquePlayers` against a real creator's own dashboard to confirm Epic's
  definitions match intuition (e.g. whether it's deduped across the whole
  window or per-bucket).
- **No auth, no accounts, no persistence beyond local files.** This is a
  local single-user tool as shipped, not a deployed multi-tenant product.
  Turning it into one is a separate, substantial project (hosting, a real
  database, user accounts, and a decision about how aggressively to crawl
  from a shared server IP without tripping Epic's undocumented rate limits).

## On "zero bugs"

Every piece of logic that's easy to get subtly wrong — dedup on repeated
identical readings, catalog re-scans not clobbering polling bookkeeping,
corrupt-file recovery, malformed-line handling, and the null-filtering metric
parser — has an automated regression test in `scripts/smoke-test.js`, and the
whole pipeline has been run end-to-end against the real live API, not mocks,
with the resulting data inspected by hand. That's meaningfully more scrutiny
than most MVPs get. It is not the same claim as "zero bugs" — no one can
honestly make that claim about any nontrivial software, and I'm not going to
pretend otherwise. What's true: nothing found in this build was left
unfixed.
