'use strict';

// Applies db/schema.sql directly to Supabase Postgres via the pooler
// connection string (SUPABASE_DB_URL in .env.local). schema.sql is written
// to be idempotent (create table/view "if not exists"/"or replace", "drop
// policy if exists") so this is safe to re-run any time the schema changes.
//
// Usage: node scripts/apply-schema.js
//
// This is a dev-time admin tool only - application code never opens a direct
// Postgres connection, it talks to Supabase via the REST client
// (src/supabaseClient.js). `pg` is intentionally not a saved dependency (see
// package.json) - install it ad hoc with `npm install --no-save pg` if it's
// not already in node_modules.

require('../src/loadEnv');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.error('Set SUPABASE_DB_URL in .env.local first (Supabase dashboard -> Project Settings -> Database -> Connection string, pooler/transaction mode).');
    process.exit(1);
  }

  const client = new Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await client.query(sql);
    console.log('[apply-schema] schema.sql applied successfully.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('[apply-schema] failed:', err.message);
  process.exit(1);
});
