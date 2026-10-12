/**
 * Fixture tests for the diff engine — the acceptance safety behaviour.
 *
 * These do not echo the implementation; they assert the CONTRACT:
 *   - additions and no-change pass
 *   - any unexcused removal fails
 *   - a rename needs an explicit map that points at real occurrences
 *   - a twin removal needs a surviving occurrence that really exists, and one
 *     surviving occurrence cannot excuse two removals (the double-use guard)
 *   - lost or runner-changed scope fails unless acknowledged
 *   - there is no fuzzy rename heuristic (a changed name without a map fails)
 *   - malformed / noncanonical input is rejected (fail-closed front door)
 *   - non-passing or incomplete execution evidence cannot yield a PASS
 *   - a preserved name that regressed from executed to skipped/todo/cancelled fails
 *   - a changed target/config tier is scope loss unless acknowledged
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffDumps } from './lib/diff.mjs';
import { DUMP_SCHEMA, SCHEMA_VERSION } from './lib/schema.mjs';

function target(pkg, runner, tests, status = 'ok', tier = 'test') {
  return { package: pkg, packageDir: pkg, runner, tier, status, exitCode: status === 'runner-failed' ? 1 : 0, tests };
}
function t(suite, fullName, status = 'passed') {
  return { suite, fullName, status };
}
function dump(targets, scope = {}) {
  return { schema: DUMP_SCHEMA, schemaVersion: SCHEMA_VERSION, runSha: 'sha', scope, targets };
}
function zeroDump() {
  return { schema: DUMP_SCHEMA, schemaVersion: SCHEMA_VERSION, runSha: 'sha', scope: {}, targets: [] };
}

test('no change and pure additions pass', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one'), t('a.spec.ts', 'two')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one'), t('a.spec.ts', 'two'), t('a.spec.ts', 'three')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, true);
  assert.equal(r.totals.added, 1);
  assert.equal(r.totals.removed, 0);
});

test('a removed occurrence blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one'), t('a.spec.ts', 'two')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.equal(r.totals.removed, 1);
  assert.ok(r.problems.some((p) => p.includes('removed without twin or rename')));
});

test('multiset: removing one of two identical fullName occurrences is still a removal', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'dup'), t('a.spec.ts', 'dup')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'dup')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false, 'identical twins do not auto-collapse');
  assert.equal(r.totals.removed, 1);
});

test('an explicit 1:1 twin excuses a removal when the survivor really exists', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'X'), t('b.spec.ts', 'X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('b.spec.ts', 'X')])]);
  const twins = [{ package: '@capiro/api', runner: 'jest', fullName: 'X', survivors: [{ suite: 'b.spec.ts' }], removed: [{ suite: 'a.spec.ts' }], note: 'byte-identical duplicate spec' }];
  const r = diffDumps({ before, after, twins });
  assert.equal(r.ok, true);
  assert.equal(r.removedConsolidated.length, 1);
  assert.equal(r.removedConsolidated[0].survivorSuite, 'b.spec.ts');
});

test('twin double-use guard: one survivor cannot excuse two removals without manyToOne', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'X'), t('b.spec.ts', 'X'), t('c.spec.ts', 'X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('b.spec.ts', 'X')])]);
  const twins = [{ package: '@capiro/api', runner: 'jest', fullName: 'X', survivors: [{ suite: 'b.spec.ts' }], removed: [{ suite: 'a.spec.ts' }, { suite: 'c.spec.ts' }] }];
  const blocked = diffDumps({ before, after, twins });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.problems.some((p) => p.includes('manyToOne')), 'double-use requires an explicit declaration');

  const declared = diffDumps({ before, after, twins: [{ ...twins[0], manyToOne: true, note: 'three byte-identical copies' }] });
  assert.equal(declared.ok, true);
});

test('twin with a survivor that is absent from after blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'X'), t('b.spec.ts', 'X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'X')])]);
  const twins = [{ package: '@capiro/api', runner: 'jest', fullName: 'X', survivors: [{ suite: 'b.spec.ts' }], removed: [{ suite: 'a.spec.ts' }] }];
  const r = diffDumps({ before, after, twins });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('survivor suite not present')));
});

test('twin referencing a removed suite not in before blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'X'), t('b.spec.ts', 'X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('b.spec.ts', 'X')])]);
  const twins = [{ package: '@capiro/api', runner: 'jest', fullName: 'X', survivors: [{ suite: 'b.spec.ts' }], removed: [{ suite: 'ghost.spec.ts' }] }];
  const r = diffDumps({ before, after, twins });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('removed suite not present')));
});

test('an explicit valid rename passes and is reported as changed', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'renders X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'renders the %s fixture')])]);
  const renames = [{ package: '@capiro/api', runner: 'jest', from: { suite: 'a.spec.ts', fullName: 'renders X' }, to: { suite: 'a.spec.ts', fullName: 'renders the %s fixture' }, note: 'it.each conversion' }];
  const r = diffDumps({ before, after, renames });
  assert.equal(r.ok, true);
  assert.equal(r.totals.changed, 1);
  assert.equal(r.totals.removed, 0);
});

test('no fuzzy rename heuristic: a changed name without a map blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'renders X')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'renders the %s fixture')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.equal(r.totals.removed, 1);
  assert.equal(r.totals.added, 1);
});

test('rename pointing at a missing after occurrence blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'renders X')])]);
  const after = dump([target('@capiro/api', 'jest', [])]);
  const renames = [{ package: '@capiro/api', runner: 'jest', from: { suite: 'a.spec.ts', fullName: 'renders X' }, to: { suite: 'a.spec.ts', fullName: 'renders Y' } }];
  const r = diffDumps({ before, after, renames });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('after occurrence not found')));
});

test('cross-package rename must be declared and the vacated target acknowledged', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'moves')])]);
  const after = dump([target('@capiro/web', 'vitest', [t('a.spec.ts', 'moves')])]);
  const undeclared = diffDumps({
    before,
    after,
    renames: [{ from: { package: '@capiro/api', runner: 'jest', suite: 'a.spec.ts', fullName: 'moves' }, to: { package: '@capiro/web', runner: 'vitest', suite: 'a.spec.ts', fullName: 'moves' } }],
  });
  assert.equal(undeclared.ok, false, 'silent cross-package move blocked');
  assert.ok(undeclared.problems.some((p) => p.includes('cross-package/runner mapping not declared')));

  const declared = diffDumps({
    before,
    after,
    renames: [{ from: { package: '@capiro/api', runner: 'jest', suite: 'a.spec.ts', fullName: 'moves' }, to: { package: '@capiro/web', runner: 'vitest', suite: 'a.spec.ts', fullName: 'moves' }, crossScope: true, note: 'suite relocated' }],
    scopeAcks: [{ package: '@capiro/api', runner: 'jest', change: 'lost', reason: 'suite relocated to @capiro/web (declared cross-scope rename)' }],
  });
  assert.equal(declared.ok, true);
  assert.ok(declared.changed[0].crossScope);
});

test('gained package is permitted; lost package blocks unless acknowledged', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')]), target('@capiro/new', 'vitest', [t('n.spec.ts', 'new')])]);
  const gained = diffDumps({ before, after });
  assert.equal(gained.ok, true);
  assert.ok(gained.scopeChanged.added.length === 1);

  const lost = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]) , before: dump([
    target('@capiro/api', 'jest', [t('a.spec.ts', 'one')]),
    target('@capiro/old', 'jest', [t('o.spec.ts', 'legacy')]),
  ]) });
  assert.equal(lost.ok, false);
  assert.ok(lost.problems.some((p) => p.includes('lost and not acknowledged')));

  const acked = diffDumps({
    before: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')]), target('@capiro/old', 'jest', [t('o.spec.ts', 'legacy')])]),
    after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]),
    scopeAcks: [{ package: '@capiro/old', runner: 'jest', change: 'lost', reason: 'package retired in CleanUp2' }],
  });
  assert.equal(acked.ok, true);
  assert.ok(acked.scopeChanged.acknowledged.length === 1);
});

test('runner change for a package blocks unless acknowledged', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]);
  const after = dump([target('@capiro/api', 'vitest', [t('a.spec.ts', 'one')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('runner changed')));
});

test('per-package before/after counts are reported', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one'), t('a.spec.ts', 'two')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one'), t('a.spec.ts', 'two'), t('a.spec.ts', 'three')])]);
  const r = diffDumps({ before, after });
  const p = r.perPackage.find((x) => x.package === '@capiro/api');
  assert.deepEqual([p.before, p.after, p.added, p.removed], [2, 3, 1, 0]);
});

/* --------------------------------------------- review finding 1: validation */

