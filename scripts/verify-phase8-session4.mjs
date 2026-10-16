#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { inspectPhase17OperatorOwnership } from './lib/phase17-operator-ownership.mjs';
import { inspectDefenseRuntimeSourceOwnership } from './lib/defense-runtime-source-ownership.mjs';

function resolveRepoRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    if (
      fs.existsSync(path.join(dir, 'pnpm-workspace.yaml')) &&
      fs.existsSync(path.join(dir, 'apps', 'defense-api'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const usage = 'Usage: node scripts/verify-phase8-session4.mjs [--enforce-replay] (no arguments runs the existing verifier)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.some((arg) => arg !== '--enforce-replay')) {
  console.error(usage);
  process.exit(2);
}
console.error(usage);
const root = resolveRepoRoot();
const failures = [];
const notes = [];
const enforceReplay = args.includes('--enforce-replay');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const exists = (relative) => fs.existsSync(path.join(root, relative));
const fail = (message) => failures.push(message);

// One canonical code owner replaces the copied implementation/spec trees.
// Independently rederived baseline blobs retain exact twin/test provenance;
// all original data and the nine dual-root replay fixtures remain byte-pinned.
const sourceOwnership = inspectDefenseRuntimeSourceOwnership(root);
failures.push(...sourceOwnership.errors);
failures.push(...inspectPhase17OperatorOwnership(exists));
notes.push('Runtime implementation owner: apps/api/src; replay compares two fixture roots through one inspect adapter, not independent implementations');

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
  if (!exists(`apps/api/src/defense-budget/${slice}`)) {
    fail(`Missing canonical Phase 1–7 runtime slice: ${slice}`);
  }
}

// Runtime composition boundary: forbid executable coupling + promotion authority.
// Allowlisted documentation-only tokens are stripped before the scan so ownership
// prose cannot false-positive (e.g. "sourceOwner: retained-api" strings).
const runtimeRoot = path.join(root, 'apps/defense-api/src/runtime');
const forbiddenExecutable = [
  /from\s+['"][^'"]*apps\/api[^'"]*['"]/,
  /require\(\s*['"][^'"]*apps\/api[^'"]*['"]\s*\)/,
  /@prisma\/client/,
  /@aws-sdk\//,
  /app\.bypass_rls/,
  /executePromotion/,
  /activateSnapshot/,
  /capiro_pe_promoter/,
  /@Controller\s*\(/,
];
for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
  if (entry.name.endsWith('.spec.ts')) continue;
  const relative = `apps/defense-api/src/runtime/${entry.name}`;
  let content = read(relative);
  // Strip block/line comments before scanning so docstrings cannot trip the gate.
  content = content
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const pattern of forbiddenExecutable) {
    if (pattern.test(content)) {
      fail(`${relative} contains forbidden executable token ${pattern}`);
    }
  }
}

if (!exists('apps/defense-api/src/runtime/phase1-7-runtime.adapters.ts')) {
  fail('Missing production-equivalent Phase17 runtime adapters');
}

const appModule = read('apps/defense-api/src/app.module.ts');
if (!appModule.includes('Phase17RuntimeModule')) fail('AppModule does not register Phase17RuntimeModule');
const packageJson = JSON.parse(read('apps/defense-api/package.json'));
if (packageJson.scripts?.['verify:session4'] !== 'node ../../scripts/verify-phase8-session4.mjs') {
  fail('defense-api package is missing the Session 4 verifier script');
}

const dockerfile = read('apps/defense-api/Dockerfile');
const runtimeStageStart = dockerfile.indexOf(' AS runtime');
if (runtimeStageStart < 0) {
  fail('defense-api Dockerfile has no named runtime stage');
} else {
  const runtimeStage = dockerfile.slice(runtimeStageStart);
  if (runtimeStage.includes('runtime-source')) {
    fail('Final defense-api image copies the trusted source mirror');
  }
  if (!runtimeStage.includes('/workspace/apps/defense-api/dist')) {
    fail('Final defense-api image does not copy the compiled dist boundary');
  }
  if (!runtimeStage.includes('USER capiro')) {
    fail('Final defense-api image is not explicitly non-root');
  }
}
// Build stage must not stomp package node_modules with wholesale package COPY.
if (/COPY packages\/auth packages\/auth/.test(dockerfile)) {
  fail('Dockerfile still wholesale-copies packages/auth (stomps install-time node_modules)');
}
if (!dockerfile.includes('PNPM_PACKAGE_IMPORT_METHOD=copy')) {
  fail('Dockerfile missing PNPM_PACKAGE_IMPORT_METHOD=copy hardening');
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
