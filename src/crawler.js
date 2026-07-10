'use strict';

const { fetchIslandsPage, fetchLatestMetrics, sleep, FortniteApiError } = require('./fortniteApi');

// One crawl cycle has two phases:
//
//   1. Catalog discovery - walk a few pages of /islands (cursor pagination)
//      to find islands we haven't seen before. The catalog has no working
//      sort/filter, so this is a blind walk; we persist the cursor between
//      cycles so successive runs make forward progress through the whole
//      catalog instead of re-scanning the same first page every time.
//
//   2. Metrics polling - for a slice of already-known islands, fetch their
//      current metrics snapshot and append it to history if it's new. Islands
//      are prioritized by "least recently polled" so coverage is fair over
//      time and newly discovered islands get their first reading quickly.
//
// Both phases are individually fault-tolerant: a failure fetching one page
// or one island's metrics is logged and skipped, it does not abort the whole
// cycle. A circuit breaker aborts a phase early only after several
// consecutive failures, on the assumption the API is down/unreachable rather
// than that specific islands are broken.

async function crawlOnce(store, opts = {}) {
  const {
    // Catalog discovery vastly outpaces our ability to poll metrics (a
    // single-digit-page crawl already found 180k+ islands with zero errors),
    // so discovery is not the bottleneck - metrics polling is. Defaults are
    // tuned accordingly: a small, steady trickle of new-catalog discovery,
    // and most of the cycle budget spent polling islands that don't have a
    // reading yet.
    catalogPages = 5,
    // 400 sequential requests at 75ms delay measured 0 errors against the
    // live API (2026-07-10); 80ms keeps a small margin above that tested
    // floor rather than running at the exact edge of what's been verified.
    metricsDelayMs = 80,
    catalogDelayMs = 150,
    // The catalog is 180k+ islands and not exhausted. There is no sane fixed
    // per-cycle cap that both (a) makes real progress against that backlog
    // and (b) doesn't need retuning as the catalog grows - so this default
    // is intentionally "effectively unbounded": poll everyone currently
    // eligible (per the discover/repoll split below) in one pass. A single
    // cycle at this scale runs for hours, which is why persistence below is
    // periodic rather than only at the very end.
    maxMetricsPerCycle = 250000,
    onProgress = () => {},
  } = opts;

  const startedAt = new Date().toISOString();
  store.setCrawlState({ lastCrawlStartedAt: startedAt });

  const result = {
    catalogPagesFetched: 0,
    newIslandsDiscovered: 0,
    metricsPolled: 0,
    metricsWritten: 0,
    metricsNotFound: 0,
    errors: [],
  };

  // --- Phase 1: catalog discovery ---
  let cursor = store.getCrawlState().cursor;
  let consecutiveFailures = 0;

  for (let i = 0; i < catalogPages; i++) {
    let page;
    try {
      page = await fetchIslandsPage(cursor);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      result.errors.push(`catalog page ${i + 1}: ${err.message}`);
      onProgress({ phase: 'catalog', error: err.message });
      if (consecutiveFailures >= 3) {
        onProgress({ phase: 'catalog', aborted: true, reason: 'too many consecutive failures' });
        break;
      }
      await sleep(catalogDelayMs);
      continue;
    }

    const codesOnPage = [];
    for (const island of page.islands) {
      if (!island.code) continue;
      const existed = store.islands.has(island.code);
      store.upsertIsland(island);
      if (!existed) result.newIslandsDiscovered++;
      codesOnPage.push(island.code);
    }
    result.catalogPagesFetched++;
    onProgress({
      phase: 'catalog',
      page: i + 1,
      islandsOnPage: page.islands.length,
      newSoFar: result.newIslandsDiscovered,
      codes: codesOnPage,
    });

    cursor = page.nextCursor;
    if (!cursor) {
      // Reached the end of the catalog. Wrap around next cycle so newly
      // published islands that land on early pages eventually get picked up.
      break;
    }
    await sleep(catalogDelayMs);
  }

  store.persistIslands();
  store.setCrawlState({ cursor: cursor || null });

  // --- Phase 2: metrics polling ---
  // Pure least-recently-polled-first is a breadth-maximizing strategy: with
  // a catalog far larger than polling capacity, a never-polled island is
  // always "more overdue" than one already polled once, so already-polled
  // islands would almost never get rechecked and every island would top out
  // at exactly 1 snapshot forever - which would make trend/movers data
  // permanently empty. Reserve a slice of the budget for re-polling islands
  // that already have a reading (oldest-checked first), so history actually
  // accumulates depth, not just breadth.
  const REPOLL_SHARE = 0.3;
  const repollBudget = Math.floor(maxMetricsPerCycle * REPOLL_SHARE);
  const discoverBudget = maxMetricsPerCycle - repollBudget;

  const neverPolled = [];
  const alreadyPolled = [];
  for (const island of store.islands.values()) {
    if (island.lastMetricsPolledAt) alreadyPolled.push(island);
    else neverPolled.push(island);
  }
  alreadyPolled.sort((a, b) => a.lastMetricsPolledAt.localeCompare(b.lastMetricsPolledAt));

  const candidates = [...neverPolled.slice(0, discoverBudget), ...alreadyPolled.slice(0, repollBudget)];

  // Cycles now routinely run for hours (250k-island budget at ~150-200ms/req
  // is many hours of wall clock). Persisting islands.json only at the very
  // end would mean a crash mid-cycle loses every lastMetricsPolledAt update
  // from that entire run - not data loss (snapshots are appended immediately
  // in addSnapshot), but wasted re-polling of islands we in fact just
  // checked. Persist periodically instead so the loss window is bounded.
  const PERSIST_EVERY = 500;

  consecutiveFailures = 0;
  for (const island of candidates) {
    let metrics;
    try {
      metrics = await fetchLatestMetrics(island.code);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      result.errors.push(`metrics ${island.code}: ${err.message}`);
      onProgress({ phase: 'metrics', code: island.code, error: err.message });
      if (consecutiveFailures >= 5) {
        onProgress({ phase: 'metrics', aborted: true, reason: 'too many consecutive failures' });
        break;
      }
      await sleep(metricsDelayMs);
      continue;
    }

    result.metricsPolled++;
    island.lastMetricsPolledAt = new Date().toISOString();

    if (metrics === null) {
      result.metricsNotFound++;
    } else {
      const { written } = store.addSnapshot(island.code, metrics);
      if (written) result.metricsWritten++;
    }

    onProgress({
      phase: 'metrics',
      code: island.code,
      title: island.title,
      found: metrics !== null,
      polledSoFar: result.metricsPolled,
      totalCandidates: candidates.length,
    });

    if (result.metricsPolled % PERSIST_EVERY === 0) {
      store.persistIslands();
    }

    await sleep(metricsDelayMs);
  }

  store.persistIslands();
  store.setCrawlState({ lastCrawlFinishedAt: new Date().toISOString() });

  return result;
}

module.exports = { crawlOnce };
