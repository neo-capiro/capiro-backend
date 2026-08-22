#!/usr/bin/env node
/**
 * Phase 27E release gate — Institutional Learning Quality Telemetry.
 *
 * COMPLEMENTS `validate-knowledge-plane-phase26.mjs` and
 * `validate-knowledge-plane-phase27.mjs`, does not replace either. Every
 * Phase 27E PR must pass ALL THREE: this script only re-checks the new
 * quality-telemetry surface, on the assumption phase26's Context Plane gate
 * and phase27's learning-signal gate have already run and passed.
 *
 * Deliberate properties, matching phase26/phase27's conventions:
 *  - No check is wrapped in `|| true`. Every failure fails this command.
 *  - No silently ignored suite. A missing jest summary is a failure, not a
 *    pass — jest never running must never read as green.
 *
 * Usage:
 *   node scripts/validate-knowledge-plane-phase27e.mjs [--base <ref>] [--skip-tests]
 *
 * Prerequisites (not run here — same as phase26/phase27):
 *   pnpm install --frozen-lockfile
 *   pnpm --filter @capiro/shared build   (and auth, meriv2-core)
 *   pnpm -C apps/api exec prisma generate
 */

import { spawnSync } from 'node:child_process';
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

// ── 1. Quality-telemetry architecture guard ─────────────────────────────────
{
  const out = run('node', ['scripts/check-quality-telemetry-new-bypasses.mjs', base]);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (out.status !== 0) console.error(text);
  else process.stdout.write(text);
  record('quality-telemetry architecture guard (no-bypass, no-governed-write, no sixth layer)', out.status === 0);
}

// ── 2. Quality-telemetry test surface (contract + capture + query + adapters
//      + isolation + internal controller) ───────────────────────────────────
if (skipTests) {
  console.log('SKIP  test suites (--skip-tests)');
} else {
  const SUITES = [
    ['meriv2-core quality-telemetry contract suite', 'packages/meriv2-core', ['--testPathPattern', 'src/quality-telemetry']],
    ['api quality-telemetry suite', 'apps/api', ['--testPathPattern', 'src/quality-telemetry']],
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

  // Regression check on every product surface this phase touched — proves
  // adding an optional telemetry constructor param and a post-commit
  // recordEvent call did not change any existing behavior.
  const REGRESSION_SUITES = [
    [
      'crm-fill / meri-feedback regression (existing specs, unmodified)',
      'apps/api',
      [
        '--testPathPattern',
        'client-profile-fill|meri-feedback-learning-signal-resilience|outreach-draft.service|outreach-v3-draft-approval|outreach-v3-drafts-architecture|meeting-artifact-lifecycle|governed-engagement.factory|governed-engagement.phase24|governed-meeting-ai.factory',
      ],
    ],
    ['tenant-scope guard (new models auto-covered)', 'apps/api', ['--testPathPattern', 'tenant-scope-guard']],
  ];
  for (const [name, dir, args] of REGRESSION_SUITES) {
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
  console.error('\nNote: this script complements phase26/phase27 — run both of those too.');
  process.exit(1);
}
console.log('Knowledge Plane Phase 27E (quality-telemetry) validation: all checks passed.');
console.log('Reminder: also run `pnpm validate:knowledge-plane:phase26` and `:phase27` — neither is superseded by this script.');
