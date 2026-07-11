'use strict';

// Stripe webhook: the ONLY place user_profiles.is_pro is flipped on, because
// it's the only signal we trust that a payment actually happened. Stripe POSTs
// here on subscription lifecycle events; we verify the signature (so a forged
// request can't grant free Pro), then set is_pro from the subscription's real
// status.
//
// Vercel note: signature verification needs the EXACT raw request body, so we
// disable body parsing and read the raw bytes ourselves.

require('../src/loadEnv');
const { createClient } = require('@supabase/supabase-js');
const Stripe = require('stripe');

// Tell Vercel not to parse the body - Stripe signature check needs raw bytes.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function setPro(svc, { supabaseUserId, customerId, isPro, subscriptionId }) {
  const update = { is_pro: isPro, plan_updated_at: new Date().toISOString() };
  if (subscriptionId !== undefined) update.stripe_subscription_id = subscriptionId;
  // Prefer the Supabase id (most reliable); fall back to the Stripe customer id
  // if that's all the event carries.
  if (supabaseUserId) {
    await svc.from('user_profiles').update(update).eq('user_id', supabaseUserId);
  } else if (customerId) {
    await svc.from('user_profiles').update(update).eq('stripe_customer_id', customerId);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed'); }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    res.statusCode = 503; return res.end('Webhook not configured');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const raw = await readRawBody(req);
    event = stripe.webhooks.constructEvent(raw, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Bad/absent signature -> reject. This is the forgery guard.
    console.error('[webhook] signature verification failed:', err.message);
    res.statusCode = 400;
    return res.end(`Webhook signature verification failed`);
  }

  const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // Initial purchase completed. Grant Pro.
        const s = event.data.object;
        await setPro(svc, {
          supabaseUserId: s.client_reference_id || s.metadata?.supabase_user_id,
          customerId: s.customer,
          isPro: true,
          subscriptionId: s.subscription || undefined,
        });
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        // Status can change (active, past_due, canceled, unpaid, etc.). Pro is
        // on only while the subscription is in a paying state.
        const sub = event.data.object;
        const paying = sub.status === 'active' || sub.status === 'trialing';
        await setPro(svc, {
          supabaseUserId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          isPro: paying,
          subscriptionId: sub.id,
        });
        break;
      }
      case 'customer.subscription.deleted': {
        // Subscription ended (cancellation took effect). Revoke Pro.
        const sub = event.data.object;
        await setPro(svc, {
          supabaseUserId: sub.metadata?.supabase_user_id,
          customerId: sub.customer,
          isPro: false,
          subscriptionId: null,
        });
        break;
      }
      default:
        // Ignore everything else - acknowledge so Stripe doesn't retry.
        break;
    }
  } catch (err) {
    console.error('[webhook] handler error:', err.message);
    // 500 so Stripe retries - a transient DB blip shouldn't drop the event.
    res.statusCode = 500;
    return res.end('handler error');
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ received: true }));
};
