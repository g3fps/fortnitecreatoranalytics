'use strict';

// Pro-only AI competitor comparison (Vercel serverless function).
//
// Given one island, this finds the top islands in the same genre (tag) and asks
// Claude to position the creator's island against that competitive set: where it
// wins, where it lags, and what to do about it. This is a premium, Pro-only
// feature - unlike per-island insights, free users get NO free runs of it,
// because head-to-head competitive intel is the kind of thing studios pay for.
//
// Mirrors api/insights.js for auth, the daily-cap claim/refund, and graceful
// degradation when ANTHROPIC_API_KEY isn't set.

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { computeGenreBenchmarks, benchmarkBlock, islandMetricsLine } = require('./_aiContext');

const MODEL = 'claude-opus-4-8';

// Pro-only, so a single generous daily cap (no free tier for this feature).
const DAILY_CAP_PRO = 5;
// How many competitors to pull for the comparison. Enough for a real read,
// small enough to keep the prompt tight and the model grounded.
const COMPETITOR_COUNT = 5;

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function getAuthedUser(token) {
  if (!token) return null;
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isProUser(svc, userId) {
  const { data } = await svc.from('user_profiles').select('is_pro').eq('user_id', userId).maybeSingle();
  return Boolean(data?.is_pro);
}

// One factual line per island (all metrics) so the model compares numbers, not
// prose. Delegates to the shared formatter used by the insights endpoint.
function islandLine(row, { self = false } = {}) {
  return '- ' + islandMetricsLine(row, { self });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(res, 503, { error: 'AI features aren\'t enabled yet.', notConfigured: true });
  }

  // Parse body.
  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      const raw = await new Promise((resolve) => {
        let d = '';
        req.on('data', (c) => (d += c));
        req.on('end', () => resolve(d));
      });
      body = raw ? JSON.parse(raw) : {};
    } catch {
      return json(res, 400, { error: 'Invalid JSON body.' });
    }
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > 64) return json(res, 400, { error: 'Provide a valid island code.' });

  // --- Auth gate ---
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const user = await getAuthedUser(token);
  if (!user) return json(res, 401, { error: 'Sign in to use competitor analysis.' });

  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // --- Pro-only gate: no free tier for this feature ---
  const pro = await isProUser(svc, user.id);
  if (!pro) {
    return json(res, 403, {
      error: 'Competitor analysis is a Pro feature.',
      upgrade: true,
    });
  }

  // --- Daily cap: claim BEFORE calling Claude (reuses the shared counter) ---
  const cap = DAILY_CAP_PRO;
  const { data: claimed, error: claimErr } = await svc.rpc('claim_insight', { p_user: user.id, p_cap: cap });
  if (claimErr) {
    console.error('[compare] claim_insight failed:', claimErr.message);
    return json(res, 500, { error: 'Could not check your usage.' });
  }
  if (claimed === -1) {
    return json(res, 429, {
      error: `You've used all ${cap} AI analyses for today. Resets tomorrow.`,
      limitReached: true,
    });
  }
  const remaining = cap - claimed;

  // --- Load the creator's island ---
  const { data: island, error: iErr } = await svc.from('islands_with_latest').select('*').eq('code', code).maybeSingle();
  if (iErr) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 500, { error: 'Failed to load island data.' });
  }
  if (!island) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 404, { error: 'Island not found.' });
  }

  // Genre = the island's primary tag. Without a tag there's no comparable set.
  const genre = Array.isArray(island.tags) && island.tags.length ? island.tags[0] : null;
  if (!genre) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 422, { error: 'This island has no genre tag to compare against yet.' });
  }

  // --- Top competitors in the same genre, by peak CCU ---
  const { data: topRows, error: tErr } = await svc
    .from('islands_with_latest')
    .select('*')
    .contains('tags', [genre])
    .not('peak_ccu', 'is', null)
    .order('peak_ccu', { ascending: false })
    .limit(COMPETITOR_COUNT + 1); // +1 in case the island itself is in the set
  if (tErr) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 500, { error: 'Failed to load competitor data.' });
  }

  const competitors = (topRows || []).filter((r) => r.code !== code).slice(0, COMPETITOR_COUNT);
  if (competitors.length === 0) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 422, { error: `Not enough other "${genre}" islands with data to compare against yet.` });
  }

  // Genre benchmarks give the model the whole-market baseline (percentiles vs
  // active peers), so the head-to-head isn't just "vs these 5" but "vs these 5
  // AND where all of you sit in the genre."
  const bench = await computeGenreBenchmarks(svc, genre, island);

  // --- Build the data block ---
  const dataBlock = [
    `Genre: ${genre}`,
    '',
    benchmarkBlock(bench),
    '',
    'The creator\'s island (all metrics):',
    islandLine(island, { self: true }),
    '',
    `Top ${competitors.length} other active "${genre}" islands by peak concurrent players:`,
    ...competitors.map((r) => islandLine(r)),
  ].join('\n');

  const client = new Anthropic();
  const system =
    'You are a senior competitive analyst for Fortnite Creative / UEFN island creators - the kind a studio pays for. ' +
    'You are given one island (the creator\'s), where it ranks against ALL active islands in its genre (percentiles + genre medians), and the top competing islands head-to-head. ' +
    'Write a sharp competitive read for the creator.\n\n' +
    'Rules:\n' +
    '- Ground every claim in the specific numbers. Cite the figure and the genre percentile or a named competitor\'s number. Never invent figures or names.\n' +
    '- Use BOTH lenses: the genre percentile (where they sit market-wide) and the head-to-head vs the named top competitors.\n' +
    '- Find the sharpest strength and the biggest exploitable gap, judged by standing - a metric can look big in absolute terms but weak vs the top competitors, or vice versa.\n' +
    '- Reference competitors by name where it sharpens the point.\n\n' +
    'Format with these exact headers, each on its own line:\n' +
    'VERDICT: <one sentence on where they stand in this set and genre>\n' +
    'VS THE FIELD: <2-3 sentences comparing to the named competitors on the metrics that matter>\n' +
    'STRENGTH: <the sharpest edge, with the number>\n' +
    'GAP: <the biggest exploitable weakness, with the number>\n' +
    'DO NEXT: <2-3 numbered, concrete moves to close the gap or extend the lead>\n' +
    'Tight and skimmable, no preamble, no markdown symbols (#, *, -) - just the headers and plain text.';

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 1400,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: `Here is the competitive data:\n\n${dataBlock}\n\nWrite the head-to-head competitive read.` }],
    });
    const message = await stream.finalMessage();
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return json(res, 200, { insight: text, genre, competitorCount: competitors.length, model: MODEL, remaining, cap });
  } catch (err) {
    console.error('[compare] Claude call failed:', err.message);
    await svc.rpc('refund_insight', { p_user: user.id }).catch((e) => console.error('[compare] refund failed:', e.message));
    return json(res, 502, { error: 'The analysis service is temporarily unavailable.' });
  }
};
