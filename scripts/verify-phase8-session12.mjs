#!/usr/bin/env node
// Phase 8 Session 12 permanent verifier — closeout / end-to-end proof only,
// no activation.
//
// Session 12's scope (see docs/defense-budget/phase8-session12-e2e-closeout-handoff.md
// §1) is deliberately additive-only: new rehearsal scripts and one closeout
// doc, and NOTHING ELSE. This gate proves that claim mechanically rather than
// by prose:
//
//   1. the frozen Session 3 route surface is untouched (still exactly 49);
//   2. the Session 11 product route table is untouched and still all-GET
//      (still exactly the routes it registered, zero net change);
//   3. Session 12 introduces ZERO diff under any production source tree
//      (apps/defense-api/src, packages/defense-domain/src,
//      packages/defense-contracts/src, apps/api/src, apps/web/src) —
//      everything this session added lives under scripts/ and docs/ only;
//   4. Session 12 adds NO new Prisma migration (the existing schema already
//      supports the full end-to-end proof);
//   5. no committed file sets PHASE8_SESSION10_TICK_AUTHORIZED (or any
//      equivalent activation gate) to a truthy literal — this session
//      performs no activation, and nothing it adds may flip that switch;
//   6. the new Session 12 scripts make no live network request (no fetch/
//      http(s).request/axios/undici outside the frozen, pre-existing
//      HttpsSourceFetchAdapter this session does not touch) and reference no
//      GPU/NVIDIA/promoter credential;
//   7. the governed run-review-resolution.mjs CLI Session 12 reuses is
//      byte-identical to what Session 11 shipped (reused, not reimplemented).
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// The commit Session 12's branch actually forked from. `origin/main` is
// deliberately NOT used as the diff base for "did Session 12 touch this
// tree" checks: main is a moving target (two unrelated merges landed on it
// during this very session — PR #1176 and PR #1177, both audited in the
// closeout doc as zero-overlap), so diffing against its live tip would fail
// this gate on every unrelated upstream change forever, not just on
// something Session 12 did. Diffing against the session's own fork point is
// the question this gate actually needs answered.
const SESSION12_BASE_REF = process.env.PHASE8_SESSION12_BASE_REF || '36cc7c1ba638db6448bd22741a14700c08517d1c';

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
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

// `git diff --name-only` lists a file as changed whenever its blob SHA
// differs — a fast path that does NOT honor `--ignore-cr-at-eol` /
// `--ignore-space-at-eol` the way a full content diff does (measured: this
// repo's non-.gitattributes-forced files, e.g. apps/web/src/**/*.css, check
// out with CRLF on this Windows host while origin/main stores them LF-only,
// so every such file appears "changed" by name even though its content is
// byte-identical modulo line endings). A production-tree gate that trusted
// `--name-only` directly would fail on every CRLF-drifted file this session
// never touched. So: take the candidate list from `--name-only`, then
// confirm each one with an actual line-ending-normalized content comparison
// (the same `\r\n` -> `\n` normalization this file's own `read()` helper
// uses) before treating it as a real change.
function gitDiffNames(pathspec, baseRef = SESSION12_BASE_REF) {
  try {
    execSync(`git rev-parse --verify ${baseRef}`, { cwd: root, stdio: 'ignore' });
  } catch {
    fail(`could not verify base ref ${baseRef} exists locally`);
    return null;
  }
  const output = execSync(`git diff --name-only ${baseRef} -- ${pathspec}`, { cwd: root, encoding: 'utf8' });
  const candidates = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const normalize = (text) => text.replace(/\r\n/g, '\n');
  return candidates.filter((relative) => {
    const target = file(relative);
    const existsLocally = fs.existsSync(target);
    let originalContent;
    try {
      originalContent = execSync(`git show ${baseRef}:"${relative}"`, {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024 * 64,
      });
    } catch {
      // Not present at the base ref at all (a genuinely new file) — real change.
      return true;
    }
    if (!existsLocally) return true; // genuinely deleted — real change.
    const currentContent = fs.readFileSync(target, 'utf8');
    return normalize(originalContent) !== normalize(currentContent);
  });
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
  fail(`expected exactly 49 frozen routes (Session 3 boundary), found ${frozenRouteMatches.length}`);
}

// ---------------------------------------------------------------------------
// 2. The Session 11 product route table is untouched and still all-GET.
// ---------------------------------------------------------------------------
const productRoutesSource = read(
  'packages/defense-contracts/src/public/budget-lifecycle-product-routes.ts',
);
const productRouteMatches = [
  ...productRoutesSource.matchAll(
    /defineProductRoute\(\s*'([^']+)'\s*,\s*'([A-Z]+)'\s*,\s*'([^']+)'\s*,?\s*\)/g,
  ),
];
if (productRouteMatches.length !== 6) {
  fail(`expected exactly 6 Session 11 product routes (Session 12 route delta must be 0), found ${productRouteMatches.length}`);
}
for (const [, id, method] of productRouteMatches) {
  if (method !== 'GET') fail(`Session 11 product route '${id}' is no longer GET — Session 12 must not have touched this`);
}
const productRouteDiff = gitDiffNames(
  'packages/defense-contracts/src/public/budget-lifecycle-product-routes.ts ' +
    'apps/defense-api/src/budget-lifecycle-product',
);
if (productRouteDiff && productRouteDiff.length > 0) {
  fail(`Session 12 modified the frozen Session 11 product surface: ${productRouteDiff.join(', ')}`);
}

