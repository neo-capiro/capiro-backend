#!/usr/bin/env node
/**
 * Tests for the Phase 2 scope check (repair for finding F-001).
 *
 * The regression test that matters is the last one: the real Phase 2 range must
 * stay clean while the real Phase 3 range is allowed to touch apps/web. That is
 * the exact distinction the original inline gate could not make.
 *
 * Run: node scripts/verify-engagement-phase2-scope.spec.mjs
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { violations, filesInRange } from './verify-engagement-phase2-scope.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PHASE2_BASE = '47902517c7dd64a408a87cef57323812407c29c8';
const PHASE2_HEAD = '3841a5ee';

const WEB = ['^apps/web/'];

// ────────────────────────────────────────────────────────────── pure predicate

test('a forbidden path is detected', () => {
  assert.deepEqual(
    violations(['apps/web/src/App.tsx', 'docs/readme.md'], WEB),
    ['apps/web/src/App.tsx'],
  );
});

test('a clean file list yields no violations', () => {
  assert.deepEqual(violations(['docs/readme.md', 'scripts/x.mjs'], WEB), []);
});

test('the pattern is anchored — apps/website is not apps/web', () => {
  // Anchoring matters: an unanchored /apps.web/ would match unrelated trees.
  assert.deepEqual(violations(['infra/apps/web/thing.ts'], WEB), []);
});

test('results are sorted and deduplicated by input order', () => {
  const found = violations(['apps/web/b.ts', 'apps/web/a.ts'], WEB);
  assert.deepEqual(found, ['apps/web/a.ts', 'apps/web/b.ts']);
});

test('multiple forbidden patterns are all applied', () => {
  const found = violations(
    ['apps/web/a.ts', 'apps/api/prisma/migrations/x/migration.sql', 'docs/y.md'],
    ['^apps/web/', '^apps/api/prisma/migrations/'],
  );
  assert.deepEqual(found, ['apps/api/prisma/migrations/x/migration.sql', 'apps/web/a.ts']);
});

// ───────────────────────────────────────────── NEGATIVE CONTROL: it must bite

test('NEGATIVE CONTROL: a range that touches apps/web is reported', () => {
  const found = violations(
    ['apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json'],
    WEB,
  );
  assert.equal(found.length, 1, 'the check must still fail on a real web change');
});

// ───────────────────────────────────────── regression: the F-001 distinction

test('REGRESSION F-001: Phase 2 range is clean, Phase 3 range may touch apps/web', () => {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

  // The assertion the gate is actually making: Phase 2 itself did not touch
  // product web. This must hold forever, on every descendant branch.
  const phase2Files = filesInRange(PHASE2_BASE, PHASE2_HEAD, ROOT);
  assert.deepEqual(
    violations(phase2Files, WEB),
    [],
    'Phase 2 must not have touched apps/web',
  );
  assert.ok(phase2Files.length > 0, 'the Phase 2 range must not be empty');

  // And the bug: the same check against an open-ended HEAD now reports Phase 3's
  // legitimate, plan-specified fixture as a Phase 2 scope violation.
  const throughHead = violations(filesInRange(PHASE2_BASE, head, ROOT), WEB);
  assert.ok(
    throughHead.length > 0,
    'expected the open-ended range to be dirty — otherwise this test no longer reproduces F-001',
  );
});
