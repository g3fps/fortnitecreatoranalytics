'use strict';

// Public genre index (/genres): lists every genre with an active-island count,
// linking to each /genre/<slug> report. An SEO hub page that spreads link
// equity to the individual genre pages and ranks for "fortnite creative genres".

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const { tagToSlug, ACTIVE_CCU_FLOOR } = require('./_genreReport');

const SITE = process.env.SITE_URL || 'https://uefnstats.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = async (req, res) => {
  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Count ACTIVE islands per tag (a genre with only dead islands isn't worth a
  // page). One pass over active islands, tally tags in JS.
  const { data } = await svc
    .from('islands_with_latest')
    .select('tags')
    .gte('peak_ccu', ACTIVE_CCU_FLOOR)
    .limit(20000);
  const counts = new Map();
  for (const row of data || []) {
    for (const t of row.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const genres = [...counts.entries()]
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, n]) => ({ tag, slug: tagToSlug(tag), n }));

  const items = genres
    .map((g) => `<a class="g-item" href="/genre/${esc(g.slug)}"><span class="g-name">${esc(g.tag)}</span><span class="g-n">${g.n.toLocaleString()}</span></a>`)
    .join('');

  const title = 'Fortnite Creative & UEFN genres — leaderboards by category | UEFN Stats';
  const desc = `Browse ${genres.length} Fortnite Creative / UEFN genres with live leaderboards, genre medians, and trends — from zonewars and boxfight to tycoon, deathrun, and parkour.`;

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.end(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/genres">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${SITE}/genres">
<style>
  :root{color-scheme:dark}*{box-sizing:border-box}
  body{margin:0;background:#0a0c11;color:#e7e9ee;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;-webkit-font-smoothing:antialiased}
  a{color:#4c7dff;text-decoration:none}
  .wrap{max-width:900px;margin:0 auto;padding:26px 18px 70px}
  .top{display:flex;align-items:center;gap:8px;margin-bottom:22px}
  .mark{width:7px;height:7px;border-radius:2px;background:#4c7dff;display:inline-block}.brand{font-weight:700}
  h1{font-size:27px;letter-spacing:-0.02em;margin:0 0 4px}
  .sub{color:#676d80;font-size:13.5px;margin:0 0 24px}
  .g-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
  .g-item{display:flex;justify-content:space-between;align-items:center;border:1px solid #232734;border-radius:9px;padding:12px 14px;background:#12151c}
  .g-item:hover{border-color:#4c7dff;text-decoration:none}
  .g-name{text-transform:capitalize;font-weight:500}.g-n{color:#676d80;font-size:12px;font-variant-numeric:tabular-nums}
  footer{margin-top:40px;padding-top:18px;border-top:1px solid #232734;color:#676d80;font-size:12px}
</style></head><body>
<div class="wrap">
  <div class="top"><span class="mark"></span><a class="brand" href="/">UEFN Stats</a></div>
  <h1>Genres</h1>
  <p class="sub">${genres.length} Fortnite Creative / UEFN genres, ranked by number of active islands. Pick one for its live leaderboard, genre medians, and trends.</p>
  <div class="g-grid">${items}</div>
  <footer>
    UEFN Stats tracks public engagement stats for Fortnite Creative &amp; UEFN islands, built on Epic's public Ecosystem API. Not affiliated with or endorsed by Epic Games.<br>
    <a href="/">Home</a> &middot; <a href="/leaderboard">Leaderboard</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a>
  </footer>
</div></body></html>`);
};
