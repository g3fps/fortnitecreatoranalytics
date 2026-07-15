'use strict';

// Pro-only AI insights endpoint (Vercel serverless function).
//
// Flow:
//   1. Verify the caller is a signed-in Pro user (Supabase JWT in the
//      Authorization header + user_profiles.is_pro). This gate exists so free
//      users / anonymous callers can't run up the Anthropic bill.
//   2. Pull the island's metadata + snapshot history from Supabase.
//   3. Ask Claude to summarize it into plain-English competitive insights.
//   4. Return the text.
//
// Degrades gracefully: if ANTHROPIC_API_KEY isn't configured yet, returns a
// clear 503 "not configured" rather than throwing, so the feature can ship
// dark and light up the moment the key is added to Vercel's env.

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');
const { computeGenreBenchmarks, benchmarkBlock, historyBlock, islandMetricsLine } = require('./_aiContext');

const MODEL = 'claude-opus-4-8';

// Daily per-user insight caps. Free gets a taste (1/day) to drive Pro
// conversion; Pro gets a useful-but-bounded 5/day so a subscriber can't run
// up an unbounded Opus bill. Keep in sync with the copy in the UI.
const DAILY_CAP = { free: 1, pro: 5 };

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Verify the Supabase access token and return the user, or null. Uses the
// anon client's auth.getUser(token) which validates the JWT signature/expiry
// against the project - we never trust a client-supplied user id directly.
async function getAuthedUser(token) {
  if (!token) return null;
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isProUser(userId) {
  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data } = await svc.from('user_profiles').select('is_pro').eq('user_id', userId).maybeSingle();
  return Boolean(data?.is_pro);
}

// Assemble the market-aware brief: identity, all current metrics, where the
// island stands vs its active genre peers (benchmarks), and its trend. The
// enrichment (benchmarks/history formatting) lives in _aiContext so the compare
// endpoint shares it.
function buildDataBlock(row, genre, bench, history) {
  return [
    `Island: ${row.title || '(untitled)'} (code ${row.code})`,
    `Creator: ${row.creator_code || 'unknown'}`,
    `Genre: ${genre || '(untagged)'}`,
    row.tags && row.tags.length ? `All tags: ${row.tags.join(', ')}` : null,
    '',
    'Current metrics:',
    '  ' + islandMetricsLine(row).split('\n')[1].trim(),
    '',
    benchmarkBlock(bench),
    '',
    historyBlock(history),
  ]
    .filter((l) => l !== null)
    .join('\n');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });

  // Key not set yet -> feature is dark. Clear signal, not a crash.
  if (!process.env.ANTHROPIC_API_KEY) {
    return json(res, 503, { error: 'AI insights aren\'t enabled yet.', notConfigured: true });
  }

  // Parse body (Vercel provides req.body for JSON; fall back to manual read).
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

  // --- Auth gate: must be signed in (free users get a limited number too) ---
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const user = await getAuthedUser(token);
  if (!user) return json(res, 401, { error: 'Sign in to use AI insights.' });

  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // --- Daily cap: claim a slot atomically BEFORE calling Claude, so we never
  //     pay for a request that's over the limit and there's no read/write race. ---
  const pro = await isProUser(user.id);
  const cap = pro ? DAILY_CAP.pro : DAILY_CAP.free;
  const { data: claimed, error: claimErr } = await svc.rpc('claim_insight', { p_user: user.id, p_cap: cap });
  if (claimErr) {
    console.error('[insights] claim_insight failed:', claimErr.message);
    return json(res, 500, { error: 'Could not check your usage.' });
  }
  if (claimed === -1) {
    return json(res, 429, {
      error: pro
        ? `You've used all ${cap} AI insights for today. Resets tomorrow.`
        : `Free accounts get ${cap} AI insight per day. Upgrade to Pro for ${DAILY_CAP.pro}/day.`,
      limitReached: true,
      upgrade: !pro,
    });
  }
  const remaining = cap - claimed;

  // --- Fetch the island's data (service role: read-only use here) ---
  const { data: islandRow, error: iErr } = await svc.from('islands_with_latest').select('*').eq('code', code).maybeSingle();
  if (iErr) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 500, { error: 'Failed to load island data.' });
  }
  if (!islandRow) {
    await svc.rpc('refund_insight', { p_user: user.id }).catch(() => {});
    return json(res, 404, { error: 'Island not found.' });
  }

  const genre = Array.isArray(islandRow.tags) && islandRow.tags.length ? islandRow.tags[0] : null;

  // Genre benchmarks (percentiles vs active peers) + full multi-metric history,
  // fetched in parallel. Benchmarks are what make the read market-aware.
  const [bench, histResult] = await Promise.all([
    genre ? computeGenreBenchmarks(svc, genre, islandRow) : Promise.resolve(null),
    svc
      .from('snapshots')
      .select('captured_at,peak_ccu,unique_players,plays,minutes_played,average_minutes_per_player,favorites,recommendations,retention_d1,retention_d7')
      .eq('code', code)
      .order('captured_at', { ascending: true }),
  ]);
  const history = histResult.data || [];

  // --- Ask Claude ---
  const dataBlock = buildDataBlock(islandRow, genre, bench, history);
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const system =
    'You are a senior analyst for Fortnite Creative / UEFN island creators - the kind a studio pays for. ' +
    'You are given one island\'s full engagement metrics, how it ranks against ACTIVE islands in its genre (percentiles + genre medians), and its history. ' +
    'Write a sharp, market-aware competitive read for the creator who owns it.\n\n' +
    'Rules:\n' +
    '- Ground every claim in the specific numbers provided. Cite the actual figure and, where it matters, the genre median or percentile ("your 30% D1 is top-quartile; the genre median is 18%"). Never invent numbers.\n' +
    '- Lead with a one-line verdict of where this island stands.\n' +
    '- Use the genre benchmarks heavily - the creator wants to know how they stack up against live competition, not just their raw numbers. Percentiles are your sharpest tool.\n' +
    '- Identify the single biggest strength and the single biggest gap, judged by percentile standing (a metric can be high in absolute terms but weak vs genre, or vice versa).\n' +
    '- Give 2-3 specific, actionable moves tied to the weakest standings.\n' +
    '- If history has 2+ readings, note the trend; if only one, do not speculate about trend.\n\n' +
    'Format as short labeled sections with these exact headers, each on its own line:\n' +
    'VERDICT: <one sentence>\n' +
    'STANDING: <2-3 sentences on percentile position across the key metrics>\n' +
    'STRENGTH: <the standout, with the number>\n' +
    'GAP: <the biggest weakness vs genre, with the number>\n' +
    'DO NEXT: <2-3 numbered, concrete moves>\n' +
    'Keep the whole thing tight and skimmable, no preamble, no markdown symbols (#, *, -) - just the headers and plain text.';

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 1400,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: `Here is the data:\n\n${dataBlock}\n\nWrite the competitive read.` }],
    });
    const message = await stream.finalMessage();
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return json(res, 200, { insight: text, model: MODEL, remaining, cap });
  } catch (err) {
    console.error('[insights] Claude call failed:', err.message);
    // Refund the slot we claimed - the user shouldn't lose one of their few
    // daily insights to our service failing. Best-effort; a failed refund just
    // means they're down one, which is acceptable versus double-charging.
    try {
      await svc.rpc('refund_insight', { p_user: user.id });
    } catch (refundErr) {
      console.error('[insights] refund failed:', refundErr.message);
    }
    return json(res, 502, { error: 'The insights service is temporarily unavailable.' });
  }
};
