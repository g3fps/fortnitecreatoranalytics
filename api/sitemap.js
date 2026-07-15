'use strict';

// Dynamic sitemap.xml so Google discovers the genre pages (the SEO surface).
// Lists the static pages, the genre index, and every active-genre report page.

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const { tagToSlug, ACTIVE_CCU_FLOOR } = require('./_genreReport');

const SITE = process.env.SITE_URL || 'https://uefnstats.com';

module.exports = async (req, res) => {
  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data } = await svc
    .from('islands_with_latest')
    .select('tags')
    .gte('peak_ccu', ACTIVE_CCU_FLOOR)
    .limit(20000);
  const counts = new Map();
  for (const row of data || []) for (const t of row.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  const genreSlugs = [...counts.entries()].filter(([, n]) => n >= 5).map(([tag]) => tagToSlug(tag));

  const urls = [
    { loc: `${SITE}/`, priority: '1.0' },
    { loc: `${SITE}/leaderboard`, priority: '0.8' },
    { loc: `${SITE}/genres`, priority: '0.8' },
    { loc: `${SITE}/pro`, priority: '0.6' },
    ...genreSlugs.map((s) => ({ loc: `${SITE}/genre/${s}`, priority: '0.7' })),
  ];

  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map((u) => `  <url><loc>${u.loc}</loc><changefreq>daily</changefreq><priority>${u.priority}</priority></url>`)
      .join('\n') +
    '\n</urlset>\n';

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=86400');
  res.end(body);
};
