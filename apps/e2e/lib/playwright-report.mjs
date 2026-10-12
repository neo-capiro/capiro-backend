/**
 * Shared Playwright report adapter/importer (CleanUp1 §8.5, review round 60).
 *
 * ONE canonical place turns a raw Playwright JSON report — either a
 * `test --list --reporter=json` DISCOVERY report or a real `test
 * --reporter=json` EXECUTION report — into the per-test identity multiset
 * (project :: suite :: name) and the ACTUAL execution status summary.
 *
 * It REUSES the reviewed canonical `parsePlaywrightList` / `parseReport`
 * exports from scripts/test-proof/lib/adapters.mjs (never a second text/JSON
 * parser), so the regression driver, the strict same-source repeat proof and
 * the gate's pinned-visual validator all agree about identity and status.
 *
 * IMPORTANT status semantics (review round 60.3): a Playwright result's
 * `result.status` is passed / failed / timedOut / skipped / interrupted — it is
 * NOT `unexpected` / `flaky`. The per-test CLASSIFICATION lives on
 * `test.status` (expected / unexpected / flaky / skipped) and must be
 * cross-checked against the raw `results[]` statuses AND the native global
 * `stats`. This module does exactly that.
 */

import { parsePlaywrightList } from '../../../scripts/test-proof/lib/adapters.mjs';

export const PLAYWRIGHT_JSON_REPORTER = 'json';

const E2E_TARGET = Object.freeze({ package: '@capiro/e2e', packageDir: 'apps/e2e', runner: 'playwright', tier: 'playwright' });
const SEP = '\u0000';

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The identity tuple for one Playwright occurrence: project :: suite :: name. */
export function playwrightIdentityKey(rec) {
  return `${rec.project ?? '(root)'}${SEP}${rec.suite ?? ''}${SEP}${rec.fullName ?? ''}`;
}

/**
 * The sorted per-test identity multiset of a Playwright JSON report (list OR
 * run), derived from the canonical parser. Duplicates are PRESERVED (a multiset,
 * not a set) so a duplicated or dropped case cannot compare equal to the
 * discovery set.
 */
export function playwrightIdentityMultiset(json) {
  const parsed = parsePlaywrightList(json, {
    target: E2E_TARGET,
    packageDirAbs: null,
    packageDirRel: 'apps/e2e',
    reportPath: null,
  });
  return parsed.tests.map(playwrightIdentityKey).sort(cmp);
}

/**
 * The raw result statuses Playwright may emit on `results[].status`. A status
 * outside this set is an UNKNOWN state and must refuse, never be counted as a
 * pass.
 */
export const PLAYWRIGHT_RESULT_STATUSES = Object.freeze(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);

/** The classifications Playwright may emit on `test.status`. */
export const PLAYWRIGHT_TEST_STATUSES = Object.freeze(['expected', 'unexpected', 'flaky', 'skipped']);

const RESULT_STATUS_SET = new Set(PLAYWRIGHT_RESULT_STATUSES);
const TEST_STATUS_SET = new Set(PLAYWRIGHT_TEST_STATUSES);

/**
 * The actual-execution summary of a Playwright run report.
 *
 * Round-73 correction: the previous version's final `else` counted a test as
 * `expected` whenever its classification was neither unexpected/flaky/skipped —
 * so a test with an EMPTY `results[]`, an UNKNOWN/absent test status, or an
 * UNKNOWN/cancelled/interrupted raw result status was silently labelled a pass.
 * This version classifies a case as `expected` ONLY when its `test.status` is a
 * known classification AND its raw `results[].status` are all valid AND the two
 * agree (expected=clean pass, skipped=all skipped, unexpected=has a failure,
 * flaky=failure then pass). EVERYTHING else is a hard `unexpected` AND recorded
 * in `statusProblems`, so a genuinely unexecuted/unknown/interrupted/cancelled
 * result can never be green. The native global `stats` and top-level `errors[]`
 * are captured for the coherence check in {@link playwrightAgreementProblems}.
 */
