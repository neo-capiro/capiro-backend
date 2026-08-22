#!/usr/bin/env node
// Phase 8 Session 11 permanent verifier — product/HTTP read integration over
// the Session 7-10 budget-lifecycle control plane.
//
// Proves, against the exact defense-api/defense-contracts/defense-domain
// source tree (not the plan's prose):
//   1. the frozen Session 3 route surface is untouched (still exactly 49);
//   2. every Session 11 route lives in its own, separate, non-frozen table;
//   3. every Session 11 HTTP handler is GET — no mutation is reachable over
//      HTTP for this domain, matching the Session 7 migration's own grant
//      ("HTTP serve reads the cycle-health state; job/ingestion is the only
//      writer");
//   4. the Session 11 NestJS module/service/controller never references the
//      frozen write-capable LIFECYCLE_STORE token or its mutating methods;
//   5. every file Sessions 7-10 built under apps/defense-api/src/budget-lifecycle
//      is completely untouched (zero diff against origin/main, not merely
//      the Session 10 allowance for module.ts + schedule/);
//   6. no GPU/NVIDIA/promoter credential and no apps/api import exists in any
//      Session 11 source file;
//   7. the governed review-resolution CLI script is fail-closed and is never
//      wired into an automatic trigger.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const failures = [];
const file = (relative) => path.join(root, relative);
const exists = (relative) => fs.existsSync(file(relative));
const read = (relative) => {
  const target = file(relative);
  if (!fs.existsSync(target)) {
    failures.push(`missing required file: ${relative}`);
    return '';
  }
  return fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
};
const fail = (message) => failures.push(message);

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// ---------------------------------------------------------------------------
// 1. The frozen Session 3 route surface is untouched.
// ---------------------------------------------------------------------------
const contractsSource = read('packages/defense-contracts/src/public/index.ts');
const frozenRouteMatches = [
  ...contractsSource.matchAll(
    /defineRoute\(\s*'([^']+)'\s*,\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*(?:,\s*'([a-z_]+)')?\s*\)/g,
  ),
];
if (frozenRouteMatches.length !== 49) {
  fail(
    `expected exactly 49 frozen routes in defense-contracts (Session 3 boundary), found ${frozenRouteMatches.length}`,
  );
}

// ---------------------------------------------------------------------------
// 2. Session 11's own route table exists, is separate, and every route is GET.
// ---------------------------------------------------------------------------
const REQUIRED_FILES = [
  'packages/defense-contracts/src/public/budget-lifecycle-product-routes.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-read.port.ts',
  'apps/defense-api/src/budget-lifecycle-product/prisma-budget-lifecycle-read.store.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-query.service.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-read.controller.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-product.module.ts',
  'apps/defense-api/scripts/run-review-resolution.mjs',
];
for (const relative of REQUIRED_FILES) {
  if (!exists(relative)) fail(`missing required Session 11 file: ${relative}`);
}

