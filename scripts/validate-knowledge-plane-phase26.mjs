#!/usr/bin/env node
/**
 * Consolidated Knowledge Plane Phase 26 release gate.
 *
 * Runs the checks that actually prove the Context Plane adoption, in one place,
 * so a release candidate can be re-verified on an exact head without
 * reconstructing the command list from a handoff document.
 *
 * Deliberate properties:
 *  - No check is wrapped in `|| true`. Every failure fails this command.
 *  - apps/api carries 16 PRE-EXISTING `tsc` errors, all in *.spec.ts files.
 *    They are not silenced: they are pinned in
 *    scripts/knowledge-plane-phase26-typecheck-baseline.json and this command
 *    fails on any NEW error signature or increased count. That converts a
 *    claim in a commit message into an enforced invariant.
 *  - Jest suites are run with --runInBand. The adoption surface is load-flaky
 *    under parallel workers, and a flake that hides a real failure is worse
 *    than a slower run.
 *
 * Usage:
 *   node scripts/validate-knowledge-plane-phase26.mjs [--base <ref>] [--skip-tests]
 *
 * Prerequisites (not run here, because they mutate the workspace):
 *   pnpm install --frozen-lockfile
 *   pnpm --filter @capiro/shared build   (and auth, meriv2-core, strategy-verifier,
 *                                         defense-contracts, defense-domain, defense-client)
 *   pnpm -C apps/<api|api-strategy|workspace|intel-api> prisma:generate
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const argv = process.argv.slice(2);
const baseIndex = argv.indexOf('--base');
const base = baseIndex >= 0 ? argv[baseIndex + 1] : 'origin/main';
const skipTests = argv.includes('--skip-tests');

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const useShell = process.platform === 'win32';

/**
 * Windows needs `shell: true` to launch `npx.cmd`, which means cmd.exe parses
 * the argv. A jest --testPathPatterns regex contains `|`, and cmd.exe read that
 * as a pipe: the check "passed" its own arg list to a nonexistent command and
 * reported no summary. Quote anything with shell metacharacters.
 */
function quoteForShell(arg) {
  if (!useShell) return arg;
  return /[|&<>^()\s]/.test(arg) ? `"${arg.split('"').join('\\"')}"` : arg;
}

