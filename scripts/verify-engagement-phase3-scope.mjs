#!/usr/bin/env node
/** Fail-closed Phase 3 scope/finding gate. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ENGAGEMENT_PHASE3_BASE_SHA ?? '3841a5ee58e011be7fb4fb6008adfccf081976d9';
const LEDGER = path.join(ROOT, 'docs/plans/engagement-api/phase-3-findings-ledger.v2.json');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

export function scopeIssues({ changed, addedSource, counts }) {
  const issues = [];
  for (const file of changed) {
    if (/^apps\/api\/prisma\/migrations\//.test(file)) issues.push(`migration added/changed: ${file}`);
    if (/^infra\//.test(file)) issues.push(`infrastructure changed in Phase 3: ${file}`);
    if (/compute-stack\.ts$/i.test(file)) issues.push(`historical Compute stack changed: ${file}`);
  }
  for (const pattern of [
    /ENGAGEMENT_EXTERNAL_ACTIONS\s*[:=]\s*['"]?enabled/i,
    /ENGAGEMENT_CALLBACKS_ENABLED\s*[:=]\s*['"]?true/i,
    /ENGAGEMENT_RECALL_WEBHOOK_ENABLED\s*[:=]\s*['"]?true/i,
    /ENGAGEMENT_BACKGROUND_OWNER\s*[:=]\s*['"]?(?:api|engagement-api)/i,
  ]) {
    if (pattern.test(addedSource)) issues.push(`forbidden runtime enablement added: ${pattern}`);
  }
  if (counts.openP0 !== 0) issues.push(`open P0 findings: ${counts.openP0}`);
  if (counts.openP1 !== 0) issues.push(`open P1 findings: ${counts.openP1}`);
  if (counts.blockingP2 !== 0) issues.push(`blocking P2 findings: ${counts.blockingP2}`);
  return issues;
}

function main() {
  git(['cat-file', '-e', `${BASE}^{commit}`]);
  const changed = git(['diff', '--name-only', `${BASE}..HEAD`]).split(/\r?\n/).filter(Boolean);
  const diff = git(['diff', '--unified=0', `${BASE}..HEAD`, '--', 'apps', 'infra', 'packages', 'scripts']);
  const addedSource = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const issues = scopeIssues({ changed, addedSource, counts: ledger.counts ?? {} });
  if (issues.length) {
    for (const issue of issues) console.error(`FAIL  ${issue}`);
    throw new Error(`ENGAGEMENT_PHASE3_SCOPE_FAILED (${issues.length})`);
  }
  console.log(
    `ENGAGEMENT_PHASE3_SCOPE_COMPLETE changed=${changed.length} openP0=0 openP1=0 blockingP2=0`,
  );
}

if (process.argv[1]?.endsWith('verify-engagement-phase3-scope.mjs')) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
