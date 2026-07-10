'use strict';

// Thin client for Epic's public Fortnite Ecosystem Data API.
// No authentication is required or supported by this API.
//
// Verified against the live API on 2026-07-09:
//   - GET /islands                      cursor-paginated catalog (~100/page, no working sort/limit params)
//   - GET /islands/{code}                metadata for one island
//   - GET /islands/{code}/metrics/{day|hour|minute}   time-series metrics
//       - Every metric bucket comes back `null` except the most recent one.
//         Epic is not actually backfilling history through this endpoint -
//         it's a live snapshot shaped like a time series. Historical `from`
//         params are accepted but the server rejects `from` values older than
//         ~6 days with HTTP 400, and even within that window only the latest
//         bucket is populated. There is NO way to backfill missed periods -
//         if we don't poll it, that data point is gone forever.

const BASE_URL = 'https://api.fortnite.com/ecosystem/v1';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

class FortniteApiError extends Error {
  constructor(message, { status = null, code = null, cause = null } = {}) {
    super(message);
    this.name = 'FortniteApiError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'fortnite-creator-analytics/0.1.0 (research tool)',
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// GET with retry/backoff on network errors, timeouts, 429, and 5xx.
// Does NOT retry on 4xx (other than 429) since those are not transient.
async function getJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS, maxRetries = MAX_RETRIES } = {}) {
  const url = `${BASE_URL}${path}`;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response;
    try {
      response = await fetchWithTimeout(url, timeoutMs);
    } catch (err) {
      lastError = new FortniteApiError(`Network error calling ${path}: ${err.message}`, { cause: err });
      if (attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw lastError;
    }

    if (response.status === 429 || response.status >= 500) {
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
      lastError = new FortniteApiError(`API returned ${response.status} for ${path}`, { status: response.status });
      if (attempt < maxRetries) {
        await sleep(retryAfterMs && Number.isFinite(retryAfterMs) ? retryAfterMs : RETRY_BASE_DELAY_MS * 2 ** attempt);
        continue;
      }
      throw lastError;
    }

    if (response.status === 404) {
      return { notFound: true, status: 404 };
    }

    let body;
    const rawText = await response.text();
    try {
      body = rawText ? JSON.parse(rawText) : null;
    } catch (err) {
      throw new FortniteApiError(`Invalid JSON from ${path}: ${err.message}`, { status: response.status, cause: err });
    }

    if (!response.ok) {
      const code = body && body.errorCode ? body.errorCode : null;
      const message = body && body.errorMessage ? body.errorMessage : `HTTP ${response.status}`;
      throw new FortniteApiError(`API error for ${path}: ${message}`, { status: response.status, code });
    }

    return body;
  }

  throw lastError;
}

// Fetch one page of the island catalog.
// cursor: opaque pagination cursor from a previous response, or null for the first page.
// Returns { islands: [...], nextCursor: string|null }
async function fetchIslandsPage(cursor) {
  const path = cursor ? `/islands?after=${encodeURIComponent(cursor)}` : '/islands';
  const body = await getJson(path);

  const islands = Array.isArray(body?.data)
    ? body.data.map((entry) => ({
        code: entry.code ?? null,
        title: entry.title ?? null,
        creatorCode: entry.creatorCode ?? null,
        category: entry.category ?? null,
        createdIn: entry.createdIn ?? null,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
      }))
    : [];

  const nextCursor = body?.meta?.page?.nextCursor ?? null;
  return { islands, nextCursor };
}

// Fetch metadata for a single island by code directly (not via catalog
// pagination) - used for on-demand lookups of a specific map, including ones
// this crawler hasn't discovered through catalog pagination yet. Returns
// null if the code doesn't resolve to a public, discoverable island.
async function fetchIslandMetadata(code) {
  const body = await getJson(`/islands/${encodeURIComponent(code)}`);
  if (body && body.notFound) return null;
  return {
    code: body?.code ?? code,
    title: body?.title ?? null,
    creatorCode: body?.creatorCode ?? null,
    category: body?.category ?? null,
    createdIn: body?.createdIn ?? null,
    tags: Array.isArray(body?.tags) ? body.tags : [],
  };
}

// Fetch day-interval metrics for one island and reduce each series down to
// its most recent non-null reading (since earlier buckets are always null).
// Returns null if the island 404s (delisted / no longer discoverable).
async function fetchLatestMetrics(code) {
  const body = await getJson(`/islands/${encodeURIComponent(code)}/metrics/day`);
  if (body && body.notFound) return null;

  const latestNonNull = (series) => {
    if (!Array.isArray(series)) return null;
    for (let i = series.length - 1; i >= 0; i--) {
      const entry = series[i];
      if (entry && entry.value !== null && entry.value !== undefined) {
        return { value: entry.value, timestamp: entry.timestamp };
      }
    }
    return null;
  };

  const latestRetention = (series) => {
    if (!Array.isArray(series)) return null;
    for (let i = series.length - 1; i >= 0; i--) {
      const entry = series[i];
      if (entry && (entry.d1 !== null || entry.d7 !== null)) {
        return { d1: entry.d1 ?? null, d7: entry.d7 ?? null, timestamp: entry.timestamp };
      }
    }
    return null;
  };

  const uniquePlayers = latestNonNull(body?.uniquePlayers);
  const peakCCU = latestNonNull(body?.peakCCU);
  const minutesPlayed = latestNonNull(body?.minutesPlayed);
  const averageMinutesPerPlayer = latestNonNull(body?.averageMinutesPerPlayer);
  const plays = latestNonNull(body?.plays);
  const favorites = latestNonNull(body?.favorites);
  const recommendations = latestNonNull(body?.recommendations);
  const retention = latestRetention(body?.retention);

  const anyData = [uniquePlayers, peakCCU, minutesPlayed, plays, favorites, recommendations, retention].some(Boolean);
  if (!anyData) return null;

  // Use the newest timestamp among populated fields as the snapshot's authoritative timestamp.
  const timestamps = [uniquePlayers, peakCCU, minutesPlayed, averageMinutesPerPlayer, plays, favorites, recommendations, retention]
    .filter(Boolean)
    .map((f) => f.timestamp)
    .sort();
  const capturedAt = timestamps.length ? timestamps[timestamps.length - 1] : new Date().toISOString();

  return {
    capturedAt,
    uniquePlayers: uniquePlayers?.value ?? null,
    peakCCU: peakCCU?.value ?? null,
    minutesPlayed: minutesPlayed?.value ?? null,
    averageMinutesPerPlayer: averageMinutesPerPlayer?.value ?? null,
    plays: plays?.value ?? null,
    favorites: favorites?.value ?? null,
    recommendations: recommendations?.value ?? null,
    retentionD1: retention?.d1 ?? null,
    retentionD7: retention?.d7 ?? null,
  };
}

module.exports = {
  FortniteApiError,
  fetchIslandsPage,
  fetchIslandMetadata,
  fetchLatestMetrics,
  sleep,
};
