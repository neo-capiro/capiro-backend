#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Phase 27 release gate — Institutional Learning & Quality.
 *
 * COMPLEMENTS `validate-knowledge-plane-phase26.mjs`, does not replace it.
 * Every Phase 27 PR must pass BOTH: this script only re-checks the new
 * learning-signal surface, on the assumption phase26's Context Plane gate
 * (architecture guard, zero-error typechecks, pinned apps/api baseline,
 * Context Plane test surface, whitespace check) has already run and passed.
 *
 * Deliberate properties, matching phase26's conventions:
 *  - No check is wrapped in `|| true`. Every failure fails this command.
 *  - No silently ignored suite. A missing jest summary is a failure, not a
 *    pass — jest never running must never read as green.
 *
 * Usage:
 *   node scripts/validate-knowledge-plane-phase27.mjs --run [--base <ref>] [--skip-tests]
 *
 * Prerequisites (not run here — same as phase26):
 *   pnpm install --frozen-lockfile
 *   pnpm --filter @capiro/shared build   (and auth, meriv2-core)
 *   pnpm -C apps/api exec prisma generate
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const usage =
  'Usage: node scripts/validate-knowledge-plane-phase27.mjs --run [--base <ref>] [--skip-tests]';
const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error(usage);
  process.exit(2);
}
if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
  console.log(usage);
  process.exit(0);
}
let base = 'origin/main';
let skipTests = false;
let baseSeen = false;
let runSeen = false;
let invalid = false;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--base' && !baseSeen) {
    const value = argv[++i];
    if (!value || value.startsWith('-') || !/^[A-Za-z0-9._/@^~-]+$/.test(value)) {
      invalid = true;
      break;
    }
    base = value;
    baseSeen = true;
  } else if (argv[i] === '--skip-tests' && !skipTests) {
    skipTests = true;
  } else if (argv[i] === '--run' && !runSeen) {
    runSeen = true;
  } else {
    invalid = true;
    break;
  }
}
if (invalid) {
  console.error(usage);
  process.exit(2);
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const useShell = process.platform === 'win32';
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

// ── 1. Learning-signal architecture guard ───────────────────────────────────
{
  const out = run('node', ['scripts/check-learning-signal-new-bypasses.mjs', base]);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (out.status !== 0) console.error(text);
  else process.stdout.write(text);
  record(
    'learning-signal architecture guard (no-bypass, no-promotion, five-layer)',
    out.status === 0,
  );
}

// ── 2. Learning-signal test surface (contract + capture + query + adapters) ─
if (skipTests) {
  console.log('SKIP  test suites (--skip-tests)');
} else {
  const SUITES = [
    [
      'meriv2-core learning contract suite',
      'packages/meriv2-core',
      ['--testPathPattern', 'src/learning'],
    ],
    [
      'api learning-signal suite',
      'apps/api',
      // learning-signal-governance: Phase 27D's new decision surface lives
      // in apps/api/src/memory/ (the canonical governance module, not
      // src/learning/ — see check-learning-signal-new-bypasses.mjs check 8),
      // so it needs its own suffix here the same way 27A's resilience tests
      // did when they landed outside src/learning/ too.
      ['--testPathPattern', 'src/learning|learning-signal-resilience|learning-signal-governance'],
    ],
  ];
  for (const [name, dir, args] of SUITES) {
    const out = run(npx, ['jest', '--runInBand', '--forceExit', ...args], dir);
    const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
    const suites = /Test Suites:.*/.exec(text)?.[0] ?? 'no summary';
    const tests = /Tests:.*/.exec(text)?.[0] ?? '';
    const failedSuites = [...text.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
    const ranAtAll = suites !== 'no summary';
    const ok = ranAtAll && failedSuites.length === 0;
    if (!ok) console.error(text.split('\n').slice(-80).join('\n'));
    record(name, ok, `${suites} | ${tests}`);
  }
}

// ── 3. Whitespace / conflict-marker cleanliness ─────────────────────────────
{
  const out = run('git', ['diff', '--check']);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (text.trim()) console.error(text);
  record('git diff --check', out.status === 0 && !text.trim());
}

// ── Summary ───────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.error('\nFAILED:');
  for (const item of failed) console.error(`- ${item.name}`);
  console.error(
    '\nNote: this script complements validate-knowledge-plane-phase26.mjs — run that one too.',
  );
  process.exit(1);
}
console.log('Knowledge Plane Phase 27 (learning-signal) validation: all checks passed.');
console.log(
  'Reminder: also run `pnpm validate:knowledge-plane:phase26` — it is not superseded by this script.',
);
