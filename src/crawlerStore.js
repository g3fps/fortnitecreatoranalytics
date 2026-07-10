'use strict';

// Supabase-backed store for the long-running crawler. Replaces the local-file
// Store (src/store.js) for the crawl process: instead of holding the whole
// catalog in memory AND rewriting a ~113MB islands.json on every save, this
// loads the catalog into memory once at boot (from Postgres) for fast hot-loop
// reads, and writes every change straight through to Postgres — so a change to
// one island is an UPDATE of one row, not a full-file rewrite.
//
// It exposes the same surface the crawler and main.js use against Store
// (`islands` Map, upsertIsland, addSnapshot, getHistory, degradeIfConfirmedDead,
// markPolled, persistIslands, getCrawlState/setCrawlState, recordCrawlCycle)
// so crawler.js is unchanged. Two differences from Store:
//   - write methods are async (they hit Postgres); the crawler already awaits
//     nothing on these, so main.js/crawler.js call them fire-and-forget or the
//     values are buffered — see the per-method notes below.
//   - it keeps only a lightweight `hasData` Set instead of full snapshot
//     history in memory (the crawler only ever asks "has this island shown any
//     data", never for the actual readings), which keeps memory bounded.
//
// src/store.js is retained for the local dev flow and the smoke tests; this is
// the production crawler path.

const { getServiceClient } = require('./supabaseClient');
const { syncCrawlState, syncCrawlLogEntry, snapshotToRow, islandToRow, sanitizeText } = require('./supabaseSync');

const PAGE = 1000; // Supabase/PostgREST hard-caps a single response at 1000 rows
const LOAD_CONCURRENCY = 8; // parallel page fetches during boot load

// Fetch a table in parallel pages. Gets the exact row count first, then fires
// all page requests through a bounded concurrency pool (instead of one
// sequential round-trip per page). For 278k rows this turns ~278 serial
// requests into ~35 batches of 8, cutting boot-load time several-fold.
async function loadAllPages(client, table, columns, onRow) {
  const { count, error: countErr } = await client.from(table).select('code', { count: 'exact', head: true });
  if (countErr) throw new Error(`${table} count failed: ${countErr.message}`);
  const total = count || 0;
  const pages = Math.ceil(total / PAGE);

  for (let base = 0; base < pages; base += LOAD_CONCURRENCY) {
    const batch = [];
    for (let i = base; i < Math.min(base + LOAD_CONCURRENCY, pages); i++) {
      const from = i * PAGE;
      batch.push(
        client
          .from(table)
          .select(columns)
          .order('code', { ascending: true })
          .range(from, from + PAGE - 1)
          .then(({ data, error }) => {
            if (error) throw new Error(`${table} page ${i} failed: ${error.message}`);
            return data || [];
          })
      );
    }
    const results = await Promise.all(batch);
    for (const rows of results) for (const row of rows) onRow(row);
  }
}
// Buffer island-metadata writes and flush them in batches. Individual upserts
// during a fast catalog-discovery phase (hundreds of islands/second) would be
// a chatty round-trip per island; batching keeps write throughput high while
// still being change-only (only touched rows are written).
const ISLAND_FLUSH_EVERY = 500;

// A stand-in for Store.getHistory()'s return value. The crawler only reads
// `.length` (to test "has this island shown data"), so a real array isn't
// needed — this exposes just `length` without holding snapshots in memory.
function historyProxy(hasData) {
  return { length: hasData ? 1 : 0 };
}

class CrawlerStore {
  constructor() {
    this.client = getServiceClient();
    // code -> island record (same shape as Store's islands values)
    this.islands = new Map();
    // codes that have at least one snapshot (drives hot/cold tiering)
    this.hasData = new Set();
    this.crawlState = { cursor: null, cyclesCompleted: 0, lastCrawlStartedAt: null, lastCrawlFinishedAt: null };
    // codes whose metadata changed since the last flush
    this._dirty = new Set();
  }

