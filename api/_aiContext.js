'use strict';

// Shared data-enrichment for the AI endpoints. The model quality is gated by
// context, not by the model - a plain "your D1 is 40%" is far weaker than "your
// 40% D1 is bottom-quartile for tycoon, where the median is 52%." This module
// turns a bare island row into a market-aware brief: all metrics, where the
// island ranks against its whole genre, and (when history exists) its trend.
//
// Everything is computed on the fly from Supabase - no schema changes, always
// fresh, and it deepens automatically as the crawler collects more history.

// The metrics we benchmark, with display metadata. `higher` = is a bigger
// number better (used to phrase percentiles as "top X%").
const METRICS = [
  { key: 'peak_ccu', label: 'Peak CCU', higher: true, kind: 'int' },
  { key: 'unique_players', label: 'Unique players', higher: true, kind: 'int' },
  { key: 'plays', label: 'Plays', higher: true, kind: 'int' },
  { key: 'minutes_played', label: 'Minutes played', higher: true, kind: 'int' },
  { key: 'average_minutes_per_player', label: 'Avg minutes/player', higher: true, kind: 'dec' },
  { key: 'favorites', label: 'Favorites', higher: true, kind: 'int' },
  { key: 'recommendations', label: 'Recommendations', higher: true, kind: 'int' },
  { key: 'retention_d1', label: 'Day-1 retention', higher: true, kind: 'pct' },
  { key: 'retention_d7', label: 'Day-7 retention', higher: true, kind: 'pct' },
];

function fmt(v, kind) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  if (kind === 'pct') return (v * 100).toFixed(0) + '%';
  if (kind === 'dec') return Number(v).toFixed(1);
  return Math.round(v).toLocaleString();
}

// Percentile rank of `value` within a sorted-ascending array (0-100). For a
// "higher is better" metric, a high percentile is good.
function percentileRank(sortedAsc, value) {
  if (value == null || !sortedAsc.length) return null;
  let below = 0;
  for (const v of sortedAsc) {
    if (v < value) below++;
    else break;
  }
  return Math.round((below / sortedAsc.length) * 100);
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] != null) return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
  return sortedAsc[base];
}

// Turn a percentile into plain-English standing for a higher-is-better metric.
function standing(pct) {
  if (pct == null) return 'n/a';
  if (pct >= 90) return `top ${100 - pct}%`;
  if (pct >= 75) return 'top quartile';
  if (pct >= 50) return 'above median';
  if (pct >= 25) return 'below median';
  return 'bottom quartile';
}

// Pull every island's latest metrics for a genre (tag) and compute, per metric,
// the median / p25 / p75 and this island's percentile + standing. `svc` is a
// Supabase service client. Returns null if the genre pool is too small to be
// meaningful.
//
// Benchmarks are computed against ACTIVE peers only. Most tags are dominated by
// long-dead/abandoned islands with ~0 engagement; including them makes the
// median ~0 and every real island look "top 0%", which is useless. We floor the
// pool to islands with real activity so the percentile actually informs the
// creator (data-honesty: compare against live competition, not the graveyard).
const ACTIVE_CCU_FLOOR = Number(process.env.BENCHMARK_ACTIVE_CCU_FLOOR) || 10;

async function computeGenreBenchmarks(svc, genre, island) {
  const cols = METRICS.map((m) => m.key).join(',');
  const { data, error } = await svc
    .from('islands_with_latest')
    .select(cols)
    .contains('tags', [genre])
    .gte('peak_ccu', ACTIVE_CCU_FLOOR)
    .limit(5000);
  if (error || !data || data.length < 8) return null; // too few active peers to benchmark

  const out = { genre, sampleSize: data.length, activeFloor: ACTIVE_CCU_FLOOR, metrics: {} };
  for (const m of METRICS) {
    const vals = data.map((r) => r[m.key]).filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
    if (vals.length < 8) continue;
    const mine = island[m.key];
    const pct = percentileRank(vals, mine);
    out.metrics[m.key] = {
      label: m.label,
      kind: m.kind,
      mine,
      median: quantile(vals, 0.5),
      p25: quantile(vals, 0.25),
      p75: quantile(vals, 0.75),
      percentile: pct,
      standing: m.higher ? standing(pct) : standing(pct == null ? null : 100 - pct),
    };
  }
  return out;
}

// Compact per-island metric line (used for the target and competitors).
function islandMetricsLine(row, { self = false } = {}) {
  const parts = METRICS.map((m) => `${m.label} ${fmt(row[m.key], m.kind)}`);
  const tag = self ? '  <- THE CREATOR\'S ISLAND' : '';
  return `${row.title || '(untitled)'} (${row.code})${tag}\n    ${parts.join(' | ')}`;
}

// Build the genre-benchmark section of the prompt: for each metric, the
// island's value, the genre median, and where it stands.
function benchmarkBlock(bench) {
  if (!bench) return 'Genre benchmarks: not enough active islands in this genre to benchmark yet.';
  const lines = [
    `Genre benchmarks — "${bench.genre}", vs ${bench.sampleSize.toLocaleString()} ACTIVE islands ` +
      `(peak CCU >= ${bench.activeFloor}; dead/abandoned islands excluded so percentiles are meaningful):`,
  ];
  for (const m of METRICS) {
    const b = bench.metrics[m.key];
    if (!b) continue;
    lines.push(
      `  ${b.label}: this island ${fmt(b.mine, b.kind)} | genre median ${fmt(b.median, b.kind)} ` +
        `(p25 ${fmt(b.p25, b.kind)}, p75 ${fmt(b.p75, b.kind)}) -> ${b.standing}` +
        (b.percentile != null ? ` (${b.percentile}th percentile)` : '')
    );
  }
  return lines.join('\n');
}

// History section: full trend when we have 2+ readings, honest note otherwise.
function historyBlock(history) {
  if (!history || history.length < 2) {
    return 'History: only one reading so far - trends will fill in as the crawler captures more over the coming days.';
  }
  const lines = [`History (${history.length} readings, oldest first):`];
  for (const h of history.slice(-21)) {
    lines.push(
      `  ${(h.captured_at || '').slice(0, 10)}: peakCCU ${fmt(h.peak_ccu, 'int')}, ` +
        `unique ${fmt(h.unique_players, 'int')}, plays ${fmt(h.plays, 'int')}, ` +
        `favorites ${fmt(h.favorites, 'int')}, D1 ${fmt(h.retention_d1, 'pct')}, D7 ${fmt(h.retention_d7, 'pct')}`
    );
  }
  // Explicit first->last deltas so the model doesn't have to do the arithmetic.
  const first = history[0];
  const last = history[history.length - 1];
  const deltas = METRICS.filter((m) => m.kind !== 'pct')
    .map((m) => {
      const a = first[m.key];
      const b = last[m.key];
      if (a == null || b == null || a === 0) return null;
      const pct = (((b - a) / a) * 100).toFixed(0);
      return `${m.label} ${pct >= 0 ? '+' : ''}${pct}%`;
    })
    .filter(Boolean);
  if (deltas.length) lines.push(`  Change over window (first->last): ${deltas.join(', ')}`);
  return lines.join('\n');
}

module.exports = {
  METRICS,
  fmt,
  computeGenreBenchmarks,
  islandMetricsLine,
  benchmarkBlock,
  historyBlock,
};
