#!/usr/bin/env node
/** Fail-closed Phase 3 scope/finding gate. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.ENGAGEMENT_PHASE3_BASE_SHA ?? '3841a5ee58e011be7fb4fb6008adfccf081976d9';
const END = process.env.ENGAGEMENT_PHASE3_SCOPE_END ?? 'HEAD';
const LEDGER = path.join(ROOT, 'docs/plans/engagement-api/phase-3-findings-ledger.v2.json');
const REVIEWED_TEST_ONLY_INFRA_FIXTURES = new Set([
  'infra/cdk/fixtures/engagement-runtime-ownership.v1.json',
  'infra/cdk/bin/capiro.ts',
  'infra/cdk/bin/engagement-api.ts',
  'infra/cdk/jest.config.cjs',
  'infra/cdk/lib/compute-stack.ts',
  'infra/cdk/lib/config.ts',
  'infra/cdk/lib/data-stack.ts',
  'infra/cdk/lib/engagement-api/engagement-api-db-budget.ts',
  'infra/cdk/lib/engagement-api/engagement-api-iam.ts',
  'infra/cdk/lib/ingestion-schedule.ts',
  'infra/cdk/package.json',
  'infra/cdk/scripts/run-engagement-api-tests.mjs',
  'infra/cdk/test/compute-stack.tango.spec.ts',
  'infra/cdk/test/engagement-api-db-budget.spec.ts',
  'infra/cdk/test/engagement-api-secret-minimization.spec.ts',
  'infra/cdk/test/engagement-api-service-stack.spec.ts',
  'infra/cdk/tsconfig.json',
]);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

export function scopeIssues({ changed, addedSource, counts, scoped = false }) {
  const issues = [];
  for (const file of changed) {
    if (!scoped && /^apps\/api\/prisma\/migrations\//.test(file)) issues.push(`migration added/changed: ${file}`);
    if (/^infra\//.test(file) && !REVIEWED_TEST_ONLY_INFRA_FIXTURES.has(file)) {
      issues.push(`infrastructure changed in Phase 3: ${file}`);
    }
    if (!scoped && /compute-stack\.ts$/i.test(file)) issues.push(`historical Compute stack changed: ${file}`);
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
  git(['cat-file', '-e', `${END}^{commit}`]);
  const range = `${BASE}..${END}`;
  const changed = git(['diff', '--name-only', range]).split(/\r?\n/).filter(Boolean);
  const diff = git(['diff', '--unified=0', range, '--', 'apps', 'infra', 'packages', 'scripts', ':(exclude)scripts/*.spec.mjs']);
  const addedSource = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n');
  const ledger = JSON.parse(readFileSync(LEDGER, 'utf8'));
  const scoped = Boolean(process.env.ENGAGEMENT_PHASE3_SCOPE_END);
  const issues = scopeIssues({ changed, addedSource, counts: ledger.counts ?? {}, scoped });
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