  // Load the whole catalog into memory once. Paginated so a 184k-row read
  // doesn't try to buffer everything in one request. Populates islands (for
  // hot-loop reads) and hasData (from latest_snapshots, so tiering is correct
  // from the first cycle).
  async load() {
    const t0 = Date.now();
    // 1. islands - only the fields the crawler's hot loop actually reads
    //    (code, last_metrics_polled_at, poll_attempts; title for one log
    //    line). Metadata like tags/category/creator isn't loaded: it's only
    //    written, never read, at runtime, and upsertIsland always has fresh
    //    values from Epic's API when it writes. Selecting 4 columns instead
    //    of 10 roughly halves the boot-load payload for 278k+ rows. To keep
    //    firstSeenAt's "carry forward on re-scan" invariant working without
    //    loading it, upsertIsland relies on the DB default (see there).
    await loadAllPages(this.client, 'islands', 'code,title,last_metrics_polled_at,poll_attempts', (row) => {
      this.islands.set(row.code, {
        code: row.code,
        title: row.title,
        lastMetricsPolledAt: row.last_metrics_polled_at,
        pollAttempts: row.poll_attempts || 0,
      });
    });

    // 2. which islands have data (codes only — cheap), also parallelized
    await loadAllPages(this.client, 'latest_snapshots', 'code', (row) => {
      this.hasData.add(row.code);
    });

    // 3. crawl state
    const { data: cs, error: csErr } = await this.client.from('crawl_state').select('*').eq('id', 1).maybeSingle();
    if (csErr) throw new Error(`crawlerStore.load crawl_state failed: ${csErr.message}`);
    if (cs) {
      this.crawlState = {
        cursor: cs.cursor,
        cyclesCompleted: cs.cycles_completed || 0,
        lastCrawlStartedAt: cs.last_crawl_started_at,
        lastCrawlFinishedAt: cs.last_crawl_finished_at,
      };
    }

    console.log(`[crawlerStore] loaded ${this.islands.size} islands (${this.hasData.size} with data) from Supabase in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Mirrors Store.upsertIsland: update the in-memory record and mark it dirty
  // for the next batched flush. Carries forward polling bookkeeping so a
  // catalog re-scan doesn't clobber it. firstSeenAt isn't kept in memory (not
  // loaded at boot to save payload), so it's set only for islands we've never
  // seen this process - existing islands keep whatever first_seen_at the DB
  // already has, because the flush omits the column for them (isNew=false).
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
      lastSeenAt: now,
      lastMetricsPolledAt: existing?.lastMetricsPolledAt || null,
      pollAttempts: existing?.pollAttempts || 0,
      // isNew drives whether the flush writes first_seen_at. Once written,
      // subsequent upserts of the same island in this process see existing
      // and leave isNew false, so the DB value is never overwritten.
      _isNew: existing ? existing._isNew : true,
      firstSeenAt: existing ? existing.firstSeenAt : now,
    };
    this.islands.set(island.code, record);
    this._dirty.add(island.code);
    return record;
  }

  markPolled(code) {
    const rec = this.islands.get(code);
    if (rec) {
      rec.lastMetricsPolledAt = new Date().toISOString();
      this._dirty.add(code);
    }
  }

  getHistory(code) {
    return historyProxy(this.hasData.has(code));
  }

  // Writes the snapshot straight to Postgres (change-only: one row). Updates
  // the in-memory hasData flag so subsequent tiering decisions this cycle see
  // it immediately. Dedup on (code, captured_at) is enforced by the DB unique
  // constraint + ignoreDuplicates, matching Store's dedup semantics.
  async addSnapshot(code, metrics) {
    const row = snapshotToRow(code, metrics);
    const { data, error } = await this.client
      .from('snapshots')
      .upsert(row, { onConflict: 'code,captured_at', ignoreDuplicates: true })
      .select();
    if (error) throw new Error(`crawlerStore.addSnapshot failed: ${error.message}`);
    this.hasData.add(code);
    return { written: (data || []).length > 0 };
  }

  // Same policy as Store.degradeIfConfirmedDead: after enough poll attempts
  // with no data ever, null the metadata (kept as a row so catalog/tag/creator
  // counts stay honest). Writes through to Postgres.
  degradeIfConfirmedDead(code, { minAttempts = 3 } = {}) {
    const rec = this.islands.get(code);
    if (!rec) return false;
    if ((rec.pollAttempts || 0) < minAttempts) return false;
    if (this.hasData.has(code)) return false;
    if (rec.title === null && rec.category === null && rec.createdIn === null) return false;
    rec.title = null;
    rec.category = null;
    rec.createdIn = null;
    this._dirty.add(code);
    return true;
  }

  // Flush buffered island-metadata changes to Postgres in batches. Called by
  // the crawler where it used to call persistIslands(); despite the name it no
  // longer writes any file — it upserts only the rows that changed since the
  // last flush.
  async persistIslands({ force = false } = {}) {
    if (!force && this._dirty.size < ISLAND_FLUSH_EVERY) return;
    if (this._dirty.size === 0) return;
    const codes = [...this._dirty];
    this._dirty.clear();
    const rows = [];
    for (const code of codes) {
      const rec = this.islands.get(code);
      if (!rec) continue;
      const row = islandToRow(rec);
      // Only write first_seen_at for islands new to this process. For existing
      // islands (loaded at boot without first_seen_at), omitting the column
      // from the upsert leaves the DB's stored value untouched.
      if (!rec._isNew) delete row.first_seen_at;
      else rec._isNew = false; // written now; don't re-write on future flushes
      rows.push(row);
    }
    const CHUNK = 500;
    try {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const { error } = await this.client.from('islands').upsert(rows.slice(i, i + CHUNK), { onConflict: 'code' });
        if (error) throw new Error(error.message);
      }
    } catch (err) {
      // Re-queue on failure so nothing is silently lost; next flush retries.
      for (const code of codes) this._dirty.add(code);
      throw new Error(`crawlerStore.persistIslands failed: ${err.message}`);
    }
  }

  getCrawlState() {
    return this.crawlState;
  }

  async setCrawlState(partial) {
    this.crawlState = { ...this.crawlState, ...partial };
    await syncCrawlState(this.crawlState);
  }

  async recordCrawlCycle(entry) {
    await syncCrawlLogEntry(entry);
  }

  // No-op parity: there is no separate outward sync step anymore — snapshots
  // and island rows are written directly above. Kept so main.js can call it
  // without special-casing which store it has.
  async flush() {
    await this.persistIslands({ force: true });
  }
}

module.exports = { CrawlerStore };