test('finding 1: malformed / noncanonical input is rejected; a validated zero-scope snapshot is accepted', () => {
  const empty = diffDumps({ before: {}, after: {} });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'invalid-canonical-dump');
  assert.ok(empty.problems.length > 0);
  assert.equal(empty.validation.before.ok, false);
  assert.equal(empty.validation.after.ok, false);

  const rawRunnerJson = diffDumps({ before: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]), after: { numTotalTests: 0, testResults: [] } });
  assert.equal(rawRunnerJson.ok, false);
  assert.equal(rawRunnerJson.validation.after.ok, false);

  // A dump missing the explicit scope is rejected even with a schema/version.
  const noScope = diffDumps({ before: { schema: DUMP_SCHEMA, schemaVersion: SCHEMA_VERSION, targets: [] }, after: zeroDump() });
  assert.equal(noScope.ok, false);
  assert.equal(noScope.validation.before.ok, false);

  // A deliberately valid zero-scope snapshot: canonical schema, version, explicit scope.
  const zr = diffDumps({ before: zeroDump(), after: zeroDump() });
  assert.equal(zr.ok, true);
  assert.equal(zr.totals.before, 0);
});

/* ----------------------------------- review finding 2: execution evidence */

test('finding 2: a runner-failed / zero-tests after target blocks acceptance but keeps the name diff', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]);

  const failed = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')], 'runner-failed')]) });
  assert.equal(failed.ok, false);
  assert.equal(failed.totals.removed, 0, 'useful name-diff output is retained');
  assert.ok(failed.problems.some((p) => p.includes('evidence') && p.includes('runner-failed')));

  const zero = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')], 'zero-tests')]) });
  assert.equal(zero.ok, false);
  assert.ok(zero.problems.some((p) => p.includes('zero-tests')));

  // Scope-level incomplete evidence in the after dump also blocks.
  const unsupported = diffDumps({
    before,
    after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])], { unsupported: [{ package: '@capiro/mystery', tier: 'test', reason: 'no known runner token' }] }),
  });
  assert.equal(unsupported.ok, false);
  assert.ok(unsupported.problems.some((p) => p.includes('unsupported scope') && p.includes('@capiro/mystery')));

  // Incomplete evidence on the BEFORE side is equally fail-closed.
  const badBefore = diffDumps({ before: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')], 'error')]), after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]) });
  assert.equal(badBefore.ok, false);
  assert.ok(badBefore.problems.some((p) => p.includes('evidence')));
});

