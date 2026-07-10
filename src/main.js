'use strict';

require('./loadEnv');
const path = require('path');
const { Store } = require('./store');
const { crawlOnce } = require('./crawler');
const { createServer } = require('./server');
const supabaseSync = require('./supabaseSync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 3742;

const CRAWL_INTERVAL_MS = Number(process.env.CRAWL_INTERVAL_MS) || 24 * 60 * 60 * 1000;
// Decoupled from CRAWL_INTERVAL_MS on purpose - a real hang should be
// flagged in hours, not after most of a day has gone by.
const STALL_WARNING_MS = Number(process.env.STALL_WARNING_MS) || 3 * 60 * 60 * 1000;
const CATALOG_PAGES_PER_CYCLE = Number(process.env.CATALOG_PAGES_PER_CYCLE) || 5;
const MAX_METRICS_PER_CYCLE = Number(process.env.MAX_METRICS_PER_CYCLE) || 250000;
const METRICS_DELAY_MS = Number(process.env.METRICS_DELAY_MS) || 80;

// Serve the dashboard without running the crawler. The reason this exists:
// only one process may own the local JSONL files at a time (both this and
// scripts/crawl-once.js hold the whole catalog in memory and rewrite
// islands.json wholesale on persist, so concurrent writers silently clobber
// each other's lastMetricsPolledAt bookkeeping). --no-crawl lets you watch
// the dashboard while a long baseline sweep runs in another terminal.
const NO_CRAWL = process.argv.includes('--no-crawl') || process.env.NO_CRAWL === '1';

// With --no-crawl, prefer reading through Supabase: the local Store snapshots
// every island into memory at construction and never reloads, so it would
// freeze at whatever was on disk the moment this process booted - actively
// misleading while another process is crawling. SupabaseStore queries live on
// every request, so the dashboard tracks the running crawl. Falls back to the
// (stale, read-only) local Store when Supabase isn't configured.
let store;
let storeLabel;
if (NO_CRAWL && supabaseSync.isEnabled()) {
  const { SupabaseStore } = require('./supabaseStore');
  store = new SupabaseStore();
  storeLabel = 'supabase (live)';
} else {
  store = new Store(DATA_DIR);
  storeLabel = NO_CRAWL ? 'local files (read-only, frozen at boot)' : 'local files';
}

let crawlInFlight = false;
let currentCycle = null; // live progress of the in-flight cycle, or null

const app = createServer(store, {
  // Don't advertise a crawl schedule this process isn't keeping.
  crawlIntervalMs: NO_CRAWL ? null : CRAWL_INTERVAL_MS,
  getCrawlProgress: () => ({ inProgress: crawlInFlight, current: currentCycle }),
});
const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT} (reading from ${storeLabel})`);
});

// Populated via onProgress during a cycle with every island code that cycle
// touched (catalog upsert and/or metrics poll), so the post-cycle Supabase
// sync pushes exactly what changed instead of re-uploading the whole catalog
// every time. Supabase itself is entirely optional (see supabaseSync.js) -
// this bookkeeping costs nothing when it's not configured.
let touchedCodes = new Set();

async function syncCycleToSupabase(logEntry) {
  if (!supabaseSync.isEnabled()) return;
  try {
    const islands = [];
    const snapshotEntries = [];
    for (const code of touchedCodes) {
      const island = store.islands.get(code);
      if (island) islands.push(island);
      const hist = store.getHistory(code);
      if (hist.length) snapshotEntries.push({ code, snapshot: hist[hist.length - 1] });
    }
    await supabaseSync.syncIslands(islands);
    await supabaseSync.syncSnapshots(snapshotEntries);
    await supabaseSync.syncCrawlState(store.getCrawlState());
    await supabaseSync.syncCrawlLogEntry(logEntry);
    console.log(`[supabase] synced ${islands.length} island(s), ${snapshotEntries.length} snapshot(s)`);
  } catch (err) {
    // Best-effort mirror - never let a Supabase hiccup take down the
    // crawler's actual job of polling Epic's API and writing local files.
    console.error('[supabase] sync failed for this cycle (local data is unaffected):', err.message);
  }
}

async function runCrawlCycle(reason) {
  if (crawlInFlight) {
    console.log(`[crawler] skipping ${reason} cycle - previous cycle still running`);
    return;
  }
  crawlInFlight = true;
  touchedCodes = new Set();
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  currentCycle = { reason, startedAt: startedAtIso, catalogPagesFetched: 0, newIslandsDiscovered: 0, metricsPolled: 0, totalCandidates: null };
  console.log(`[crawler] starting cycle (${reason})`);

  try {
    const result = await crawlOnce(store, {
      catalogPages: CATALOG_PAGES_PER_CYCLE,
      maxMetricsPerCycle: MAX_METRICS_PER_CYCLE,
      metricsDelayMs: METRICS_DELAY_MS,
      onProgress: (evt) => {
        if (evt.error) console.error('[crawler]', JSON.stringify(evt));
        if (evt.phase === 'catalog' && !evt.error) {
          currentCycle.catalogPagesFetched = evt.page;
          currentCycle.newIslandsDiscovered = evt.newSoFar;
          for (const code of evt.codes || []) touchedCodes.add(code);
        }
        if (evt.phase === 'metrics' && !evt.error && evt.polledSoFar) {
          currentCycle.metricsPolled = evt.polledSoFar;
          currentCycle.totalCandidates = evt.totalCandidates;
          if (evt.code) touchedCodes.add(evt.code);
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
    const logEntry = {
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
    };
    store.recordCrawlCycle(logEntry);
    await syncCycleToSupabase(logEntry);
  } catch (err) {
    console.error('[crawler] cycle failed unexpectedly:', err);
    store.recordCrawlCycle({
      reason,
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      fatal: true,
      errorCount: 1,
      sampleErrors: [String(err && err.message ? err.message : err)],
    });
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

if (NO_CRAWL) {
  console.log('[main] --no-crawl: serving the dashboard only, not crawling.');
  console.log('[main] safe to run alongside scripts/crawl-once.js.');
  if (!supabaseSync.isEnabled()) {
    console.warn('[main] Supabase not configured - serving a snapshot of the local files as they were at boot. It will not reflect a crawl running in another process.');
  }
} else {
  loop();
  startStallMonitor();
}

function shutdown(signal) {
  console.log(`[main] received ${signal}, shutting down`);
  shuttingDown = true;
  if (stallMonitor) clearInterval(stallMonitor);
  server.close(() => process.exit(0));
  // Force-exit if graceful close hangs (e.g. a keep-alive connection, or the
  // crawl loop is mid-request and doesn't yield before the process needs to go).
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
