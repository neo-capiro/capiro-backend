#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const notes = [];
const enforceReplay = process.argv.includes('--enforce-replay');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

function gitTree(relative) {
  try {
    return execFileSync('git', ['rev-parse', `HEAD:${relative}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`Unable to resolve Git tree for ${relative}`);
    return null;
  }
}

const treePairs = [
  ['apps/api/src/defense-budget', 'apps/defense-api/runtime-source/defense-budget'],
  ['apps/api/src/program-element/snapshot', 'apps/defense-api/runtime-source/program-element/snapshot'],
  ['apps/api/src/program-element/source-document', 'apps/defense-api/runtime-source/program-element/source-document'],
  ['apps/api/src/program-element/deltas', 'apps/defense-api/runtime-source/program-element/deltas'],
];
for (const [source, mirror] of treePairs) {
  const sourceSha = gitTree(source);
  const mirrorSha = gitTree(mirror);
  if (sourceSha && mirrorSha && sourceSha !== mirrorSha) {
    fail(`Trusted runtime drift: ${source}=${sourceSha}, ${mirror}=${mirrorSha}`);
  }
}

const blobPairs = [
  ['apps/api/src/program-element/program-element-change-outbox.service.ts', 'apps/defense-api/runtime-source/program-element/program-element-change-outbox.service.ts'],
  ['apps/api/src/program-element/program-element-change-outbox.service.spec.ts', 'apps/defense-api/runtime-source/program-element/program-element-change-outbox.service.spec.ts'],
  ['apps/api/scripts/phase6-stage-cycle.ts', 'apps/defense-api/runtime-source/operators/phase6-stage-cycle.ts'],
  ['apps/api/scripts/plan-defense-budget-promotion-v1.ts', 'apps/defense-api/runtime-source/operators/plan-defense-budget-promotion-v1.ts'],
  ['apps/api/scripts/status-defense-budget-promotion-v1.ts', 'apps/defense-api/runtime-source/operators/status-defense-budget-promotion-v1.ts'],
];
for (const [source, mirror] of blobPairs) {
  if (!exists(source) || !exists(mirror)) {
    fail(`Missing source/mirror blob: ${source} -> ${mirror}`);
    continue;
  }
  if (read(source) !== read(mirror)) fail(`Trusted runtime blob drift: ${source} -> ${mirror}`);
}

const requiredSlices = [
  'contracts',
  'parser-router',
  'extractors',
  'verification',
  'rdte',
  'procurement',
  'om',
  'milcon',
  'projection-plan',
  'stages',
  'phase6',
  'promotion',
];
for (const slice of requiredSlices) {
  if (!exists(`apps/defense-api/runtime-source/defense-budget/${slice}`)) {
    fail(`Missing Phase 1–7 runtime slice: ${slice}`);
  }
}

const runtimeRoot = path.join(root, 'apps/defense-api/src/runtime');
for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  const relative = `apps/defense-api/src/runtime/${entry.name}`;
  const content = read(relative);
  for (const forbidden of [
    'apps/api',
    '@prisma/client',
    '@aws-sdk/',
    'app.bypass_rls',
    'executePromotion',
    'activateSnapshot',
    'capiro_pe_promoter',
    '@Controller(',
  ]) {
    if (content.includes(forbidden)) fail(`${relative} contains forbidden token ${forbidden}`);
  }
}

const appModule = read('apps/defense-api/src/app.module.ts');
if (!appModule.includes('Phase17RuntimeModule')) fail('AppModule does not register Phase17RuntimeModule');
const packageJson = JSON.parse(read('apps/defense-api/package.json'));
if (packageJson.scripts?.['verify:session4'] !== 'node ../../scripts/verify-phase8-session4.mjs') {
  fail('defense-api package is missing the Session 4 verifier script');
}

if (!exists('apps/api/src/defense-budget')) {
  fail('Legacy source was removed before shadow/canary/decommission acceptance');
}

const replayEvidencePath = process.env.PHASE8_SESSION4_REPLAY_EVIDENCE;
if (enforceReplay) {
  if (!replayEvidencePath || !exists(replayEvidencePath)) {
    fail('Real FY27 replay evidence is required under --enforce-replay');
  } else {
    const evidence = JSON.parse(read(replayEvidencePath));
    const required = [
      evidence.schemaVersion === 1,
      evidence.fiscalYear === 2027,
      evidence.sameSourceSha === true,
      evidence.sameParserIdentity === true,
      evidence.sameExtractionHash === true,
      evidence.sameVerificationDecisionHash === true,
      evidence.sameProjectionPlanHash === true,
      evidence.sameCertificationHash === true,
      evidence.sameEligibilityHash === true,
      evidence.samePromotionInspectionHash === true,
      evidence.unexplainedDifferences === 0,
      evidence.canonicalMutationAttempted === false,
    ];
    if (required.some((value) => value !== true)) {
      fail('FY27 replay evidence does not satisfy the Session 4 acceptance contract');
    }
  }
} else {
  notes.push('FY27 behavioral replay was not enforced; rerun with --enforce-replay before declaring Session 4 complete');
}

for (const note of notes) console.log(`[phase8-session4] ${note}`);
if (failures.length) {
  console.error(`\n[phase8-session4] FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('[phase8-session4] SESSION4_SOURCE_PARITY_PASS');
