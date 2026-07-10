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
    // Real-world data: only ~24-32% of ever-polled islands turn out to have
    // any live traffic at all (the rest 404 or come back all-null every
    // time). Repolling those "cold" islands every cycle at the same
    // priority as ones that actually have traffic wastes most of the
    // budget re-confirming they're still dead. Cold islands only get
    // included on 1 out of every N cycles (to still catch revivals
    // eventually), tracked via crawl_state's cyclesCompleted counter.
    coldRepollEveryNCycles = 20,
    // Of whatever budget remains after "hot" islands (see tiering below),
    // this share goes to cold islands on a cycle where they're included at
    // all - the rest goes to "unknown" (never-polled) islands.
    coldShareOnColdCycle = 0.5,
    // Islands polled this many times with zero data ever get their
    // metadata degraded to bound storage cost - see
    // Store.degradeIfConfirmedDead for what "degraded" means and why it's
    // not deletion.
    degradeAfterAttempts = 3,
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
  // Three tiers, not just "polled vs not":
  //   hot     - has shown at least one live reading. This is what keeps the
  //             leaderboard/movers fresh, so it's repolled every cycle,
  //             ahead of everything else.
  //   cold    - polled before, never showed anything (404s or all-null
  //             every time). Real data: only ~24-32% of ever-polled islands
  //             turn out to have live traffic, so most already-polled
  //             islands are cold - repolling them as often as hot ones
  //             would mostly just reconfirm they're still dead. Only
  //             included on 1 out of every coldRepollEveryNCycles cycles,
  //             to still catch revivals eventually.
  //   unknown - never polled. Gets whatever budget hot doesn't use, for
  //             ongoing catalog discovery.
  const hot = [];
  const cold = [];
  const unknown = [];
  for (const island of store.islands.values()) {
    if (!island.lastMetricsPolledAt) {
      unknown.push(island);
    } else if (store.getHistory(island.code).length > 0) {
      hot.push(island);
    } else {
      cold.push(island);
    }
  }
  // Oldest-checked-first within each tier, same fairness principle as
  // before - if a tier exceeds its budget, whoever's most overdue goes
  // first rather than whoever happens to iterate first.
  hot.sort((a, b) => a.lastMetricsPolledAt.localeCompare(b.lastMetricsPolledAt));
  cold.sort((a, b) => a.lastMetricsPolledAt.localeCompare(b.lastMetricsPolledAt));

  const cyclesCompleted = store.getCrawlState().cyclesCompleted || 0;
  const includeColdThisCycle = cyclesCompleted % coldRepollEveryNCycles === 0;

  const budgetAfterHot = Math.max(0, maxMetricsPerCycle - hot.length);
  // Clamped to cold.length so budget reserved for cold islands that don't
  // exist (or don't need it this cycle) flows to unknown instead of being
  // wasted - otherwise a cold cycle with few/no cold candidates would poll
  // fewer islands total than a non-cold cycle for no reason.
  const coldBudget = includeColdThisCycle ? Math.min(Math.floor(budgetAfterHot * coldShareOnColdCycle), cold.length) : 0;
  const unknownBudget = budgetAfterHot - coldBudget;

  const candidates = [...hot.slice(0, maxMetricsPerCycle), ...unknown.slice(0, unknownBudget), ...cold.slice(0, coldBudget)];

  // Cycles routinely run for hours. Persisting islands.json only at the very
  // end would mean a crash mid-cycle loses every lastMetricsPolledAt update
  // from that entire run - not data loss (snapshots are appended immediately
  // in addSnapshot), but wasted re-polling of islands we in fact just
  // checked. Persist periodically instead so the loss window is bounded.
  //
  // Throttled on elapsed time, not poll count: persistIslands() serializes
  // and rewrites the *entire* islands.json (~70MB at 184k islands), so a
  // fixed every-N-polls rule ties total disk churn to catalog size - a full
  // baseline sweep at every-500-polls would rewrite it hundreds of times.
  // Time-based keeps the crash-loss window bounded (what actually matters)
  // while making that churn independent of how big the catalog gets.
  const PERSIST_EVERY_MS = 60 * 1000;
  let lastPersistAt = Date.now();

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
    island.pollAttempts = (island.pollAttempts || 0) + 1;

    if (metrics === null) {
      result.metricsNotFound++;
    } else {
      const { written } = store.addSnapshot(island.code, metrics);
      if (written) result.metricsWritten++;
    }

    // Bound storage cost from islands that are never going to show data,
    // without deleting them (see Store.degradeIfConfirmedDead for why that
    // matters). Checked every poll, not just this one - degradeAfterAttempts
    // isn't necessarily reached on the attempt that just ran.
    store.degradeIfConfirmedDead(island.code, { minAttempts: degradeAfterAttempts });

    onProgress({
      phase: 'metrics',
      code: island.code,
      title: island.title,
      found: metrics !== null,
      polledSoFar: result.metricsPolled,
      totalCandidates: candidates.length,
    });

    if (Date.now() - lastPersistAt >= PERSIST_EVERY_MS) {
      store.persistIslands();
      lastPersistAt = Date.now();
    }

    await sleep(metricsDelayMs);
  }

  store.persistIslands();
  store.setCrawlState({ lastCrawlFinishedAt: new Date().toISOString(), cyclesCompleted: cyclesCompleted + 1 });

  return result;
}

module.exports = { crawlOnce };
