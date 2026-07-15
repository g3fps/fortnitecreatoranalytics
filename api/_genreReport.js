'use strict';

// Builds a "state of the genre" report for a tag: the active-island leaders,
// the genre medians/distribution per metric, and (where 2+ readings exist) the
// biggest movers. Shared by the public genre pages and the AI genre summary.
//
// Cross-sectional today (leaders + medians work with one reading each); the
// movers section deepens automatically as the crawler accumulates history.

const { METRICS, fmt } = require('./_aiContext');

const ACTIVE_CCU_FLOOR = Number(process.env.BENCHMARK_ACTIVE_CCU_FLOOR) || 10;

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base + 1] != null) return sortedAsc[base] + rest * (sortedAsc[base + 1] - sortedAsc[base]);
  return sortedAsc[base];
}

// slugify a tag for URLs: "team deathmatch" -> "team-deathmatch"
function tagToSlug(tag) {
  return String(tag).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
// A slug can collide only if two tags differ solely by punctuation; resolve by
// scanning the known tag list for an exact slug match.
function slugToTag(slug, knownTags) {
  const s = String(slug).toLowerCase();
  return (knownTags || []).find((t) => tagToSlug(t) === s) || null;
}

// Main builder. Returns null if the genre has too few active islands to report.
async function buildGenreReport(svc, tag, { leaderLimit = 10 } = {}) {
  const cols = ['code', 'title', 'creator_code', ...METRICS.map((m) => m.key)].join(',');
  const { data, error } = await svc
    .from('islands_with_latest')
    .select(cols)
    .contains('tags', [tag])
    .gte('peak_ccu', ACTIVE_CCU_FLOOR)
    .order('peak_ccu', { ascending: false })
    .limit(2000);
  if (error || !data || data.length < 5) return null;

  const active = data;
  const leaders = active.slice(0, leaderLimit);

  // Per-metric distribution across active islands.
  const distribution = {};
  for (const m of METRICS) {
    const vals = active.map((r) => r[m.key]).filter((v) => v != null && !Number.isNaN(v)).sort((a, b) => a - b);
    if (!vals.length) continue;
    distribution[m.key] = {
      label: m.label,
      kind: m.kind,
      median: quantile(vals, 0.5),
      p75: quantile(vals, 0.75),
      p90: quantile(vals, 0.9),
      max: vals[vals.length - 1],
    };
  }

  // Movers: for the active leaders, compare latest vs prior snapshot if present.
  // Cheap enough to do for the top slice; skipped for islands with one reading.
  const movers = await computeMovers(svc, leaders.map((r) => r.code));

  return {
    tag,
    slug: tagToSlug(tag),
    activeCount: active.length,
    leaders,
    distribution,
    movers,
    generatedAt: new Date().toISOString(),
  };
}

// Pull the two most recent snapshots for each code and compute peak-CCU delta.
async function computeMovers(svc, codes) {
  if (!codes.length) return [];
  const { data } = await svc
    .from('islands_with_movement')
    .select('code,title,latest_peak_ccu,prior_peak_ccu')
    .in('code', codes);
  const out = [];
  for (const r of data || []) {
    if (r.prior_peak_ccu == null || r.latest_peak_ccu == null || r.prior_peak_ccu === 0) continue;
    const pct = ((r.latest_peak_ccu - r.prior_peak_ccu) / r.prior_peak_ccu) * 100;
    out.push({ code: r.code, title: r.title, latest: r.latest_peak_ccu, prior: r.prior_peak_ccu, pct: Math.round(pct) });
  }
  out.sort((a, b) => b.pct - a.pct);
  return out;
}

module.exports = { buildGenreReport, tagToSlug, slugToTag, quantile, fmt, ACTIVE_CCU_FLOOR };
