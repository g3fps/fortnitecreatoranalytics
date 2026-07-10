'use strict';

// One-off backfill: pushes the existing local data/islands.json and
// data/snapshots.jsonl into Supabase. Run this once, after applying
// db/schema.sql in the Supabase SQL Editor, before the crawler's ongoing
// write-through sync (src/supabaseSync.js) takes over.
//
// Usage: node scripts/migrate-to-supabase.js

require('../src/loadEnv');
const path = require('path');
const { Store } = require('../src/store');
const supabaseSync = require('../src/supabaseSync');

const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  if (!supabaseSync.isEnabled()) {
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.local). Aborting.');
    process.exit(1);
  }

  console.log('[migrate] loading local data...');
  const store = new Store(DATA_DIR);
  const islands = [...store.islands.values()];
  console.log(`[migrate] ${islands.length} island(s) to upsert`);

  const started = Date.now();
  await supabaseSync.syncIslands(islands);
  console.log(`[migrate] islands done in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  let snapshotCount = 0;
  const snapshotEntries = [];
  for (const [code, history] of store.history) {
    for (const snapshot of history) {
      snapshotEntries.push({ code, snapshot });
      snapshotCount++;
    }
  }
  console.log(`[migrate] ${snapshotCount} snapshot(s) to insert`);

  const snapStarted = Date.now();
  // Push in large-but-bounded batches with progress output - this is a
  // one-off run against 9.7k+ rows today and growing, so silent multi-minute
  // waits with no feedback would look hung.
  const BATCH = 2000;
  for (let i = 0; i < snapshotEntries.length; i += BATCH) {
    const slice = snapshotEntries.slice(i, i + BATCH);
    await supabaseSync.syncSnapshots(slice);
    console.log(`[migrate] snapshots ${Math.min(i + BATCH, snapshotEntries.length)}/${snapshotEntries.length}`);
  }
  console.log(`[migrate] snapshots done in ${((Date.now() - snapStarted) / 1000).toFixed(1)}s`);

  await supabaseSync.syncCrawlState(store.getCrawlState());
  const log = store.getCrawlLog(50).reverse(); // oldest first, to insert in original order
  for (const entry of log) {
    await supabaseSync.syncCrawlLogEntry(entry);
  }
  console.log(`[migrate] crawl state + ${log.length} crawl log entrie(s) synced`);

  console.log('[migrate] done.');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
