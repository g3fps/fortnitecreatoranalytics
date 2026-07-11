'use strict';

// Creates a Stripe Checkout session for a UEFN Stats Pro subscription.
//
// Flow: the signed-in user picks monthly/yearly on the Pro page -> this
// verifies their Supabase login, finds/creates their Stripe customer, opens a
// subscription Checkout session, and returns its URL for the browser to
// redirect to. The is_pro flip happens later, in api/stripe-webhook.js, when
// Stripe confirms the payment - never here (the user could abandon checkout).
//
// Follows Stripe's subscription-Checkout guidance: mode:'subscription', Price
// IDs, and NO payment_method_types (dynamic payment methods, configured in the
// Stripe dashboard, maximize conversion).

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
  if (!process.env.STRIPE_SECRET_KEY) return json(res, 503, { error: 'Checkout isn\'t enabled yet.', notConfigured: true });

  // Parse body
  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      const raw = await new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
      body = raw ? JSON.parse(raw) : {};
    } catch { return json(res, 400, { error: 'Invalid JSON body.' }); }
  }
  const cycle = body.cycle === 'yearly' ? 'yearly' : 'monthly';
  const priceId = cycle === 'yearly' ? process.env.STRIPE_PRICE_YEARLY : process.env.STRIPE_PRICE_MONTHLY;
  if (!priceId) return json(res, 500, { error: 'Price is not configured.' });

  // Auth: must be signed in.
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const user = await getAuthedUser(token);
  if (!user) return json(res, 401, { error: 'Sign in to upgrade.' });

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    // Reuse the user's Stripe customer if we already made one; else create it
    // and remember it on their profile. Keyed to the Supabase user id so the
    // webhook can map a payment back to the right account.
    const { data: profile } = await svc.from('user_profiles').select('stripe_customer_id').eq('user_id', user.id).maybeSingle();
    let customerId = profile?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email || undefined,
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;
      await svc.from('user_profiles').update({ stripe_customer_id: customerId }).eq('user_id', user.id);
    }

    const site = process.env.SITE_URL || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      // client_reference_id + metadata both carry the Supabase id so the
      // webhook can flip the right user's is_pro, even if the customer record
      // was somehow created out of band.
      client_reference_id: user.id,
      subscription_data: { metadata: { supabase_user_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${site}/?upgraded=1#pro`,
      cancel_url: `${site}/#pro`,
    });

    return json(res, 200, { url: session.url });
  } catch (err) {
    console.error('[checkout] failed:', err.message);
    return json(res, 502, { error: 'Could not start checkout. Please try again.' });
  }
};
