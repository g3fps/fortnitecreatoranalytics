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

// ---------------------------------------------------------------- nav / views

const views = ['overview', 'leaderboard', 'movers', 'creators', 'browse', 'explore', 'health'];
const loaders = {
  overview: loadOverview,
  leaderboard: loadLeaderboard,
  movers: loadMovers,
  creators: loadCreators,
  browse: loadBrowse,
  explore: () => {},
  health: loadHealth,
};

function switchView(name) {
  for (const v of views) {
    $(`view-${v}`).classList.toggle('active', v === name);
  }
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  loaders[name]?.();
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

$('overview-see-all').addEventListener('click', () => switchView('leaderboard'));

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

function buildBarCell(value, max, variant) {
  const td = document.createElement('td');
  td.className = 'value';
  const wrap = document.createElement('div');
  wrap.className = 'bar-cell';
  const num = document.createElement('span');
  num.className = 'bar-num';
  num.textContent = fmtNumber(value);
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
    tr.appendChild(buildBarCell(row.latest?.[metricKey], max, opts.variant));
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
    const [stats, timeline, board] = await Promise.all([
      fetchJson('/api/stats'),
      fetchJson('/api/timeline'),
      fetchJson('/api/leaderboard?metric=peakCCU&limit=5'),
    ]);

    $('kpi-islands').textContent = stats.islandsTracked.toLocaleString();

    const checkedPct = stats.islandsTracked > 0 ? (stats.islandsPolled / stats.islandsTracked) * 100 : 0;
    $('kpi-checked').textContent = `${checkedPct < 0.1 && checkedPct > 0 ? checkedPct.toFixed(2) : checkedPct.toFixed(1)}%`;
    $('kpi-checked-note').textContent = `${stats.islandsPolled.toLocaleString()} of ${stats.islandsTracked.toLocaleString()} polled at least once`;

    const signalPct = stats.islandsPolled > 0 ? (stats.islandsWithData / stats.islandsPolled) * 100 : 0;
    $('kpi-signal').textContent = `${signalPct.toFixed(1)}%`;

    const progress = stats.crawlProgress || { inProgress: false, current: null };
    if (progress.inProgress && progress.current) {
      $('kpi-lastcrawl').textContent = 'Crawling';
      const polled = progress.current.metricsPolled || 0;
      const total = progress.current.totalCandidates;
      $('kpi-lastcrawl-note').textContent = total ? `${polled.toLocaleString()} / ${total.toLocaleString()} polled this cycle` : 'discovering catalog…';
    } else {
      $('kpi-lastcrawl').textContent = 'Idle';
      $('kpi-lastcrawl-note').textContent = `last cycle finished ${fmtRelativeTime(stats.crawlState?.lastCrawlFinishedAt)}`;
    }
    $('overview-updated').textContent = `updated ${fmtRelativeTime(new Date().toISOString())}`;

    clearChildren($('growth-chart'));
    $('growth-chart').appendChild(buildGrowthChart(timeline.days));

    renderRankedTable($('overview-board-body'), board.rows, 'peakCCU');
  } catch (err) {
    console.error('loadOverview failed', err);
  }
}

// ---------------------------------------------------------------- leaderboard

let currentMetric = 'peakCCU';
let lastLeaderboardRows = [];

document.querySelectorAll('#metric-tabs .tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    currentMetric = btn.dataset.metric;
    document.querySelectorAll('#metric-tabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    $('leaderboard-value-head').textContent = METRIC_LABELS[currentMetric];
    loadLeaderboard();
  });
});

async function loadLeaderboard() {
  try {
    const data = await fetchJson(`/api/leaderboard?metric=${encodeURIComponent(currentMetric)}&limit=40`);
    lastLeaderboardRows = data.rows;
    $('leaderboard-count').textContent = `${data.rows.length} ranked island${data.rows.length === 1 ? '' : 's'}`;
    const empty = $('leaderboard-empty');
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = 'No islands have live data for this metric yet — coverage grows every crawl cycle.';
    } else {
      empty.style.display = 'none';
    }
    renderRankedTable($('leaderboard-body'), data.rows, currentMetric, { variant: 'sonar' });
  } catch (err) {
    console.error('loadLeaderboard failed', err);
  }
}

$('leaderboard-export').addEventListener('click', () => {
  downloadCsv(`leaderboard-${currentMetric}.csv`, flattenRowsForCsv(lastLeaderboardRows, currentMetric));
});

// ---------------------------------------------------------------- movers

let moversMetric = 'peakCCU';
let moversDirection = 'up';
let lastMoversRows = [];

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

