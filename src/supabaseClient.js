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

let serviceClient = null;
let anonClient = null;

function getServiceClient() {
  if (serviceClient) return serviceClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the Supabase service client.');
  }
  serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return serviceClient;
}

function getAnonClient() {
  if (anonClient) return anonClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to use the Supabase anon client.');
  }
  anonClient = createClient(url, key, { auth: { persistSession: false } });
  return anonClient;
}

module.exports = { getServiceClient, getAnonClient };
