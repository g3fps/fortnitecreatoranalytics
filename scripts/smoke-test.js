'use strict';

// Lightweight regression tests using Node's built-in test runner (node:test,
// available since Node 18 with no extra dependency - keeps install friction
// at zero). Run with: npm test
//
// These target the specific failure modes that matter for this project:
// data loss (dedup/persistence bugs) and mis-parsing the Fortnite API's
// mostly-null metric payloads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/store');
const { crawlOnce } = require('../src/crawler');
const { createServer } = require('../src/server');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fca-smoke-'));
}

test('upsertIsland preserves lastMetricsPolledAt across re-upsert', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  store.upsertIsland({ code: 'AAAA-BBBB-CCCC', title: 'Test Island', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });

  const record = store.islands.get('AAAA-BBBB-CCCC');
  record.lastMetricsPolledAt = '2026-07-09T12:00:00.000Z';

  // Simulate the catalog re-discovering the same island on a later crawl page.
  store.upsertIsland({ code: 'AAAA-BBBB-CCCC', title: 'Test Island', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });

  assert.equal(
    store.islands.get('AAAA-BBBB-CCCC').lastMetricsPolledAt,
    '2026-07-09T12:00:00.000Z',
    'catalog re-scan must not wipe out metrics-polling bookkeeping'
  );
});

test('addSnapshot dedups identical capturedAt, writes on new capturedAt', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  store.upsertIsland({ code: 'DUP1-DUP1-DUP1', title: 'Dup Island', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });

  const snap1 = { capturedAt: '2026-07-09T00:00:00.000Z', peakCCU: 10, uniquePlayers: 5, minutesPlayed: 30, averageMinutesPerPlayer: 3, plays: 5, favorites: 1, recommendations: 0, retentionD1: null, retentionD7: null };
  const r1 = store.addSnapshot('DUP1-DUP1-DUP1', snap1);
  assert.equal(r1.written, true);

  // Same timestamp again (simulating a crawl cycle before Epic's reading changed).
  const r2 = store.addSnapshot('DUP1-DUP1-DUP1', snap1);
  assert.equal(r2.written, false);
  assert.equal(store.getHistory('DUP1-DUP1-DUP1').length, 1);

  // New timestamp should be written.
  const snap2 = { ...snap1, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 12 };
  const r3 = store.addSnapshot('DUP1-DUP1-DUP1', snap2);
  assert.equal(r3.written, true);
  assert.equal(store.getHistory('DUP1-DUP1-DUP1').length, 2);
});

test('data survives a full reload from disk (islands + snapshots)', () => {
  const dir = makeTempDir();
  const store1 = new Store(dir);
  store1.upsertIsland({ code: 'PERS-IST1-DATA', title: 'Persisted Island', creatorCode: 'creator1', category: 'Horror', createdIn: 'UEFN', tags: ['scary'] });
  store1.persistIslands();
  store1.addSnapshot('PERS-IST1-DATA', {
    capturedAt: '2026-07-09T00:00:00.000Z',
    peakCCU: 42,
    uniquePlayers: 20,
    minutesPlayed: 100,
    averageMinutesPerPlayer: 5,
    plays: 20,
    favorites: 3,
    recommendations: 1,
    retentionD1: 0.4,
    retentionD7: 0.1,
  });

  const store2 = new Store(dir);
  const island = store2.getIsland('PERS-IST1-DATA');
  assert.ok(island, 'island metadata should survive reload');
  assert.equal(island.title, 'Persisted Island');
  assert.equal(island.tags[0], 'scary');
  assert.ok(island.latest, 'latest snapshot should survive reload');
  assert.equal(island.latest.peakCCU, 42);
  assert.equal(island.snapshotCount, 1);
});

test('corrupt islands.json is backed up and does not crash startup', () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'islands.json'), '{ this is not valid json');

  assert.doesNotThrow(() => {
    const store = new Store(dir);
    assert.equal(store.islands.size, 0);
  });

  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('islands.json.corrupt-'));
  assert.equal(backups.length, 1, 'corrupt file should be backed up rather than silently discarded');
});

