import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ALLOWED_WALL_LITERALS,
  SENTINEL_FILE,
  evaluate,
  findWallLiterals,
} from './check-ethical-wall-literals.mjs';

const guard = fileURLToPath(new URL('./check-ethical-wall-literals.mjs', import.meta.url));

function fixture(files) {
  const cwd = mkdtempSync(join(tmpdir(), 'ethical-wall-gate-'));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'core.autocrlf', 'false');
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, name)), { recursive: true });
    writeFileSync(join(cwd, name), body);
  }
  git('add', '-A');
  return spawnSync(process.execPath, [guard], { cwd, encoding: 'utf8' });
}

const SENTINEL = { [SENTINEL_FILE]: 'export class ContextCompilerService {}\n' };

test('the live allowlist is empty and every entry, if added, must carry a reason', () => {
  assert.deepEqual(ALLOWED_WALL_LITERALS, []);
  for (const entry of ALLOWED_WALL_LITERALS) assert.ok(entry.reason?.trim());
});

test('a literal grant in live source fails with its location', () => {
  const run = fixture({
    ...SENTINEL,
    'apps/api/src/legiwatch.service.ts': 'const req = {\n  ethicalWallAllowed: true,\n};\n',
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /Live ethical-wall bypass found/);
  assert.match(run.stderr, /apps\/api\/src\/legiwatch\.service\.ts:2:ethicalWallAllowed: true,/);
});

test('quoted keys, loose spacing, tsx and packages/ are all in scope', () => {
  const run = fixture({
    ...SENTINEL,
    'apps/web/src/a.tsx': "const a = { 'ethicalWallAllowed' : true };\n",
    'packages/core/src/b.mts': 'const b = { "ethicalWallAllowed":true };\n',
  });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stderr, /apps\/web\/src\/a\.tsx:1:/);
  assert.match(run.stderr, /packages\/core\/src\/b\.mts:1:/);
});

test('derived values, tests, untracked roots and non-literal identifiers pass', () => {
  const run = fixture({
    ...SENTINEL,
    'apps/api/src/derived.ts':
      'const r = { ethicalWallAllowed: security.authorizedClientIds.includes(clientId) };\n' +
      'const s = { ethicalWallAllowed: trueFromServer };\n',
    'apps/api/src/derived.spec.ts': 'const fixture = { ethicalWallAllowed: true };\n',
    'apps/api/src/derived.test.ts': 'const fixture = { ethicalWallAllowed: true };\n',
    'scripts/offline.ts': 'const offline = { ethicalWallAllowed: true };\n',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Ethical-wall gate PASS: 2 live source file\(s\) scanned/);
});

test('a scan that never saw the Context Plane compiler fails closed instead of passing', () => {
  const run = fixture({ 'apps/api/src/other.ts': 'export const x = 1;\n' });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /refusing to report a clean result/);
});

test('outside a git checkout the gate cannot verify anything and fails closed', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ethical-wall-nogit-'));
  const run = spawnSync(process.execPath, [guard], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(cwd) },
  });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /could not run/);
});

test('an allowlist entry matches only its exact trimmed line and goes stale when it changes', () => {
  const allowlist = [
    { file: 'apps/a.ts', line: 'ethicalWallAllowed: true, // reviewed', reason: 'fixture' },
  ];
  const reviewed = findWallLiterals(
    ['apps/a.ts'],
    () => '    ethicalWallAllowed: true, // reviewed\n',
  );
  assert.deepEqual(evaluate(reviewed, allowlist), {
    violations: [],
    allowed: reviewed,
    stale: [],
  });

  const edited = findWallLiterals(['apps/a.ts'], () => '    ethicalWallAllowed: true,\n');
  const result = evaluate(edited, allowlist);
  assert.deepEqual(result.violations, edited);
  assert.deepEqual(result.stale, allowlist);
});