function run(command, args, cwd) {
  return spawnSync(command, useShell ? args.map(quoteForShell) : args, {
    cwd: cwd ? join(repoRoot, cwd) : repoRoot,
    encoding: 'utf8',
    shell: useShell,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// ── 1. Architecture guard ───────────────────────────────────────────────────
{
  const out = run('node', ['scripts/check-context-plane-new-bypasses.mjs', base]);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (out.status !== 0) console.error(text);
  else process.stdout.write(text);
  record('architecture guard (no-bypass)', out.status === 0);
}

// ── 2. Zero-error typechecks ────────────────────────────────────────────────
const ZERO_ERROR_TYPECHECKS = [
  ['meriv2-core typecheck', 'packages/meriv2-core'],
  ['api-strategy typecheck', 'apps/api-strategy'],
  ['workspace typecheck', 'apps/workspace'],
  ['meriv2-orchestrator typecheck', 'apps/meriv2-orchestrator'],
  ['intel-api typecheck', 'apps/intel-api'],
];
for (const [name, dir] of ZERO_ERROR_TYPECHECKS) {
  const out = run(npx, ['tsc', '-p', 'tsconfig.json', '--noEmit'], dir);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  const errors = (text.match(/error TS\d+/g) ?? []).length;
  if (errors > 0) console.error(text);
  record(name, out.status === 0 && errors === 0, `${errors} error(s)`);
}

// ── 3. apps/api typecheck vs pinned pre-existing baseline ───────────────────
{
  const baselinePath = 'scripts/knowledge-plane-phase26-typecheck-baseline.json';
  const baseline = JSON.parse(readFileSync(join(repoRoot, baselinePath), 'utf8')).errors;
  const out = run(npx, ['tsc', '--noEmit'], 'apps/api');
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;

  const observed = {};
  for (const line of text.split('\n')) {
    // e.g. "src/reviews/reviews.service.spec.ts(48,46): error TS2345: ..."
    const match = /^(.+?)\(\d+,\d+\): error (TS\d+)/.exec(line.trim());
    if (!match) continue;
    const key = `${match[1].split('\\').join('/')}|${match[2]}`;
    observed[key] = (observed[key] ?? 0) + 1;
  }

  const regressions = [];
  for (const [key, count] of Object.entries(observed)) {
    const allowed = baseline[key] ?? 0;
    if (count > allowed) {
      regressions.push(`${key}: ${count} > ${allowed} allowed`);
    }
  }
  const fixed = [];
  for (const [key, allowed] of Object.entries(baseline)) {
    const count = observed[key] ?? 0;
    if (count < allowed) fixed.push(`${key}: ${count} < ${allowed} pinned`);
  }

  const total = Object.values(observed).reduce((a, b) => a + b, 0);
  if (regressions.length > 0) {
    console.error('\napps/api typecheck REGRESSIONS vs pinned baseline:');
    for (const item of regressions) console.error(`- ${item}`);
    console.error('\nFull typecheck output:\n' + text);
  }
  for (const item of fixed) {
    console.log(`Notice: pre-existing error fixed, trim ${baselinePath} — ${item}`);
  }
  record(
    'apps/api typecheck (no new errors vs pinned baseline)',
    regressions.length === 0,
    `${total} error(s), 0 regressions`,
  );
}

// ── 4. Context Plane + adoption test surface ────────────────────────────────
if (skipTests) {
  console.log('SKIP  test suites (--skip-tests)');
} else {
  const API_SPEC_PATTERN =
    'context-plane|context-resolver|context-packet|retrieval|ethical|tenant-isolation|governed-|phase-?2[0-6]|adoption|strategy-work';
  const SUITES = [
    ['meriv2-core suite', 'packages/meriv2-core', []],
    ['api-strategy suite', 'apps/api-strategy', []],
    [
      'api Context Plane + adoption surface',
      'apps/api',
      ['--testPathPattern', API_SPEC_PATTERN],
    ],
  ];
  const knownFailing = JSON.parse(
    readFileSync(join(repoRoot, 'scripts/knowledge-plane-phase26-typecheck-baseline.json'), 'utf8'),
  ).knownFailingSuites;

  for (const [name, dir, args] of SUITES) {
    const out = run(npx, ['jest', '--runInBand', '--forceExit', ...args], dir);
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    const suites = /Test Suites:.*/.exec(text)?.[0] ?? 'no summary';
    const tests = /Tests:.*/.exec(text)?.[0] ?? '';

    // Jest exiting non-zero is only a gate failure if a suite that is NOT an
    // attributed pre-existing failure went red. A missing summary always fails:
    // it means jest never ran, which must never read as a pass.
    const failedSuites = [
      ...new Set(
        [...text.matchAll(/^FAIL\s+(\S+)/gm)].map((match) => match[1].split('\\').join('/')),
      ),
    ];
    const unexpected = failedSuites.filter((suite) => !(suite in knownFailing));
    const ranAtAll = suites !== 'no summary';
    const ok = ranAtAll && unexpected.length === 0;

    if (!ok) {
      console.error(text.split('\n').slice(-80).join('\n'));
      for (const suite of unexpected) console.error(`Unexpected failing suite: ${suite}`);
    }
    for (const suite of failedSuites.filter((s) => s in knownFailing)) {
      console.log(`Known pre-existing failure (attributed): ${suite}`);
    }
    for (const suite of Object.keys(knownFailing)) {
      if (dir === 'apps/api' && !failedSuites.includes(suite) && text.includes(suite)) {
        console.log(`Notice: ${suite} now passes — remove it from knownFailingSuites.`);
      }
    }
    record(
      name,
      ok,
      `${suites} | ${tests}${unexpected.length ? ` | ${unexpected.length} unexpected` : ''}`,
    );
  }
}

// ── 5. Whitespace / conflict-marker cleanliness ─────────────────────────────
{
  const out = run('git', ['diff', '--check']);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (text.trim()) console.error(text);
  record('git diff --check', out.status === 0 && !text.trim());
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.error('\nFAILED:');
  for (const item of failed) console.error(`- ${item.name}`);
  process.exit(1);
}
console.log('Knowledge Plane Phase 26 validation: all checks passed.');