test('malformed lines in snapshots.jsonl are skipped, not fatal', () => {
  const dir = makeTempDir();
  const goodLine = JSON.stringify({ code: 'OK00-0000-0000', capturedAt: '2026-07-09T00:00:00.000Z', peakCCU: 1 });
  fs.writeFileSync(path.join(dir, 'snapshots.jsonl'), `${goodLine}\nnot json at all\n{"code":"missing-timestamp"}\n`);

  const store = new Store(dir);
  assert.equal(store.getHistory('OK00-0000-0000').length, 1);
});

test('leaderboard sorts descending by the requested metric and skips islands with no data', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  for (const [code, ccu] of [['L1-0000-0000', 100], ['L2-0000-0000', 50], ['L3-0000-0000', 200]]) {
    store.upsertIsland({ code, title: code, creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
    store.addSnapshot(code, {
      capturedAt: '2026-07-09T00:00:00.000Z',
      peakCCU: ccu,
      uniquePlayers: ccu,
      minutesPlayed: null,
      averageMinutesPerPlayer: null,
      plays: null,
      favorites: null,
      recommendations: null,
      retentionD1: null,
      retentionD7: null,
    });
  }
  // An island with no snapshot at all should never appear in the leaderboard.
  store.upsertIsland({ code: 'NODATA-0000-0', title: 'No Data', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });

  const board = store.getLeaderboard('peakCCU', 10);
  assert.deepEqual(board.map((r) => r.code), ['L3-0000-0000', 'L1-0000-0000', 'L2-0000-0000']);
});

test('getTimeline aggregates snapshot counts by UTC calendar date across all islands', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  store.upsertIsland({ code: 'T1-0000-0000-0', title: 'T1', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
  store.upsertIsland({ code: 'T2-0000-0000-0', title: 'T2', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });

  const base = { peakCCU: 1, uniquePlayers: 1, minutesPlayed: 1, averageMinutesPerPlayer: 1, plays: 1, favorites: 1, recommendations: 1, retentionD1: null, retentionD7: null };
  store.addSnapshot('T1-0000-0000-0', { ...base, capturedAt: '2026-07-09T00:00:00.000Z' });
  store.addSnapshot('T2-0000-0000-0', { ...base, capturedAt: '2026-07-09T05:00:00.000Z' });
  store.addSnapshot('T1-0000-0000-0', { ...base, capturedAt: '2026-07-10T00:00:00.000Z' });

  const timeline = store.getTimeline();
  assert.deepEqual(timeline, [
    { date: '2026-07-09', newSnapshots: 2 },
    { date: '2026-07-10', newSnapshots: 1 },
  ]);
});

test('recordCrawlCycle keeps a bounded, most-recent-first log that survives reload', () => {
  const dir = makeTempDir();
  const store1 = new Store(dir);
  for (let i = 0; i < 55; i++) {
    store1.recordCrawlCycle({ reason: 'scheduled', startedAt: `2026-07-09T00:${String(i).padStart(2, '0')}:00.000Z`, metricsWritten: i });
  }

  const log = store1.getCrawlLog(20);
  assert.equal(log.length, 20, 'should cap at the requested limit');
  assert.equal(log[0].metricsWritten, 54, 'most recent cycle should come first');

  // The rolling cap (50) should also have trimmed the oldest entries from disk.
  const store2 = new Store(dir);
  const fullLog = store2.getCrawlLog(100);
  assert.equal(fullLog.length, 50, 'should be capped at 50 total entries on disk');
  assert.equal(fullLog[0].metricsWritten, 54);
  assert.equal(fullLog[fullLog.length - 1].metricsWritten, 5, 'oldest 5 entries (0-4) should have been trimmed');
});

test('getMovers ranks by delta between the two most recent snapshots and excludes islands with under 2 readings', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  const base = { uniquePlayers: 1, minutesPlayed: 1, averageMinutesPerPlayer: 1, plays: 1, favorites: 1, recommendations: 1, retentionD1: null, retentionD7: null };

  store.upsertIsland({ code: 'GAIN-0000-0000', title: 'Gainer', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
  store.addSnapshot('GAIN-0000-0000', { ...base, capturedAt: '2026-07-09T00:00:00.000Z', peakCCU: 100 });
  store.addSnapshot('GAIN-0000-0000', { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 150 });

  store.upsertIsland({ code: 'DROP-0000-0000', title: 'Dropper', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
  store.addSnapshot('DROP-0000-0000', { ...base, capturedAt: '2026-07-09T00:00:00.000Z', peakCCU: 200 });
  store.addSnapshot('DROP-0000-0000', { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 50 });

  store.upsertIsland({ code: 'ONE-00000-0000', title: 'Only one reading', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
  store.addSnapshot('ONE-00000-0000', { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 999 });

  const gainers = store.getMovers('peakCCU', 10, 'up');
  assert.deepEqual(gainers.map((r) => r.code), ['GAIN-0000-0000', 'DROP-0000-0000']);
  assert.equal(gainers[0].delta, 50);

  const droppers = store.getMovers('peakCCU', 10, 'down');
  assert.equal(droppers[0].code, 'DROP-0000-0000');
  assert.equal(droppers[0].delta, -150);

  assert.ok(!gainers.some((r) => r.code === 'ONE-00000-0000'), 'islands with only 1 reading must be excluded');
});

test('getCreatorLeaderboard counts all islands but ranks only on islands with data', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  const base = { uniquePlayers: 10, minutesPlayed: 1, averageMinutesPerPlayer: 1, plays: 1, favorites: 1, recommendations: 1, retentionD1: null, retentionD7: null };

  store.upsertIsland({ code: 'CR1-00000-0000', title: 'Creator One Hit', creatorCode: 'popular', category: null, createdIn: 'UEFN', tags: [] });
  store.addSnapshot('CR1-00000-0000', { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 300 });
  // A second island from the same creator that has never been polled.
  store.upsertIsland({ code: 'CR1-00001-0000', title: 'Creator One Unpolled', creatorCode: 'popular', category: null, createdIn: 'UEFN', tags: [] });

  store.upsertIsland({ code: 'CR2-00000-0000', title: 'Creator Two', creatorCode: 'small', category: null, createdIn: 'UEFN', tags: [] });
  store.addSnapshot('CR2-00000-0000', { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: 50 });

  const board = store.getCreatorLeaderboard(10);
  const popular = board.find((c) => c.creatorCode === 'popular');
  assert.equal(popular.islandCount, 2, 'should count the unpolled island too');
  assert.equal(popular.islandsWithData, 1);
  assert.equal(popular.totalPeakCCU, 300);
  assert.equal(popular.bestIsland.code, 'CR1-00000-0000');
  assert.equal(board[0].creatorCode, 'popular', 'higher totalPeakCCU should rank first');
});

test('getTagCounts aggregates across the whole catalog, sorted descending', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  store.upsertIsland({ code: 'TG1-00000-0000', title: 'A', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: ['pvp', 'action'] });
  store.upsertIsland({ code: 'TG2-00000-0000', title: 'B', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: ['pvp', 'tycoon'] });
  store.upsertIsland({ code: 'TG3-00000-0000', title: 'C', creatorCode: 'x', category: null, createdIn: 'UEFN', tags: ['pvp'] });

  const tags = store.getTagCounts(10);
  assert.equal(tags[0].tag, 'pvp');
  assert.equal(tags[0].count, 3);
});

test('browseIslands filters, sorts, and paginates correctly, clamping out-of-range pages', () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  const base = { peakCCU: 1, uniquePlayers: 1, minutesPlayed: 1, averageMinutesPerPlayer: 1, plays: 1, favorites: 1, recommendations: 1, retentionD1: null, retentionD7: null };

  for (let i = 0; i < 5; i++) {
    store.upsertIsland({ code: `BR${i}-0000-0000`, title: `Island ${i}`, creatorCode: i < 3 ? 'alice' : 'bob', category: null, createdIn: 'UEFN', tags: i % 2 === 0 ? ['pvp'] : ['tycoon'] });
    if (i < 4) store.addSnapshot(`BR${i}-0000-0000`, { ...base, capturedAt: '2026-07-10T00:00:00.000Z', peakCCU: i * 10 });
  }

  const byTag = store.browseIslands({ tag: 'pvp', pageSize: 50 });
  assert.equal(byTag.total, 3); // islands 0, 2, 4

  const byCreator = store.browseIslands({ creatorCode: 'alice', pageSize: 50 });
  assert.equal(byCreator.total, 3);

  const withData = store.browseIslands({ hasData: true, pageSize: 50 });
  assert.equal(withData.total, 4);
  const withoutData = store.browseIslands({ hasData: false, pageSize: 50 });
  assert.equal(withoutData.total, 1);

  const sorted = store.browseIslands({ sort: 'peakCCU', dir: 'desc', pageSize: 50 });
  assert.equal(sorted.rows[0].code, 'BR3-0000-0000');

  const paged = store.browseIslands({ page: 999, pageSize: 2 });
  assert.equal(paged.page, paged.totalPages, 'requesting a page past the end should clamp, not error');
  assert.ok(paged.rows.length > 0);
});

test('GET /api/lookup/:code fetches a map directly from Epic, even one the crawler never discovered, and adds it to the store', async () => {
  const dir = makeTempDir();
  const store = new Store(dir);
  const app = createServer(store, { crawlIntervalMs: 600000 });
  const server = app.listen(0);
  const port = server.address().port;

  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const urlStr = String(url);
    if (urlStr.startsWith('https://api.fortnite.com')) {
      if (urlStr.includes('/islands/UNSEEN-0000-0000/metrics/day')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ peakCCU: [{ value: 77, timestamp: '2026-07-10T00:00:00.000Z' }] }),
        };
      }
      if (urlStr.includes('/islands/UNSEEN-0000-0000')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ code: 'UNSEEN-0000-0000', title: 'Never Crawled Island', creatorCode: 'someone', tags: ['pvp'] }),
        };
      }
      if (urlStr.includes('/islands/GONE-0000-0000')) {
        return { ok: false, status: 404, headers: { get: () => null }, text: async () => '{"errorMessage":"Not found"}' };
      }
    }
    // Anything else (i.e. the test's own request to the local server) goes through for real.
    return originalFetch(url, opts);
  };

  try {
    const res = await fetch(`http://localhost:${port}/api/lookup/UNSEEN-0000-0000`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Never Crawled Island');
    assert.equal(body.latest.peakCCU, 77);
    assert.equal(body.hasLiveData, true);
    assert.ok(store.islands.has('UNSEEN-0000-0000'), 'lookup should add the island to the store immediately');
    assert.equal(store.getHistory('UNSEEN-0000-0000').length, 1);

    const res404 = await fetch(`http://localhost:${port}/api/lookup/GONE-0000-0000`);
    assert.equal(res404.status, 404);

    const resBadInput = await fetch(`http://localhost:${port}/api/lookup/${'x'.repeat(100)}`);
    assert.equal(resBadInput.status, 400);
  } finally {
    global.fetch = originalFetch;
    server.close();
  }
});

