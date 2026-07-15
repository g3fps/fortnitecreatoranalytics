'use strict';

// Public genre index (/genres): lists every genre with an active-island count,
// linking to each /genre/<slug> report. An SEO hub page that spreads link
// equity to the individual genre pages and ranks for "fortnite creative genres".

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const { tagToSlug, ACTIVE_CCU_FLOOR, siteHeader } = require('./_genreReport');

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
  :root{
    --ground:#0a0c11;--panel:#12151c;--panel-raised:#191d27;--topbar:#0d0f15;
    --line:#232734;--paper:#e7e9ee;--paper-dim:#a2a8b8;--muted:#676d80;
    --accent:#4c7dff;--accent-soft:rgba(76,125,255,0.12);color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--paper);font:14px/1.55 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  .site-hdr{position:sticky;top:0;z-index:10;background:var(--topbar);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:24px;padding:0 22px;height:56px}
  .site-wordmark{display:flex;align-items:baseline;gap:7px;font-weight:700;font-size:15px;letter-spacing:-0.01em;color:var(--paper);flex-shrink:0}
  .site-wordmark:hover{text-decoration:none}
  .site-wordmark .mark{width:7px;height:7px;border-radius:2px;background:var(--accent);align-self:center}
  .site-tag{font-size:11.5px;color:var(--muted);font-weight:400}
  .site-nav{display:flex;gap:2px;flex:1;overflow-x:auto;scrollbar-width:none;min-width:0}.site-nav::-webkit-scrollbar{display:none}
  .site-nav a{color:var(--paper-dim);font-size:13px;font-weight:500;padding:0 12px;height:56px;display:flex;align-items:center;white-space:nowrap;border-bottom:2px solid transparent}
  .site-nav a:hover{color:var(--paper);text-decoration:none}.site-nav a.on{color:var(--paper);border-bottom-color:var(--accent);font-weight:600}
  @media(max-width:640px){.site-tag{display:none}}
  .wrap{max-width:940px;margin:0 auto;padding:0 18px 70px}
  .ghero{border:1px solid var(--line);border-radius:16px;padding:28px 26px;margin:24px 0 22px;overflow:hidden;
    background:radial-gradient(900px 320px at 85% -30%,var(--accent-soft),transparent 60%),linear-gradient(180deg,var(--panel),var(--ground))}
  .ghero .eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
  h1{font-size:30px;letter-spacing:-0.02em;margin:6px 0 6px}
  .sub{color:var(--paper-dim);font-size:14px;margin:0;max-width:60ch}
  .g-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
  .g-item{display:flex;justify-content:space-between;align-items:center;border:1px solid var(--line);border-radius:11px;padding:13px 15px;background:var(--panel);transition:border-color .12s ease,background .12s ease}
  .g-item:hover{border-color:var(--accent);background:var(--panel-raised);text-decoration:none}
  .g-name{text-transform:capitalize;font-weight:600;color:var(--paper)}
  .g-n{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
  footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}
</style></head><body>
${siteHeader('genres')}
<div class="wrap">
  <section class="ghero">
    <div class="eyebrow">Browse</div>
    <h1>Genres</h1>
    <p class="sub">${genres.length} Fortnite Creative / UEFN genres, ranked by number of active islands. Pick one for its live leaderboard, genre medians, and AI trend report.</p>
  </section>
  <div class="g-grid">${items}</div>
  <footer>
    UEFN Stats tracks public engagement stats for Fortnite Creative &amp; UEFN islands, built on Epic's public Ecosystem API. Not affiliated with or endorsed by Epic Games.<br>
    <a href="/">Home</a> &middot; <a href="/leaderboard">Leaderboard</a> &middot; <a href="/terms">Terms</a> &middot; <a href="/privacy">Privacy</a>
  </footer>
</div></body></html>`);
};
