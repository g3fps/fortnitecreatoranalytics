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
// Both stall thresholds measure time since the last progress event, NOT total
// cycle length (a full sweep legitimately runs ~90 min). Warn first, then let
// the monitor restart the process if nothing has moved for even longer.
const STALL_WARNING_MS = Number(process.env.STALL_WARNING_MS) || 5 * 60 * 1000;
const CATALOG_PAGES_PER_CYCLE = Number(process.env.CATALOG_PAGES_PER_CYCLE) || 5;
const MAX_METRICS_PER_CYCLE = Number(process.env.MAX_METRICS_PER_CYCLE) || 250000;
const METRICS_DELAY_MS = Number(process.env.METRICS_DELAY_MS) || 80;

// Serve the dashboard without running the crawler - lets you run the site
// process while a separate crawler (or baseline sweep) writes to Supabase.
const NO_CRAWL = process.argv.includes('--no-crawl') || process.env.NO_CRAWL === '1';

// Crawl without standing up the HTTP server - for running the crawler on an
// always-on host (VPS/cloud) where Vercel already serves the dashboard, so no
// local web server or port is needed. NO_CRAWL + NO_SERVER together make no
// sense (nothing to do); NO_CRAWL wins with a warning.
const NO_SERVER = process.argv.includes('--no-server') || process.env.NO_SERVER === '1';

let crawlInFlight = false;
let currentCycle = null; // live progress of the in-flight cycle, or null
let crawlStore; // write path for the crawl loop (CrawlerStore, or null)
let webStore;   // read path for the Express API (SupabaseStore / Store)
let server;

// Returns { crawlStore, webStore, label }:
//   crawlStore - what the crawl loop writes through (null when --no-crawl).
//   webStore   - what the Express API reads from (has the full read
//                interface: getStats/getLeaderboard/getMovers/etc.).
//
// The split matters: CrawlerStore is a write-optimized in-memory catalog +
// Postgres write-through, and deliberately does NOT implement the dashboard's
// read queries. So even in crawler mode the web server reads through a
// SupabaseStore (which queries Postgres directly and has every read method).
// Both point at the same Supabase, so the local dashboard shows live data
// while the crawler writes it.
//
//   --no-crawl + Supabase  -> web: SupabaseStore, no crawl.
//   crawling  + Supabase   -> crawl: CrawlerStore (write), web: SupabaseStore (read).
//   no Supabase configured -> local-file Store for both (dev / offline).
async function buildStore() {
  if (supabaseSync.isEnabled()) {
    const { SupabaseStore } = require('./supabaseStore');
    const webStore = new SupabaseStore();
    if (NO_CRAWL) {
      return { crawlStore: null, webStore, label: 'supabase (live, read-only)' };
    }
    const { CrawlerStore } = require('./crawlerStore');
    const crawlStore = new CrawlerStore();
    await crawlStore.load();
    return { crawlStore, webStore, label: 'supabase (crawler writes; dashboard reads live)' };
  }
  // No Supabase: local-file Store does both read and write.
  const s = new Store(DATA_DIR);
  return { crawlStore: NO_CRAWL ? null : s, webStore: s, label: NO_CRAWL ? 'local files (read-only)' : 'local files' };
}

