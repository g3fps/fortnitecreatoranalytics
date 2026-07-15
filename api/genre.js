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
const { buildGenreReport, slugToTag, fmt, siteHeader } = require('./_genreReport');

const SITE = process.env.SITE_URL || 'https://uefnstats.com';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A distinct accent per metric so the card row reads as a set of different
// tiles rather than a monotonous gray grid.
const METRIC_COLOR = {
  'Peak CCU': '#4c7dff',
  'Unique players': '#22b8cf',
  'Avg minutes/player': '#7c5cff',
  'Day-1 retention': '#2fbf71',
  'Day-7 retention': '#12b886',
  Favorites: '#f5a623',
  Plays: '#e5484d',
  'Minutes played': '#e64980',
  Recommendations: '#d9a441',
};

function metricCard(d) {
  // The card shows the genre's full range so the big number is unambiguous:
  //   big value  = the MEDIAN island (labeled)
  //   bar        = where that median sits within the genre (median -> best)
  //   sub-line   = the top-10% bar and the single best island
  const best = d.max != null ? d.max : d.p90;
  const pctFill = best && d.median != null && best > 0 ? Math.min(100, Math.max(3, Math.round((d.median / best) * 100))) : 0;
  const color = METRIC_COLOR[d.label] || '#4c7dff';
  return (
    `<div class="gm-card" style="--c:${color}"><div class="gm-k">${esc(d.label)}</div>` +
    `<div class="gm-v">${esc(fmt(d.median, d.kind))} <span class="gm-tag">median</span></div>` +
    `<div class="gm-bar"><i style="width:${pctFill}%"></i></div>` +
    `<div class="gm-sub">top 10% <b>${esc(fmt(d.p90, d.kind))}</b> &middot; best <b>${esc(fmt(best, d.kind))}</b></div></div>`
  );
}

