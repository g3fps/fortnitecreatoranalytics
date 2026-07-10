'use strict';

// Vercel entrypoint. Vercel can't run src/main.js's continuous crawl loop
// (serverless functions are request-scoped, not long-lived - see that
// file's header comment), so this only ever serves reads (and the odd
// single-island /api/lookup write) against Supabase, backed by
// src/supabaseStore.js instead of the local-file src/store.js. The actual
// crawler keeps running elsewhere (locally / a small VPS) and writes here
// via src/supabaseSync.js.

require('../src/loadEnv');
const { createServer } = require('../src/server');
const { SupabaseStore } = require('../src/supabaseStore');

const store = new SupabaseStore();

const app = createServer(store, {
  crawlIntervalMs: null,
  getCrawlProgress: () => ({ inProgress: false, current: null }),
});

module.exports = app;