const productRoutesSource = read(
  'packages/defense-contracts/src/public/budget-lifecycle-product-routes.ts',
);
const productRouteMatches = [
  ...productRoutesSource.matchAll(
    /defineProductRoute\(\s*'([^']+)'\s*,\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*,?\s*\)/g,
  ),
];
if (productRouteMatches.length === 0) {
  fail('found no defineProductRoute(...) entries in budget-lifecycle-product-routes.ts');
}
for (const [, id, method, contractPath] of productRouteMatches) {
  if (method !== 'GET') {
    fail(`Session 11 route '${id}' (${method} ${contractPath}) is not GET — this domain is read-only over HTTP`);
  }
  const frozenCollision = frozenRouteMatches.find((frozen) => frozen[3] === contractPath);
  if (frozenCollision) {
    fail(`Session 11 route path '${contractPath}' collides with a frozen Session 3 route`);
  }
}
// Strip comments first: this file's own doc comment explains the naming
// choice by naming the string it avoids, which would otherwise trip this
// exact check (the same class of self-referential false-failure flagged in
// the Session 7 closeout notes).
if (/\bdefineRoute\(/.test(stripComments(productRoutesSource))) {
  fail('budget-lifecycle-product-routes.ts must use defineProductRoute, never defineRoute, to stay unambiguous under the Session 3 static scan');
}

// ---------------------------------------------------------------------------
// 3. Every Session 11 HTTP handler is GET; no mutation decorator anywhere.
// ---------------------------------------------------------------------------
const controllerSource = stripComments(
  read('apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-read.controller.ts'),
);
if (/@Post\(|@Put\(|@Patch\(|@Delete\(/.test(controllerSource)) {
  fail('budget-lifecycle-read.controller.ts declares a non-GET route decorator');
}
if (!/@Get\(/.test(controllerSource)) {
  fail('budget-lifecycle-read.controller.ts declares no GET route at all');
}

// ---------------------------------------------------------------------------
// 4. The Session 11 module/service/controller never reach the write-capable
//    LIFECYCLE_STORE port or its mutating methods.
// ---------------------------------------------------------------------------
const SESSION11_NESTJS_FILES = [
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-product.module.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-read.controller.ts',
  'apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-query.service.ts',
  'apps/defense-api/src/budget-lifecycle-product/prisma-budget-lifecycle-read.store.ts',
];
const FORBIDDEN_WRITE_TOKENS = [
  'LIFECYCLE_STORE',
  'setExpectedSourceState',
  'recordObservation',
  'supersedeObservation',
  'enqueueIngestion',
  'acquireAdapterLease',
  'releaseAdapterLease',
  'recordWatcherRun',
  '$executeRawUnsafe',
  'PrismaLifecycleStore',
];
for (const relative of SESSION11_NESTJS_FILES) {
  const content = stripComments(read(relative));
  for (const token of FORBIDDEN_WRITE_TOKENS) {
    if (content.includes(token)) {
      fail(`${relative} references '${token}' — the HTTP-reachable Session 11 surface must stay read-only`);
    }
  }
  if (/apps\/api\b|from ['"]\.\.\/\.\.\/\.\.\/api\//.test(content)) {
    fail(`${relative} appears to import from apps/api, which the Session 3 boundary forbids`);
  }
  if (/sagemaker|nvidia|nemotron|cuda|gpu_?instance|DEFENSE_PARSER_MODEL_|DEFENSE_PROMOTER_/i.test(content)) {
    fail(`${relative} names a GPU/parser/promoter credential; this session touches none of them`);
  }
}

// ---------------------------------------------------------------------------
// 5. Sessions 7-10's own tree is completely untouched by Session 11.
// ---------------------------------------------------------------------------
try {
  execSync('git rev-parse --verify origin/main', { cwd: root, stdio: 'ignore' });
  const diffOutput = execSync(
    'git diff --name-only origin/main -- apps/defense-api/src/budget-lifecycle',
    { cwd: root, encoding: 'utf8' },
  );
  const changed = diffOutput
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (changed.length > 0) {
    fail(
      `Session 11 modified the frozen Sessions 7-10 tree (apps/defense-api/src/budget-lifecycle): ${changed.join(', ')}`,
    );
  }
} catch (error) {
  fail(`Could not diff against origin/main to prove the Sessions 7-10 tree is untouched: ${error.message}`);
}

// ---------------------------------------------------------------------------
// 6. app.module.ts registers the new module additively.
// ---------------------------------------------------------------------------
const appModuleSource = stripComments(read('apps/defense-api/src/app.module.ts'));
if (!/BudgetLifecycleProductModule/.test(appModuleSource)) {
  fail('app.module.ts does not register BudgetLifecycleProductModule');
}
if (!/BudgetLifecycleModule/.test(appModuleSource)) {
  fail('app.module.ts no longer registers the Session 7-10 BudgetLifecycleModule');
}

// ---------------------------------------------------------------------------
// 7. The governed review-resolution CLI is fail-closed and never auto-invoked.
// ---------------------------------------------------------------------------
const cliSource = stripComments(read('apps/defense-api/scripts/run-review-resolution.mjs'));
if (!/PHASE8_SESSION11_REVIEW_RESOLUTION_AUTHORIZED/.test(cliSource)) {
  fail('run-review-resolution.mjs does not gate commits behind an explicit authorization env var');
}
if (!/--commit/.test(cliSource)) {
  fail('run-review-resolution.mjs does not require an explicit --commit flag');
}
// The known verification harness legitimately invokes `--commit`: the
// disposable-DB rehearsal proves the job-role commit path actually works
// (and that a serve-role commit is refused), and the CI workflow's own step
// is a NEGATIVE test asserting a bogus commit attempt fails. Neither runs
// outside an explicit, gated rehearsal invocation. Anything else that
// mentions both the CLI path and `--commit` is worth a human look.
const KNOWN_HARNESS_FILES = new Set([
  'scripts/verify-phase8-session11-integration.mjs',
  'scripts/verify-phase8-session11-db.sh',
  'scripts/verify-phase8-session11-db.mjs',
  'scripts/verify-phase8-session11.mjs',
  '.github/workflows/phase8-session11-product-integration.yml',
]);
const repoTextFiles = execSync('git ls-files -- .github/workflows scripts', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
for (const relative of repoTextFiles) {
  if (relative.includes('run-review-resolution') || KNOWN_HARNESS_FILES.has(relative)) continue;
  const content = fs.readFileSync(file(relative), 'utf8');
  if (content.includes('run-review-resolution.mjs') && /--commit/.test(content)) {
    fail(`${relative} appears to invoke run-review-resolution.mjs --commit automatically`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error('SESSION11_PRODUCT_INTEGRATION_FAIL');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('SESSION11_PRODUCT_INTEGRATION_PASS');