const MEDAL = ['gold', 'silver', 'bronze'];
function leaderRow(l, i) {
  const rankCell = i < 3
    ? `<td class="gr-rank"><span class="medal ${MEDAL[i]}">${i + 1}</span></td>`
    : `<td class="gr-rank">${i + 1}</td>`;
  return (
    `<tr class="${i < 3 ? 'top3' : ''}">${rankCell}` +
    `<td><a class="gr-title" href="/island/${encodeURIComponent(l.code)}">${esc(l.title || '(untitled)')}</a>` +
    `<div class="gr-creator">${esc(l.creator_code || '')}</div></td>` +
    `<td class="gr-num gr-ccu">${esc(fmt(l.peak_ccu, 'int'))}</td>` +
    `<td class="gr-num gr-hide-sm">${esc(fmt(l.unique_players, 'int'))}</td>` +
    `<td class="gr-num gr-hide-sm">${esc(fmt(l.retention_d1, 'pct'))}</td></tr>`
  );
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
  :root{
    --ground:#0a0c11;--panel:#12151c;--panel-raised:#191d27;--topbar:#0d0f15;
    --line:#232734;--paper:#e7e9ee;--paper-dim:#a2a8b8;--muted:#676d80;
    --accent:#4c7dff;--accent-soft:rgba(76,125,255,0.12);--ok:#2fbf71;--bad:#e5484d;
    color-scheme:dark;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--paper);font:14px/1.55 'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}

  /* site header - matches the main app top bar exactly */
  .site-hdr{position:sticky;top:0;z-index:10;background:var(--topbar);border-bottom:1px solid var(--line);display:flex;align-items:center;gap:24px;padding:0 22px;height:56px}
  .site-wordmark{display:flex;align-items:baseline;gap:7px;font-weight:700;font-size:15px;letter-spacing:-0.01em;color:var(--paper);flex-shrink:0}
  .site-wordmark:hover{text-decoration:none}
  .site-wordmark .mark{width:7px;height:7px;border-radius:2px;background:var(--accent);align-self:center}
  .site-tag{font-size:11.5px;color:var(--muted);font-weight:400}
  .site-nav{display:flex;gap:2px;flex:1;overflow-x:auto;scrollbar-width:none;min-width:0}
  .site-nav::-webkit-scrollbar{display:none}
  .site-nav a{color:var(--paper-dim);font-size:13px;font-weight:500;padding:0 12px;height:56px;display:flex;align-items:center;white-space:nowrap;border-bottom:2px solid transparent}
  .site-nav a:hover{color:var(--paper);text-decoration:none}
  .site-nav a.on{color:var(--paper);border-bottom-color:var(--accent);font-weight:600}
  @media(max-width:640px){.site-tag{display:none}}

  .wrap{max-width:940px;margin:0 auto;padding:0 18px 70px}

  /* hero */
  .ghero{position:relative;border:1px solid var(--line);border-radius:16px;padding:30px 26px;margin:24px 0 22px;overflow:hidden;
    background:radial-gradient(900px 320px at 85% -30%,var(--accent-soft),transparent 60%),linear-gradient(180deg,var(--panel),var(--ground))}
  .ghero .eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)}
  .ghero h1{font-size:32px;letter-spacing:-0.02em;margin:6px 0 6px;text-transform:capitalize}
  .ghero p{color:var(--paper-dim);font-size:14px;margin:0;max-width:60ch}
  .ghero .pop{color:var(--paper);font-weight:600}

  h2{font-size:12.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:28px 0 12px;font-weight:700}
  .gr-section{margin-bottom:6px}

  /* stat cards - each metric gets its own accent so the row reads as distinct
     tiles, not a wall of identical gray boxes. */
  .gm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(162px,1fr));gap:12px}
  .gm-card{position:relative;border:1px solid var(--line);border-radius:13px;padding:15px 16px 14px;
    background:linear-gradient(180deg,var(--panel),var(--topbar));overflow:hidden}
  .gm-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--c,#4c7dff);opacity:.9}
  .gm-card::after{content:"";position:absolute;top:-40px;right:-40px;width:120px;height:120px;border-radius:50%;
    background:radial-gradient(circle,var(--c,#4c7dff),transparent 70%);opacity:.08;pointer-events:none}
  .gm-k{color:var(--paper-dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:700}
  .gm-v{font-size:25px;font-weight:800;margin-top:6px;letter-spacing:-0.02em;line-height:1.1}
  .gm-tag{font-size:9.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-left:4px;vertical-align:middle}
  .gm-bar{height:5px;background:rgba(255,255,255,0.06);border-radius:20px;margin:11px 0 8px;overflow:hidden}
  .gm-bar>i{display:block;height:100%;background:var(--c,#4c7dff);border-radius:20px}
  .gm-sub{color:var(--muted);font-size:11px}.gm-sub b{color:var(--paper)}

  .ai-loading{color:var(--muted);font-style:italic}
  .ai-loading::after{content:"";display:inline-block;width:1em;text-align:left;animation:dots 1.4s steps(4,end) infinite}
  @keyframes dots{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}

  /* leaderboard */
  .scroll{overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:var(--panel)}
  table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:460px}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:600;font-size:11.5px;text-transform:uppercase;letter-spacing:.03em;background:var(--topbar)}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:var(--panel-raised)}
  tr.top3{background:rgba(76,125,255,0.04)}
  .gr-rank{width:44px;color:var(--muted);font-variant-numeric:tabular-nums}
  .medal{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:12px;font-weight:800;color:#1a1205}
  .medal.gold{background:linear-gradient(135deg,#ffd968,#f5a623)}
  .medal.silver{background:linear-gradient(135deg,#e6e9ef,#aab1c4);color:#1a1d26}
  .medal.bronze{background:linear-gradient(135deg,#e6a267,#b9722f);color:#241205}
  .gr-title{font-weight:600;color:var(--paper)}.gr-title:hover{color:var(--accent)}
  .gr-creator{color:var(--muted);font-size:11.5px;margin-top:1px}
  .gr-num{text-align:right;font-variant-numeric:tabular-nums}
  .gr-ccu{font-weight:700}

  /* AI analyst take */
  .ai{border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin:6px 0 4px;line-height:1.6;
    background:radial-gradient(600px 200px at 100% 0%,rgba(124,92,255,0.10),transparent 55%),linear-gradient(180deg,var(--panel),var(--topbar))}
  .ai .ai-body{white-space:pre-wrap}
  .ai-badge{display:inline-block;font-size:10px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,#7c5cff,#f5a623);padding:2px 9px;border-radius:20px;margin-bottom:12px}
  .ai-tease{margin-top:14px;padding-top:14px;border-top:1px solid var(--line);color:var(--paper-dim);font-size:13px}

  .gr-movers{list-style:none;padding:0;margin:0;border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
  .gr-movers li{padding:11px 15px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center}
  .gr-movers li:last-child{border-bottom:none}
  .up{color:var(--ok);font-weight:700}.down{color:var(--bad);font-weight:700}

  .btn{display:inline-block;background:var(--accent);color:#fff;padding:10px 18px;border-radius:9px;font-weight:600;font-size:13.5px}
  .btn:hover{text-decoration:none;filter:brightness(1.08)}

  footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.7}
  @media(max-width:560px){.gr-hide-sm{display:none}.ghero{padding:24px 18px}.ghero h1{font-size:26px}}
</style>
</head><body>
${siteHeader('genres')}
<div class="wrap">
  <section class="ghero">
    <div class="eyebrow">Genre report</div>
    <h1>${esc(report.tag)}</h1>
    <p>Ranked by peak concurrent players across <span class="pop">${esc(report.activeCount.toLocaleString())}</span> active ${esc(report.tag)} islands on Fortnite Creative / UEFN. Updated daily.</p>
  </section>

  <section class="gr-section"><h2>The genre at a glance</h2><div class="gm-grid">${cards}</div></section>

  <section class="gr-section" id="analyst-section"><h2>Analyst take</h2>
    <div class="ai"><span class="ai-badge">✦ AI analysis</span>
      <div class="ai-body" id="ai-body"><span class="ai-loading">Analyzing the ${esc(report.tag)} genre…</span></div>
      <div class="ai-tease">Want this depth for <em>your</em> island — where you rank in ${esc(report.tag)} and exactly what to fix? <a href="/pro">Get Pro</a> for per-island AI analysis and competitor breakdowns.</div>
    </div>
  </section>
  <script>
    // Fetch the AI summary after the page paints, so the page never blocks on it.
    (function(){
      fetch(location.pathname + '?summary=1').then(function(r){return r.json()}).then(function(d){
        var el = document.getElementById('ai-body');
        if (d && d.summary) { el.textContent = d.summary; }
        else { document.getElementById('analyst-section').style.display = 'none'; }
      }).catch(function(){ document.getElementById('analyst-section').style.display='none'; });
    })();
  </script>

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

  // The page renders INSTANTLY - it does NOT block on the AI summary (that was a
  // ~5-6s stall on every render). The leaders + medians are the SEO substance
  // and ship immediately; the summary is fetched client-side from
  // /genre/<slug>?summary=1 and dropped in when ready. Requesting ?summary=1
  // returns just the JSON summary.
  const wantSummaryOnly = /[?&]summary=1(?:&|$)/.test(req.url || '');
  if (wantSummaryOnly) {
    let summary = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        summary = await genreSummary(report);
      } catch (err) {
        console.error('[genre] summary failed:', err.message);
      }
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Cache a full day: the underlying data only changes once per daily crawl,
    // so regenerating the AI summary hourly would be pure waste. ~1 AI call per
    // genre per day regardless of traffic.
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800');
    res.end(JSON.stringify({ summary }));
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
  res.end(page(report, null));
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
  // A ~90-word factual teaser doesn't need Opus + thinking (that was the ~6s
  // page stall). Haiku is several times faster and plenty for this, and the
  // result is cached (see below) so it's computed at most once per genre per day.
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system:
      'You are an analyst for Fortnite Creative / UEFN. Write a tight, factual "state of the genre" paragraph (max ~90 words) for a public web page, grounded strictly in the numbers given. Note who leads and by how much, and what the genre medians say about the bar to be competitive. Plain text, no headers, no markdown, no preamble.',
    messages: [{ role: 'user', content: `${data}\n\nWrite the state-of-the-genre paragraph.` }],
  });
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}
