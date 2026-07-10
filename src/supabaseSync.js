'use strict';

// Write-through mirror of the local Store into Supabase Postgres, so a
// central database stays populated while the crawler itself keeps running as
// a long-lived local/VPS process (Vercel serverless functions can't run the
// hours-long crawl loop, but they can read from this table via
// supabaseStore.js). Local JSONL files remain the crawler's own source of
// truth - this module only pushes a copy outward, best-effort, chunked to
// stay under PostgREST's request size limits.
//
// Every exported function is safe to call even when Supabase isn't
// configured (no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): isEnabled()
// reports that up front so callers can skip the work entirely, matching how
// this project treats every other external dependency - optional, and never
// allowed to take down the crawler's core job.

const { getServiceClient } = require('./supabaseClient');

const CHUNK_SIZE = 500;

function isEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Island titles/tags come from creators via Epic's API, unsanitized. Two
// things break Postgres/PostgREST outright rather than just looking ugly:
// the null character (Postgres text/jsonb cannot store it at all) and
// unpaired UTF-16 surrogates (invalid Unicode - fails JSON encoding on the
// wire with "unsupported Unicode escape sequence"). Strip both; leave
// everything else (emoji, other scripts, punctuation) untouched.
const NUL_CHAR = String.fromCharCode(0);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeText(value) {
  if (typeof value !== 'string') return value;
  const withoutNulChars = value.indexOf(NUL_CHAR) === -1 ? value : value.split(NUL_CHAR).join('');
  return withoutNulChars.replace(LONE_SURROGATE_RE, '');
}

function islandToRow(island) {
  return {
    code: island.code,
    title: sanitizeText(island.title) ?? null,
    creator_code: sanitizeText(island.creatorCode) ?? null,
    category: sanitizeText(island.category) ?? null,
    created_in: sanitizeText(island.createdIn) ?? null,
    tags: (island.tags || []).map(sanitizeText),
    first_seen_at: island.firstSeenAt,
    last_seen_at: island.lastSeenAt,
    last_metrics_polled_at: island.lastMetricsPolledAt ?? null,
  };
}

function snapshotToRow(code, snapshot) {
  return {
    code,
    captured_at: snapshot.capturedAt,
    peak_ccu: snapshot.peakCCU ?? null,
    unique_players: snapshot.uniquePlayers ?? null,
    minutes_played: snapshot.minutesPlayed ?? null,
    average_minutes_per_player: snapshot.averageMinutesPerPlayer ?? null,
    plays: snapshot.plays ?? null,
    favorites: snapshot.favorites ?? null,
    recommendations: snapshot.recommendations ?? null,
    retention_d1: snapshot.retentionD1 ?? null,
    retention_d7: snapshot.retentionD7 ?? null,
  };
}

async function syncIslands(islands) {
  if (!islands.length) return;
  const client = getServiceClient();
  for (const batch of chunk(islands.map(islandToRow), CHUNK_SIZE)) {
    const { error } = await client.from('islands').upsert(batch, { onConflict: 'code' });
    if (error) throw new Error(`islands upsert failed: ${error.message}`);
  }
}

// entries: [{ code, snapshot }]. Relies on the (code, captured_at) unique
// constraint in db/schema.sql + ignoreDuplicates so re-syncing the same
// snapshot (e.g. after a retry) is a safe no-op rather than an error.
async function syncSnapshots(entries) {
  if (!entries.length) return;
  const client = getServiceClient();
  const rows = entries.map(({ code, snapshot }) => snapshotToRow(code, snapshot));
  for (const batch of chunk(rows, CHUNK_SIZE)) {
    const { error } = await client
      .from('snapshots')
      .upsert(batch, { onConflict: 'code,captured_at', ignoreDuplicates: true });
    if (error) throw new Error(`snapshots insert failed: ${error.message}`);
  }
}

async function syncCrawlState(state) {
  const client = getServiceClient();
  const { error } = await client.from('crawl_state').upsert(
    {
      id: 1,
      cursor: state.cursor ?? null,
      cycles_completed: state.cyclesCompleted ?? 0,
      last_crawl_started_at: state.lastCrawlStartedAt ?? null,
      last_crawl_finished_at: state.lastCrawlFinishedAt ?? null,
    },
    { onConflict: 'id' }
  );
  if (error) throw new Error(`crawl_state upsert failed: ${error.message}`);
}

async function syncCrawlLogEntry(entry) {
  const client = getServiceClient();
  const { error } = await client.from('crawl_log').insert({
    reason: entry.reason ?? null,
    started_at: entry.startedAt ?? null,
    finished_at: entry.finishedAt ?? null,
    duration_ms: entry.durationMs ?? null,
    catalog_pages_fetched: entry.catalogPagesFetched ?? null,
    new_islands_discovered: entry.newIslandsDiscovered ?? null,
    metrics_polled: entry.metricsPolled ?? null,
    metrics_written: entry.metricsWritten ?? null,
    metrics_not_found: entry.metricsNotFound ?? null,
    error_count: entry.errorCount ?? 0,
    fatal: Boolean(entry.fatal),
    sample_errors: entry.sampleErrors ?? [],
  });
  if (error) throw new Error(`crawl_log insert failed: ${error.message}`);
}

module.exports = {
  isEnabled,
  syncIslands,
  syncSnapshots,
  syncCrawlState,
  syncCrawlLogEntry,
  sanitizeText,
  islandToRow,
  snapshotToRow,
};
