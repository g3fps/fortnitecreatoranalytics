'use strict';

// Prints a quick health readout of the crawler, read from Supabase. Works
// whether or not a crawler is currently running - it reflects what the
// crawler has actually recorded, which is the real signal (a running node
// process can still be crash-looping; this shows if cycles are completing).
//
// Usage: npm run crawler-status

require('../src/loadEnv');
const { getServiceClient } = require('../src/supabaseClient');

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function main() {
  const c = getServiceClient();

  const [{ data: cs }, { data: cycles }, { count: tracked }, { count: withData }, { data: newest }] = await Promise.all([
    c.from('crawl_state').select('*').eq('id', 1).maybeSingle(),
    c.from('crawl_log').select('reason,started_at,finished_at,metrics_polled,metrics_written,new_islands_discovered,error_count,fatal').order('created_at', { ascending: false }).limit(5),
    c.from('islands').select('code', { count: 'exact', head: true }),
    c.from('latest_snapshots').select('code', { count: 'exact', head: true }),
    c.from('snapshots').select('captured_at').order('captured_at', { ascending: false }).limit(1),
  ].map((p) => p.then((r) => r)));

  const recent = (cycles || [])[0];
  const lastFinishedOk = recent && !recent.fatal && (recent.error_count || 0) === 0;

  // A cycle is "in progress" when the crawler recorded a start more recently
  // than its last finish. Cycles don't log until they finish/fail, so without
  // this a healthy long-running cycle looks identical to a stale crash.
  const startedAt = cs && cs.last_crawl_started_at ? new Date(cs.last_crawl_started_at).getTime() : 0;
  const finishedAt = cs && cs.last_crawl_finished_at ? new Date(cs.last_crawl_finished_at).getTime() : 0;
  const inProgress = startedAt > finishedAt;

  let overall;
  if (inProgress) overall = `RUNNING a cycle now (started ${ago(cs.last_crawl_started_at)})`;
  else if (!recent) overall = 'no cycles recorded yet';
  else if (lastFinishedOk) overall = 'HEALTHY';
  else if (recent.fatal) overall = 'last recorded cycle FATAL';
  else overall = 'errors in last cycle';

  console.log('');
  console.log('  UEFN Stats — crawler status');
  console.log('  ' + '-'.repeat(40));
  console.log(`  overall:        ${overall}`);
  console.log(`  cycles done:    ${cs ? cs.cycles_completed : '?'}`);
  console.log(`  last finished:  ${ago(cs && cs.last_crawl_finished_at)}`);
  console.log(`  islands tracked:${(tracked || 0).toLocaleString().padStart(10)}`);
  console.log(`  with live data: ${(withData || 0).toLocaleString().padStart(10)}`);
  console.log(`  newest reading: ${ago(newest && newest[0] && newest[0].captured_at)}`);
  console.log('');
  console.log('  recent cycles (newest first):');
  for (const r of cycles || []) {
    const dur = r.finished_at && r.started_at ? `${Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)}s` : '?';
    const tag = r.fatal ? 'FATAL' : `${r.error_count || 0} err`;
    console.log(`    ${(r.started_at || '').slice(0, 19)}  [${r.reason}]  polled ${r.metrics_polled ?? '-'}, wrote ${r.metrics_written ?? '-'}, +${r.new_islands_discovered ?? '-'} new, ${tag}  (${dur})`);
  }
  console.log('');
  if (inProgress) {
    console.log('  ▶  A cycle is running now. It logs a result when it finishes -');
    console.log('     re-run this in a bit to see the outcome.');
    console.log('');
  } else if (!lastFinishedOk && recent && recent.fatal) {
    console.log('  ⚠  Last recorded cycle failed. If you just changed code, restart the');
    console.log('     crawler (Ctrl+C the npm start terminal, then `npm start`).');
    console.log('');
  }
}

main().catch((err) => {
  console.error('crawler-status failed:', err.message);
  process.exit(1);
});
