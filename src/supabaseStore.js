'use strict';

// Read (and light on-demand write, for /api/lookup) implementation of the
// same interface src/store.js exposes, backed by Supabase Postgres instead
// of local files/in-memory Maps. Meant for the Vercel-hosted dashboard API,
// which can't run the long-lived crawler (see src/main.js's header comment)
// but can serve reads - and the occasional single-island lookup-and-write -
// from whatever the crawler has already synced via src/supabaseSync.js.
//
// Every method mirrors a same-named method on Store, with the same return
// shape (camelCase field names matching the local JSONL model), so
// src/server.js works unmodified against either one - the only difference is
// these all return Promises, which `await` handles transparently for Store's
// synchronous methods too.
//
// The complex aggregations (movers, creator leaderboard, tag counts, browse)
// are backed by SQL views defined in db/schema.sql rather than reimplemented
// here, since pulling the whole catalog into a serverless function just to
// rank it in JS defeats the point of using a real database.

const { getServiceClient } = require('./supabaseClient');
const { sanitizeText, snapshotToRow } = require('./supabaseSync');

const METRIC_COLUMNS = {
  peakCCU: 'peak_ccu',
  uniquePlayers: 'unique_players',
  minutesPlayed: 'minutes_played',
  averageMinutesPerPlayer: 'average_minutes_per_player',
  plays: 'plays',
  favorites: 'favorites',
  recommendations: 'recommendations',
  retentionD1: 'retention_d1',
  retentionD7: 'retention_d7',
};

const CREATOR_SORT_COLUMNS = {
  totalPeakCCU: 'total_peak_ccu',
  totalUniquePlayers: 'total_unique_players',
};

const BROWSE_SORT_COLUMNS = { title: 'title', firstSeenAt: 'first_seen_at', ...METRIC_COLUMNS };

function rowToIslandMeta(row) {
  return {
    code: row.code,
    title: row.title,
    creatorCode: row.creator_code,
    category: row.category,
    createdIn: row.created_in,
    tags: row.tags || [],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastMetricsPolledAt: row.last_metrics_polled_at,
  };
}

function rowToSnapshot(row) {
  return {
    capturedAt: row.captured_at,
    peakCCU: row.peak_ccu,
    uniquePlayers: row.unique_players,
    minutesPlayed: row.minutes_played,
    averageMinutesPerPlayer: row.average_minutes_per_player,
    plays: row.plays,
    favorites: row.favorites,
    recommendations: row.recommendations,
    retentionD1: row.retention_d1,
    retentionD7: row.retention_d7,
  };
}

// islands_with_latest rows are a flat island+snapshot join - split back into
// the { ...meta, latest } shape store.js callers expect.
function rowToIslandWithLatest(row) {
  const meta = rowToIslandMeta(row);
  const latest = row.captured_at
    ? {
        capturedAt: row.captured_at,
        peakCCU: row.peak_ccu,
        uniquePlayers: row.unique_players,
        minutesPlayed: row.minutes_played,
        averageMinutesPerPlayer: row.average_minutes_per_player,
        plays: row.plays,
        favorites: row.favorites,
        recommendations: row.recommendations,
        retentionD1: row.retention_d1,
        retentionD7: row.retention_d7,
      }
    : null;
  return { ...meta, latest };
}

function movementRowToLatest(row) {
  return {
    capturedAt: row.latest_captured_at,
    peakCCU: row.latest_peak_ccu,
    uniquePlayers: row.latest_unique_players,
    minutesPlayed: row.latest_minutes_played,
    averageMinutesPerPlayer: row.latest_average_minutes_per_player,
    plays: row.latest_plays,
    favorites: row.latest_favorites,
    recommendations: row.latest_recommendations,
    retentionD1: row.latest_retention_d1,
    retentionD7: row.latest_retention_d7,
  };
}

function movementRowToPrior(row) {
  return {
    capturedAt: row.prior_captured_at,
    peakCCU: row.prior_peak_ccu,
    uniquePlayers: row.prior_unique_players,
    minutesPlayed: row.prior_minutes_played,
    averageMinutesPerPlayer: row.prior_average_minutes_per_player,
    plays: row.prior_plays,
    favorites: row.prior_favorites,
    recommendations: row.prior_recommendations,
    retentionD1: row.prior_retention_d1,
    retentionD7: row.prior_retention_d7,
  };
}