test('finding 2: pytest COLLECTED-only targets are reported as collection-only, not executed success', () => {
  const collected = () => dump([{ package: 'capirov2-py', packageDir: 'apps/py', runner: 'pytest', tier: 'pytest-collect', status: 'imported', exitCode: 0, tests: [{ suite: 'tests/test_a.py', fullName: 'test_a', status: 'collected' }] }]);
  const r = diffDumps({ before: collected(), after: collected() });
  assert.equal(r.ok, true, 'collection-only name evidence is still a valid name diff');
  assert.ok(r.evidence.after.collectionOnly.some((m) => m.includes('COLLECTED')));
});

/* ------------------------------------ review finding 3: status regression */

test('finding 3: a preserved name regressed from passed to skipped/todo/cancelled blocks; pre-existing skips remain', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'runs'), t('a.spec.ts', 'conditional', 'skipped')])]);

  const regressed = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'runs', 'skipped'), t('a.spec.ts', 'conditional', 'skipped')])]) });
  assert.equal(regressed.ok, false);
  assert.equal(regressed.statusRegressions.length, 1);
  assert.ok(regressed.problems.some((p) => p.includes('status-regression')));
  assert.deepEqual(regressed.statusChanges[0].before, { passed: 1 });
  assert.deepEqual(regressed.statusChanges[0].after, { skipped: 1 });

  for (const bad of ['todo', 'cancelled', 'pending']) {
    const r = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'runs', bad), t('a.spec.ts', 'conditional', 'skipped')])]) });
    assert.equal(r.ok, false, `${bad} regression blocks`);
  }

  // An identical pre-existing conditional skip may remain.
  const preserved = diffDumps({ before, after: dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'runs'), t('a.spec.ts', 'conditional', 'skipped')])]) });
  assert.equal(preserved.ok, true);
  assert.equal(preserved.statusRegressions.length, 0);
});

