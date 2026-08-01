#!/usr/bin/env node
// Compose DATABASE_URL from DB_* env parts. Prints URL to stdout only.
// Never logs. Fails if required parts missing or if password is the masked marker.
'use strict';
const req = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
for (const k of req) {
  if (!process.env[k]) {
    console.error('Missing ' + k);
    process.exit(1);
  }
}
const user = process.env.DB_USER;
const passRaw = process.env.DB_PASSWORD;
if (passRaw === String.fromCharCode(42,42,42)) {
  console.error('refusing masked DB_PASSWORD');
  process.exit(1);
}
const pass = encodeURIComponent(passRaw);
const host = process.env.DB_HOST;
const port = process.env.DB_PORT;
const name = process.env.DB_NAME;
const url = ['postgresql://', user, ':', pass, '@', host, ':', port, '/', name,
  '?schema=public&sslmode=require&connection_limit=10'].join('');
const bad = ':' + ['*','*','*'].join('') + '@';
if (url.includes(bad)) {
  console.error('refusing masked DATABASE_URL');
  process.exit(1);
}
process.stdout.write(url);
