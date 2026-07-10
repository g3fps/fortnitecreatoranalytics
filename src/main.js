'use strict';

require('./loadEnv');
const { Store } = require('./store');
const { crawlOnce } = require('./crawler');
const { createServer } = require('./server');
const supabaseSync = require('./supabaseSync');

const path = require('path');
const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 3742;

const CRAWL_INTERVAL_MS = Number(process.env.CRAWL_INTERVAL_MS) || 24 * 60 * 60 * 1000;
// Decoupled from CRAWL_INTERVAL_MS on purpose - a real hang should be
// flagged in hours, not after most of a day has gone by.
const STALL_WARNING_MS = Number(process.env.STALL_WARNING_MS) || 3 * 60 * 60 * 1000;
const CATALOG_PAGES_PER_CYCLE = Number(process.env.CATALOG_PAGES_PER_CYCLE) || 5;
const MAX_METRICS_PER_CYCLE = Number(process.env.MAX_METRICS_PER_CYCLE) || 250000;
const METRICS_DELAY_MS = Number(process.env.METRICS_DELAY_MS) || 80;

// Serve the dashboard without running the crawler - lets you run the site
// process while a separate crawler (or baseline sweep) writes to Supabase.
const NO_CRAWL = process.argv.includes('--no-crawl') || process.env.NO_CRAWL === '1';

let crawlInFlight = false;
let currentCycle = null; // live progress of the in-flight cycle, or null
let store;
let server;

// Store selection:
//   --no-crawl + Supabase  -> SupabaseStore, reads live from Postgres (so the
//                             dashboard reflects a crawler running elsewhere).
//   crawling + Supabase    -> CrawlerStore: loads the catalog into memory once
//                             at boot for fast hot-loop reads, then writes every
//                             change straight to Postgres (no local file). This
//                             is the production crawler path.
//   no Supabase configured -> local-file Store (dev / offline fallback).
async function buildStore() {
  if (NO_CRAWL && supabaseSync.isEnabled()) {
    const { SupabaseStore } = require('./supabaseStore');
    return { store: new SupabaseStore(), label: 'supabase (live, read-only)' };
  }
  if (!NO_CRAWL && supabaseSync.isEnabled()) {
    const { CrawlerStore } = require('./crawlerStore');
    const s = new CrawlerStore();
    await s.load();
    return { store: s, label: 'supabase (crawler: in-memory catalog + write-through)' };
  }
  const s = new Store(DATA_DIR);
  return { store: s, label: NO_CRAWL ? 'local files (read-only, frozen at boot)' : 'local files' };
}

// Populated via onProgress during a cycle with every island code that cycle
// touched (catalog upsert and/or metrics poll), so the post-cycle Supabase
// sync pushes exactly what changed instead of re-uploading the whole catalog
// every time. Supabase itself is entirely optional (see supabaseSync.js) -
// this bookkeeping costs nothing when it's not configured.
async function runCrawlCycle(reason) {
  if (crawlInFlight) {
    console.log(`[crawler] skipping ${reason} cycle - previous cycle still running`);
    return;
  }
  crawlInFlight = true;
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  currentCycle = { reason, startedAt: startedAtIso, catalogPagesFetched: 0, newIslandsDiscovered: 0, metricsPolled: 0, totalCandidates: null };
  console.log(`[crawler] starting cycle (${reason})`);

  try {
    // No separate Supabase sync step: with CrawlerStore, crawlOnce's writes
    // (upsertIsland/addSnapshot/setCrawlState) go straight to Postgres.
    const result = await crawlOnce(store, {
      catalogPages: CATALOG_PAGES_PER_CYCLE,
      maxMetricsPerCycle: MAX_METRICS_PER_CYCLE,
      metricsDelayMs: METRICS_DELAY_MS,
      onProgress: (evt) => {
        if (evt.error) console.error('[crawler]', JSON.stringify(evt));
        if (evt.phase === 'catalog' && !evt.error) {
          currentCycle.catalogPagesFetched = evt.page;
          currentCycle.newIslandsDiscovered = evt.newSoFar;
        }
        if (evt.phase === 'metrics' && !evt.error && evt.polledSoFar) {
          currentCycle.metricsPolled = evt.polledSoFar;
          currentCycle.totalCandidates = evt.totalCandidates;
        }
      },
    });
    const finishedAtIso = new Date().toISOString();
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `[crawler] cycle finished in ${(elapsedMs / 1000).toFixed(1)}s - ` +
        `${result.catalogPagesFetched} catalog page(s), ${result.newIslandsDiscovered} new island(s), ` +
        `${result.metricsPolled} polled, ${result.metricsWritten} new snapshot(s), ` +
        `${result.metricsNotFound} not found, ${result.errors.length} error(s)`
    );
    await store.recordCrawlCycle({
      reason,
      startedAt: startedAtIso,
      finishedAt: finishedAtIso,
      durationMs: elapsedMs,
      catalogPagesFetched: result.catalogPagesFetched,
      newIslandsDiscovered: result.newIslandsDiscovered,
      metricsPolled: result.metricsPolled,
      metricsWritten: result.metricsWritten,
      metricsNotFound: result.metricsNotFound,
      errorCount: result.errors.length,
      sampleErrors: result.errors.slice(0, 3),
    });
  } catch (err) {
    console.error('[crawler] cycle failed unexpectedly:', err);
    try {
      await store.recordCrawlCycle({
        reason,
        startedAt: startedAtIso,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        fatal: true,
        errorCount: 1,
        sampleErrors: [String(err && err.message ? err.message : err)],
      });
    } catch (logErr) {
      console.error('[crawler] failed to record fatal-cycle log:', logErr.message);
    }
  } finally {
    crawlInFlight = false;
    currentCycle = null;
  }
}