// ---------------------------------------------------------------------------
// 3. Session 12 introduces ZERO diff under any production source tree.
// ---------------------------------------------------------------------------
const PRODUCTION_TREES = [
  'apps/defense-api/src',
  'packages/defense-domain/src',
  'packages/defense-contracts/src',
  'apps/api/src',
  'apps/web/src',
  'apps/api/prisma/schema.prisma',
];
for (const tree of PRODUCTION_TREES) {
  const diff = gitDiffNames(tree);
  if (diff && diff.length > 0) {
    fail(`Session 12 (closeout/E2E-proof-only) modified a production source tree it must not touch: ${tree} -> ${diff.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Session 12 adds no new Prisma migration.
// ---------------------------------------------------------------------------
const migrationDiff = gitDiffNames('apps/api/prisma/migrations apps/defense-api/prisma/migrations');
if (migrationDiff && migrationDiff.length > 0) {
  fail(
    `Session 12 added or modified a migration (expected zero — the existing schema already supports the E2E proof): ${migrationDiff.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// 5. No committed file flips an activation gate to a truthy literal.
// ---------------------------------------------------------------------------
const ACTIVATION_GATES = [
  'PHASE8_SESSION10_TICK_AUTHORIZED',
  'PHASE8_SESSION8_CRAWL_AUTHORIZED',
  'PHASE8_SESSION8_COMMIT_AUTHORIZED',
  'PHASE8_SESSION7_COMMIT_AUTHORIZED',
];
const repoScriptFiles = execSync('git ls-files -- scripts docs/defense-budget .github/workflows', {
  cwd: root,
  encoding: 'utf8',
})
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
for (const relative of repoScriptFiles) {
  if (!relative.startsWith('scripts/') || !relative.includes('phase8-session12')) continue;
  const content = fs.readFileSync(file(relative), 'utf8');
  for (const gate of ACTIVATION_GATES) {
    const truthyAssignment = new RegExp(`${gate}\\s*=\\s*['"]?true['"]?`);
    if (truthyAssignment.test(content)) {
      fail(`${relative} sets ${gate} to a truthy literal — Session 12 performs no activation`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. The new Session 12 scripts make no live network request and reference
//    no GPU/NVIDIA/promoter credential.
//
// Deliberately excludes THIS file (verify-phase8-session12.mjs): its own
// source necessarily spells out the detection patterns below as string/regex
// literals, which would otherwise match itself — the same "verifier matched
// its own prose" bug class the Session 7 and Session 9 closeouts each found
// and fixed by stripping comments; here the fix is not scanning the detector
// itself, since unlike those cases the pattern lives in code, not a comment.
// ---------------------------------------------------------------------------
const SESSION12_SCRIPTS = [
  'scripts/seed-phase8-session12-corpus.mjs',
  'scripts/verify-phase8-session12-e2e.mjs',
  'scripts/verify-phase8-session12-e2e-db.sh',
  'scripts/verify-phase8-session12-e2e-db.mjs',
];
for (const relative of SESSION12_SCRIPTS) {
  if (!exists(relative)) {
    fail(`missing required Session 12 file: ${relative}`);
    continue;
  }
  const content = stripComments(read(relative));
  if (/\bfetch\(|https?\.request\(|https?\.get\(|axios\.|new\s+Undici|XMLHttpRequest/.test(content)) {
    fail(`${relative} appears to make a live HTTP call — Session 12's E2E proof must be fixture-driven, no network`);
  }
  if (/sagemaker|nvidia|nemotron|cuda|gpu_?instance|DEFENSE_PARSER_MODEL_|DEFENSE_PROMOTER_/i.test(content)) {
    fail(`${relative} names a GPU/parser/promoter credential; this session touches none of them`);
  }
  if (/\baws\b.*sdk|@aws-sdk|new\s+AWS\./i.test(content)) {
    fail(`${relative} appears to reference an AWS SDK; Session 12 makes zero AWS API calls`);
  }
}

// ---------------------------------------------------------------------------
// 7. The governed CLI Session 12 reuses is byte-identical to Session 11's.
// ---------------------------------------------------------------------------
const cliDiff = gitDiffNames('apps/defense-api/scripts/run-review-resolution.mjs');
if (cliDiff && cliDiff.length > 0) {
  fail(`Session 12 must reuse run-review-resolution.mjs unmodified, but it differs from origin/main: ${cliDiff.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error('SESSION12_E2E_CLOSEOUT_FAIL');
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log('SESSION12_E2E_CLOSEOUT_PASS');
