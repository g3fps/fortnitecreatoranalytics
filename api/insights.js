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

// Build a compact, factual data summary for the model. Kept small and
// structured so the model reasons over numbers, not prose.
function buildDataBlock(island, history) {
  const latest = island.latest || {};
  const lines = [
    `Island: ${island.title || '(untitled)'} (code ${island.code})`,
    `Creator: ${island.creatorCode || 'unknown'}`,
    island.tags && island.tags.length ? `Tags: ${island.tags.join(', ')}` : null,
    '',
    'Latest reading:',
    `  Peak concurrent players: ${latest.peakCCU ?? 'n/a'}`,
    `  Unique players: ${latest.uniquePlayers ?? 'n/a'}`,
    `  Minutes played: ${latest.minutesPlayed ?? 'n/a'}`,
    `  Avg minutes/player: ${latest.averageMinutesPerPlayer ?? 'n/a'}`,
    `  Plays: ${latest.plays ?? 'n/a'}`,
    `  Favorites: ${latest.favorites ?? 'n/a'}`,
    `  Day-1 retention: ${latest.retentionD1 != null ? (latest.retentionD1 * 100).toFixed(0) + '%' : 'n/a'}`,
    `  Day-7 retention: ${latest.retentionD7 != null ? (latest.retentionD7 * 100).toFixed(0) + '%' : 'n/a'}`,
  ].filter((l) => l !== null);

  if (history && history.length > 1) {
    lines.push('', `History (${history.length} readings, oldest first):`);
    for (const h of history.slice(-14)) {
      lines.push(`  ${(h.capturedAt || '').slice(0, 10)}: peakCCU ${h.peakCCU ?? 'n/a'}, unique ${h.uniquePlayers ?? 'n/a'}, D1 ${h.retentionD1 != null ? (h.retentionD1 * 100).toFixed(0) + '%' : 'n/a'}`);
    }
  } else {
    lines.push('', 'History: only one reading so far (trends not yet available).');
  }
  return lines.join('\n');
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
  if (iErr) return json(res, 500, { error: 'Failed to load island data.' });
  if (!islandRow) return json(res, 404, { error: 'Island not found.' });

  const island = {
    code: islandRow.code,
    title: islandRow.title,
    creatorCode: islandRow.creator_code,
    tags: islandRow.tags || [],
    latest: islandRow.captured_at
      ? {
          peakCCU: islandRow.peak_ccu,
          uniquePlayers: islandRow.unique_players,
          minutesPlayed: islandRow.minutes_played,
          averageMinutesPerPlayer: islandRow.average_minutes_per_player,
          plays: islandRow.plays,
          favorites: islandRow.favorites,
          retentionD1: islandRow.retention_d1,
          retentionD7: islandRow.retention_d7,
        }
      : null,
  };

  const { data: histRows } = await svc
    .from('snapshots')
    .select('captured_at,peak_ccu,unique_players,retention_d1')
    .eq('code', code)
    .order('captured_at', { ascending: true });
  const history = (histRows || []).map((h) => ({
    capturedAt: h.captured_at,
    peakCCU: h.peak_ccu,
    uniquePlayers: h.unique_players,
    retentionD1: h.retention_d1,
  }));

  // --- Ask Claude ---
  const dataBlock = buildDataBlock(island, history);
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

  const system =
    'You are an analyst for Fortnite Creative / UEFN island creators. You get engagement stats for one island and write a short, sharp competitive read for the creator who owns it. Be concrete and grounded strictly in the numbers given - never invent figures. Cover: how it is performing, what the trend (if any) suggests, retention health, and one or two specific, actionable things the creator could focus on. Keep it under ~180 words, plain language, no preamble, no markdown headers.';

  try {
    const stream = await client.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      system,
      messages: [{ role: 'user', content: `Here is the data for one island:\n\n${dataBlock}\n\nWrite the competitive read.` }],
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