function applyBrowseFilters(query, { tag, creatorCode, hasData, hideEmpty }) {
  let q = query;
  if (tag) q = q.contains('tags', [tag]);
  if (creatorCode) q = q.eq('creator_code', creatorCode);
  if (hasData === true) q = q.not('captured_at', 'is', null);
  if (hasData === false) q = q.is('captured_at', null);
  // hideEmpty drops internal-noise rows (Epic tournament/matchmaking
  // playlists): untitled AND never showed data. The row is KEPT when it has
  // a non-empty title OR it has a reading - so an untitled-but-active island
  // still survives. In the junk data, title is an empty string ('') rather
  // than null, so the "has a real title" test is: title is not null AND
  // title <> '', which PostgREST expresses inside .or() with the and() group.
  if (hideEmpty) {
    q = q.or('and(title.not.is.null,title.neq.),captured_at.not.is.null');
  }
  return q;
}

function check(result) {
  if (result.error) throw new Error(result.error.message);
  return result;
}

// Retry a query-producing function once on a transient statement timeout.
// These happen when the crawler is mid-cycle and momentarily saturates the
// connection pool, starving a read - the query itself is fast, so a short
// wait + one retry almost always succeeds. Non-timeout errors are not
// retried (they won't get better on a second try).
async function withRetry(fn, { tries = 2, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const transient = /statement timeout|canceling statement|timeout|fetch failed|ECONNRESET/i.test(err.message || '');
      if (!transient || i === tries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

class SupabaseStore {
  constructor() {
    this.client = getServiceClient();
  }

  async getStats() {
    const [islandsTracked, islandsPolled, islandsWithData, snapshotCount, oldest, newest, crawlState] = await Promise.all([
      this.client.from('islands').select('code', { count: 'exact', head: true }),
      this.client.from('islands').select('code', { count: 'exact', head: true }).not('last_metrics_polled_at', 'is', null),
      this.client.from('latest_snapshots').select('code', { count: 'exact', head: true }),
      this.client.from('snapshots').select('id', { count: 'exact', head: true }),
      this.client.from('snapshots').select('captured_at').order('captured_at', { ascending: true }).limit(1),
      this.client.from('snapshots').select('captured_at').order('captured_at', { ascending: false }).limit(1),
      this.client.from('crawl_state').select('*').eq('id', 1).maybeSingle(),
    ].map((p) => p.then(check)));

    const cs = crawlState.data;
    return {
      islandsTracked: islandsTracked.count || 0,
      islandsPolled: islandsPolled.count || 0,
      islandsWithData: islandsWithData.count || 0,
      snapshotCount: snapshotCount.count || 0,
      oldestSnapshotAt: oldest.data?.[0]?.captured_at ?? null,
      newestSnapshotAt: newest.data?.[0]?.captured_at ?? null,
      crawlState: cs
        ? {
            cursor: cs.cursor,
            cyclesCompleted: cs.cycles_completed,
            lastCrawlStartedAt: cs.last_crawl_started_at,
            lastCrawlFinishedAt: cs.last_crawl_finished_at,
          }
        : { cursor: null, cyclesCompleted: 0, lastCrawlStartedAt: null, lastCrawlFinishedAt: null },
    };
  }

  async getTimeline() {
    const { data } = check(await this.client.from('snapshot_daily_counts').select('*').order('date', { ascending: true }));
    return (data || []).map((r) => ({ date: r.date, newSnapshots: r.new_snapshots }));
  }

  async getCrawlLog(limit = 20) {
    const { data } = check(
      await this.client.from('crawl_log').select('*').order('created_at', { ascending: false }).limit(limit)
    );
    return (data || []).map((r) => ({
      reason: r.reason,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      durationMs: r.duration_ms,
      catalogPagesFetched: r.catalog_pages_fetched,
      newIslandsDiscovered: r.new_islands_discovered,
      metricsPolled: r.metrics_polled,
      metricsWritten: r.metrics_written,
      metricsNotFound: r.metrics_not_found,
      errorCount: r.error_count,
      fatal: r.fatal,
      sampleErrors: r.sample_errors || [],
    }));
  }

  async searchIslands(query, limit = 25) {
    let q = this.client.from('islands_with_latest').select('*');
    const trimmed = (query || '').trim();
    if (trimmed) {
      // PostgREST's .or() mini-language uses , ( ) as syntax and * as the
      // ilike wildcard - strip the syntax characters rather than trying to
      // escape them, which is plenty for a title/code/creator search box.
      const safe = trimmed.replace(/[,()*]/g, ' ').trim();
      if (safe) {
        q = q.or(`title.ilike.*${safe}*,code.ilike.*${safe}*,creator_code.ilike.*${safe}*`);
      }
    }
    const { data } = check(await q.order('peak_ccu', { ascending: false, nullsFirst: false }).limit(limit));
    return (data || []).map(rowToIslandWithLatest);
  }

  async getLeaderboard(metric = 'peakCCU', limit = 25, { tag = null, creatorCode = null } = {}) {
    const col = METRIC_COLUMNS[metric] || METRIC_COLUMNS.peakCCU;
    const data = await withRetry(async () => {
      let q = this.client.from('islands_with_latest').select('*').not(col, 'is', null);
      if (tag) q = q.contains('tags', [tag]);
      if (creatorCode) q = q.eq('creator_code', creatorCode);
      return check(await q.order(col, { ascending: false }).limit(limit)).data;
    });
    return (data || []).map(rowToIslandWithLatest);
  }

  // Candidate pool is capped (recency-biased) rather than scanning every
  // island with 2+ readings - fine at today's scale, worth revisiting if the
  // catalog's polled-twice-or-more population grows past the tens of
  // thousands.
  async getMovers(metric = 'peakCCU', limit = 20, direction = 'up', { tag = null, creatorCode = null } = {}) {
    const col = METRIC_COLUMNS[metric] || METRIC_COLUMNS.peakCCU;
    const data = await withRetry(async () => {
      let mq = this.client
        .from('islands_with_movement')
        .select('*')
        .not(`latest_${col}`, 'is', null)
        .not(`prior_${col}`, 'is', null);
      if (tag) mq = mq.contains('tags', [tag]);
      if (creatorCode) mq = mq.eq('creator_code', creatorCode);
      return check(await mq.order('latest_captured_at', { ascending: false }).limit(5000)).data;
    });
    const rows = (data || []).map((row) => {
      const latest = movementRowToLatest(row);
      const previous = movementRowToPrior(row);
      const latestVal = latest[metric];
      const previousVal = previous[metric];
      const delta = latestVal - previousVal;
      const percentChange = previousVal !== 0 ? (delta / previousVal) * 100 : null;
      return { ...rowToIslandMeta(row), latest, previous, delta, percentChange };
    });
    rows.sort((a, b) => (direction === 'down' ? a.delta - b.delta : b.delta - a.delta));
    return rows.slice(0, limit);
  }

  async getCreatorLeaderboard(limit = 25, sortBy = 'totalPeakCCU') {
    const col = CREATOR_SORT_COLUMNS[sortBy] || CREATOR_SORT_COLUMNS.totalPeakCCU;
    const { data } = check(
      await this.client.from('creator_stats').select('*').gt('islands_with_data', 0).order(col, { ascending: false }).limit(limit)
    );
    const creatorCodes = (data || []).map((r) => r.creator_code);
    const bestByCreator = new Map();
    if (creatorCodes.length) {
      const { data: bestRows } = check(
        await this.client.from('creator_best_island').select('*').in('creator_code', creatorCodes)
      );
      for (const row of bestRows || []) {
        bestByCreator.set(row.creator_code, { code: row.code, title: row.title, peakCCU: row.peak_ccu });
      }
    }
    return (data || []).map((r) => ({
      creatorCode: r.creator_code,
      islandCount: r.island_count,
      islandsWithData: r.islands_with_data,
      totalPeakCCU: r.total_peak_ccu,
      totalUniquePlayers: r.total_unique_players,
      bestIsland: bestByCreator.get(r.creator_code) || null,
    }));
  }

  // See Store.getCreatorCounts() - the leaderboard above correctly omits
  // creators with zero islands showing data (nothing to rank them on), but
  // that means they're invisible without this honest denominator alongside it.
  async getCreatorCounts() {
    const [{ count: totalCreators }, { count: creatorsWithData }] = await Promise.all(
      [
        this.client.from('creator_stats').select('creator_code', { count: 'exact', head: true }),
        this.client.from('creator_stats').select('creator_code', { count: 'exact', head: true }).gt('islands_with_data', 0),
      ].map((p) => p.then(check))
    );
    return { totalCreators: totalCreators || 0, creatorsWithData: creatorsWithData || 0 };
  }

  async getTagCounts(limit = 40) {
    const { data } = check(await this.client.from('tag_counts').select('*').order('count', { ascending: false }).limit(limit));
    return (data || []).map((r) => ({ tag: r.tag, count: r.count }));
  }

  async browseIslands(opts = {}) {
    const { tag = null, creatorCode = null, hasData = null, hideEmpty = false, sort = 'title', dir = 'asc', page = 1, pageSize = 50 } = opts;
    const safePageSize = Math.min(Math.max(1, pageSize), 200);
    const filters = { tag, creatorCode, hasData, hideEmpty };

    const { count } = check(
      await applyBrowseFilters(this.client.from('islands_with_latest').select('code', { count: 'exact', head: true }), filters)
    );
    const total = count || 0;
    const totalPages = Math.max(1, Math.ceil(total / safePageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * safePageSize;

    const col = BROWSE_SORT_COLUMNS[sort] || 'title';
    let dataQuery = applyBrowseFilters(this.client.from('islands_with_latest').select('*'), filters);
    dataQuery = dataQuery.order(col, { ascending: dir !== 'desc', nullsFirst: false }).range(start, start + safePageSize - 1);
    const { data } = check(await dataQuery);

    return { total, page: safePage, pageSize: safePageSize, totalPages, rows: (data || []).map(rowToIslandWithLatest) };
  }

  async getIsland(code) {
    const { data } = check(await this.client.from('islands_with_latest').select('*').eq('code', code).maybeSingle());
    if (!data) return null;
    const { count } = check(await this.client.from('snapshots').select('id', { count: 'exact', head: true }).eq('code', code));
    return { ...rowToIslandWithLatest(data), snapshotCount: count || 0 };
  }

  async getHistory(code) {
    const { data } = check(
      await this.client.from('snapshots').select('*').eq('code', code).order('captured_at', { ascending: true })
    );
    return (data || []).map(rowToSnapshot);
  }

  // Used by GET /api/lookup/:code - a single-row write is fine from a
  // request-scoped serverless function, unlike the crawler's hours-long bulk
  // job. Preserves firstSeenAt/lastMetricsPolledAt the same way
  // store.js's upsertIsland does: carried forward from any existing row.
  async upsertIsland(metadata) {
    const now = new Date().toISOString();
    const { data: existing } = check(
      await this.client.from('islands').select('first_seen_at,last_metrics_polled_at').eq('code', metadata.code).maybeSingle()
    );
    const row = {
      code: metadata.code,
      title: sanitizeText(metadata.title) ?? null,
      creator_code: sanitizeText(metadata.creatorCode) ?? null,
      category: sanitizeText(metadata.category) ?? null,
      created_in: sanitizeText(metadata.createdIn) ?? null,
      tags: (metadata.tags || []).map(sanitizeText),
      first_seen_at: existing?.first_seen_at || now,
      last_seen_at: now,
      last_metrics_polled_at: existing?.last_metrics_polled_at ?? null,
    };
    check(await this.client.from('islands').upsert(row, { onConflict: 'code' }));
    return rowToIslandMeta(row);
  }

  async addSnapshot(code, metrics) {
    const row = snapshotToRow(code, metrics);
    const { data } = check(
      await this.client.from('snapshots').upsert(row, { onConflict: 'code,captured_at', ignoreDuplicates: true }).select()
    );
    return { written: (data || []).length > 0 };
  }

  async markPolled(code) {
    check(await this.client.from('islands').update({ last_metrics_polled_at: new Date().toISOString() }).eq('code', code));
  }

  // No-op: every write above is already persisted immediately (there's no
  // in-memory state to flush), unlike the local Store's file-backed version.
  async persistIslands() {}
}

module.exports = { SupabaseStore };
