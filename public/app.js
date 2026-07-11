'use strict';

// Vanilla JS, no build step, no CDN dependency (charts are hand-rolled SVG,
// fonts are served locally from /fonts) so this page has no external
// failure modes.
//
// Security note: island titles/creator codes/tags are arbitrary strings
// supplied by Fortnite creators via Epic's API - untrusted input. Every
// place this file writes them into the DOM uses textContent (or element
// creation), never innerHTML.

const METRIC_LABELS = {
  peakCCU: 'Peak CCU',
  uniquePlayers: 'Unique Players',
  minutesPlayed: 'Minutes Played',
  averageMinutesPerPlayer: 'Avg Min / Player',
  plays: 'Plays',
  favorites: 'Favorites',
  recommendations: 'Recommendations',
  retentionD1: 'D1 Retention',
  retentionD7: 'D7 Retention',
};

const $ = (id) => document.getElementById(id);

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function fmtNumber(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number') return String(value);
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toFixed(2);
}

// retentionD1/D7 are fractions (0.6 = 60%) straight from Epic's API - shown
// through the generic fmtNumber() that reads as a bare, unlabeled "0.60".
// Render them as what they actually are: the % of players who came back.
const PERCENT_METRICS = new Set(['retentionD1', 'retentionD7']);

function fmtMetricValue(value, metricKey) {
  if (PERCENT_METRICS.has(metricKey)) {
    if (typeof value !== 'number') return '—';
    return `${(value * 100).toFixed(0)}%`;
  }
  return fmtNumber(value);
}

function fmtRelativeTime(isoString) {
  if (!isoString) return 'never';
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

function downloadCsv(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escapeCell = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(','), ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(','))];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// CSV export is a Pro feature. Non-Pro clicks open the upgrade modal instead
// of downloading. (can/openUpgradeModal are defined in the auth section
// below; this only runs on click, well after load.)
function gatedExport(filename, rows) {
  if (!can('csvExport')) {
    if (typeof currentUser !== 'undefined' && !currentUser) openAuthModal();
    else openUpgradeModal();
    return;
  }
  downloadCsv(filename, rows);
}

// ---------------------------------------------------------------- nav / views

const views = ['overview', 'leaderboard', 'movers', 'creators', 'compare', 'browse', 'explore', 'watchlist', 'data'];
const loaders = {
  overview: loadOverview,
  leaderboard: loadLeaderboard,
  movers: loadMovers,
  creators: loadCreators,
  compare: loadCompare,
  browse: loadBrowse,
  explore: () => {},
  watchlist: loadWatchlist,
  data: loadDataView,
};

function switchView(name, { updateHash = true } = {}) {
  if (!views.includes(name)) name = 'overview';
  for (const v of views) {
    $(`view-${v}`).classList.toggle('active', v === name);
  }
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  // Reflect the view in the URL hash so a given screen is linkable/shareable
  // and survives a refresh - important for a tool people are meant to send
  // each other ("look at this leaderboard").
  if (updateHash && `#${name}` !== window.location.hash) {
    history.replaceState(null, '', `#${name}`);
  }
  loaders[name]?.();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

window.addEventListener('hashchange', () => {
  const name = window.location.hash.replace(/^#/, '');
  if (views.includes(name)) switchView(name, { updateHash: false });
});

$('overview-see-all').addEventListener('click', () => switchView('leaderboard'));
$('overview-see-movers').addEventListener('click', () => switchView('movers'));
$('hero-lookup-cta').addEventListener('click', () => switchView('explore'));
$('hero-leaderboard-cta').addEventListener('click', () => switchView('leaderboard'));
document.querySelectorAll('.feature-card').forEach((card) => {
  card.addEventListener('click', () => switchView(card.dataset.go));
});

// ---------------------------------------------------------------- top bar status

// Cycles now run continuously and often take hours to cover the eligible
// backlog, so "stale/stalled" no longer means "hasn't run in a while" - it
// means "not currently in progress." The crawler is expected to always
// either be actively polling or in the ~2s gap between cycles.
async function refreshStatus() {
  try {
    const stats = await fetchJson('/api/stats');
    const dot = $('status-dot');
    const text = $('status-text');
    const progress = stats.crawlProgress || { inProgress: false, current: null };

    dot.classList.remove('stale', 'error', 'live');
    if (progress.inProgress && progress.current) {
      dot.classList.add('live');
      const polled = progress.current.metricsPolled || 0;
      const total = progress.current.totalCandidates;
      text.textContent = total
        ? `crawling — ${polled.toLocaleString()} / ${total.toLocaleString()} polled this cycle`
        : `crawling — discovering catalog…`;
    } else if (!stats.crawlState?.lastCrawlFinishedAt) {
      dot.classList.add('stale');
      text.textContent = 'starting first cycle…';
    } else {
      dot.classList.add('stale');
      text.textContent = `between cycles — last finished ${fmtRelativeTime(stats.crawlState.lastCrawlFinishedAt)}`;
    }
    return stats;
  } catch (err) {
    $('status-dot').classList.add('error');
    $('status-text').textContent = 'server unreachable';
    console.error('refreshStatus failed', err);
    return null;
  }
}

// ---------------------------------------------------------------- shared row rendering

function buildIslandCell(row) {
  const td = document.createElement('td');
  td.className = 'island';
  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = row.title || '(untitled)';
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = `${row.creatorCode || 'unknown'} · ${row.code}`;
  td.appendChild(title);
  td.appendChild(sub);
  return td;
}

function buildBarCell(value, max, variant, metricKey) {
  const td = document.createElement('td');
  td.className = 'value';
  const wrap = document.createElement('div');
  wrap.className = 'bar-cell';
  const num = document.createElement('span');
  num.className = 'bar-num';
  num.textContent = fmtMetricValue(value, metricKey);
  const track = document.createElement('div');
  track.className = 'bar-track';
  const fill = document.createElement('div');
  fill.className = variant === 'sonar' ? 'bar-fill sonar' : 'bar-fill';
  const pct = max > 0 && typeof value === 'number' ? Math.max(2, (value / max) * 100) : 0;
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  wrap.appendChild(num);
  wrap.appendChild(track);
  td.appendChild(wrap);
  return td;
}

function renderRankedTable(tbody, rows, metricKey, opts = {}) {
  clearChildren(tbody);
  const max = rows.reduce((m, r) => Math.max(m, r.latest?.[metricKey] ?? 0), 0);
  rows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => showDetail(row.code));

    if (opts.rank !== false) {
      const tdRank = document.createElement('td');
      tdRank.className = 'rank';
      tdRank.textContent = String(i + 1);
      tr.appendChild(tdRank);
    }
    tr.appendChild(buildIslandCell(row));
    tr.appendChild(buildBarCell(row.latest?.[metricKey], max, opts.variant, metricKey));
    tbody.appendChild(tr);
  });
}

function flattenRowsForCsv(rows, metricKey) {
  return rows.map((r) => ({
    code: r.code,
    title: r.title || '',
    creatorCode: r.creatorCode || '',
    [metricKey]: r.latest?.[metricKey] ?? '',
    capturedAt: r.latest?.capturedAt || '',
  }));
}

// ---------------------------------------------------------------- charts (hand-rolled SVG)

function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function emptyChartMessage(width, height, message) {
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
  const text = svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', fill: '#6b7099', 'font-size': 13 });
  text.textContent = message;
  svg.appendChild(text);
  return svg;
}

