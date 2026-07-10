'use strict';

// Manual one-off crawl, useful for testing/demoing without starting the
// HTTP server. Prints progress to stdout as it goes.
//
// Usage: npm run crawl
//        node scripts/crawl-once.js --pages=10 --max-metrics=500

const path = require('path');
const { Store } = require('../src/store');
const { crawlOnce } = require('../src/crawler');

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)=(.+)$/.exec(arg);
    if (match) opts[match[1]] = match[2];
  }
  return opts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = path.join(__dirname, '..', 'data');
  const store = new Store(dataDir);

  console.log(`[crawl-once] data dir: ${dataDir}`);
  console.log(`[crawl-once] islands known before this run: ${store.islands.size}`);

  const result = await crawlOnce(store, {
    catalogPages: args.pages ? Number(args.pages) : 5,
    maxMetricsPerCycle: args['max-metrics'] ? Number(args['max-metrics']) : 300,
    onProgress: (evt) => {
      if (evt.phase === 'catalog' && !evt.error) {
        console.log(`  [catalog] page ${evt.page}: +${evt.islandsOnPage} islands (new so far: ${evt.newSoFar})`);
      } else if (evt.phase === 'metrics' && evt.found) {
        console.log(`  [metrics] ${evt.code} "${(evt.title || '').slice(0, 40)}" - captured`);
      } else if (evt.error) {
        console.log(`  [error] ${evt.phase}: ${evt.error}`);
      }
    },
  });

  console.log('\n[crawl-once] summary:');
  console.log(JSON.stringify(result, null, 2));
  console.log(`\n[crawl-once] islands known after this run: ${store.islands.size}`);
  console.log(JSON.stringify(store.getStats(), null, 2));
}

main().catch((err) => {
  console.error('[crawl-once] fatal error:', err);
  process.exit(1);
});