test('finding 3: a multiset regression (one of two executed -> skipped) blocks', () => {
  const before = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'dup'), t('a.spec.ts', 'dup')])]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'dup'), t('a.spec.ts', 'dup', 'skipped')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.equal(r.statusRegressions.length, 1);
});

/* -------------------------------------- review finding 4: target/tier scope */

test('finding 4: a target/config tier change blocks unless acknowledged with a concrete reason', () => {
  const before = dump([{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test:unit', status: 'ok', exitCode: 0, tests: [t('a.spec.ts', 'one')] }]);
  const after = dump([{ package: '@capiro/api', packageDir: 'apps/api', runner: 'jest', tier: 'test:integration', status: 'ok', exitCode: 0, tests: [t('a.spec.ts', 'one')] }]);

  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.equal(r.scopeChanged.tierChanged.length, 1);
  assert.ok(r.problems.some((p) => p.includes('tier changed') && p.includes('acknowledged')));

  const acked = diffDumps({ before, after, targetAcks: [{ package: '@capiro/api', runner: 'jest', tier: 'test:unit', change: 'tier-changed', reason: 'unit tier renamed to integration in CleanUp2' }] });
  assert.equal(acked.ok, true);
  assert.equal(acked.scopeChanged.targetsAcknowledged.length, 1);

  const emptyReason = diffDumps({ before, after, targetAcks: [{ package: '@capiro/api', runner: 'jest', tier: 'test:unit', change: 'tier-changed', reason: '   ' }] });
  assert.equal(emptyReason.ok, false, 'an acknowledgement with no reason is not an acknowledgement');
});

test('finding 4: a zero-occurrence target that disappears is still scope loss', () => {
  const before = dump([
    target('@capiro/api', 'jest', [t('a.spec.ts', 'one')]),
    { package: '@capiro/quant', packageDir: 'apps/quant', runner: 'jest', tier: 'test', status: 'ok', exitCode: 0, tests: [] },
  ]);
  const after = dump([target('@capiro/api', 'jest', [t('a.spec.ts', 'one')])]);
  const r = diffDumps({ before, after });
  assert.equal(r.ok, false);
  assert.ok(r.scopeChanged.targetsRemoved.some((x) => x.includes('@capiro/quant')));

  const acked = diffDumps({ before, after, targetAcks: [{ package: '@capiro/quant', runner: 'jest', tier: 'test', change: 'target-removed', reason: 'quant package retired in CleanUp2' }] });
  assert.equal(acked.ok, true);
});

test('finding 4: a compound script tier loss (same package+runner, one tier gone) is not preserved by package/runner alone', () => {
  const before = dump([
    { package: '@capiro/hybrid', packageDir: 'infra/hybrid', runner: 'jest', tier: 'test:jest', status: 'ok', exitCode: 0, tests: [t('a.spec.ts', 'jest one')] },
    { package: '@capiro/hybrid', packageDir: 'infra/hybrid', runner: 'jest', tier: 'test:extra', status: 'ok', exitCode: 0, tests: [t('b.spec.ts', 'extra one')] },
  ]);
  const after = dump([
    { package: '@capiro/hybrid', packageDir: 'infra/hybrid', runner: 'jest', tier: 'test:jest', status: 'ok', exitCode: 0, tests: [t('a.spec.ts', 'jest one')] },
  ]);
  const r = diffDumps({ before, after, renames: [], twins: [], scopeAcks: [] });
  assert.equal(r.ok, false, 'the second target tier vanished');
  assert.ok(r.scopeChanged.tierChanged.some((x) => x.includes('test:extra')));
});
