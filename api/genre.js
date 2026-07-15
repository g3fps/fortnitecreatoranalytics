'use strict';

// Server-rendered public genre report page (SEO funnel).
//
// Why server-rendered and not part of the SPA: Google indexes the HTML it's
// served. A genre page baked with real leaders + medians + an AI summary is a
// page that ranks for "best zonewars maps fortnite" and funnels searchers into
// the product. The full breakdown teases the Pro depth.
//
// Route: /genre/:slug  (via a vercel.json rewrite -> /api/genre)

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const { buildGenreReport, slugToTag, fmt } = require('./_genreReport');

const SITE = process.env.SITE_URL || 'https://uefnstats.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function metricCard(d) {
  return `<div class="gm-card"><div class="gm-k">${esc(d.label)}</div>` +
    `<div class="gm-v">${esc(fmt(d.median, d.kind))}</div>` +
    `<div class="gm-sub">median &middot; top 10% at ${esc(fmt(d.p90, d.kind))}</div></div>`;
}

function leaderRow(l, i) {
  return `<tr><td class="gr-rank">${i + 1}</td>` +
    `<td><a href="/island/${encodeURIComponent(l.code)}">${esc(l.title || '(untitled)')}</a>` +
    `<div class="gr-creator">${esc(l.creator_code || '')}</div></td>` +
    `<td class="gr-num">${esc(fmt(l.peak_ccu, 'int'))}</td>` +
    `<td class="gr-num gr-hide-sm">${esc(fmt(l.unique_players, 'int'))}</td>` +
    `<td class="gr-num gr-hide-sm">${esc(fmt(l.retention_d1, 'pct'))}</td></tr>`;
}

function page(report, summary) {
  const title = `${report.tag} islands — leaderboard, stats & trends | UEFN Stats`;
  const desc = `The top ${report.tag} Fortnite Creative / UEFN islands ranked by peak players, with genre medians and trends across ${report.activeCount.toLocaleString()} active islands. Updated daily.`;
  const canonical = `${SITE}/genre/${report.slug}`;
  const leaders = report.leaders.map(leaderRow).join('');
  const cards = ['peak_ccu', 'unique_players', 'average_minutes_per_player', 'retention_d1', 'retention_d7', 'favorites']
    .map((k) => report.distribution[k]).filter(Boolean).map(metricCard).join('');

  const moversHtml = report.movers && report.movers.length
    ? `<section class="gr-section"><h2>Biggest movers</h2><ul class="gr-movers">` +
      report.movers.slice(0, 5).map((m) =>
        `<li><a href="/island/${encodeURIComponent(m.code)}">${esc(m.title)}</a> ` +
        `<span class="${m.pct >= 0 ? 'up' : 'down'}">${m.pct >= 0 ? '+' : ''}${m.pct}%</span> peak CCU</li>`
      ).join('') + `</ul></section>`
    : '';

  // JSON-LD for rich results (ItemList of the leaders).
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Top ${report.tag} UEFN islands`,
    itemListElement: report.leaders.slice(0, 10).map((l, i) => ({
      '@type': 'ListItem', position: i + 1, name: l.title || l.code,
    })),
  };

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;background:#0a0c11;color:#e7e9ee;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:#4c7dff;text-decoration:none}a:hover{text-decoration:underline}
  .wrap{max-width:900px;margin:0 auto;padding:26px 18px 70px}
  .top{display:flex;align-items:center;gap:8px;margin-bottom:22px}
  .mark{width:7px;height:7px;border-radius:2px;background:#4c7dff;display:inline-block}
  .brand{font-weight:700}
  h1{font-size:27px;letter-spacing:-0.02em;margin:0 0 4px;text-transform:capitalize}
  .sub{color:#676d80;font-size:13.5px;margin:0 0 26px}
  h2{font-size:15px;color:#a2a8b8;text-transform:uppercase;letter-spacing:.04em;margin:30px 0 12px}
  .gr-section{margin-bottom:8px}
  .gm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:11px}
  .gm-card{border:1px solid #232734;border-radius:10px;padding:13px 15px;background:#12151c}
  .gm-k{color:#676d80;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  .gm-v{font-size:22px;font-weight:700;margin-top:4px}
  .gm-sub{color:#676d80;font-size:11px;margin-top:3px}
  .scroll{overflow-x:auto;border:1px solid #232734;border-radius:10px}
  table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:440px}
  th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #1c202b}
  th{color:#676d80;font-weight:600;background:#0f1219;font-size:12px}
  tr:last-child td{border-bottom:none}
  .gr-rank{color:#676d80;width:34px}.gr-num{text-align:right;font-variant-numeric:tabular-nums}
  .gr-creator{color:#676d80;font-size:11.5px}
  .gr-movers{list-style:none;padding:0;margin:0}
  .gr-movers li{padding:8px 0;border-bottom:1px solid #1c202b}
  .up{color:#2fbf71;font-weight:600}.down{color:#e5484d;font-weight:600}
  .ai{border:1px solid #232734;border-radius:12px;padding:18px 20px;background:linear-gradient(180deg,#12151c,#0d0f15);margin:8px 0 4px;white-space:pre-wrap;line-height:1.55}
  .ai-tease{margin-top:12px;padding-top:12px;border-top:1px solid #232734;color:#a2a8b8;font-size:13px}
  .btn{display:inline-block;margin-top:8px;background:#4c7dff;color:#fff;padding:9px 16px;border-radius:8px;font-weight:600}
  .btn:hover{text-decoration:none;filter:brightness(1.08)}
  footer{margin-top:40px;padding-top:18px;border-top:1px solid #232734;color:#676d80;font-size:12px}
  @media(max-width:560px){.gr-hide-sm{display:none}}
</style>
</head><body>
<div class="wrap">
  <div class="top"><span class="mark"></span><a class="brand" href="/">UEFN Stats</a></div>
  <h1>${esc(report.tag)} islands</h1>
  <p class="sub">Ranked by peak concurrent players across ${esc(report.activeCount.toLocaleString())} active ${esc(report.tag)} islands on Fortnite Creative / UEFN. Updated daily.</p>

  <section class="gr-section"><h2>The genre at a glance</h2><div class="gm-grid">${cards}</div></section>

  ${summary ? `<section class="gr-section"><h2>Analyst take</h2><div class="ai">${esc(summary)}<div class="ai-tease">Want this depth for <em>your</em> island — where you rank in ${esc(report.tag)} and exactly what to fix? <a href="/pro">Get Pro</a> for per-island AI analysis and competitor breakdowns.</div></div></section>` : ''}

  <section class="gr-section"><h2>Top ${esc(report.tag)} islands</h2>
    <div class="scroll"><table>
      <thead><tr><th>#</th><th>Island</th><th class="gr-num">Peak CCU</th><th class="gr-num gr-hide-sm">Unique</th><th class="gr-num gr-hide-sm">D1</th></tr></thead>
      <tbody>${leaders}</tbody>
    </table></div>
  </section>

  ${moversHtml}

  <section class="gr-section" style="margin-top:26px">
    <a class="btn" href="/leaderboard">Explore the full leaderboard &rarr;</a>
  </section>

  <footer>
    UEFN Stats tracks public engagement stats for Fortnite Creative &amp; UEFN islands, built on Epic's public Ecosystem API. Not affiliated with or endorsed by Epic Games.<br>
    <a href="/genres">All genres</a> &middot; <a href="/">Home</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a>
  </footer>
</div>
</body></html>`;
}