async function runCrawlCycle(reason) {
  if (crawlInFlight) {
    console.log(`[crawler] skipping ${reason} cycle - previous cycle still running`);
    return;
  }
  crawlInFlight = true;
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  // lastProgressAt is the heartbeat: it advances on every progress event, so a
  // wedged cycle is obvious (cycle "running" but heartbeat frozen) instead of
  // looking identical to a healthy long one. That distinction is exactly what
  // hid a 2h hang before.
  currentCycle = {
    reason,
    startedAt: startedAtIso,
    lastProgressAt: startedAtIso,
    phase: 'starting',
    catalogPagesFetched: 0,
    newIslandsDiscovered: 0,
    metricsPolled: 0,
    metricsWritten: 0,
    totalCandidates: null,
  };
  console.log(`[crawler] starting cycle (${reason})`);

  try {
    // No separate Supabase sync step: with CrawlerStore, crawlOnce's writes
    // (upsertIsland/addSnapshot/setCrawlState) go straight to Postgres.
    const result = await crawlOnce(crawlStore, {
      catalogPages: CATALOG_PAGES_PER_CYCLE,
      maxMetricsPerCycle: MAX_METRICS_PER_CYCLE,
      metricsDelayMs: METRICS_DELAY_MS,
      onProgress: (evt) => {
        if (evt.error) console.error('[crawler]', JSON.stringify(evt));
        currentCycle.lastProgressAt = new Date().toISOString();
        if (evt.phase) currentCycle.phase = evt.phase;
        if (evt.phase === 'catalog' && !evt.error) {
          currentCycle.catalogPagesFetched = evt.page;
          currentCycle.newIslandsDiscovered = evt.newSoFar;
        }
        if (evt.phase === 'metrics' && !evt.error && evt.polledSoFar) {
          currentCycle.metricsPolled = evt.polledSoFar;
          currentCycle.totalCandidates = evt.totalCandidates;
          if (typeof evt.writtenSoFar === 'number') currentCycle.metricsWritten = evt.writtenSoFar;
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
    await crawlStore.recordCrawlCycle({
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
      await crawlStore.recordCrawlCycle({
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

// A wedged crawler is worse than a dead one: it looks alive (process up, port
// held, "cycle running") while collecting nothing, so nobody notices for hours.
//
// The signal for "wedged" is a FROZEN HEARTBEAT, not a long cycle. A full sweep
// of the catalog legitimately takes ~90+ min at the polite poll rate, so keying
// recovery off total cycle duration kills healthy cycles moments before they
// finish - which restarts them forever and means the crawler never sleeps.
// (That is exactly what an earlier 90-min duration cap did here.) If progress
// events are still arriving, the cycle is working, however long it takes.
const STALL_NO_PROGRESS_MS = Number(process.env.STALL_NO_PROGRESS_MS) || 10 * 60 * 1000;

let stallMonitor = null;
function startStallMonitor() {
  stallMonitor = setInterval(() => {
    if (crawlInFlight && currentCycle) {
      const runningForMs = Date.now() - new Date(currentCycle.startedAt).getTime();
      const sinceProgressMs = Date.now() - new Date(currentCycle.lastProgressAt || currentCycle.startedAt).getTime();
      if (sinceProgressMs > STALL_NO_PROGRESS_MS) {
        console.error(
          `[main] cycle wedged: no progress for ${(sinceProgressMs / 60000).toFixed(1)} min (limit ${(STALL_NO_PROGRESS_MS / 60000).toFixed(0)} min) - exiting so the supervisor restarts a clean crawler.`
        );
        process.exit(1);
      }
      // Warn only when the heartbeat is going quiet - a long cycle that is
      // still polling is healthy and shouldn't fill the log with false alarms.
      if (sinceProgressMs > STALL_WARNING_MS) {
        console.error(
          `[main] no crawl progress for ${(sinceProgressMs / 60000).toFixed(1)} min (cycle running ${(runningForMs / 60000).toFixed(1)} min) - possible stall`
        );
      }
    }
  }, 60 * 1000);
}

// Build the store (async: CrawlerStore loads the catalog from Supabase),
// start the HTTP server, then begin crawling. Wrapped so the async store
// load completes before the crawl loop starts.
async function bootstrap() {
  const built = await buildStore();
  crawlStore = built.crawlStore;
  webStore = built.webStore;

  // Crawl-only mode (always-on host): no HTTP server, just the crawl loop.
  // Vercel serves the dashboard; this process only writes to Supabase.
  if (NO_SERVER && !NO_CRAWL) {
    console.log('[main] --no-server: crawling only, no HTTP server (dashboard is served elsewhere).');
    loop();
    startStallMonitor();
    return;
  }

  // The Express API reads through webStore (full read interface); the crawl
  // loop writes through crawlStore.
  const app = createServer(webStore, {
    crawlIntervalMs: NO_CRAWL ? null : CRAWL_INTERVAL_MS,
    getCrawlProgress: () => ({ inProgress: crawlInFlight, current: currentCycle }),
  });
  // Bring the HTTP server up before starting the crawl loop, and turn a port
  // conflict into a clear, fatal message instead of an unhandled 'error' event
  // that crashes the whole process (which previously killed the crawler too,
  // showing up as a FATAL cycle every ~2s). We only begin crawling once the
  // socket is actually listening.
  await new Promise((resolve, reject) => {
    server = app.listen(PORT);
    server.once('listening', () => {
      console.log(`[server] listening on http://localhost:${PORT} (reading from ${built.label})`);
      resolve();
    });
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Another crawler already owns the port, so it's already doing the
        // work - this instance must NOT keep the process alive fighting for
        // it. Exit 0 (clean) so the keep-alive wrapper treats it as "already
        // running, stand down" rather than a crash to restart-loop on. This
        // is the single-instance guard: it's impossible to run two crawlers.
        console.error(`[main] port ${PORT} already in use - another crawler is already running. This instance is exiting (not an error).`);
        process.exit(0);
      }
      console.error('[main] HTTP server error:', err);
      reject(err);
    });
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
  console.error('[main] failed to start:', err && err.message ? err.message : err);
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