function buildGrowthChart(days) {
  const width = 900;
  const height = 200;
  const pad = 32;

  if (!days.length) return emptyChartMessage(width, height, 'No data yet — the first crawl cycle is still running.');

  let running = 0;
  const points = days.map((d) => {
    running += d.newSnapshots;
    return { date: d.date, cumulative: running };
  });

  if (points.length === 1) {
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
    svg.appendChild(svgEl('circle', { cx: width / 2, cy: height / 2, r: 4, fill: '#a855f7' }));
    const text = svgEl('text', { x: width / 2, y: height / 2 - 14, 'text-anchor': 'middle', fill: '#6b7099', 'font-size': 12 });
    text.textContent = `${points[0].cumulative} snapshots on ${points[0].date} — chart builds up as more days accumulate`;
    svg.appendChild(text);
    return svg;
  }

  const maxV = points[points.length - 1].cumulative;
  const scaleX = (i) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const scaleY = (v) => height - pad - (maxV > 0 ? (v / maxV) * (height - pad * 2) : 0);

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });

  for (let i = 0; i <= 3; i++) {
    const y = pad + (i / 3) * (height - pad * 2);
    svg.appendChild(svgEl('line', { x1: pad, x2: width - pad, y1: y, y2: y, stroke: '#2c2f52', 'stroke-width': 1 }));
  }

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(i).toFixed(1)} ${scaleY(p.cumulative).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${scaleX(points.length - 1).toFixed(1)} ${height - pad} L ${scaleX(0).toFixed(1)} ${height - pad} Z`;

  const gradId = 'growth-fill';
  const defs = svgEl('defs', {});
  const grad = svgEl('linearGradient', { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#a855f7', 'stop-opacity': 0.35 }));
  grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#a855f7', 'stop-opacity': 0.02 }));
  defs.appendChild(grad);
  svg.appendChild(defs);

  svg.appendChild(svgEl('path', { d: areaPath, fill: `url(#${gradId})`, stroke: 'none' }));
  svg.appendChild(svgEl('path', { d: linePath, fill: 'none', stroke: '#a855f7', 'stroke-width': 2.5 }));

  const last = points[points.length - 1];
  svg.appendChild(svgEl('circle', { cx: scaleX(points.length - 1), cy: scaleY(last.cumulative), r: 4, fill: '#2dd4ff' }));

  const t0 = svgEl('text', { x: pad, y: height - 8, 'font-size': 10.5, fill: '#6b7099' });
  t0.textContent = points[0].date;
  const t1 = svgEl('text', { x: width - pad, y: height - 8, 'text-anchor': 'end', 'font-size': 10.5, fill: '#6b7099' });
  t1.textContent = points[points.length - 1].date;
  svg.appendChild(t0);
  svg.appendChild(t1);

  return svg;
}

function buildSparkline(snapshots, metricKey) {
  const width = 400;
  const height = 130;
  const pad = 20;

  const points = snapshots
    .map((s) => ({ t: new Date(s.capturedAt).getTime(), v: s[metricKey] }))
    .filter((p) => typeof p.v === 'number' && Number.isFinite(p.t));

  if (points.length === 0) return emptyChartMessage(width, height, 'No data for this metric yet.');

  if (points.length === 1) {
    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
    svg.appendChild(svgEl('circle', { cx: width / 2, cy: height / 2, r: 4, fill: '#a855f7' }));
    const text = svgEl('text', { x: width / 2, y: height / 2 - 14, 'text-anchor': 'middle', fill: '#6b7099', 'font-size': 11 });
    text.textContent = `${fmtNumber(points[0].v)} — only 1 reading so far`;
    svg.appendChild(text);
    return svg;
  }

  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const minV = Math.min(...points.map((p) => p.v));
  const maxV = Math.max(...points.map((p) => p.v));
  const scaleX = (t) => (maxT === minT ? pad : pad + ((t - minT) / (maxT - minT)) * (width - pad * 2));
  const scaleY = (v) => (maxV === minV ? height / 2 : height - pad - ((v - minV) / (maxV - minV)) * (height - pad * 2));

  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height });
  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.t).toFixed(1)} ${scaleY(p.v).toFixed(1)}`).join(' ');
  svg.appendChild(svgEl('path', { d: pathD, fill: 'none', stroke: '#a855f7', 'stroke-width': 2.5 }));
  for (const p of points) {
    svg.appendChild(svgEl('circle', { cx: scaleX(p.t).toFixed(1), cy: scaleY(p.v).toFixed(1), r: 3, fill: '#2dd4ff' }));
  }
  return svg;
}

// ---------------------------------------------------------------- overview

async function loadOverview() {
  try {
    const [stats, board, movers] = await Promise.all([
      fetchJson('/api/stats'),
      fetchJson('/api/leaderboard?metric=peakCCU&limit=8'),
      fetchJson('/api/movers?metric=peakCCU&direction=up&limit=8'),
    ]);

    $('kpi-islands').textContent = stats.islandsTracked.toLocaleString();
    $('kpi-active').textContent = stats.islandsWithData.toLocaleString();
    $('kpi-snapshots').textContent = stats.snapshotCount.toLocaleString();

    const last = stats.crawlState?.lastCrawlFinishedAt;
    $('kpi-lastupdate').textContent = last ? fmtRelativeTime(last) : '—';
    $('overview-updated').textContent = last ? `Stats last updated ${fmtRelativeTime(last)}` : '';

    renderRankedTable($('overview-board-body'), board.rows, 'peakCCU');
    renderOverviewMovers(movers.rows || []);
  } catch (err) {
    console.error('loadOverview failed', err);
  }
}

// Compact gainers table for the homepage (island · current CCU · +delta).
function renderOverviewMovers(rows) {
  const tbody = $('overview-movers-body');
  clearChildren(tbody);
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 3;
    td.className = 'empty-state';
    td.style.padding = '18px';
    td.textContent = 'Not enough history yet — gainers appear once islands have 2+ readings.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', () => showDetail(row.code));
    tr.appendChild(buildIslandCell(row));

    const tdCcu = document.createElement('td');
    tdCcu.className = 'mono-cell';
    tdCcu.textContent = fmtNumber(row.latest?.peakCCU);
    tr.appendChild(tdCcu);

    const tdDelta = document.createElement('td');
    const span = document.createElement('span');
    span.className = row.delta >= 0 ? 'delta-up' : 'delta-down';
    span.textContent = `${row.delta > 0 ? '+' : ''}${fmtNumber(row.delta)}`;
    tdDelta.appendChild(span);
    tr.appendChild(tdDelta);

    tbody.appendChild(tr);
  }
}

// ---------------------------------------------------------------- leaderboard

let currentMetric = 'peakCCU';
let lastLeaderboardRows = [];
const leaderboardFilters = { tag: '', creatorCode: '' };

document.querySelectorAll('#metric-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentMetric = btn.dataset.metric;
    document.querySelectorAll('#metric-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $('leaderboard-value-head').textContent = METRIC_LABELS[currentMetric];
    loadLeaderboard();
  });
});

function leaderboardFilterQuery() {
  const params = new URLSearchParams({ metric: currentMetric, limit: '40' });
  if (leaderboardFilters.tag) params.set('tag', leaderboardFilters.tag);
  if (leaderboardFilters.creatorCode) params.set('creatorCode', leaderboardFilters.creatorCode);
  return params.toString();
}

function refreshLeaderboardFilterUi() {
  const active = Boolean(leaderboardFilters.tag || leaderboardFilters.creatorCode);
  $('leaderboard-clear-filters').style.display = active ? '' : 'none';
}

$('leaderboard-tag-filter').addEventListener('change', (e) => {
  leaderboardFilters.tag = e.target.value;
  refreshLeaderboardFilterUi();
  loadLeaderboard();
});
let leaderboardCreatorDebounce = null;
$('leaderboard-creator-filter').addEventListener('input', (e) => {
  clearTimeout(leaderboardCreatorDebounce);
  leaderboardCreatorDebounce = setTimeout(() => {
    leaderboardFilters.creatorCode = e.target.value.trim();
    refreshLeaderboardFilterUi();
    loadLeaderboard();
  }, 300);
});
$('leaderboard-clear-filters').addEventListener('click', () => {
  leaderboardFilters.tag = '';
  leaderboardFilters.creatorCode = '';
  $('leaderboard-tag-filter').value = '';
  $('leaderboard-creator-filter').value = '';
  refreshLeaderboardFilterUi();
  loadLeaderboard();
});

async function loadLeaderboard() {
  try {
    const data = await fetchJson(`/api/leaderboard?${leaderboardFilterQuery()}`);
    lastLeaderboardRows = data.rows;
    $('leaderboard-count').textContent = `${data.rows.length} ranked island${data.rows.length === 1 ? '' : 's'}`;
    const empty = $('leaderboard-empty');
    const filtered = Boolean(leaderboardFilters.tag || leaderboardFilters.creatorCode);
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = filtered
        ? 'No islands with live data match these filters — try a different tag or creator.'
        : 'No islands have live data for this metric yet — coverage grows every crawl cycle.';
    } else {
      empty.style.display = 'none';
    }
    renderRankedTable($('leaderboard-body'), data.rows, currentMetric, { variant: 'sonar' });
  } catch (err) {
    console.error('loadLeaderboard failed', err);
  }
}

$('leaderboard-export').addEventListener('click', () => {
  gatedExport(`leaderboard-${currentMetric}.csv`, flattenRowsForCsv(lastLeaderboardRows, currentMetric));
});

// ---------------------------------------------------------------- movers

let moversMetric = 'peakCCU';
let moversDirection = 'up';
let lastMoversRows = [];
const moversFilters = { tag: '', creatorCode: '' };

document.querySelectorAll('#movers-metric-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    moversMetric = btn.dataset.metric;
    document.querySelectorAll('#movers-metric-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    loadMovers();
  });
});

document.querySelectorAll('#movers-direction-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    moversDirection = btn.dataset.direction;
    document.querySelectorAll('#movers-direction-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    loadMovers();
  });
});

function moversFilterQuery() {
  const params = new URLSearchParams({ metric: moversMetric, direction: moversDirection, limit: '30' });
  if (moversFilters.tag) params.set('tag', moversFilters.tag);
  if (moversFilters.creatorCode) params.set('creatorCode', moversFilters.creatorCode);
  return params.toString();
}

function refreshMoversFilterUi() {
  const active = Boolean(moversFilters.tag || moversFilters.creatorCode);
  $('movers-clear-filters').style.display = active ? '' : 'none';
}

$('movers-tag-filter').addEventListener('change', (e) => {
  moversFilters.tag = e.target.value;
  refreshMoversFilterUi();
  loadMovers();
});
let moversCreatorDebounce = null;
$('movers-creator-filter').addEventListener('input', (e) => {
  clearTimeout(moversCreatorDebounce);
  moversCreatorDebounce = setTimeout(() => {
    moversFilters.creatorCode = e.target.value.trim();
    refreshMoversFilterUi();
    loadMovers();
  }, 300);
});
$('movers-clear-filters').addEventListener('click', () => {
  moversFilters.tag = '';
  moversFilters.creatorCode = '';
  $('movers-tag-filter').value = '';
  $('movers-creator-filter').value = '';
  refreshMoversFilterUi();
  loadMovers();
});

async function loadMovers() {
  try {
    const data = await fetchJson(`/api/movers?${moversFilterQuery()}`);
    lastMoversRows = data.rows;
    $('movers-count').textContent = `${data.rows.length} island${data.rows.length === 1 ? '' : 's'} with 2+ readings`;

    const tbody = $('movers-body');
    clearChildren(tbody);
    const empty = $('movers-empty');
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = moversFilters.tag || moversFilters.creatorCode
        ? 'No islands with 2+ readings match these filters — try a different tag or creator.'
        : 'No islands have 2 captured readings yet for this metric — check back after the next crawl cycle.';
      return;
    }
    empty.style.display = 'none';

    data.rows.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', () => showDetail(row.code));

      const tdRank = document.createElement('td');
      tdRank.className = 'rank';
      tdRank.textContent = String(i + 1);
      tr.appendChild(tdRank);

      tr.appendChild(buildIslandCell(row));

      const tdChange = document.createElement('td');
      tdChange.className = 'mono-cell';
      tdChange.textContent = `${fmtMetricValue(row.previous[moversMetric], moversMetric)} → ${fmtMetricValue(row.latest[moversMetric], moversMetric)}`;
      tr.appendChild(tdChange);

      const tdDelta = document.createElement('td');
      const sign = row.delta > 0 ? '+' : '';
      const deltaSpan = document.createElement('span');
      deltaSpan.className = row.delta >= 0 ? 'delta-up' : 'delta-down';
      // For retention, row.delta is a fraction-point difference (0.04 = 4
      // percentage points) - "pp" flags that explicitly so it's never read
      // as the same kind of number as the relative-% badge next to it.
      deltaSpan.textContent = PERCENT_METRICS.has(moversMetric)
        ? `${sign}${(row.delta * 100).toFixed(0)}pp`
        : `${sign}${fmtNumber(row.delta)}`;
      tdDelta.appendChild(deltaSpan);
      if (row.percentChange !== null) {
        const pctSpan = document.createElement('span');
        pctSpan.className = 'delta-pct';
        pctSpan.textContent = `(${row.percentChange > 0 ? '+' : ''}${row.percentChange.toFixed(0)}%)`;
        tdDelta.appendChild(pctSpan);
      }
      tr.appendChild(tdDelta);

      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('loadMovers failed', err);
  }
}

// ---------------------------------------------------------------- creators

async function loadCreators() {
  try {
    const data = await fetchJson('/api/creators?limit=40');
    const silent = data.totalCreators - data.creatorsWithData;
    $('creators-count').textContent =
      `${data.creatorsWithData} of ${data.totalCreators} creators have measurable traffic` +
      (silent > 0 ? ` (${silent} tracked with none yet)` : '');

    const tbody = $('creators-body');
    clearChildren(tbody);
    const empty = $('creators-empty');
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = 'No creators have measured islands yet.';
      return;
    }
    empty.style.display = 'none';

    data.rows.forEach((c, i) => {
      const tr = document.createElement('tr');

      const tdRank = document.createElement('td');
      tdRank.className = 'rank';
      tdRank.textContent = String(i + 1);
      tr.appendChild(tdRank);

      const tdName = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'creator-link';
      link.textContent = c.creatorCode;
      link.addEventListener('click', () => {
        switchView('browse');
        applyCreatorFilter(c.creatorCode);
      });
      tdName.appendChild(link);
      tr.appendChild(tdName);

      const tdCount = document.createElement('td');
      tdCount.className = 'mono-cell';
      tdCount.textContent = `${c.islandsWithData} / ${c.islandCount}`;
      tr.appendChild(tdCount);

      const tdBest = document.createElement('td');
      if (c.bestIsland) {
        tdBest.textContent = c.bestIsland.title || c.bestIsland.code;
      } else {
        tdBest.textContent = '—';
      }
      tr.appendChild(tdBest);

      const tdTotal = document.createElement('td');
      tdTotal.className = 'mono-cell';
      tdTotal.textContent = fmtNumber(c.totalPeakCCU);
      tr.appendChild(tdTotal);

      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('loadCreators failed', err);
  }
}

// ---------------------------------------------------------------- compare

const COMPARE_MAX = 3;
const COMPARE_METRICS = [
  'peakCCU',
  'uniquePlayers',
  'minutesPlayed',
  'averageMinutesPerPlayer',
  'plays',
  'favorites',
  'recommendations',
  'retentionD1',
  'retentionD7',
];
let compareCodes = [];
let compareSearchDebounce = null;

$('compare-search-input').addEventListener('input', (e) => {
  clearTimeout(compareSearchDebounce);
  const q = e.target.value.trim();
  const resultsBox = $('compare-search-results');
  if (!q) {
    clearChildren(resultsBox);
    return;
  }
  compareSearchDebounce = setTimeout(async () => {
    try {
      const rows = await fetchJson(`/api/islands?search=${encodeURIComponent(q)}&limit=8`);
      clearChildren(resultsBox);
      for (const row of rows) {
        const alreadyAdded = compareCodes.includes(row.code);
        const atMax = compareCodes.length >= COMPARE_MAX;
        const item = document.createElement('div');
        item.className = 'compare-result-item' + (alreadyAdded || atMax ? ' disabled' : '');

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = row.title || '(untitled)';
        const code = document.createElement('span');
        code.className = 'code';
        code.textContent = row.code;
        name.appendChild(code);

        const hint = document.createElement('span');
        hint.className = 'add-hint';
        hint.textContent = alreadyAdded ? 'already added' : atMax ? `max ${COMPARE_MAX} reached` : '+ add';

        item.appendChild(name);
        item.appendChild(hint);
        if (!alreadyAdded && !atMax) {
          item.addEventListener('click', () => addToCompare(row.code));
        }
        resultsBox.appendChild(item);
      }
    } catch (err) {
      console.error('compare search failed', err);
    }
  }, 250);
});

async function addToCompare(code) {
  if (compareCodes.includes(code) || compareCodes.length >= COMPARE_MAX) return;
  compareCodes.push(code);
  $('compare-search-input').value = '';
  clearChildren($('compare-search-results'));
  await renderCompare();
}

function removeFromCompare(code) {
  compareCodes = compareCodes.filter((c) => c !== code);
  renderCompare();
}

$('compare-clear').addEventListener('click', () => {
  compareCodes = [];
  renderCompare();
});

function buildCompareRow(label, cells) {
  const tr = document.createElement('tr');
  const labelTd = document.createElement('td');
  labelTd.className = 'compare-row-label';
  labelTd.textContent = label;
  tr.appendChild(labelTd);
  cells.forEach((cell) => tr.appendChild(cell));
  return tr;
}

// Compare is a Pro feature. Non-Pro users see an upgrade gate instead of the
// tool; the gate is enforced here (view load) and the search/render below
// are simply never reached for them.
function loadCompare() {
  const gate = $('compare-gate');
  const search = $('compare-search-section');
  const panel = $('compare-panel');
  const empty = $('compare-empty');
  if (!can('compare')) {
    gate.style.display = 'block';
    search.style.display = 'none';
    panel.style.display = 'none';
    empty.style.display = 'none';
    renderUpgradeGate(gate, {
      title: 'Compare is a Pro feature',
      body: 'Put any islands head-to-head — your maps against your rivals, metric by metric. Upgrade to Pro to unlock side-by-side comparison.',
    });
    return;
  }
  gate.style.display = 'none';
  search.style.display = '';
  renderCompare();
}

// Reusable "this is Pro" panel with an upgrade button. Used by every gated
// surface so the upsell is consistent.
function renderUpgradeGate(container, { title, body }) {
  clearChildren(container);
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'panel-sub';
  p.textContent = body;
  const btn = document.createElement('button');
  btn.className = 'tab-btn active';
  btn.textContent = currentUser ? 'Upgrade to Pro' : 'Sign in to upgrade';
  btn.addEventListener('click', () => {
    if (!currentUser) {
      openAuthModal();
    } else {
      openUpgradeModal();
    }
  });
  container.appendChild(h);
  container.appendChild(p);
  container.appendChild(btn);
}

async function renderCompare() {
  const panel = $('compare-panel');
  const empty = $('compare-empty');

  if (compareCodes.length < 2) {
    panel.style.display = 'none';
    empty.style.display = 'block';
    empty.textContent = compareCodes.length === 1
      ? 'Add one more island to see a comparison.'
      : 'Search above and add at least 2 islands to compare.';
    return;
  }

  let islands;
  try {
    islands = await Promise.all(compareCodes.map((code) => fetchJson(`/api/islands/${encodeURIComponent(code)}`)));
  } catch (err) {
    console.error('renderCompare failed', err);
    empty.style.display = 'block';
    empty.textContent = 'Failed to load one or more islands — try again.';
    panel.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  panel.style.display = 'block';

  const head = $('compare-head');
  clearChildren(head);
  const metricTh = document.createElement('th');
  metricTh.textContent = 'Metric';
  head.appendChild(metricTh);
  islands.forEach((isl) => {
    const th = document.createElement('th');
    const titleDiv = document.createElement('div');
    titleDiv.className = 'compare-col-title';
    titleDiv.textContent = isl.title || '(untitled)';
    const codeDiv = document.createElement('div');
    codeDiv.className = 'compare-col-code';
    codeDiv.textContent = isl.code;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-ghost';
    removeBtn.style.fontSize = '10.5px';
    removeBtn.style.padding = '3px 8px';
    removeBtn.textContent = '✕ Remove';
    removeBtn.addEventListener('click', () => removeFromCompare(isl.code));
    th.appendChild(titleDiv);
    th.appendChild(codeDiv);
    th.appendChild(removeBtn);
    head.appendChild(th);
  });

  const body = $('compare-body');
  clearChildren(body);

  const creatorCells = islands.map((isl) => {
    const td = document.createElement('td');
    td.textContent = isl.creatorCode || '—';
    return td;
  });
  body.appendChild(buildCompareRow('Creator', creatorCells));

  const discoveredCells = islands.map((isl) => {
    const td = document.createElement('td');
    td.className = 'mono-cell';
    td.textContent = fmtRelativeTime(isl.firstSeenAt);
    return td;
  });
  body.appendChild(buildCompareRow('First seen', discoveredCells));

  for (const metric of COMPARE_METRICS) {
    const values = islands.map((isl) => (isl.latest ? isl.latest[metric] : null));
    const numericValues = values.filter((v) => typeof v === 'number');
    // Only mark a winner when there's an actual difference to show - with
    // one island, or several tied, "highlighting" one is just noise.
    const hasSpread = numericValues.length > 1 && numericValues.some((v) => v !== numericValues[0]);
    const max = hasSpread ? Math.max(...numericValues) : null;

    const cells = values.map((v) => {
      const td = document.createElement('td');
      td.className = 'mono-cell';
      td.textContent = fmtMetricValue(v, metric);
      if (max !== null && v === max) td.classList.add('compare-winner');
      return td;
    });
    body.appendChild(buildCompareRow(METRIC_LABELS[metric], cells));
  }

  const tagsCells = islands.map((isl) => {
    const td = document.createElement('td');
    td.textContent = (isl.tags || []).join(', ') || '—';
    return td;
  });
  body.appendChild(buildCompareRow('Tags', tagsCells));
}

// ---------------------------------------------------------------- browse

const browseState = { tag: null, creatorCode: null, hasData: '', showEmpty: false, sort: 'peakCCU', dir: 'desc', page: 1, pageSize: 40 };
let lastBrowseRows = [];

let allTags = [];

function populateTagSelect(select) {
  clearChildren(select);
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All genres/tags';
  select.appendChild(allOpt);
  for (const t of allTags) {
    const opt = document.createElement('option');
    opt.value = t.tag;
    opt.textContent = `${t.tag} (${t.count.toLocaleString()})`;
    select.appendChild(opt);
  }
}

async function loadTagCloud() {
  try {
    const data = await fetchJson('/api/tags?limit=24');
    allTags = data.tags;
    populateTagSelect($('leaderboard-tag-filter'));
    populateTagSelect($('movers-tag-filter'));
    const cloud = $('tag-cloud');
    clearChildren(cloud);
    for (const t of data.tags) {
      const btn = document.createElement('button');
      btn.className = 'tag-chip-btn';
      btn.classList.toggle('active', browseState.tag === t.tag);
      const label = document.createElement('span');
      label.textContent = t.tag;
      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = t.count.toLocaleString();
      btn.appendChild(label);
      btn.appendChild(count);
      btn.addEventListener('click', () => {
        browseState.tag = browseState.tag === t.tag ? null : t.tag;
        browseState.page = 1;
        loadBrowse();
        renderActiveFilters();
        document.querySelectorAll('.tag-chip-btn').forEach((b) => b.classList.toggle('active', b === btn && browseState.tag === t.tag));
      });
      cloud.appendChild(btn);
    }
  } catch (err) {
    console.error('loadTagCloud failed', err);
  }
}

function applyCreatorFilter(creatorCode) {
  browseState.creatorCode = creatorCode;
  browseState.page = 1;
  renderActiveFilters();
  loadBrowse();
}

function renderActiveFilters() {
  const row = $('browse-active-filters');
  clearChildren(row);
  if (browseState.tag) {
    const chip = document.createElement('span');
    chip.className = 'chip-active';
    chip.append(`tag: ${browseState.tag}`);
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      browseState.tag = null;
      browseState.page = 1;
      renderActiveFilters();
      loadBrowse();
      loadTagCloud();
    });
    chip.appendChild(btn);
    row.appendChild(chip);
  }
  if (browseState.creatorCode) {
    const chip = document.createElement('span');
    chip.className = 'chip-active';
    chip.append(`creator: ${browseState.creatorCode}`);
    const btn = document.createElement('button');
    btn.textContent = '×';
    btn.addEventListener('click', () => {
      browseState.creatorCode = null;
      browseState.page = 1;
      renderActiveFilters();
      loadBrowse();
    });
    chip.appendChild(btn);
    row.appendChild(chip);
  }
}

// Reflect the JS defaults in the actual select elements on load (the HTML
// lists options in a fixed order; the browseState defaults are the source of
// truth).
$('browse-sort').value = browseState.sort;
$('browse-dir').value = browseState.dir;
$('browse-show-empty').checked = browseState.showEmpty;

$('browse-hasdata').addEventListener('change', (e) => {
  browseState.hasData = e.target.value;
  browseState.page = 1;
  loadBrowse();
});
$('browse-sort').addEventListener('change', (e) => {
  browseState.sort = e.target.value;
  browseState.page = 1;
  loadBrowse();
});
$('browse-dir').addEventListener('change', (e) => {
  browseState.dir = e.target.value;
  loadBrowse();
});
$('browse-show-empty').addEventListener('change', (e) => {
  browseState.showEmpty = e.target.checked;
  browseState.page = 1;
  loadBrowse();
});
$('browse-prev').addEventListener('click', () => {
  if (browseState.page > 1) {
    browseState.page--;
    loadBrowse();
  }
});
$('browse-next').addEventListener('click', () => {
  browseState.page++;
  loadBrowse();
});
$('browse-export').addEventListener('click', () => {
  gatedExport('browse-page.csv', lastBrowseRows.map((r) => ({
    code: r.code,
    title: r.title || '',
    creatorCode: r.creatorCode || '',
    peakCCU: r.latest?.peakCCU ?? '',
    uniquePlayers: r.latest?.uniquePlayers ?? '',
    firstSeenAt: r.firstSeenAt || '',
  })));
});

// When Browse is filtered to a single creator, show their portfolio at a
// glance - the aggregate reach number an agency actually cares about, which
// no single-island row conveys. Totals are summed over the creator's
// islands that have live data (the leaderboard endpoint filtered to them,
// which returns up to 200 - plenty for any real creator).
async function renderCreatorSummary() {
  const box = $('browse-creator-summary');
  if (!browseState.creatorCode) {
    box.style.display = 'none';
    return;
  }
  try {
    const data = await fetchJson(`/api/leaderboard?metric=peakCCU&creatorCode=${encodeURIComponent(browseState.creatorCode)}&limit=200`);
    const rows = data.rows || [];
    const totalPeak = rows.reduce((s, r) => s + (r.latest?.peakCCU ?? 0), 0);
    const totalUnique = rows.reduce((s, r) => s + (r.latest?.uniquePlayers ?? 0), 0);
    const best = rows[0];

    clearChildren(box);
    box.style.display = 'block';

    const h = document.createElement('h2');
    h.textContent = browseState.creatorCode;
    box.appendChild(h);

    const sub = document.createElement('p');
    sub.className = 'panel-sub';
    sub.textContent = rows.length
      ? `${rows.length} island${rows.length === 1 ? '' : 's'} with live data · combined ${fmtNumber(totalPeak)} peak CCU · ${fmtNumber(totalUnique)} unique players${best ? ` · top island: ${best.title || best.code}` : ''}`
      : 'No islands from this creator have live data captured yet.';
    box.appendChild(sub);
  } catch (err) {
    console.error('renderCreatorSummary failed', err);
    box.style.display = 'none';
  }
}

async function loadBrowse() {
  try {
    const params = new URLSearchParams({
      sort: browseState.sort,
      dir: browseState.dir,
      page: String(browseState.page),
      pageSize: String(browseState.pageSize),
    });
    if (browseState.tag) params.set('tag', browseState.tag);
    if (browseState.creatorCode) params.set('creatorCode', browseState.creatorCode);
    if (browseState.hasData) params.set('hasData', browseState.hasData);
    // API hides unnamed/inactive by default; only send the override when the
    // user has ticked "show" them.
    if (browseState.showEmpty) params.set('hideEmpty', 'false');

    const data = await fetchJson(`/api/browse?${params.toString()}`);
    lastBrowseRows = data.rows;
    browseState.page = data.page;

    await renderCreatorSummary();

    $('browse-total').textContent = `${data.total.toLocaleString()} island${data.total === 1 ? '' : 's'} matching filters`;
    $('nav-browse-count').textContent = '';
    $('browse-page-label').textContent = `Page ${data.page} of ${data.totalPages}`;
    $('browse-prev').disabled = data.page <= 1;
    $('browse-next').disabled = data.page >= data.totalPages;

    const tbody = $('browse-body');
    clearChildren(tbody);
    const empty = $('browse-empty');
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = 'No islands match the current filters.';
    } else {
      empty.style.display = 'none';
    }

    for (const row of data.rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', () => showDetail(row.code));
      tr.appendChild(buildIslandCell(row));

      const tdCcu = document.createElement('td');
      tdCcu.className = 'mono-cell';
      tdCcu.textContent = fmtNumber(row.latest?.peakCCU);
      tr.appendChild(tdCcu);

      const tdUp = document.createElement('td');
      tdUp.className = 'mono-cell';
      tdUp.textContent = fmtNumber(row.latest?.uniquePlayers);
      tr.appendChild(tdUp);

      const tdSeen = document.createElement('td');
      tdSeen.className = 'mono-cell';
      tdSeen.textContent = fmtRelativeTime(row.firstSeenAt);
      tr.appendChild(tdSeen);

      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error('loadBrowse failed', err);
  }
}

// ---------------------------------------------------------------- own-map lookup

async function runLookup() {
  const input = $('lookup-input');
  const code = input.value.trim();
  const resultBox = $('lookup-result');
  clearChildren(resultBox);

  if (!code) {
    resultBox.textContent = 'Enter an island code first.';
    return;
  }

  const btn = $('lookup-btn');
  btn.disabled = true;
  btn.textContent = 'Looking up…';

  try {
    const res = await fetch(`/api/lookup/${encodeURIComponent(code)}`);
    const body = await res.json();

    if (!res.ok) {
      resultBox.textContent = body.error || `Lookup failed (HTTP ${res.status}).`;
      return;
    }

    const card = document.createElement('div');
    card.className = 'panel';
    card.style.margin = '0';
    card.style.background = 'var(--panel-raised)';

    const title = document.createElement('h2');
    title.textContent = body.title || '(untitled)';
    card.appendChild(title);

    const meta = document.createElement('p');
    meta.className = 'panel-sub';
    meta.textContent = [
      body.code,
      body.creatorCode ? `by ${body.creatorCode}` : null,
      body.hasLiveData ? '✓ live data found and added to tracking' : 'no live traffic in the current reading (island exists, but shows no active players right now)',
    ].filter(Boolean).join(' · ');
    card.appendChild(meta);

    if (body.latest) {
      const grid = document.createElement('div');
      grid.className = 'metric-grid';
      grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(120px, 1fr))';
      for (const key of ['peakCCU', 'uniquePlayers', 'minutesPlayed', 'plays', 'favorites', 'recommendations', 'retentionD1', 'retentionD7']) {
        const tile = document.createElement('div');
        tile.className = 'metric-tile';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = METRIC_LABELS[key];
        const value = document.createElement('div');
        value.className = 'value';
        value.textContent = fmtMetricValue(body.latest[key], key);
        tile.appendChild(label);
        tile.appendChild(value);
        grid.appendChild(tile);
      }
      card.appendChild(grid);
    }

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-ghost';
    openBtn.textContent = 'Open full detail →';
    openBtn.addEventListener('click', () => showDetail(body.code));
    card.appendChild(openBtn);

    resultBox.appendChild(card);
  } catch (err) {
    resultBox.textContent = 'Lookup failed — is the server running?';
    console.error('runLookup failed', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Look Up';
  }
}

$('lookup-btn').addEventListener('click', runLookup);
$('lookup-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runLookup();
});

// ---------------------------------------------------------------- explore

let searchDebounce = null;

$('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = $('search-input').value.trim();
  searchDebounce = setTimeout(() => runSearch(q), 250);
});

async function runSearch(query) {
  const panel = $('explore-results-panel');
  if (!query) {
    panel.style.display = 'none';
    return;
  }
  try {
    const rows = await fetchJson(`/api/islands?search=${encodeURIComponent(query)}&limit=40`);
    panel.style.display = 'block';
    const tbody = $('explore-body');
    clearChildren(tbody);
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'empty-state';
      td.textContent = `No islands matching "${query}" in the local index yet.`;
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.addEventListener('click', () => showDetail(row.code));
      tr.appendChild(buildIslandCell(row));
      const tdCcu = document.createElement('td');
      tdCcu.className = 'mono-cell';
      tdCcu.textContent = fmtNumber(row.latest?.peakCCU);
      const tdUp = document.createElement('td');
      tdUp.className = 'mono-cell';
      tdUp.textContent = fmtNumber(row.latest?.uniquePlayers);
      tr.appendChild(tdCcu);
      tr.appendChild(tdUp);
      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error('runSearch failed', err);
  }
}

// ---------------------------------------------------------------- about the data

async function loadDataView() {
  try {
    const stats = await fetchJson('/api/stats');
    $('data-tracked').textContent = fmtNumber(stats.islandsTracked);
    $('data-withdata').textContent = fmtNumber(stats.islandsWithData);
    $('data-snapshots').textContent = fmtNumber(stats.snapshotCount);
    const last = stats.crawlState?.lastCrawlFinishedAt;
    $('data-lastupdate').textContent = last ? fmtRelativeTime(last) : '—';
    $('data-updated').textContent = last ? `stats last refreshed ${fmtRelativeTime(last)}` : '';
  } catch (err) {
    console.error('loadDataView failed', err);
  }
}

// ---------------------------------------------------------------- detail drawer

const drawer = $('drawer');
const drawerBackdrop = $('drawer-backdrop');

function openDrawer() {
  drawer.classList.add('open');
  drawerBackdrop.classList.add('open');
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawerBackdrop.classList.remove('open');
}
$('drawer-close').addEventListener('click', closeDrawer);
drawerBackdrop.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

async function showDetail(code) {
  try {
    const [island, historyResp] = await Promise.all([
      fetchJson(`/api/islands/${encodeURIComponent(code)}`),
      fetchJson(`/api/islands/${encodeURIComponent(code)}/history`),
    ]);

    $('drawer-title').textContent = island.title || '(untitled)';
    $('drawer-meta').textContent = [
      island.code,
      island.creatorCode ? `by ${island.creatorCode}` : null,
      island.createdIn,
      `first seen ${fmtRelativeTime(island.firstSeenAt)}`,
      `${island.snapshotCount} snapshot${island.snapshotCount === 1 ? '' : 's'} captured`,
    ].filter(Boolean).join(' · ');

    const tagRow = $('drawer-tags');
    clearChildren(tagRow);
    for (const tag of island.tags || []) {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.textContent = tag;
      tagRow.appendChild(chip);
    }

    const grid = $('drawer-metrics');
    clearChildren(grid);
    const latest = island.latest || {};
    if (!island.latest) {
      const note = document.createElement('div');
      note.className = 'empty-state';
      note.style.gridColumn = '1 / -1';
      note.style.padding = '14px';
      note.textContent = 'No live reading yet — this island has been discovered but not polled, or showed no active players when last checked.';
      grid.appendChild(note);
    } else {
      for (const key of ['peakCCU', 'uniquePlayers', 'minutesPlayed', 'averageMinutesPerPlayer', 'plays', 'favorites', 'recommendations', 'retentionD1', 'retentionD7']) {
        const tile = document.createElement('div');
        tile.className = 'metric-tile';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = METRIC_LABELS[key];
        const value = document.createElement('div');
        value.className = 'value';
        value.textContent = fmtMetricValue(latest[key], key);
        tile.appendChild(label);
        tile.appendChild(value);
        grid.appendChild(tile);
      }
    }

    // Actions: turn the two dead-ends (compare, see creator's catalog) into
    // one-click jumps, since this drawer is where people land from every table.
    const actions = $('drawer-actions');
    clearChildren(actions);
    if (island.latest) {
      const cmpBtn = document.createElement('button');
      cmpBtn.className = 'btn-ghost';
      cmpBtn.textContent = compareCodes.includes(island.code) ? '✓ In compare' : '+ Add to compare';
      cmpBtn.disabled = compareCodes.includes(island.code) || compareCodes.length >= COMPARE_MAX;
      cmpBtn.addEventListener('click', async () => {
        await addToCompare(island.code);
        closeDrawer();
        switchView('compare');
      });
      actions.appendChild(cmpBtn);
    }
    if (island.creatorCode) {
      const creatorBtn = document.createElement('button');
      creatorBtn.className = 'btn-ghost';
      creatorBtn.textContent = `See all by ${island.creatorCode} →`;
      creatorBtn.addEventListener('click', () => {
        closeDrawer();
        switchView('browse');
        applyCreatorFilter(island.creatorCode);
      });
      actions.appendChild(creatorBtn);
    }

    // Track/untrack. Shown only when auth is available (Supabase configured).
    // Clicking while logged out opens the sign-in modal rather than silently
    // doing nothing.
    if (supabaseReady()) {
      const trackBtn = document.createElement('button');
      trackBtn.className = 'btn-ghost';
      trackBtn.setAttribute('data-track-code', island.code);
      trackBtn.textContent = watchlistCodes.has(island.code) ? '★ Tracking (remove)' : '☆ Track this island';
      trackBtn.addEventListener('click', async () => {
        if (!currentUser) {
          openAuthModal();
          return;
        }
        if (watchlistCodes.has(island.code)) {
          await untrackIsland(island.code);
        } else {
          await trackIsland(island.code);
        }
      });
      actions.appendChild(trackBtn);
    }

    // The sparkline metric follows whatever the leaderboard is currently
    // showing; label it, and be honest when there's only one point to plot.
    const oneReading = (historyResp.snapshots || []).length < 2;
    $('drawer-chart-caption').textContent = oneReading
      ? `${METRIC_LABELS[currentMetric]} — only one reading so far; the line fills in as the crawler captures more over the coming days`
      : `${METRIC_LABELS[currentMetric]} over time (captured by this crawler only)`;
    clearChildren($('drawer-chart'));
    $('drawer-chart').appendChild(buildSparkline(historyResp.snapshots, currentMetric));

    openDrawer();
  } catch (err) {
    console.error('showDetail failed', err);
  }
}

// ---------------------------------------------------------------- auth + plan + watchlist

// Optional feature layer: the whole dashboard works logged-out (all public
// data). Signing in adds personal features; some are gated behind Pro.
// Everything about the browser talks to Supabase directly with the public
// anon key; no credentials/user data pass through this app's own API. The
// is_pro flag lives in user_profiles and can only be flipped server-side
// (Stripe webhook via service_role) - the client only ever reads it.
let sbClient = null;
let currentUser = null;
let isPro = false;
let watchlistCodes = new Set(); // codes the signed-in user is tracking

// Single source of truth for the free/Pro split. Changing a limit here
// changes it everywhere it's enforced. A `studio` tier slot is intentionally
// left out for now — it'll drop in here (seats/roster/API) once there's
// agency demand; the gating code already keys off can()/planLimits() so
// adding a tier is config-only.
const PLAN_LIMITS = {
  free: { watchlistMax: 3, historyDays: 7, compare: false, csvExport: false },
  pro: { watchlistMax: Infinity, historyDays: Infinity, compare: true, csvExport: true },
};

// Pricing (single source of truth; shown in the upgrade modal, used by Stripe
// checkout once wired). Annual is ~2 months free.
const PRICING = {
  pro: { monthly: 19, yearly: 190, currency: 'USD' },
};

function planLimits() {
  return isPro ? PLAN_LIMITS.pro : PLAN_LIMITS.free;
}

// A feature is allowed if the current plan grants it. Logged-out users get
// the free limits (so e.g. Compare prompts them to sign in / upgrade).
function can(feature) {
  return Boolean(planLimits()[feature]);
}

function supabaseReady() {
  return Boolean(sbClient);
}

function initSupabase() {
  const cfg = window.SUPABASE_CONFIG;
  // window.supabase is the UMD global from /vendor/supabase.js.
  if (!cfg || !cfg.url || !cfg.anonKey || !window.supabase) {
    console.warn('Supabase not configured/loaded; auth features disabled.');
    return;
  }
  sbClient = window.supabase.createClient(cfg.url, cfg.anonKey);
  sbClient.auth.getSession().then(({ data }) => applyAuthState(data.session));
  sbClient.auth.onAuthStateChange((_event, session) => applyAuthState(session));
}

async function applyAuthState(session) {
  currentUser = session?.user || null;
  const btn = $('auth-button');
  document.querySelectorAll('.auth-only').forEach((el) => {
    el.style.display = currentUser ? '' : 'none';
  });
  if (currentUser) {
    btn.textContent = 'Sign out';
    await Promise.all([refreshWatchlistCodes(), refreshPlan()]);
  } else {
    btn.textContent = 'Sign in';
    isPro = false;
    watchlistCodes = new Set();
    // If they were on My Islands when they signed out, bounce to Overview.
    if ($('view-watchlist').classList.contains('active')) switchView('overview');
  }
  applyPlanUi();
  // Reflect track/untrack state anywhere it's currently shown.
  updateTrackButtons();
}

async function refreshWatchlistCodes() {
  if (!currentUser) return;
  const { data, error } = await sbClient.from('user_watchlist').select('code');
  if (error) {
    console.error('watchlist load failed', error.message);
    return;
  }
  watchlistCodes = new Set((data || []).map((r) => r.code));
}

async function refreshPlan() {
  if (!currentUser) {
    isPro = false;
    return;
  }
  const { data, error } = await sbClient.from('user_profiles').select('is_pro').eq('user_id', currentUser.id).maybeSingle();
  if (error) {
    console.error('plan load failed', error.message);
    isPro = false;
    return;
  }
  isPro = Boolean(data?.is_pro);
}

// Reflect plan state in the UI: a Pro badge on the auth button, and the
// Compare nav item gets a lock hint for non-Pro users (it still navigates,
// but the view shows an upgrade gate).
function applyPlanUi() {
  const badge = $('pro-badge');
  if (badge) badge.style.display = isPro ? '' : 'none';
  const compareNav = document.querySelector('.nav-item[data-view="compare"]');
  if (compareNav) {
    compareNav.classList.toggle('locked', !can('compare'));
  }
}

async function trackIsland(code) {
  if (!currentUser) {
    openAuthModal();
    return false;
  }
  // Free-tier watchlist cap. Already-tracked codes don't count against it
  // (untracking then retracking is fine); only a genuinely new add is blocked.
  const max = planLimits().watchlistMax;
  if (!watchlistCodes.has(code) && watchlistCodes.size >= max) {
    openUpgradeModal();
    $('upgrade-msg').className = 'auth-msg';
    $('upgrade-msg').textContent = `Free accounts can track up to ${max} islands. Upgrade to Pro for unlimited.`;
    return false;
  }
  const { error } = await sbClient.from('user_watchlist').insert({ user_id: currentUser.id, code });
  if (error && !String(error.message).includes('duplicate')) {
    console.error('track failed', error.message);
    return false;
  }
  watchlistCodes.add(code);
  updateTrackButtons();
  return true;
}

async function untrackIsland(code) {
  if (!currentUser) return;
  const { error } = await sbClient.from('user_watchlist').delete().eq('user_id', currentUser.id).eq('code', code);
  if (error) {
    console.error('untrack failed', error.message);
    return;
  }
  watchlistCodes.delete(code);
  updateTrackButtons();
}

// Re-label any visible track/untrack buttons (drawer) to match current state.
function updateTrackButtons() {
  document.querySelectorAll('[data-track-code]').forEach((btn) => {
    const code = btn.getAttribute('data-track-code');
    const tracked = watchlistCodes.has(code);
    btn.textContent = tracked ? '★ Tracking (remove)' : '☆ Track this island';
  });
}

// ---- auth modal ----

let authMode = 'signin'; // or 'signup'

function openAuthModal() {
  $('auth-msg').textContent = '';
  $('auth-msg').className = 'auth-msg';
  $('auth-backdrop').classList.add('open');
  $('auth-modal').classList.add('open');
  $('auth-email').focus();
}
function closeAuthModal() {
  $('auth-backdrop').classList.remove('open');
  $('auth-modal').classList.remove('open');
}

// ---- upgrade modal ----
// Stripe Checkout gets wired into the checkout button once the account + key
// exist (see README). For now it explains the plan and shows a clear
// "not yet available" state rather than a fake payment flow.
let billingCycle = 'monthly';

function renderUpgradePrice() {
  const p = PRICING.pro;
  const el = $('upgrade-price');
  if (billingCycle === 'yearly') {
    el.innerHTML = `<span class="price-num">$${p.yearly}</span><span class="price-unit">/year</span> <span class="price-sub">($${(p.yearly / 12).toFixed(2)}/mo, billed annually)</span>`;
  } else {
    el.innerHTML = `<span class="price-num">$${p.monthly}</span><span class="price-unit">/month</span>`;
  }
}

function openUpgradeModal() {
  $('upgrade-msg').textContent = '';
  $('upgrade-msg').className = 'auth-msg';
  renderUpgradePrice();
  $('upgrade-backdrop').classList.add('open');
  $('upgrade-modal').classList.add('open');
}
function closeUpgradeModal() {
  $('upgrade-backdrop').classList.remove('open');
  $('upgrade-modal').classList.remove('open');
}
function wireUpgradeUi() {
  $('upgrade-close').addEventListener('click', closeUpgradeModal);
  $('upgrade-backdrop').addEventListener('click', closeUpgradeModal);
  document.querySelectorAll('.billing-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      billingCycle = btn.dataset.billing;
      document.querySelectorAll('.billing-opt').forEach((b) => b.classList.toggle('active', b === btn));
      renderUpgradePrice();
    });
  });
  $('upgrade-checkout').addEventListener('click', async () => {
    const msg = $('upgrade-msg');
    // Placeholder until Stripe is connected. When wired, this becomes a fetch
    // to /api/create-checkout-session with { cycle: billingCycle } that
    // returns a Stripe Checkout URL to redirect to.
    if (!window.STRIPE_ENABLED) {
      msg.className = 'auth-msg';
      msg.textContent = 'Checkout isn\'t live yet — Pro is coming very soon.';
      return;
    }
    // (Wired later.)
  });
}
function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  $('auth-title').textContent = isSignup ? 'Create account' : 'Sign in';
  $('auth-submit').textContent = isSignup ? 'Create account' : 'Sign in';
  $('auth-toggle-text').textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
  $('auth-toggle-btn').textContent = isSignup ? 'Sign in' : 'Create one';
  $('auth-password').autocomplete = isSignup ? 'new-password' : 'current-password';
}

function wireAuthUi() {
  $('auth-button').addEventListener('click', async () => {
    if (currentUser) {
      await sbClient.auth.signOut();
    } else {
      setAuthMode('signin');
      openAuthModal();
    }
  });
  $('auth-close').addEventListener('click', closeAuthModal);
  $('auth-backdrop').addEventListener('click', closeAuthModal);
  $('auth-toggle-btn').addEventListener('click', () => setAuthMode(authMode === 'signin' ? 'signup' : 'signin'));
  $('watchlist-signin-cta').addEventListener('click', () => {
    setAuthMode('signin');
    openAuthModal();
  });

  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabaseReady()) return;
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const msg = $('auth-msg');
    msg.className = 'auth-msg';
    msg.textContent = 'Working…';
    $('auth-submit').disabled = true;
    try {
      if (authMode === 'signup') {
        const { error } = await sbClient.auth.signUp({ email, password });
        if (error) throw error;
        // Depending on the project's email-confirmation setting, the user may
        // be signed in immediately or need to confirm via email first.
        const { data } = await sbClient.auth.getSession();
        if (data.session) {
          msg.className = 'auth-msg success';
          msg.textContent = 'Account created — you\'re signed in.';
          setTimeout(closeAuthModal, 900);
        } else {
          msg.className = 'auth-msg success';
          msg.textContent = 'Check your email to confirm your account, then sign in.';
        }
      } else {
        const { error } = await sbClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        msg.className = 'auth-msg success';
        msg.textContent = 'Signed in.';
        setTimeout(closeAuthModal, 500);
      }
    } catch (err) {
      msg.className = 'auth-msg error';
      msg.textContent = err.message || 'Something went wrong.';
    } finally {
      $('auth-submit').disabled = false;
    }
  });
}

// ---- My Islands view ----

let lastWatchlistRows = [];

async function loadWatchlist() {
  const signedOut = $('watchlist-signedout');
  const panel = $('watchlist-panel');
  if (!currentUser) {
    signedOut.style.display = 'block';
    panel.style.display = 'none';
    $('watchlist-count').textContent = '';
    return;
  }
  signedOut.style.display = 'none';
  panel.style.display = 'block';

  await refreshWatchlistCodes();
  const codes = [...watchlistCodes];
  $('watchlist-count').textContent = `${codes.length} island${codes.length === 1 ? '' : 's'} tracked`;

  const tbody = $('watchlist-body');
  clearChildren(tbody);
  const empty = $('watchlist-empty');
  if (!codes.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  // Fetch each island's current stats through the public API (up to a
  // sensible cap - a personal watchlist isn't going to be thousands long).
  const islands = await Promise.all(
    codes.slice(0, 100).map((code) => fetchJson(`/api/islands/${encodeURIComponent(code)}`).catch(() => null))
  );
  lastWatchlistRows = islands.filter(Boolean);

  for (const isl of islands) {
    if (!isl) continue;
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.watchlist-remove')) return;
      showDetail(isl.code);
    });
    tr.appendChild(buildIslandCell(isl));

    const tdCcu = document.createElement('td');
    tdCcu.className = 'mono-cell';
    tdCcu.textContent = fmtNumber(isl.latest?.peakCCU);
    tr.appendChild(tdCcu);

    const tdUp = document.createElement('td');
    tdUp.className = 'mono-cell';
    tdUp.textContent = fmtNumber(isl.latest?.uniquePlayers);
    tr.appendChild(tdUp);

    const tdRemove = document.createElement('td');
    const rm = document.createElement('button');
    rm.className = 'watchlist-remove';
    rm.textContent = 'Remove';
    rm.addEventListener('click', async () => {
      await untrackIsland(isl.code);
      loadWatchlist();
    });
    tdRemove.appendChild(rm);
    tr.appendChild(tdRemove);

    tbody.appendChild(tr);
  }
}

$('watchlist-export').addEventListener('click', () => {
  gatedExport('my-islands.csv', lastWatchlistRows.map((r) => ({
    code: r.code,
    title: r.title || '',
    creatorCode: r.creatorCode || '',
    peakCCU: r.latest?.peakCCU ?? '',
    uniquePlayers: r.latest?.uniquePlayers ?? '',
  })));
});

// ---------------------------------------------------------------- boot

initSupabase();
wireAuthUi();
wireUpgradeUi();
refreshStatus();
loadTagCloud();
// Honor a deep-link hash on load (e.g. someone shared /#leaderboard), else
// land on Overview. Always loads Overview's data too so the nav counts/status
// are populated regardless of which view is shown first.
loadOverview();
const initialView = window.location.hash.replace(/^#/, '');
if (views.includes(initialView) && initialView !== 'overview') {
  switchView(initialView, { updateHash: false });
}
setInterval(refreshStatus, 15000);
setInterval(() => {
  const active = views.find((v) => $(`view-${v}`).classList.contains('active'));
  if (active && active !== 'explore' && active !== 'browse' && active !== 'compare') loaders[active]();
}, 30000);