module.exports = async (req, res) => {
  // Extract the slug from the path (/genre/<slug>).
  const m = (req.url || '').match(/\/genre\/([^/?#]+)/);
  const slug = m ? decodeURIComponent(m[1]) : '';

  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Resolve the slug to a real tag (tags can contain spaces/punctuation).
  const { data: tagRows } = await svc.from('tag_counts').select('tag').limit(2000);
  const knownTags = (tagRows || []).map((r) => r.tag);
  const tag = slugToTag(slug, knownTags);
  if (!tag) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><meta charset="utf-8"><title>Genre not found</title><body style="background:#0a0c11;color:#e7e9ee;font-family:sans-serif;padding:40px"><h1>Genre not found</h1><p><a href="/genres" style="color:#4c7dff">See all genres</a></p>');
    return;
  }

  const report = await buildGenreReport(svc, tag);
  if (!report) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><title>${esc(tag)}</title><body style="background:#0a0c11;color:#e7e9ee;font-family:sans-serif;padding:40px"><h1>${esc(tag)}</h1><p>Not enough active islands in this genre to report yet.</p><p><a href="/genres" style="color:#4c7dff">See all genres</a></p>`);
    return;
  }

  // AI summary is best-effort: if the key is missing or the call fails, the page
  // still renders (leaders + medians are the SEO substance). Cached hard so we
  // don't pay per pageview.
  let summary = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      summary = await genreSummary(report);
    } catch (err) {
      console.error('[genre] summary failed:', err.message);
    }
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Cache at the edge for an hour: genre data only changes once a day, and this
  // keeps AI cost to ~1 call/genre/hour regardless of traffic.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.end(page(report, summary));
};

// Short AI "state of the genre" paragraph. Public (teaser), so kept tight.
async function genreSummary(report) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  const top = report.leaders.slice(0, 5).map((l, i) => `${i + 1}. ${l.title} — ${fmt(l.peak_ccu, 'int')} CCU, ${fmt(l.retention_d1, 'pct')} D1`).join('\n');
  const meds = ['peak_ccu', 'retention_d1', 'retention_d7', 'average_minutes_per_player']
    .map((k) => report.distribution[k]).filter(Boolean)
    .map((d) => `${d.label} median ${fmt(d.median, d.kind)} (top 10% ${fmt(d.p90, d.kind)})`).join('; ');
  const data = `Genre: ${report.tag}\nActive islands: ${report.activeCount}\nTop 5:\n${top}\nGenre medians: ${meds}`;
  const stream = await client.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 500,
    system:
      'You are an analyst for Fortnite Creative / UEFN. Write a tight, factual "state of the genre" paragraph (max ~90 words) for a public web page, grounded strictly in the numbers given. Note who leads and by how much, and what the genre medians say about the bar to be competitive. Plain text, no headers, no markdown, no preamble.',
    messages: [{ role: 'user', content: `${data}\n\nWrite the state-of-the-genre paragraph.` }],
  });
  const msg = await stream.finalMessage();
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
