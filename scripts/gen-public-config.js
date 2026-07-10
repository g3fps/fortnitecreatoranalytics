'use strict';

// Regenerates public/config.js from .env.local. The browser needs the
// Supabase URL and anon key to run auth + read/write the user's own
// watchlist; the anon key is a *public* key by design (it grants only what
// Row Level Security permits), so serving/committing it is expected and
// safe. The service_role key is never written here.
//
// Run this whenever SUPABASE_URL or SUPABASE_ANON_KEY changes.

require('../src/loadEnv');
const fs = require('fs');
const path = require('path');

const url = process.env.SUPABASE_URL || '';
const anonKey = process.env.SUPABASE_ANON_KEY || '';

if (!url || !anonKey) {
  console.error('SUPABASE_URL and SUPABASE_ANON_KEY must be set in .env.local.');
  process.exit(1);
}

const content =
  '// Public Supabase config for the browser client. The anon key is designed\n' +
  '// to be public (it only grants what Row Level Security allows) - safe to\n' +
  '// commit and serve. Regenerate with: node scripts/gen-public-config.js\n' +
  `window.SUPABASE_CONFIG = ${JSON.stringify({ url, anonKey }, null, 2)};\n`;

fs.writeFileSync(path.join(__dirname, '..', 'public', 'config.js'), content);
console.log('Wrote public/config.js');
