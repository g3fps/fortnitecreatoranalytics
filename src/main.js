'use strict';

require('./loadEnv');
const path = require('path');
const { Store } = require('./store');
const { crawlOnce } = require('./crawler');
const { createServer } = require('./server');
const supabaseSync = require('./supabaseSync');

const DATA_DIR = path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT) || 3742;

// CRAWL_INTERVAL_MS no longer gates scheduling directly (see the continuous
// loop below) - a cycle now covers the whole eligible backlog each time and
// routinely runs for hours, so waiting for a fixed tick before starting the
// next one would just add idle time for no reason. It's kept as a
// stall-detection threshold and as informational text in the UI.
const CRAWL_INTERVAL_MS = Number(process.env.CRAWL_INTERVAL_MS) || 10 * 60 * 1000;
const CATALOG_PAGES_PER_CYCLE = Number(process.env.CATALOG_PAGES_PER_CYCLE) || 5;
const MAX_METRICS_PER_CYCLE = Number(process.env.MAX_METRICS_PER_CYCLE) || 250000;
const METRICS_DELAY_MS = Number(process.env.METRICS_DELAY_MS) || 80;

const store = new Store(DATA_DIR);

let crawlInFlight = false;
let currentCycle = null; // live progress of the in-flight cycle, or null

const app = createServer(store, {
  crawlIntervalMs: CRAWL_INTERVAL_MS,
  getCrawlProgress: () => ({ inProgress: crawlInFlight, current: currentCycle }),
});
const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
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

// Continuous back-to-back crawling: as soon as one cycle ends, the next one
// starts (after a small fixed cooldown, just to yield the event loop - not a
// real pacing mechanism, since actual API pacing happens per-request inside
// crawlOnce). A cycle now covers the whole eligible backlog, so this is what
// makes the crawler actually converge on full catalog coverage over time
// instead of only advancing a capped amount every fixed interval.
let shuttingDown = false;
async function loop() {
  let firstRun = true;
  while (!shuttingDown) {
    await runCrawlCycle(firstRun ? 'startup' : 'continuous');
    firstRun = false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
loop();

// Safety net only - logs if a cycle has been running suspiciously long
// (possible hang), it does not intervene. Forcibly starting a second
// concurrent cycle would be worse than a stalled one (duplicate in-flight
// writes), so the only automatic recovery here is the crash-safety already
// built into crawlOnce's periodic persistence.
setInterval(() => {
  if (crawlInFlight && currentCycle) {
    const runningForMs = Date.now() - new Date(currentCycle.startedAt).getTime();
    if (runningForMs > CRAWL_INTERVAL_MS * 12) {
      console.error(`[main] current cycle has been running for ${(runningForMs / 60000).toFixed(1)} min - possible stall`);
    }
  }
}, CRAWL_INTERVAL_MS);

function shutdown(signal) {
  console.log(`[main] received ${signal}, shutting down`);
  shuttingDown = true;
  server.close(() => process.exit(0));
  // Force-exit if graceful close hangs (e.g. a keep-alive connection, or the
  // crawl loop is mid-request and doesn't yield before the process needs to go).
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
