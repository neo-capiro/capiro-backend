#!/usr/bin/env node
// Compare committed migration paths and exact Git blobs. Working-tree edits
// are outside this check; CI must provide the PR base commit and full history.
import { execFileSync } from 'node:child_process';

function git(...args) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function migrationsAt(commit) {
  const buffer = git('ls-tree', '-r', '-z', commit);
  const text = buffer.toString('utf8');
  if (!Buffer.from(text).equals(buffer)) throw new Error('Non-UTF8 Git path');
  const entries = new Map();
  for (const record of text.split('\0')) {
    if (!record) continue;
    const split = record.indexOf('\t');
    if (split < 0) throw new Error('Malformed Git tree');
    const [mode, type, oid] = record.slice(0, split).split(' ');
    const path = record.slice(split + 1);
    if (!/(?:^|\/)migrations\/[^/]+\/migration\.sql$/.test(path)) continue;
    if (!/^100(?:644|755)$/.test(mode) || type !== 'blob' || !/^[a-f0-9]{40,64}$/.test(oid)) {
      throw new Error('Migration must be a regular Git blob');
    }
    if (entries.has(path)) throw new Error('Duplicate migration path');
    entries.set(path, { mode, oid });
  }
  return entries;
}

try {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== '--base')) {
    throw new Error('Usage: node scripts/check-migration-integrity.mjs [--base <ref>]');
  }
  const ref = args.length ? args[1] : 'origin/main';
  if (!ref || ref.startsWith('-') || /[\0\r\n]/.test(ref)) throw new Error('Invalid base ref');
  const baseCommit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const head = git('rev-parse', '--verify', 'HEAD^{commit}').toString().trim();
  const base = git('merge-base', baseCommit, head).toString().trim();
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error('Missing merge-base');
  const before = migrationsAt(base);
  const after = migrationsAt(head);
  const violations = [];
  for (const [path, original] of before) {
    const current = after.get(path);
    if (!current) violations.push(`DELETED_OR_RENAMED ${JSON.stringify(path)}`);
    else if (current.oid !== original.oid || current.mode !== original.mode) {
      violations.push(`MODIFIED ${JSON.stringify(path)}`);
    }
  }
  if (violations.length) {
    console.error(`Migration history integrity FAILED: ${violations.length} existing migration(s) changed.`);
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
  } else {
    console.log(`Migration history integrity PASS: ${before.size} existing migration(s) unchanged; base ${base}; HEAD ${head}.`);
  }
} catch (error) {
  console.error('Migration history integrity could not be verified. Check arguments, Git availability, full checkout history, and base commit.');
  // Never turn an unavailable comparison into a pass.
  process.exitCode = 2;
}