test('crawlOnce metrics phase reserves budget for re-polling already-seen islands, not just never-polled ones', async () => {
  const dir = makeTempDir();
  const store = new Store(dir);

  // 20 islands already polled a while ago (have 1 snapshot each), 20 that
  // have never been polled. With maxMetricsPerCycle=10 and a 30% repoll
  // share, we expect roughly 7 never-polled + 3 already-polled this cycle -
  // critically, more than zero from the already-polled pool, which is the
  // bug this test guards against (pure least-recently-polled-first starves
  // already-polled islands forever once the catalog outgrows capacity).
  for (let i = 0; i < 20; i++) {
    const code = `OLD${i}-0000-0000`.padEnd(14, '0').slice(0, 14);
    store.upsertIsland({ code, title: `Old ${i}`, creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
    const rec = store.islands.get(code);
    rec.lastMetricsPolledAt = '2020-01-01T00:00:00.000Z'; // long overdue for a recheck
    store.addSnapshot(code, { capturedAt: '2020-01-01T00:00:00.000Z', peakCCU: 1, uniquePlayers: 1, minutesPlayed: 1, averageMinutesPerPlayer: 1, plays: 1, favorites: 1, recommendations: 1, retentionD1: null, retentionD7: null });
  }
  for (let i = 0; i < 20; i++) {
    const code = `NEW${i}-0000-0000`.padEnd(14, '0').slice(0, 14);
    store.upsertIsland({ code, title: `New ${i}`, creatorCode: 'x', category: null, createdIn: 'UEFN', tags: [] });
  }

  const originalFetch = global.fetch;
  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ peakCCU: [{ value: 5, timestamp: '2026-07-10T00:00:00.000Z' }] }),
  });

  try {
    delete require.cache[require.resolve('../src/fortniteApi')];
    delete require.cache[require.resolve('../src/crawler')];
    const { crawlOnce: freshCrawlOnce } = require('../src/crawler');

    await freshCrawlOnce(store, { catalogPages: 0, maxMetricsPerCycle: 10 });

    const polledOld = [...store.islands.values()].filter((r) => r.code.startsWith('OLD') && r.lastMetricsPolledAt !== '2020-01-01T00:00:00.000Z').length;
    const polledNew = [...store.islands.values()].filter((r) => r.code.startsWith('NEW') && r.lastMetricsPolledAt).length;

    assert.ok(polledOld > 0, 'already-polled islands must get some repoll budget, not be starved forever');
    assert.ok(polledNew > 0, 'never-polled islands should still get the majority of the budget');
    assert.ok(polledNew > polledOld, 'discovery should still outweigh repolling under the default 70/30 split');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[require.resolve('../src/fortniteApi')];
    delete require.cache[require.resolve('../src/crawler')];
  }
});