export function playwrightExecutionSummary(json) {
  const identity = playwrightIdentityMultiset(json);
  const statusProblems = [];
  let expected = 0;
  let skipped = 0;
  let flaky = 0;
  let unexpected = 0;
  const suites = json && Array.isArray(json.suites) ? json.suites : null;
  if (!suites) statusProblems.push('run report has no suites[] array (no executed cases)');
  const walk = (ss) => {
    for (const s of ss || []) {
      for (const spec of (s && s.specs) || []) {
        for (const t of (spec && spec.tests) || []) {
          const who = `${t && t.projectName ? t.projectName : '(root)'} :: ${spec && spec.title ? spec.title : '(untitled)'}`;
          const ts = t && t.status;
          const results = t && Array.isArray(t.results) ? t.results : null;
          const rs = results ? results.map((r) => r && r.status) : [];
          let bad = false;
          if (!results || results.length === 0) {
            statusProblems.push(`case "${who}" has NO raw results[] (unexecuted/absent result)`);
            bad = true;
          }
          if (!TEST_STATUS_SET.has(ts)) {
            statusProblems.push(`case "${who}" has an UNKNOWN test classification ${JSON.stringify(ts)}`);
            bad = true;
          }
          for (const r of rs) {
            if (!RESULT_STATUS_SET.has(r)) {
              statusProblems.push(`case "${who}" has an UNKNOWN/cancelled/interrupted raw result status ${JSON.stringify(r)}`);
              bad = true;
            }
          }
          const anyFail = rs.some((x) => x === 'failed' || x === 'timedOut' || x === 'interrupted');
          const anyPass = rs.some((x) => x === 'passed');
          const allSkip = rs.length > 0 && rs.every((x) => x === 'skipped');
          if (!bad) {
            if (ts === 'expected') {
              if (anyFail || allSkip || !anyPass) {
                statusProblems.push(`case "${who}" is classified expected but its raw results are not a clean pass`);
                bad = true;
              }
            } else if (ts === 'skipped') {
              if (!allSkip) {
                statusProblems.push(`case "${who}" is classified skipped but its raw results are not all skipped`);
                bad = true;
              }
            } else if (ts === 'unexpected') {
              if (!anyFail) {
                statusProblems.push(`case "${who}" is classified unexpected but has no failed/timedOut/interrupted raw result`);
                bad = true;
              }
            } else if (ts === 'flaky') {
              if (!anyFail || !anyPass) {
                statusProblems.push(`case "${who}" is classified flaky but its raw results do not show a failure followed by a pass`);
                bad = true;
              }
            }
          }
          if (bad) {
            unexpected += 1;
            continue;
          }
          if (ts === 'unexpected') unexpected += 1;
          else if (ts === 'flaky') flaky += 1;
          else if (ts === 'skipped' || allSkip) skipped += 1;
          else expected += 1;
        }
      }
      if (Array.isArray(s && s.suites)) walk(s.suites);
    }
  };
  walk(suites || []);
  const unique = new Set(identity);
  const stats = json && json.stats && typeof json.stats === 'object' ? json.stats : null;
  const intOrNull = (v) => (Number.isInteger(v) ? v : null);
  // Playwright's JSON report carries errors as a TOP-LEVEL array (`errors`), not
  // a `stats.errors` count. Both are captured so the coherence check can require
  // an empty error list AND an agreeing numeric count.
  const errorsArr = json && Array.isArray(json.errors) ? json.errors : null;
  const errorListCount = errorsArr ? errorsArr.length : null;
  const statsErrorsField = intOrNull(stats && stats.errors);
  const statsErrors = errorListCount !== null ? errorListCount : statsErrorsField;
  return {
    identity,
    identityDigest: identity.join('\n'),
    count: identity.length,
    uniqueCount: unique.size,
    duplicates: identity.length - unique.size,
    expected,
    skipped,
    flaky,
    unexpected,
    statusProblems,
    stats,
    statsExpected: intOrNull(stats && stats.expected),
    statsSkipped: intOrNull(stats && stats.skipped),
    statsUnexpected: intOrNull(stats && stats.unexpected),
    statsFlaky: intOrNull(stats && stats.flaky),
    statsErrorsField,
    errorListCount,
    statsErrors,
  };
}

