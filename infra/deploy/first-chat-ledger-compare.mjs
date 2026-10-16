#!/usr/bin/env node
// Offline only: compare a separately approved, metadata-only Aurora ledger export
// to exact migration.sql bytes. This program never opens a database connection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const receipt = '20281016020000_clio_conversation_bootstrap_receipts';
const receiptChecksum = '943ef85f23922de246c4ec53771630f586f4ad4d99b8a871504c341ee66e9ff0';
const manifestChecksum = 'cebd7886545e3fbee1c3024a2d2c2e6f3fab8127c1d77c01341bd16f0b6ad5ac';
const fields = ['checksum', 'finished', 'has_error', 'migration_name', 'rolled_back'];

function usage() {
  console.error('Usage: node first-chat-ledger-compare.mjs <apps/api/prisma/migrations> <metadata-only-ledger.json> [--post]');
  process.exit(2);
}

if (process.argv.length < 4 || process.argv.length > 5 ||
    (process.argv[4] !== undefined && process.argv[4] !== '--post')) usage();
const [, , migrationDir, ledgerPath, mode] = process.argv;
const post = mode === '--post';

try {
  const manifestBytes = readFileSync(new URL('./first-chat-core-pr43-migration-checksums.json', import.meta.url));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), manifestChecksum,
    'Pinned PR43 migration manifest has changed');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length === 475, 'Expected 475 PR43 migrations');
  const pinned = new Map();
  for (const row of manifest) {
    assert.deepEqual(Object.keys(row).sort(), ['checksum', 'migration_name']);
    assert.match(row.migration_name, /^\d{14}_[a-z0-9_]+$/);
    assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.ok(!pinned.has(row.migration_name), 'Duplicate pinned migration');
    pinned.set(row.migration_name, row.checksum);
  }
  const local = new Map();
  for (const entry of readdirSync(migrationDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sqlPath = join(migrationDir, entry.name, 'migration.sql');
    if (!statSync(sqlPath).isFile()) throw new Error('Migration SQL is not a regular file');
    const checksum = createHash('sha256').update(readFileSync(sqlPath)).digest('hex');
    local.set(entry.name, checksum);
  }
  assert.equal(local.get(receipt), receiptChecksum, 'Pinned receipt SQL has changed');
  assert.equal([...local.keys()].some(name => name.startsWith('20281016010000_')), false,
    'Objective migration must not enter the first-chat image');
  assert.deepEqual([...local].sort(([a], [b]) => a.localeCompare(b)),
    [...pinned].sort(([a], [b]) => a.localeCompare(b)),
    'Local migration tree differs from exact PR43 manifest');

  const rows = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  assert.ok(Array.isArray(rows), 'Ledger JSON must be an array');
  const successful = new Map();
  const unresolved = [];
  const rolledBack = [];
  for (const row of rows) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row));
    assert.deepEqual(Object.keys(row).sort(), fields, 'Ledger export must have only five metadata fields');
    assert.match(row.migration_name, /^\d{14}_[a-z0-9_]+$/);
    assert.match(row.checksum, /^[0-9a-f]{64}$/);
    assert.equal(typeof row.finished, 'boolean');
    assert.equal(typeof row.rolled_back, 'boolean');
    assert.equal(typeof row.has_error, 'boolean');
    assert.ok(!(row.finished && row.rolled_back), 'Contradictory ledger state');
    if (row.rolled_back) { rolledBack.push(row.migration_name); continue; }
    if (!row.finished || row.has_error) { unresolved.push(row.migration_name); continue; }
    assert.ok(!successful.has(row.migration_name), 'Duplicate successful migration');
    successful.set(row.migration_name, row.checksum);
  }

  const dbOnly = [...successful.keys()].filter(name => !local.has(name));
  const altered = [...successful].filter(([name, checksum]) => local.get(name) !== checksum).map(([name]) => name);
  const pending = [...local.keys()].filter(name => !successful.has(name));
  const expectedPending = post ? [] : [receipt];
  const pass = unresolved.length === 0 && rolledBack.length === 0 &&
    dbOnly.length === 0 && altered.length === 0 &&
    pending.length === expectedPending.length &&
    pending.every(name => expectedPending.includes(name));
  console.log(JSON.stringify({
    result: pass ? 'PASS' : 'BLOCK',
    phase: post ? 'post-migration' : 'pre-migration',
    localCount: local.size,
    successfulCount: successful.size,
    pending, dbOnly, altered, unresolved, rolledBack,
    receiptChecksum,
  }, null, 2));
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error(`BLOCK: invalid local migration tree or ledger metadata (${error.message})`);
  process.exitCode = 1;
}
