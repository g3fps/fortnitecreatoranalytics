'use strict';

const express = require('express');
const path = require('path');
const { fetchIslandMetadata, fetchLatestMetrics } = require('./fortniteApi');

const ALLOWED_METRICS = new Set([
  'peakCCU',
  'uniquePlayers',
  'minutesPlayed',
  'averageMinutesPerPlayer',
  'plays',
  'favorites',
  'recommendations',
  'retentionD1',
  'retentionD7',
]);

// Express 4 doesn't catch rejected Promises from async route handlers on its
// own (unlike Express 5) - without this wrapper, a throw/rejection inside an
// async handler just hangs the request forever instead of reaching the error
// middleware below.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// Shared by /api/leaderboard, /api/movers, /api/browse - a non-empty string
// or null, never '' (which would otherwise match every island via the
// downstream .includes()/.eq() checks).
function parseFilterParams(query) {
  const { tag, creatorCode } = query;
  return {
    tag: typeof tag === 'string' && tag ? tag : null,
    creatorCode: typeof creatorCode === 'string' && creatorCode ? creatorCode : null,
  };
}

function createServer(store, options = {}) {
  const { crawlIntervalMs = null, getCrawlProgress = () => ({ inProgress: false, current: null }) } = options;
  const app = express();

  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get(
    '/api/stats',
    ah(async (req, res) => {
      res.json({ ...(await store.getStats()), crawlIntervalMs, crawlProgress: getCrawlProgress() });
    })
  );

  app.get(
    '/api/timeline',
    ah(async (req, res) => {
      res.json({ days: await store.getTimeline() });
    })
  );

  app.get(
    '/api/crawl-log',
    ah(async (req, res) => {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 50) : 20;
      res.json({ cycles: await store.getCrawlLog(limit) });
    })
  );

  app.get(
    '/api/islands',
    ah(async (req, res) => {
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
      res.json(await store.searchIslands(search, limit));
    })
  );

  app.get(
    '/api/leaderboard',
    ah(async (req, res) => {
      const metric = typeof req.query.metric === 'string' && ALLOWED_METRICS.has(req.query.metric)
        ? req.query.metric
        : 'peakCCU';
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
      const filters = parseFilterParams(req.query);
      res.json({ metric, ...filters, rows: await store.getLeaderboard(metric, limit, filters) });
    })
  );

  app.get(
    '/api/movers',
    ah(async (req, res) => {
      const metric = typeof req.query.metric === 'string' && ALLOWED_METRICS.has(req.query.metric)
        ? req.query.metric
        : 'peakCCU';
      const direction = req.query.direction === 'down' ? 'down' : 'up';
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 20;
      const filters = parseFilterParams(req.query);
      res.json({ metric, direction, ...filters, rows: await store.getMovers(metric, limit, direction, filters) });
    })
  );

  app.get(
    '/api/creators',
    ah(async (req, res) => {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 25;
      const [rows, counts] = await Promise.all([store.getCreatorLeaderboard(limit), store.getCreatorCounts()]);
      res.json({ ...counts, rows });
    })
  );

  app.get(
    '/api/tags',
    ah(async (req, res) => {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 40;
      res.json({ tags: await store.getTagCounts(limit) });
    })
  );

  app.get(
    '/api/browse',
    ah(async (req, res) => {
      const { sort } = req.query;
      const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
      const hasDataRaw = req.query.hasData;
      const hasData = hasDataRaw === 'true' ? true : hasDataRaw === 'false' ? false : null;
      const page = Number.isFinite(Number(req.query.page)) && Number(req.query.page) > 0 ? Number(req.query.page) : 1;
      const pageSize = Number.isFinite(Number(req.query.pageSize)) && Number(req.query.pageSize) > 0 ? Number(req.query.pageSize) : 50;
      const allowedSort = new Set(['title', 'firstSeenAt', ...ALLOWED_METRICS]);
      res.json(
        await store.browseIslands({
          ...parseFilterParams(req.query),
          hasData,
          sort: typeof sort === 'string' && allowedSort.has(sort) ? sort : 'title',
          dir,
          page,
          pageSize,
        })
      );
    })
  );

  // On-demand lookup of a specific island by code, straight from Epic's live
  // API - not limited to whatever the background crawler has discovered so
  // far. Used for "check your own map" - it also upserts the result into the
  // local store immediately, so a map a creator looks up here is instantly
  // part of this instance's tracked catalog rather than waiting for organic
  // catalog-pagination discovery (which could otherwise take a long time to
  // reach any one specific island, given the catalog is 180k+ islands).
  app.get(
    '/api/lookup/:code',
    ah(async (req, res) => {
      const code = (req.params.code || '').trim();
      if (!code || code.length > 64) {
        res.status(400).json({ error: 'Provide a valid island code, e.g. 1234-5678-9012.' });
        return;
      }

      let metadata;
      try {
        metadata = await fetchIslandMetadata(code);
      } catch (err) {
        res.status(502).json({ error: `Epic's API didn't respond: ${err.message}` });
        return;
      }
      if (!metadata) {
        res.status(404).json({ error: `"${code}" isn't a public, discoverable island on Epic's API right now.` });
        return;
      }

      await store.upsertIsland(metadata);

      let metrics = null;
      try {
        metrics = await fetchLatestMetrics(code);
      } catch (err) {
        // Metadata succeeded but the metrics call failed transiently - still
        // return the metadata we do have rather than failing the whole lookup.
      }

      await store.markPolled(code);
      let wroteNewSnapshot = false;
      if (metrics) {
        wroteNewSnapshot = (await store.addSnapshot(code, metrics)).written;
      }
      await store.persistIslands();

      res.json({ ...(await store.getIsland(code)), wroteNewSnapshot, hasLiveData: metrics !== null });
    })
  );

  app.get(
    '/api/islands/:code',
    ah(async (req, res) => {
      const island = await store.getIsland(req.params.code);
      if (!island) {
        res.status(404).json({ error: 'Island not found in local index (not yet crawled, or code is invalid).' });
        return;
      }
      res.json(island);
    })
  );

  app.get(
    '/api/islands/:code/history',
    ah(async (req, res) => {
      const island = await store.getIsland(req.params.code);
      if (!island) {
        res.status(404).json({ error: 'Island not found in local index.' });
        return;
      }
      res.json({ code: req.params.code, snapshots: await store.getHistory(req.params.code) });
    })
  );

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // package.json pins Express 4.x (path-to-regexp 0.1.x), where a bare '*'
  // is the catch-all wildcard. Express 5's path-to-regexp requires a named
  // wildcard like '/*splat' instead - don't switch to that syntax unless the
  // Express dependency is also bumped to ^5, or this route will throw a
  // routing error at startup.
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  // Catches anything ah() forwarded via next(err) - without this, Express's
  // default HTML error page would go out for what should be a JSON API.
  app.use((err, req, res, next) => {
    console.error('[server] request failed:', err);
    res.status(500).json({ error: 'Internal error.' });
  });

  return app;
}

module.exports = { createServer };
