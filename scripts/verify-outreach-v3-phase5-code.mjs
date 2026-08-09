#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const phase4Base = '208dae611d9f5636f3b7507f8782ff7cc864c4ed';

function run(label, command, args, options = {}) {
  process.stdout.write(`\n== ${label} ==\n${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    process.stderr.write(`\nOUTREACH_V3_PHASE5_FAILED:${label}\n`);
    process.exit(result.status ?? 1);
  }
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `${command} failed\n`);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) {
    process.stderr.write(`OUTREACH_V3_PHASE5_CONTRACT_FAILED:${message}\n`);
    process.exit(1);
  }
}

function isProductionSource(path) {
  return (
    (path.endsWith('.ts') || path.endsWith('.tsx') || path.endsWith('.json')) &&
    !path.endsWith('.spec.ts') &&
    !path.endsWith('.spec.tsx') &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.test.tsx') &&
    !path.includes('/__fixtures__/')
  );
}

const required = [
  'apps/api/src/capabilities/context/outreach-context.contract.ts',
  'apps/api/src/capabilities/context/outreach-context-reference.service.ts',
  'apps/api/src/capabilities/context/search-memory.capability.ts',
  'apps/api/src/capabilities/context/research-government.capability.ts',
  'apps/api/src/capabilities/context/get-document.capability.ts',
  'apps/api/src/capabilities/context/recommend-outreach-strategy.capability.ts',
  'apps/api/src/outreach-v3/context/outreach-context-sponsor-policy.ts',
  'apps/api/src/outreach-v3/context/outreach-v3-context.controller.ts',
  'apps/api/src/outreach-v3/context/outreach-v3-context.guard.ts',
  'apps/api/src/outreach-v3/context/outreach-v3-context.service.ts',
  'apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json',
  'apps/api/tsconfig.outreach-v3-phase5.json',
];
for (const path of required) assert(existsSync(resolve(root, path)), `missing:${path}`);

const changed = output('git', ['diff', '--name-only', `${phase4Base}...HEAD`])
  .split(/\r?\n/)
  .filter(Boolean);
assert(changed.length > 0, 'empty-phase5-diff');
for (const path of changed) {
  assert(!path.startsWith('apps/web/src/'), `phase5-ui-change:${path}`);
  assert(!path.includes('/prisma/migrations/'), `phase5-migration:${path}`);
  assert(!path.startsWith('infra/cdk/'), `phase5-infrastructure-change:${path}`);
  assert(!path.startsWith('apps/outreach-api/'), `new-outreach-service:${path}`);
}

const productionCombined = changed
  .filter(isProductionSource)
  .map((path) => readFileSync(resolve(root, path), 'utf8'))
  .join('\n');
assert(
  !/@langchain\/langgraph|LANGGRAPH_|LANGSMITH_/.test(productionCombined),
  'langgraph-or-langsmith',
);
assert(!/SEND_EMAIL_NOW/.test(productionCombined), 'direct-send-command');
assert(
  !/sendMail\(|mailSender\.|createSendIntent\(/.test(productionCombined),
  'phase5-send-side-effect',
);

const reasoning = readFileSync(
  resolve(root, 'apps/api/src/outreach-v3/reasoning/outreach-reasoning.service.ts'),
  'utf8',
);
assert(!/OutreachCommandEngineService/.test(reasoning), 'reasoning-direct-engine');
assert(!/\.applyBatch\(|\.applyProposal\(/.test(reasoning), 'reasoning-direct-mutation');

const catalog = JSON.parse(
  readFileSync(
    resolve(root, 'apps/api/src/capabilities/__fixtures__/capiro-capability-catalog.v1.json'),
    'utf8',
  ),
);
for (const name of [
  'search_memory',
  'research_government',
  'get_document',
  'recommend_outreach_strategy',
]) {
  const entry = catalog.find((candidate) => candidate.name === name);
  assert(entry?.status === 'implemented', `context-capability-not-implemented:${name}`);
  assert(
    entry?.meriConsumer === true && entry?.outreachConsumer === true,
    `shared-capability-consumers:${name}`,
  );
}

const manifest = JSON.parse(
  readFileSync(
    resolve(root, 'apps/api/src/outreach-v3/__fixtures__/outreach-v3-context-route-manifest.v1.json'),
    'utf8',
  ),
);
assert(manifest.runtime === 'engagement-api', 'wrong-context-runtime');
assert(manifest.requiresStateFlag === 'OUTREACH_V3_STATE_ENABLED', 'missing-state-flag');
assert(manifest.featureFlag === 'OUTREACH_V3_CONTEXT_ENABLED', 'wrong-context-flag');
assert(manifest.disabledBehavior === 404, 'context-flag-not-fail-closed');
assert(manifest.routes.length === 5, 'context-route-count');

const commandContract = readFileSync(
  resolve(root, 'apps/api/src/outreach-v3/state/outreach-command.contract.ts'),
  'utf8',
);
const implementedBlock =
  commandContract.match(/OUTREACH_IMPLEMENTED_COMMAND_TYPES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
for (const type of ['ACCEPT_CONTEXT_REFS', 'EXCLUDE_CONTEXT_REFS']) {
  assert(implementedBlock.includes(`'${type}'`), `context-command-not-implemented:${type}`);
}
const futureBlock =
  commandContract.match(/OUTREACH_FUTURE_COMMAND_TYPES\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
for (const type of [
  'SET_SENDER_REF',
  'SET_ATTACHMENT_REFS',
  'REQUEST_SAMPLE_GENERATION',
  'REQUEST_FULL_GENERATION',
  'REQUEST_SEND_REVIEW',
]) {
  assert(futureBlock.includes(`'${type}'`), `future-command-promoted-too-early:${type}`);
}

run('Phase 5 TypeScript project', 'pnpm', [
  '--filter',
  '@capiro/api',
  'exec',
  'tsc',
  '-p',
  'tsconfig.outreach-v3-phase5.json',
]);
run('Phase 5 focused tests', 'pnpm', [
  '--filter',
  '@capiro/api',
  'exec',
  'jest',
  '--runInBand',
  'src/capabilities/context/outreach-context.contract.spec.ts',
  'src/outreach-v3/services/outreach-command-engine.service.spec.ts',
  'src/outreach-v3/context/outreach-context-sponsor-policy.spec.ts',
  'src/outreach-v3/context/outreach-v3-context.guard.spec.ts',
  'src/outreach-v3/context/outreach-v3-phase5-architecture.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning-context.service.spec.ts',
  'src/outreach-v3/reasoning/outreach-reasoning.service.spec.ts',
  '--forceExit',
]);
run('API build', 'pnpm', ['--filter', '@capiro/api', 'build']);
run('Diff whitespace', 'git', ['diff', '--check', `${phase4Base}...HEAD`]);

process.stdout.write('\nOUTREACH_V3_PHASE5_DB_FREE_COMPLETE\n');
