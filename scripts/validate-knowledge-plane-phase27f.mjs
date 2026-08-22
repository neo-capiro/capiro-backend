#!/usr/bin/env node
/**
 * Phase 27F release gate — Institutional-Context Effectiveness Evaluation.
 *
 * COMPLEMENTS `validate-knowledge-plane-phase26.mjs`,
 * `validate-knowledge-plane-phase27.mjs`, and
 * `validate-knowledge-plane-phase27e.mjs` — does not replace any of them.
 * Every Phase 27F PR must pass ALL FOUR: this script only re-checks the new
 * evaluation surface, on the assumption the other three gates have already
 * run and passed.
 *
 * Deliberate properties, matching phase26/27/27e's conventions:
 *  - No check is wrapped in `|| true`. Every failure fails this command.
 *  - No silently ignored suite. A missing jest summary is a failure, not a
 *    pass — jest never running must never read as green.
 *
 * Usage:
 *   node scripts/validate-knowledge-plane-phase27f.mjs [--base <ref>] [--skip-tests]
 *
 * Prerequisites (not run here — same as phase26/27/27e):
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

// ── 1. Evaluation architecture guard ────────────────────────────────────────
{
  const out = run('node', ['scripts/check-evaluation-new-bypasses.mjs', base]);
  const text = `${out.stdout ?? ''}${out.stderr ?? ''}`;
  if (out.status !== 0) console.error(text);
  else process.stdout.write(text);
  record('evaluation architecture guard (no-bypass, no-governed-write, no sixth layer, no feedback loop)', out.status === 0);
}

// ── 2. Evaluation test surface (contract + capture + query + isolation +
//      surface runners) ─────────────────────────────────────────────────────
if (skipTests) {
  console.log('SKIP  test suites (--skip-tests)');
} else {
  const SUITES = [
    ['meriv2-core evaluation contract suite', 'packages/meriv2-core', ['--testPathPattern', 'src/evaluation']],
    ['api evaluation suite', 'apps/api', ['--testPathPattern', 'src/evaluation']],
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

  // Regression check on every product surface Phase 27F touched — proves
  // adding an optional evaluation hook did not change any existing
  // generation behavior.
  const REGRESSION_SUITES = [
    [
      'outreach / crm-fill / meri regression (existing specs, unmodified)',
      'apps/api',
      [
        '--testPathPattern',
        'generation-gateway|outreach-draft.service|outreach-v3-draft-approval|client-profile-fill|meri-context-plane|governed-meri-research',
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
  console.error('\nNote: this script complements phase26/phase27/phase27e — run all three too.');
  process.exit(1);
}
console.log('Knowledge Plane Phase 27F (evaluation) validation: all checks passed.');
console.log('Reminder: also run `pnpm validate:knowledge-plane:phase26`, `:phase27`, and `:phase27e` — none is superseded by this script.');
