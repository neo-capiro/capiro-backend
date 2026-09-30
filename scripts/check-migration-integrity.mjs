#!/usr/bin/env node
// Compare committed migration paths and exact Git blobs. Working-tree edits
// are outside this check; CI must provide the PR base commit and full history.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function git(...args) {
  return execFileSync('git', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// This is a fixed incident repair, not a general history override. Both paths,
// both byte hashes and unchanged regular-file modes must match. There is no
// CLI, environment or manifest option to add exceptions. Once a replacement
// is on the base branch, subsequent edits to it are checked normally.
// See docs/runbooks/db-incident-20260927-source-repair.md for review evidence
// and the separate owner-acceptance/merge requirements.
// The dedup migration has a second recognized original: main briefly carried
// an interim ROW_NUMBER() DELETE repair (57352c01…, commit ae095ad13) before
// this reviewed replacement landed. Only a change TO the pinned replacement is
// recognized; nothing may change the replacement back to either original.
const incidentReplacements = new Map([
  ['apps/api/prisma/migrations/20281002010000_research_portfolios_phase10_watch_delivery/migration.sql', {
    before: ['72b628ee6928b17466a53d6d78e32059a3e8939a1eeb0bbc12d6f6e35456d37e'],
    after: 'b344515e85d90c9363c9cf690e97ce2372fd38baf1b97c5c8b7213409fb6d784',
  }],
  ['apps/api/prisma/migrations/20281003010000_dedup_client_intel_mapping/migration.sql', {
    before: [
      '3f982ab8d2a7dea5ee37cf738317b9eaf4b2b16f248309ff9a1d6968074ee724',
      '57352c011c97da81e38b8b6601b9331198f02209a0587206e3d2724f7ea2117c',
    ],
    after: '8189f8a447c6851ca2d342ecab1da1ee822a2451b1610828aa434d99fceaf95b',
  }],
]);

function isExactIncidentReplacement(path, original, current) {
  const expected = incidentReplacements.get(path);
  if (!expected || original.mode !== '100644' || current.mode !== '100644') return false;
  const sha256 = oid => createHash('sha256').update(git('cat-file', 'blob', oid)).digest('hex');
  return expected.before.includes(sha256(original.oid)) && sha256(current.oid) === expected.after;
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
  const recognizedReplacements = [];
  for (const [path, original] of before) {
    const current = after.get(path);
    if (!current) violations.push(`DELETED_OR_RENAMED ${JSON.stringify(path)}`);
    else if (current.oid !== original.oid || current.mode !== original.mode) {
      if (isExactIncidentReplacement(path, original, current)) recognizedReplacements.push(path);
      else violations.push(`MODIFIED ${JSON.stringify(path)}`);
    }
  }
  if (violations.length) {
    console.error(`Migration history integrity FAILED: ${violations.length} existing migration(s) changed.`);
    for (const violation of violations) console.error(violation);
    process.exitCode = 1;
  } else {
    for (const path of recognizedReplacements) console.log(`Exact incident replacement recognized: ${JSON.stringify(path)}`);
    console.log(`Migration history integrity PASS: ${before.size - recognizedReplacements.length} existing migration(s) unchanged; ${recognizedReplacements.length} exact incident replacement(s); base ${base}; HEAD ${head}.`);
  }
} catch (error) {
  console.error('Migration history integrity could not be verified. Check arguments, Git availability, full checkout history, and base commit.');
  // Never turn an unavailable comparison into a pass.
  process.exitCode = 2;
}
