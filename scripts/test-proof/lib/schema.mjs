/**
 * Canonical schema + identity helpers for the test-name preservation proof.
 *
 * A dump is a multiset of test OCCURRENCES. Two tests with an identical
 * (package, runner, suite, fullName) key are still two occurrences: the array
 * keeps every one of them, and nothing in this module ever puts them in a Set.
 * That is what stops "two identical fullName tests in different or the same
 * suites" from silently collapsing into one.
 */

export const DUMP_SCHEMA = 'capiro.test-name-dump';
export const DIFF_SCHEMA = 'capiro.test-name-diff';
export const SCHEMA_VERSION = 1;

export const RUNNERS = ['jest', 'vitest', 'node:test', 'pytest', 'playwright'];

/** Canonical per-test status vocabulary (runner-native statuses are mapped onto it). */
export const STATUSES = ['passed', 'failed', 'skipped', 'todo', 'pending', 'cancelled', 'collected', 'other'];

/** Occurrences that are positive proof the case actually EXECUTED. */
export const EXECUTED_STATUSES = new Set(['passed', 'failed']);

/**
 * Occurrences that prove the case was DISCOVERED but did NOT run: a skip, todo,
 * cancellation or an unmapped status. A preserved name carrying one of these is
 * NOT proof the existing case still ran.
 */
export const NEVER_RUN_STATUSES = new Set(['skipped', 'todo', 'pending', 'cancelled', 'other']);

/** Collection-only evidence (pytest `--collect-only`): names exist, run not proven. */
export const COLLECTION_STATUSES = new Set(['collected']);

/** Target-level statuses. Only `ok` and `imported` are "passing scope". */
export const TARGET_STATUS = {
  OK: 'ok',
  IMPORTED: 'imported',
  RUNNER_FAILED: 'runner-failed',
  ZERO_TESTS: 'zero-tests',
  UNSUPPORTED: 'unsupported',
  ERROR: 'error',
};

export const NON_PASSING_TARGET_STATUSES = new Set([
  TARGET_STATUS.RUNNER_FAILED,
  TARGET_STATUS.ZERO_TESTS,
  TARGET_STATUS.UNSUPPORTED,
  TARGET_STATUS.ERROR,
]);

/** Target statuses that count as passing scope for a target record. */
export const PASSING_TARGET_STATUSES = new Set([TARGET_STATUS.OK, TARGET_STATUS.IMPORTED]);

export function emptyCounts() {
  return { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0, pending: 0, cancelled: 0, collected: 0, other: 0 };
}

/** Count an array of canonical test records. Never dedupes. */
export function countTests(tests) {
  const counts = emptyCounts();
  for (const t of tests) {
    counts.total += 1;
    const s = t.status;
    if (Object.prototype.hasOwnProperty.call(counts, s)) counts[s] += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * The identity tuple for a single occurrence. Returned as a POSIX-joined string
 * for stable sorting and set/multiset bookkeeping.
 *
 * NOTE: this is the identity of an occurrence TYPE. Multiplicity is layered on
 * top of it by the diff engine (which counts occurrences, not this string).
 */
export function identityKey(t) {
  return [t.package, t.runner, t.suite, t.fullName].join('\u0000');
}

/** Stable human-readable rendering (also the ordering key). */
export function describeIdentity(t) {
  return `${t.package} [${t.runner}] ${t.suite} :: ${t.fullName}`;
}

/**
 * Scope identity for a dynamically discovered TARGET: the package, the runner,
 * and the config/script TIER the runner was actually invoked through. A dump
 * whose target tier silently changed (test:unit -> test:integration) is a
 * different target even when every test name is preserved, so scope accounting
 * must key on this, not on package+runner alone.
 */
export function targetKey(t) {
  return [t.package, t.runner, t.tier ?? ''].join('\u0000');
}

/** Human-readable rendering of a target scope key. */
export function describeTarget(t) {
  return `${t.package} [${t.runner}] tier=${t.tier ?? '(none)'}`;
}

/**
 * Build one canonical test record. `suite` is package-relative posix.
 */
export function makeTest({ package: pkg, runner, suite, fullName, status, ancestors, file, project }) {
  return {
    package: pkg,
    runner,
    suite: suite ?? '',
    fullName: fullName ?? '',
    status: status ?? 'other',
    ...(ancestors ? { ancestors } : {}),
    ...(file ? { file } : {}),
    ...(project ? { project } : {}),
  };
}

/** Deterministic ordering of a test array. Never drops entries. */
export function sortTests(tests) {
  return tests.slice().sort((a, b) => {
    const ka = identityKey(a);
    const kb = identityKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    return 0; // identical occurrences keep their insertion order (stable sort)
  });
}
