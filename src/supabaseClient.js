'use strict';

// Two separate clients on purpose:
//   service role - bypasses Row Level Security, used only by the long-running
//     crawler process to write islands/snapshots/crawl state. Never ship this
//     key to a browser.
//   anon - read-only per the RLS policies in db/schema.sql, safe for the
//     Vercel-hosted dashboard API (and, if ever called directly from
//     public/app.js, the browser).
//
// Both are optional at require-time so `npm test` and other local-only flows
// don't need Supabase env vars set; callers that actually need a client call
// the getters below, which throw a clear error only if that client is used
// without its env vars configured.

const { createClient } = require('@supabase/supabase-js');

// supabase-js calls fetch with no AbortSignal, so a request that stalls (a
// dropped connection, a network blip, a Supabase hiccup) hangs FOREVER - the
// awaiting caller never resolves, never throws. That is exactly how the
// crawler used to wedge: a cycle would start, block on a Supabase write, and
// sit there with no output, no error, and no CPU until it was killed.
//
// Wrapping fetch with an AbortController turns "hang forever" into a normal
// error the crawler's existing retry/error handling can see.
const REQUEST_TIMEOUT_MS = Number(process.env.SUPABASE_TIMEOUT_MS) || 60000;

function timeoutFetch(input, init = {}) {
  // Respect a caller-supplied signal if there ever is one; otherwise use ours.
  if (init.signal) return fetch(input, init);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

const clientOptions = {
  auth: { persistSession: false },
  global: { fetch: timeoutFetch },
};

let serviceClient = null;
let anonClient = null;

function getServiceClient() {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the Supabase service client.');
  }
  serviceClient = createClient(url, key, clientOptions);
  return serviceClient;
}

function getAnonClient() {
  if (anonClient) return anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to use the Supabase anon client.');
  }
  anonClient = createClient(url, key, clientOptions);
  return anonClient;
}

module.exports = { getServiceClient, getAnonClient };
