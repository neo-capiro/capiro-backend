#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const phase3Base = 'b043a995928314f7085b7f9df94bdba02cee9640';

function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label} ==\n${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    process.stderr.write(`\nOUTREACH_V3_PHASE4_FAILED:${label}\n`);
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${command} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`OUTREACH_V3_PHASE4_CONTRACT_FAILED:${message}\n`);
    process.exit(1);
  }
}

const required = [
  'apps/api/src/capabilities/targets/outreach-target.contract.ts',
  'apps/api/src/capabilities/targets/outreach-target-reference.service.ts',
  'apps/api/src/capabilities/targets/search-targets.capability.ts',
  'apps/api/src/capabilities/targets/get-target-profile.capability.ts',
  'apps/api/src/capabilities/targets/analyze-relationships.capability.ts',
  'apps/api/src/outreach-v3/targets/outreach-target-coverage.service.ts',
  'apps/api/src/outreach-v3/targets/outreach-v3-targets.controller.ts',
  'apps/api/src/outreach-v3/targets/outreach-v3-targets.guard.ts',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-target-route-manifest.v1.json',
  'apps/api/tsconfig.outreach-v3-phase4.json',
];
for (const path of required) assert(existsSync(resolve(root, path)), `missing:${path}`);

const changed = output('git', ['diff', '--name-only', `${phase3Base}...HEAD`])
  .split(/\r?\n/)
  .filter(Boolean);
assert(changed.length > 0, 'empty-phase4-diff');
for (const path of changed) {
  assert(!path.startsWith('apps/web/src/'), `web-ui-change:${path}`);
  assert(!path.includes('/prisma/migrations/'), `phase4-migration:${path}`);
  assert(!path.startsWith('infra/cdk/'), `phase4-infrastructure-change:${path}`);
  assert(!path.startsWith('apps/outreach-api/'), `new-outreach-service:${path}`);
}

const combined = changed
  .filter((path) => path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.json'))
  .map((path) => readFileSync(resolve(root, path), 'utf8'))
  .join('\n');
assert(!/@langchain\/langgraph|LANGGRAPH_|LANGSMITH_/.test(combined), 'langgraph-or-langsmith');
assert(!/SEND_EMAIL_NOW/.test(combined), 'direct-send-command');
assert(!/OutreachCommandEngineService/.test(readFileSync(resolve(root, 'apps/api/src/outreach-v3/reasoning/outreach-reasoning.service.ts'), 'utf8')), 'reasoning-direct-engine');

const catalog = JSON.parse(
  readFileSync(
    resolve(root, 'apps/api/src/capabilities/__fixtures__/capiro-capability-catalog.v1.json'),
    'utf8',
  ),
);
for (const name of ['search_targets', 'get_target_profile', 'analyze_relationships']) {
  const entry = catalog.find((candidate) => candidate.name === name);
  assert(entry?.status === 'implemented', `target-capability-not-implemented:${name}`);
  assert(entry?.meriConsumer === true && entry?.outreachConsumer === true, `shared-capability-consumers:${name}`);
}

const manifest = JSON.parse(
  readFileSync(
    resolve(root, 'apps/api/src/outreach-v3/__fixtures__/outreach-v3-target-route-manifest.v1.json'),
    'utf8',
  ),
);
assert(manifest.runtime === 'engagement-api', 'wrong-target-runtime');
assert(manifest.featureFlag === 'OUTREACH_V3_TARGETS_ENABLED', 'wrong-target-flag');
assert(manifest.disabledBehavior === 404, 'target-flag-not-fail-closed');
assert(manifest.routes.length === 4, 'target-route-count');

run('Phase 3 reasoning regression', 'node', ['scripts/verify-outreach-v3-phase3-code.mjs']);
run('Phase 4 TypeScript project', 'pnpm', [
  '--filter',
  '@capiro/api',
  'exec',
  'tsc',
  '-p',
  'tsconfig.outreach-v3-phase4.json',
]);
run('Phase 4 focused tests', 'pnpm', [
  '--filter',
  '@capiro/api',
  'exec',
  'jest',
  '--runInBand',
  'src/capabilities/targets/outreach-target.contract.spec.ts',
  'src/capabilities/targets/search-targets.capability.spec.ts',
  'src/outreach-v3/state/outreach-campaign-state.spec.ts',
  'src/outreach-v3/services/outreach-command-engine.service.spec.ts',
  'src/outreach-v3/targets/outreach-target-coverage.service.spec.ts',
  'src/outreach-v3/targets/outreach-v3-targets.guard.spec.ts',
  'src/outreach-v3/targets/outreach-v3-targets.service.spec.ts',
  'src/outreach-v3/targets/outreach-v3-phase4-architecture.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-context.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning.service.spec.ts',
  '--forceExit',
]);
run('API build', 'pnpm', ['--filter', '@capiro/api', 'build']);
run('Diff whitespace', 'git', ['diff', '--check', `${phase3Base}...HEAD`]);

process.stdout.write('\nOUTREACH_V3_PHASE4_DB_FREE_COMPLETE\n');