test('fetchLatestMetrics picks the last non-null value per series and ignores earlier nulls', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () =>
      JSON.stringify({
        uniquePlayers: [
          { value: null, timestamp: '2026-07-08T00:00:00.000Z' },
          { value: 31, timestamp: '2026-07-09T00:00:00.000Z' },
        ],
        peakCCU: [
          { value: null, timestamp: '2026-07-08T00:00:00.000Z' },
          { value: null, timestamp: '2026-07-09T00:00:00.000Z' },
        ],
        minutesPlayed: [{ value: 113, timestamp: '2026-07-09T00:00:00.000Z' }],
        averageMinutesPerPlayer: [{ value: 3.65, timestamp: '2026-07-09T00:00:00.000Z' }],
        plays: [{ value: 31, timestamp: '2026-07-09T00:00:00.000Z' }],
        favorites: [{ value: 15, timestamp: '2026-07-09T00:00:00.000Z' }],
        recommendations: [{ value: 0, timestamp: '2026-07-09T00:00:00.000Z' }],
        retention: [{ d1: null, d7: null, timestamp: '2026-07-09T00:00:00.000Z' }],
      }),
  });

  try {
    delete require.cache[require.resolve('../src/fortniteApi')];
    const { fetchLatestMetrics } = require('../src/fortniteApi');
    const metrics = await fetchLatestMetrics('TEST-CODE-0000');
    assert.equal(metrics.uniquePlayers, 31);
    assert.equal(metrics.peakCCU, null, 'all-null series should surface as null, not crash');
    assert.equal(metrics.minutesPlayed, 113);
    assert.equal(metrics.capturedAt, '2026-07-09T00:00:00.000Z');
  } finally {
    global.fetch = originalFetch;
  }
});

test('fetchLatestMetrics returns null for a 404 (delisted island), not a thrown error', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '{"errorMessage":"Not found"}' });

  try {
    delete require.cache[require.resolve('../src/fortniteApi')];
    const { fetchLatestMetrics } = require('../src/fortniteApi');
    const metrics = await fetchLatestMetrics('GONE-0000-0000');
    assert.equal(metrics, null);
  } finally {
    global.fetch = originalFetch;
  }
});
