'use strict';

// Append-only JSONL storage. No native/compiled dependencies (deliberately
// avoids better-sqlite3 etc. to sidestep node-gyp/build-tools install failures
// on machines that don't have a C++ toolchain set up).
//
// Layout on disk (all under dataDir):
//   islands.json      - { [code]: { code, title, creatorCode, category, createdIn, tags, firstSeenAt, lastSeenAt } }
//   snapshots.jsonl    - one JSON object per line, append-only, one metrics reading per line
//   crawl-state.json  - { cursor, cyclesCompleted, lastCrawlStartedAt, lastCrawlFinishedAt }
//   crawl-log.json    - array of the last 50 crawl-cycle summaries, most recent last
//
// This is intentionally simple: for a project at this scale (thousands of
// islands, one snapshot per island per crawl cycle) a plain JSONL log loaded
// into memory on startup is more than sufficient, and it's trivial to inspect
// or repair by hand if something goes wrong - you can literally open the file
// in a text editor. It will need to move to a real database once the dataset
// grows past what comfortably fits in memory; that's a known, documented
// scaling limit, not a hidden one.

const fs = require('fs');
const path = require('path');

function atomicWriteJson(filePath, data) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Corrupt file (e.g. crash mid-write before the atomic rename landed).
    // Back it up rather than silently discarding data or crashing the app.
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
    console.error(`[store] ${filePath} was corrupt JSON, backed up to ${backupPath} and starting fresh:`, err.message);
    return fallback;
  }
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.islandsPath = path.join(dataDir, 'islands.json');
    this.snapshotsPath = path.join(dataDir, 'snapshots.jsonl');
    this.crawlStatePath = path.join(dataDir, 'crawl-state.json');
    this.crawlLogPath = path.join(dataDir, 'crawl-log.json');

    fs.mkdirSync(dataDir, { recursive: true });

    // islands: Map<code, islandRecord>
    this.islands = new Map(Object.entries(readJsonSafe(this.islandsPath, {})));

    // history: Map<code, snapshot[]> sorted ascending by capturedAt
    this.history = new Map();
    this._loadSnapshots();

    this.crawlState = readJsonSafe(this.crawlStatePath, {
      cursor: null,
      cyclesCompleted: 0,
      lastCrawlStartedAt: null,
      lastCrawlFinishedAt: null,
    });

    this.crawlLog = readJsonSafe(this.crawlLogPath, []);
  }

  _loadSnapshots() {
    if (!fs.existsSync(this.snapshotsPath)) return;
    const raw = fs.readFileSync(this.snapshotsPath, 'utf8');
    if (!raw) return;
    const lines = raw.split('\n');
    let malformed = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let entry;
      try {
        entry = JSON.parse(trimmed);
      } catch (err) {
        malformed++;
        continue;
      }
      if (!entry.code || !entry.capturedAt) {
        malformed++;
        continue;
      }
      if (!this.history.has(entry.code)) this.history.set(entry.code, []);
      this.history.get(entry.code).push(entry);
    }
    if (malformed > 0) {
      console.error(`[store] skipped ${malformed} malformed line(s) in snapshots.jsonl`);
    }
    // Ensure each island's history is sorted ascending by time - the file is
    // append-only in crawl order, which is already time-ascending per island
    // in practice, but sort defensively in case of manual edits or merges.
    for (const arr of this.history.values()) {
      arr.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    }
  }

  upsertIsland(island) {
    const now = new Date().toISOString();
    const existing = this.islands.get(island.code);
    const record = {
      code: island.code,
      title: island.title,
      creatorCode: island.creatorCode,
      category: island.category,
      createdIn: island.createdIn,
      tags: island.tags || [],
      firstSeenAt: existing?.firstSeenAt || now,
      lastSeenAt: now,
      // Carried forward from the existing record - upsertIsland is called on
      // every catalog re-scan (including for islands we already know about),
      // and must not clobber metrics-polling bookkeeping set by the crawler's
      // metrics phase.
      lastMetricsPolledAt: existing?.lastMetricsPolledAt || null,
      pollAttempts: existing?.pollAttempts || 0,
    };
    this.islands.set(island.code, record);
    return record;
  }

  persistIslands() {
    atomicWriteJson(this.islandsPath, Object.fromEntries(this.islands));
  }

  // Appends a new snapshot for an island, but skips it if the most recent
  // stored snapshot already has the same capturedAt timestamp - Epic's API
  // only exposes a "current" reading, and crawl cycles run more often than
  // that reading changes, so without dedup we'd write near-duplicate rows
  // every cycle forever.
  addSnapshot(code, metrics) {
    const arr = this.history.get(code) || [];
    const last = arr[arr.length - 1];
    if (last && last.capturedAt === metrics.capturedAt) {
      return { written: false };
    }

    const entry = { code, ...metrics };
    fs.appendFileSync(this.snapshotsPath, `${JSON.stringify(entry)}\n`);
    arr.push(entry);
    this.history.set(code, arr);
    return { written: true };
  }

  markPolled(code) {
    const rec = this.islands.get(code);
    if (rec) rec.lastMetricsPolledAt = new Date().toISOString();
  }

  // Storage-bounding, not deletion: once an island has been polled several
  // times and never once shown data, null out the fields that cost the most
  // (title/category/createdIn - typically the longest strings on the
  // record) but keep the row itself, its code, creatorCode, and tags.
  //
  // Deleting the row outright was the first idea, but it would quietly
  // corrupt exactly the stats this project is built to keep honest:
  // islandsTracked would stop meaning "the real size of Epic's catalog",
  // getTagCounts() would lose those islands' tags entirely (survivorship
  // bias in the one metric explicitly designed to represent the *whole*
  // catalog, dead islands included), and a creator's islandCount would
  // shrink to look more successful than they actually are. Keeping the row
  // with tags/creatorCode intact preserves all three; only the
  // human-readable metadata (which nobody queries in aggregate) is dropped.
  //
  // Not permanent: if the island resurfaces in a catalog page, upsertIsland
  // repopulates title/category/createdIn from that fresh response, same as
  // any other island.
  degradeIfConfirmedDead(code, { minAttempts = 3 } = {}) {
    const rec = this.islands.get(code);
    if (!rec) return false;
    if ((rec.pollAttempts || 0) < minAttempts) return false;
    const hist = this.history.get(code);
    if (hist && hist.length > 0) return false;
    if (rec.title === null && rec.category === null && rec.createdIn === null) return false; // already degraded
    rec.title = null;
    rec.category = null;
    rec.createdIn = null;
    return true;
  }

  getIsland(code) {
    const meta = this.islands.get(code);
    if (!meta) return null;
    const hist = this.history.get(code) || [];
    return { ...meta, latest: hist[hist.length - 1] || null, snapshotCount: hist.length };
  }

  getHistory(code) {
    return this.history.get(code) || [];
  }

  searchIslands(query, limit = 25) {
    const q = (query || '').trim().toLowerCase();
    const results = [];
    for (const meta of this.islands.values()) {
      if (q) {
        const haystack = `${meta.title || ''} ${meta.code} ${meta.creatorCode || ''}`.toLowerCase();
        if (!haystack.includes(q)) continue;
      }
      const hist = this.history.get(meta.code) || [];
      results.push({ ...meta, latest: hist[hist.length - 1] || null });
    }
    results.sort((a, b) => (b.latest?.peakCCU ?? -1) - (a.latest?.peakCCU ?? -1));
    return results.slice(0, limit);
  }

  getLeaderboard(metric = 'peakCCU', limit = 25, { tag = null, creatorCode = null } = {}) {
    const rows = [];
    for (const meta of this.islands.values()) {
      if (tag && !(meta.tags || []).includes(tag)) continue;
      if (creatorCode && meta.creatorCode !== creatorCode) continue;
      const hist = this.history.get(meta.code) || [];
      const latest = hist[hist.length - 1];
      if (!latest || latest[metric] === null || latest[metric] === undefined) continue;
      rows.push({ ...meta, latest });
    }
    rows.sort((a, b) => b.latest[metric] - a.latest[metric]);
    return rows.slice(0, limit);
  }

  // Biggest movers between an island's two most recent snapshots - the one
  // view that is structurally impossible to build from Epic's API directly,
  // since it exposes no history at all. Only includes islands with at least
  // two captured readings, which today is a small fraction of the catalog
  // and grows every cycle.
  getMovers(metric = 'peakCCU', limit = 20, direction = 'up', { tag = null, creatorCode = null } = {}) {
    const rows = [];
    for (const meta of this.islands.values()) {
      if (tag && !(meta.tags || []).includes(tag)) continue;
      if (creatorCode && meta.creatorCode !== creatorCode) continue;
      const hist = this.history.get(meta.code);
      if (!hist || hist.length < 2) continue;
      const latest = hist[hist.length - 1];
      const previous = hist[hist.length - 2];
      const latestVal = latest[metric];
      const previousVal = previous[metric];
      if (typeof latestVal !== 'number' || typeof previousVal !== 'number') continue;
      const delta = latestVal - previousVal;
      const percentChange = previousVal !== 0 ? (delta / previousVal) * 100 : null;
      rows.push({ ...meta, latest, previous, delta, percentChange });
    }
    rows.sort((a, b) => (direction === 'down' ? a.delta - b.delta : b.delta - a.delta));
    return rows.slice(0, limit);
  }

  // Aggregates every island up to its creator. islandCount covers the whole
  // catalog (including islands never polled); the ranking metrics only ever
  // sum over islands that actually have a reading, so a creator with 50
  // unpolled islands and 1 measured one is ranked on that 1, not phantom 50x.
  getCreatorLeaderboard(limit = 25, sortBy = 'totalPeakCCU') {
    const creators = new Map();

    for (const meta of this.islands.values()) {
      const code = meta.creatorCode || '(unknown)';
      if (!creators.has(code)) {
        creators.set(code, {
          creatorCode: code,
          islandCount: 0,
          islandsWithData: 0,
          totalPeakCCU: 0,
          totalUniquePlayers: 0,
          bestIsland: null,
        });
      }
      const entry = creators.get(code);
      entry.islandCount++;

      const hist = this.history.get(meta.code);
      const latest = hist && hist[hist.length - 1];
      if (!latest) continue;

      entry.islandsWithData++;
      entry.totalPeakCCU += latest.peakCCU ?? 0;
      entry.totalUniquePlayers += latest.uniquePlayers ?? 0;
      if (!entry.bestIsland || (latest.peakCCU ?? 0) > entry.bestIsland.peakCCU) {
        entry.bestIsland = { code: meta.code, title: meta.title, peakCCU: latest.peakCCU ?? 0 };
      }
    }

    const rows = [...creators.values()].filter((c) => c.islandsWithData > 0);
    rows.sort((a, b) => b[sortBy] - a[sortBy]);
    return rows.slice(0, limit);
  }

  // A creator with zero islands showing data doesn't rank low in
  // getCreatorLeaderboard - it's absent entirely, since there's nothing to
  // rank it on. That's correct for a leaderboard, but without this,
  // there's no honest denominator anywhere: someone browsing Creators would
  // never learn that creator ever existed. Same "tracked vs has-data" split
  // getStats() already does for islands, one level up.
  getCreatorCounts() {
    const withData = new Set();
    const allCreators = new Set();
    for (const meta of this.islands.values()) {
      const code = meta.creatorCode || '(unknown)';
      allCreators.add(code);
      const hist = this.history.get(meta.code);
      if (hist && hist.length > 0) withData.add(code);
    }
    return { totalCreators: allCreators.size, creatorsWithData: withData.size };
  }

  // Tag frequency across the whole discovered catalog (not just islands with
  // data) - this answers "what does Creative's catalog actually look like",
  // which is legitimate on its own even before a tag's islands get polled.
  getTagCounts(limit = 40) {
    const counts = new Map();
    for (const meta of this.islands.values()) {
      for (const tag of meta.tags || []) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }));
  }

  // General-purpose paginated/filterable listing over the entire catalog,
  // not just the top-N leaderboard slice. This is the only way to actually
  // browse the long tail rather than the same 25-40 popular islands.
  browseIslands({ tag = null, creatorCode = null, hasData = null, hideEmpty = false, sort = 'title', dir = 'asc', page = 1, pageSize = 50 } = {}) {
    let rows = [];
    for (const meta of this.islands.values()) {
      if (tag && !(meta.tags || []).includes(tag)) continue;
      if (creatorCode && meta.creatorCode !== creatorCode) continue;
      const hist = this.history.get(meta.code);
      const latest = hist && hist.length ? hist[hist.length - 1] : null;
      if (hasData === true && !latest) continue;
      if (hasData === false && latest) continue;
      // hideEmpty drops the internal-noise rows (Epic tournament/matchmaking
      // playlists): islands that are BOTH untitled AND have never shown data.
      // An island with a real title, or with any reading, is always kept -
      // including Epic's own big modes like "Battle Royale".
      if (hideEmpty && !latest && !(meta.title && meta.title.trim())) continue;
      rows.push({ ...meta, latest });
    }

    const dirMult = dir === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      let av;
      let bv;
      if (sort === 'title') {
        av = (a.title || '').toLowerCase();
        bv = (b.title || '').toLowerCase();
      } else if (sort === 'firstSeenAt') {
        av = a.firstSeenAt || '';
        bv = b.firstSeenAt || '';
      } else {
        av = a.latest?.[sort] ?? -Infinity;
        bv = b.latest?.[sort] ?? -Infinity;
      }
      if (av < bv) return -1 * dirMult;
      if (av > bv) return 1 * dirMult;
      return 0;
    });

    const total = rows.length;
    const safePageSize = Math.min(Math.max(1, pageSize), 200);
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * safePageSize;

    return {
      total,
      page: safePage,
      pageSize: safePageSize,
      totalPages,
      rows: rows.slice(start, start + safePageSize),
    };
  }

  // Three distinct counts that must not be conflated, especially once the
  // catalog is much bigger than what's been polled (discovery is far cheaper
  // than polling, so "tracked" races ahead of "polled" and "polled" races
  // ahead of "has data"):
  //   islandsTracked  - known to exist at all (found via catalog pagination)
  //   islandsPolled   - actually queried for metrics at least once
  //   islandsWithData - polled AND showed at least one live reading
  // "islandsWithData / islandsTracked" looks like a coverage percentage but
  // answers a different, much bleaker-sounding question than intended once
  // the catalog outpaces polling - the honest ratios are
  // islandsPolled/islandsTracked (how much of the catalog we've checked) and
  // islandsWithData/islandsPolled (of what we checked, how much is alive).
  getStats() {
    let snapshotCount = 0;
    let oldest = null;
    let newest = null;
    for (const arr of this.history.values()) {
      snapshotCount += arr.length;
      for (const entry of arr) {
        if (!oldest || entry.capturedAt < oldest) oldest = entry.capturedAt;
        if (!newest || entry.capturedAt > newest) newest = entry.capturedAt;
      }
    }
    const islandsWithData = [...this.history.values()].filter((arr) => arr.length > 0).length;
    let islandsPolled = 0;
    for (const meta of this.islands.values()) {
      if (meta.lastMetricsPolledAt) islandsPolled++;
    }
    return {
      islandsTracked: this.islands.size,
      islandsPolled,
      islandsWithData,
      snapshotCount,
      oldestSnapshotAt: oldest,
      newestSnapshotAt: newest,
      crawlState: this.crawlState,
    };
  }

  getCrawlState() {
    return this.crawlState;
  }

  setCrawlState(partial) {
    this.crawlState = { ...this.crawlState, ...partial };
    atomicWriteJson(this.crawlStatePath, this.crawlState);
  }

  // Daily count of snapshots captured (by UTC calendar date of capturedAt),
  // across every island. This is the "growth" series for the dashboard: it's
  // the closest thing to a history of the crawler's own coverage, since
  // Epic's API itself exposes none. Returns dates in ascending order.
  getTimeline() {
    const counts = new Map();
    for (const arr of this.history.values()) {
      for (const entry of arr) {
        const date = entry.capturedAt.slice(0, 10); // YYYY-MM-DD (UTC, since capturedAt is an ISO Z timestamp)
        counts.set(date, (counts.get(date) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, newSnapshots: count }));
  }

  // Bounded log of recent crawl-cycle summaries, most recent last on disk /
  // most recent first when read back via getCrawlLog(). Kept small on
  // purpose - this is for a "is the crawler healthy" panel, not an audit
  // trail, so unbounded growth would just be wasted memory and disk.
  recordCrawlCycle(entry) {
    this.crawlLog.push(entry);
    const MAX_ENTRIES = 50;
    if (this.crawlLog.length > MAX_ENTRIES) {
      this.crawlLog = this.crawlLog.slice(this.crawlLog.length - MAX_ENTRIES);
    }
    atomicWriteJson(this.crawlLogPath, this.crawlLog);
  }

  getCrawlLog(limit = 20) {
    return this.crawlLog.slice(-limit).reverse();
  }
}

module.exports = { Store };
