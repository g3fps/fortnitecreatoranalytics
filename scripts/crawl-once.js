'use strict';

// Manual one-off crawl. Unlike src/main.js (which runs the server + a daily
// loop forever), this runs exactly one cycle and exits - it's what the
// initial full-catalog baseline sweep is meant to be run with.
//
// Usage:
//   npm run crawl                                    # small default crawl
//   node scripts/crawl-once.js --pages=10 --max-metrics=500
//
//   # Full baseline, staged (recommended - see README):
//   node scripts/crawl-once.js --catalog-only --pages=100000
//   node scripts/crawl-once.js --skip-catalog --max-metrics=999999
//
// Both phases stream progress to stdout, and (when Supabase is configured)
// sync to Postgres *periodically during the run*, not just at the end - a
// baseline sweep runs for many hours, and a crash at hour 10 shouldn't mean
// Supabase saw none of it. Local JSONL files remain the source of truth
// either way; scripts/migrate-to-supabase.js can always replay them.

require('../src/loadEnv');
const path = require('path');
const { Store } = require('../src/store');
const { crawlOnce } = require('../src/crawler');
const supabaseSync = require('../src/supabaseSync');

const DEFAULT_SYNC_EVERY_MS = 2 * 60 * 1000;

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const withValue = /^--([a-zA-Z-]+)=(.+)$/.exec(arg);
    if (withValue) {
      opts[withValue[1]] = withValue[2];
      continue;
    }
    const boolFlag = /^--([a-zA-Z-]+)$/.exec(arg);
    if (boolFlag) opts[boolFlag[1]] = true;
  }
  return opts;
}

// Codes touched since the last successful sync. Kept separate from any
// "touched this whole run" set so a sync only ever ships the delta - by the
// end of a baseline sweep the full catalog is 184k+ islands, and re-uploading
// all of it every couple of minutes would dwarf the crawl itself.
let pendingCodes = new Set();
let lastSyncAt = Date.now();
let inFlight = null; // Promise of the sync currently running, or null

async function syncPending(store, { force = false } = {}) {
  if (!supabaseSync.isEnabled()) return;
  // A forced (final) sync must wait its turn rather than silently no-op -
  // otherwise the last batch of a multi-hour crawl could be dropped just
  // because a periodic sync happened to still be in flight.
  if (inFlight) {
    if (!force) return;
    await inFlight;
  }
  if (!pendingCodes.size) return;
  if (!force && Date.now() - lastSyncAt < DEFAULT_SYNC_EVERY_MS) return;

  // Swap the buffer up front so codes touched *during* the await still get
  // picked up by the next sync rather than being dropped on the floor.
  const codes = pendingCodes;
  pendingCodes = new Set();

  inFlight = (async () => {
    try {
      const islands = [];
      const snapshotEntries = [];
      for (const code of codes) {
        const island = store.islands.get(code);
        if (island) islands.push(island);
        const history = store.getHistory(code);
        if (history.length) snapshotEntries.push({ code, snapshot: history[history.length - 1] });
      }
      await supabaseSync.syncIslands(islands);
      await supabaseSync.syncSnapshots(snapshotEntries);
      await supabaseSync.syncCrawlState(store.getCrawlState());
      console.log(`  [supabase] synced ${islands.length} island(s), ${snapshotEntries.length} snapshot(s)`);
    } catch (err) {
      // Never let a Supabase hiccup kill a multi-hour crawl. Put the codes
      // back so the next sync retries them; local files are unaffected.
      for (const code of codes) pendingCodes.add(code);
      console.error(`  [supabase] sync failed (will retry; local data unaffected): ${err.message}`);
    } finally {
      // Throttle from the end of the last *attempt*, not the last success -
      // otherwise a failing Supabase would get retried on every single
      // onProgress tick instead of once every DEFAULT_SYNC_EVERY_MS.
      lastSyncAt = Date.now();
      inFlight = null;
    }
  })();

  await inFlight;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.join(__dirname, '..', 'data');
  const store = new Store(dataDir);

  const catalogOnly = Boolean(args['catalog-only']);
  const skipCatalog = Boolean(args['skip-catalog']);
  if (catalogOnly && skipCatalog) {
    console.error('[crawl-once] --catalog-only and --skip-catalog are mutually exclusive.');
    process.exit(1);
  }

  const catalogPages = skipCatalog ? 0 : args.pages ? Number(args.pages) : 5;
  const maxMetricsPerCycle = catalogOnly ? 0 : args['max-metrics'] ? Number(args['max-metrics']) : 300;

  console.log(`[crawl-once] data dir: ${dataDir}`);
  console.log(`[crawl-once] islands known before this run: ${store.islands.size}`);
  console.log(`[crawl-once] catalog pages: ${catalogPages}, max metrics: ${maxMetricsPerCycle}`);
  console.log(`[crawl-once] supabase sync: ${supabaseSync.isEnabled() ? `on (every ~${DEFAULT_SYNC_EVERY_MS / 1000}s)` : 'off (not configured)'}`);

  const result = await crawlOnce(store, {
    catalogPages,
    maxMetricsPerCycle,
    onProgress: (evt) => {
      if (evt.phase === 'catalog' && !evt.error) {
        for (const code of evt.codes || []) pendingCodes.add(code);
        console.log(`  [catalog] page ${evt.page}: +${evt.islandsOnPage} islands (new so far: ${evt.newSoFar})`);
      } else if (evt.phase === 'metrics' && !evt.error) {
        if (evt.code) pendingCodes.add(evt.code);
        if (evt.found) console.log(`  [metrics] ${evt.code} "${(evt.title || '').slice(0, 40)}" - captured`);
        if (evt.polledSoFar && evt.polledSoFar % 500 === 0) {
          console.log(`  [metrics] ${evt.polledSoFar}/${evt.totalCandidates} polled`);
        }
      } else if (evt.error) {
        console.log(`  [error] ${evt.phase}: ${evt.error}`);
      }
      // Fire-and-forget: syncPending self-throttles and no-ops while one is
      // already in flight, so this never stacks up behind the crawl loop.
      void syncPending(store);
    },
  });

  console.log('\n[crawl-once] summary:');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n[crawl-once] islands known after this run: ${store.islands.size}`);
  console.log(JSON.stringify(store.getStats(), null, 2));

  if (supabaseSync.isEnabled()) {
    console.log('\n[crawl-once] final sync...');
    // Loop because a sync that fails re-queues its codes, and a sync that
    // succeeds may leave behind codes touched while it was in flight.
    for (let attempt = 0; attempt < 5 && pendingCodes.size; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      await syncPending(store, { force: true });
    }
    if (pendingCodes.size) {
      console.error(`[crawl-once] ${pendingCodes.size} island(s) still unsynced after retries - rerun scripts/migrate-to-supabase.js to reconcile from local files.`);
    } else {
      console.log('[crawl-once] final sync complete.');
    }
  } else {
    console.log('\n[crawl-once] Supabase not configured (SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY) - skipped sync.');
  }
}

main().catch((err) => {
  console.error('[crawl-once] fatal error:', err);
  process.exit(1);
});