/** The sorted identity multiset discovered by a `--list` report (list == run contract). */
export function playwrightDiscoveredMultiset(json) {
  return playwrightIdentityMultiset(json);
}

/**
 * Problem list for "the observed execution identity/status disagrees with an
 * independently-supplied discovery multiset". Empty = agreement. `discovered`
 * is the `--list` identity multiset for the SAME config.
 *
 * FAIL-CLOSED on every review-required hole: unknown/unexecuted/interrupted/
 * cancelled statuses, a non-empty/absent error list, and a native global stats
 * block that does not agree with the observed classification.
 */
export function playwrightAgreementProblems(summary, discovered, { label = 'playwright stage' } = {}) {
  const problems = [];
  const push = (m) => problems.push(`${label}: ${m}`);
  if (!summary || !Array.isArray(summary.identity)) {
    push('no parsed execution summary');
    return problems;
  }
  // The strict per-case classification must be clean.
  if (Array.isArray(summary.statusProblems) && summary.statusProblems.length > 0) {
    for (const m of summary.statusProblems) push(m);
  }
  if (summary.count === 0) push('execution produced ZERO test identities');
  if (!Array.isArray(discovered) || discovered.length === 0) {
    push('no independently discovered identity multiset (a --list report is required)');
  } else if (summary.identityDigest !== discovered.slice().sort(cmp).join('\n')) {
    push(`execution identity multiset does not equal the independent --list discovery (run=${summary.count} list=${discovered.length})`);
  }
  if (summary.unexpected !== 0) push(`${summary.unexpected} unexpected/failed/unexecuted/unknown case(s)`);
  if (summary.flaky !== 0) push(`${summary.flaky} flaky case(s)`);
  if (summary.skipped !== 0) push(`${summary.skipped} skipped case(s)`);
  // native global stats must exist, be complete, and agree with the observed
  // classification.
  if (summary.statsExpected === null || summary.statsSkipped === null || summary.statsUnexpected === null || summary.statsFlaky === null) {
    push('native global stats are incomplete (expected/skipped/unexpected/flaky must be integers)');
  } else {
    if (summary.statsUnexpected !== 0) push(`native stats report ${summary.statsUnexpected} unexpected`);
    if (summary.statsFlaky !== 0) push(`native stats report ${summary.statsFlaky} flaky`);
    if (summary.statsSkipped !== 0) push(`native stats report ${summary.statsSkipped} skipped`);
    if (summary.statsUnexpected !== summary.unexpected) push(`native stats unexpected ${summary.statsUnexpected} != observed unexpected ${summary.unexpected}`);
    if (summary.statsFlaky !== summary.flaky) push(`native stats flaky ${summary.statsFlaky} != observed flaky ${summary.flaky}`);
    if (summary.statsSkipped !== summary.skipped) push(`native stats skipped ${summary.statsSkipped} != observed skipped ${summary.skipped}`);
    if (summary.statsExpected !== summary.expected) push(`native stats expected ${summary.statsExpected} != observed expected ${summary.expected}`);
    if (summary.statsExpected !== summary.count) {
      push(`native stats expected ${summary.statsExpected} != observed identity count ${summary.count}`);
    }
  }
  // The native global ERROR list/count must be recorded, coherent and empty: the
  // top-level errors[] array is REQUIRED (an absent list is a refusal, not a
  // silent zero) and, when a numeric stats.errors is present, it must agree.
  if (summary.errorListCount === null) {
    push('native global error list is not recorded (an empty top-level errors[] is required)');
  } else if (summary.statsErrorsField !== null && summary.errorListCount !== summary.statsErrorsField) {
    push(`native error list length ${summary.errorListCount} disagrees with stats.errors ${summary.statsErrorsField}`);
  }
  if (summary.statsErrors === null) push('native global error count is not recorded');
  else if (summary.statsErrors !== 0) push(`native stats report ${summary.statsErrors} error(s)`);
  return problems;
}