// One cycle per day: sleep until CRAWL_INTERVAL_MS has elapsed since the
// cycle *started* (not since it finished), so a slow cycle doesn't push the
// schedule later and later - it just eats into that day's wait. If a cycle
// somehow runs longer than the full interval, the next one starts right
// away rather than waiting an extra day on top.
let shuttingDown = false;
async function loop() {
  let firstRun = true;
  while (!shuttingDown) {
    const cycleStartedAt = Date.now();
    await runCrawlCycle(firstRun ? 'startup' : 'scheduled');
    firstRun = false;
    const waitMs = Math.max(CRAWL_INTERVAL_MS - (Date.now() - cycleStartedAt), 2000);
    console.log(`[crawler] next cycle in ${(waitMs / 60000).toFixed(1)} min`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

// Safety net only - logs if a cycle has been running suspiciously long
// (possible hang), it does not intervene. Forcibly starting a second
// concurrent cycle would be worse than a stalled one (duplicate in-flight
// writes), so the only automatic recovery here is the crash-safety already
// built into crawlOnce's periodic persistence.
let stallMonitor = null;
function startStallMonitor() {
  stallMonitor = setInterval(() => {
    if (crawlInFlight && currentCycle) {
      const runningForMs = Date.now() - new Date(currentCycle.startedAt).getTime();
      if (runningForMs > STALL_WARNING_MS) {
        console.error(`[main] current cycle has been running for ${(runningForMs / 60000).toFixed(1)} min - possible stall`);
      }
    }
  }, 10 * 60 * 1000);
}

// Build the store (async: CrawlerStore loads the catalog from Supabase),
// start the HTTP server, then begin crawling. Wrapped so the async store
// load completes before the crawl loop starts.
async function bootstrap() {
  const built = await buildStore();
  store = built.store;

  const app = createServer(store, {
    crawlIntervalMs: NO_CRAWL ? null : CRAWL_INTERVAL_MS,
    getCrawlProgress: () => ({ inProgress: crawlInFlight, current: currentCycle }),
  });
  server = app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT} (reading from ${built.label})`);
  });

  if (NO_CRAWL) {
    console.log('[main] --no-crawl: serving the dashboard only, not crawling.');
    if (!supabaseSync.isEnabled()) {
      console.warn('[main] Supabase not configured - serving a snapshot of the local files as they were at boot. It will not reflect a crawl running in another process.');
    }
    return;
  }
  loop();
  startStallMonitor();
}

bootstrap().catch((err) => {
  console.error('[main] failed to start:', err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[main] received ${signal}, shutting down`);
  shuttingDown = true;
  if (stallMonitor) clearInterval(stallMonitor);
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
  // Force-exit if graceful close hangs (e.g. a keep-alive connection, or the
  // crawl loop is mid-request and doesn't yield before the process needs to go).
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