async function loadMovers() {
  try {
    const data = await fetchJson(`/api/movers?metric=${encodeURIComponent(moversMetric)}&direction=${moversDirection}&limit=30`);
    lastMoversRows = data.rows;
    $('movers-count').textContent = `${data.rows.length} island${data.rows.length === 1 ? '' : 's'} with 2+ readings`;

    const tbody = $('movers-body');
    clearChildren(tbody);
    const empty = $('movers-empty');
    if (!data.rows.length) {
      empty.style.display = 'block';
      empty.textContent = 'No islands have 2 captured readings yet for this metric — check back after the next crawl cycle.';
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
      tdChange.textContent = `${fmtNumber(row.previous[moversMetric])} → ${fmtNumber(row.latest[moversMetric])}`;
      tr.appendChild(tdChange);

      const tdDelta = document.createElement('td');
      const sign = row.delta > 0 ? '+' : '';
      const deltaSpan = document.createElement('span');
      deltaSpan.className = row.delta >= 0 ? 'delta-up' : 'delta-down';
      deltaSpan.textContent = `${sign}${fmtNumber(row.delta)}`;
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
    $('creators-count').textContent = `${data.rows.length} ranked creator${data.rows.length === 1 ? '' : 's'}`;

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

// ---------------------------------------------------------------- browse

const browseState = { tag: null, creatorCode: null, hasData: '', sort: 'title', dir: 'asc', page: 1, pageSize: 40 };
let lastBrowseRows = [];

async function loadTagCloud() {
  try {
    const data = await fetchJson('/api/tags?limit=24');
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
  downloadCsv('browse-page.csv', lastBrowseRows.map((r) => ({
    code: r.code,
    title: r.title || '',
    creatorCode: r.creatorCode || '',
    peakCCU: r.latest?.peakCCU ?? '',
    uniquePlayers: r.latest?.uniquePlayers ?? '',
    firstSeenAt: r.firstSeenAt || '',
  })));
});

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

    const data = await fetchJson(`/api/browse?${params.toString()}`);
    lastBrowseRows = data.rows;
    browseState.page = data.page;

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
      for (const key of ['peakCCU', 'uniquePlayers', 'minutesPlayed', 'plays', 'favorites', 'recommendations']) {
        const tile = document.createElement('div');
        tile.className = 'metric-tile';
        const label = document.createElement('div');
        label.className = 'label';
        label.textContent = METRIC_LABELS[key];
        const value = document.createElement('div');
        value.className = 'value';
        value.textContent = fmtNumber(body.latest[key]);
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

// ---------------------------------------------------------------- crawl health

async function loadHealth() {
  try {
    const [stats, log] = await Promise.all([fetchJson('/api/stats'), fetchJson('/api/crawl-log?limit=20')]);

    $('health-updated').textContent = `updated ${fmtRelativeTime(new Date().toISOString())}`;
    const cursor = stats.crawlState?.cursor;
    $('health-cursor').textContent = cursor ? `${cursor.slice(0, 14)}…` : '(wrapped to start)';

    const progress = stats.crawlProgress || { inProgress: false, current: null };
    if (progress.inProgress && progress.current) {
      const polled = progress.current.metricsPolled || 0;
      const total = progress.current.totalCandidates;
      $('health-progress').textContent = total ? `${polled.toLocaleString()} / ${total.toLocaleString()}` : 'discovering…';
    } else {
      $('health-progress').textContent = 'idle';
    }

    const cycles = log.cycles || [];
    const latest = cycles[0];
    $('health-duration').textContent = latest ? fmtDuration(latest.durationMs) : '—';
    const errEl = $('health-errors');
    errEl.textContent = latest ? String(latest.errorCount ?? 0) : '—';
    errEl.classList.toggle('accent-bad', !!latest && latest.errorCount > 0);

    const tbody = $('health-body');
    clearChildren(tbody);
    $('health-empty').style.display = cycles.length ? 'none' : 'block';

    for (const cycle of cycles) {
      const tr = document.createElement('tr');

      const tdStart = document.createElement('td');
      tdStart.className = 'mono-cell';
      tdStart.textContent = fmtRelativeTime(cycle.startedAt);
      tr.appendChild(tdStart);

      const tdReason = document.createElement('td');
      tdReason.textContent = cycle.reason || '—';
      tr.appendChild(tdReason);

      const tdNew = document.createElement('td');
      tdNew.className = 'mono-cell';
      tdNew.textContent = fmtNumber(cycle.newIslandsDiscovered);
      tr.appendChild(tdNew);

      const tdPolled = document.createElement('td');
      tdPolled.className = 'mono-cell';
      tdPolled.textContent = fmtNumber(cycle.metricsPolled);
      tr.appendChild(tdPolled);

      const tdWritten = document.createElement('td');
      tdWritten.className = 'mono-cell';
      tdWritten.textContent = fmtNumber(cycle.metricsWritten);
      tr.appendChild(tdWritten);

      const tdNotFound = document.createElement('td');
      tdNotFound.className = 'mono-cell';
      tdNotFound.textContent = fmtNumber(cycle.metricsNotFound);
      tr.appendChild(tdNotFound);

      const tdErrors = document.createElement('td');
      const pill = document.createElement('span');
      const errorCount = cycle.errorCount ?? 0;
      pill.className = `pill ${errorCount > 0 ? 'bad' : 'ok'}`;
      pill.textContent = cycle.fatal ? 'fatal' : String(errorCount);
      tdErrors.appendChild(pill);
      tr.appendChild(tdErrors);

      tbody.appendChild(tr);
    }
  } catch (err) {
    console.error('loadHealth failed', err);
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
    for (const key of ['peakCCU', 'uniquePlayers', 'minutesPlayed', 'averageMinutesPerPlayer', 'plays', 'favorites']) {
      const tile = document.createElement('div');
      tile.className = 'metric-tile';
      const label = document.createElement('div');
      label.className = 'label';
      label.textContent = METRIC_LABELS[key];
      const value = document.createElement('div');
      value.className = 'value';
      value.textContent = fmtNumber(latest[key]);
      tile.appendChild(label);
      tile.appendChild(value);
      grid.appendChild(tile);
    }

    $('drawer-chart-caption').textContent = `${METRIC_LABELS[currentMetric]} over time (captured by this crawler only)`;
    clearChildren($('drawer-chart'));
    $('drawer-chart').appendChild(buildSparkline(historyResp.snapshots, currentMetric));

    openDrawer();
  } catch (err) {
    console.error('showDetail failed', err);
  }
}

// ---------------------------------------------------------------- boot

refreshStatus();
loadOverview();
loadTagCloud();
setInterval(refreshStatus, 15000);
setInterval(() => {
  const active = views.find((v) => $(`view-${v}`).classList.contains('active'));
  if (active && active !== 'explore' && active !== 'browse') loaders[active]();
}, 30000);
