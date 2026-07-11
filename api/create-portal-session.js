'use strict';

// Opens a Stripe Customer Portal session so a Pro user can manage their own
// subscription (update card, cancel, view invoices) - no custom billing UI
// needed. Verifies the Supabase login, looks up their Stripe customer id, and
// returns the portal URL to redirect to.

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'Use POST.' });
  if (!process.env.STRIPE_SECRET_KEY) return json(res, 503, { error: 'Billing isn\'t enabled yet.', notConfigured: true });

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const user = await getAuthedUser(token);
  if (!user) return json(res, 401, { error: 'Sign in first.' });

  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: profile } = await svc.from('user_profiles').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
  if (!profile?.stripe_customer_id) return json(res, 400, { error: 'No subscription found for this account.' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const site = process.env.SITE_URL || `https://${req.headers.host}`;
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${site}/account`,
    });
    return json(res, 200, { url: session.url });
  } catch (err) {
    console.error('[portal] failed:', err.message);
    return json(res, 502, { error: 'Could not open billing portal.' });
  }
};
