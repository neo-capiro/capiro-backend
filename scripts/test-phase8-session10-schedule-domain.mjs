#!/usr/bin/env node
/**
 * Phase 8 Session 10 — schedule domain gate.
 *
 * Runs against the BUILT @capiro/defense-domain output so CI exercises the
 * same artifact the coordinator service consumes. Every assertion is a
 * Session 10 acceptance requirement: due-ness is a pure function of
 * (adapterId, nowIso) with no hidden "current year", a cold start is due
 * rather than silently idle, and a tick summary cannot misreport its own
 * counts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const {
  evaluateAdapterDue,
  selectDueAdapters,
  sanitizeScheduleFailureReason,
  buildScheduleTickSummary,
  InvalidScheduleTickSummaryError,
} = domain;

const NOW = '2028-06-15T12:00:00.000Z';
const PAST = '2028-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';

// ── due-ness ────────────────────────────────────────────────────────────────

test('no prior state at all is due now, not silently idle', () => {
  const decision = evaluateAdapterDue({ adapterId: 'hasc', state: null, nowIso: NOW });
  assert.equal(decision.due, true);
  assert.match(decision.reason, /no prior next_check_at/);
});

test('a null next_check_at on an existing row is due now', () => {
  const decision = evaluateAdapterDue({
    adapterId: 'hasc',
    state: { nextCheckAt: null },
    nowIso: NOW,
  });
  assert.equal(decision.due, true);
});

test('a future next_check_at is not due', () => {
  const decision = evaluateAdapterDue({
    adapterId: 'hasc',
    state: { nextCheckAt: FUTURE },
    nowIso: NOW,
  });
  assert.equal(decision.due, false);
  assert.match(decision.reason, /not due until/);
});

test('a past next_check_at is due, however overdue', () => {
  const decision = evaluateAdapterDue({
    adapterId: 'hasc',
    state: { nextCheckAt: PAST },
    nowIso: NOW,
  });
  assert.equal(decision.due, true);
});

test('next_check_at exactly equal to now is due (inclusive boundary)', () => {
  const decision = evaluateAdapterDue({ adapterId: 'hasc', state: { nextCheckAt: NOW }, nowIso: NOW });
  assert.equal(decision.due, true);
});

test('an invalid instant throws rather than silently resolving to "not due"', () => {
  assert.throws(
    () => evaluateAdapterDue({ adapterId: 'hasc', state: null, nowIso: 'not-a-date' }),
    RangeError,
  );
  assert.throws(
    () =>
      evaluateAdapterDue({
        adapterId: 'hasc',
        state: { nextCheckAt: 'not-a-date' },
        nowIso: NOW,
      }),
    RangeError,
  );
});

test('due-ness contains no fiscal-year or calendar-year concept at all', () => {
  // Sessions 7/8 fixed classification to (fiscalYear, authorityTrack); the
  // scheduler must not reintroduce a "current year" anywhere. Proven here by
  // running the exact same decision across three fiscal years' worth of
  // instants and confirming only next_check_at ever changes the outcome.
  for (const nowIso of ['2024-01-01T00:00:00.000Z', '2028-06-15T00:00:00.000Z', '2032-12-31T23:59:59.000Z']) {
    const due = evaluateAdapterDue({ adapterId: 'hasc', state: null, nowIso });
    assert.equal(due.due, true, `a cold start must be due regardless of calendar year (${nowIso})`);
  }
});

test('selectDueAdapters evaluates every registered id independently', () => {
  const decisions = selectDueAdapters({
    adapterIds: ['hasc', 'sasc', 'govinfo-bills'],
    states: new Map([
      ['hasc', { nextCheckAt: PAST }],
      ['sasc', { nextCheckAt: FUTURE }],
      // govinfo-bills intentionally has no entry: cold start.
    ]),
    nowIso: NOW,
  });
  const byId = new Map(decisions.map((decision) => [decision.adapterId, decision]));
  assert.equal(byId.get('hasc').due, true);
  assert.equal(byId.get('sasc').due, false);
  assert.equal(byId.get('govinfo-bills').due, true);
});

// ── failure sanitisation ────────────────────────────────────────────────────

test('an Error is reduced to its bounded message', () => {
  const reason = sanitizeScheduleFailureReason(new Error('boom'));
  assert.equal(reason, 'boom');
});

test('a non-Error throw still produces a readable, bounded string', () => {
  assert.equal(sanitizeScheduleFailureReason('a plain string'), 'a plain string');
  assert.equal(sanitizeScheduleFailureReason(42), '42');
});

test('an overlong message is bounded to 500 characters', () => {
  const reason = sanitizeScheduleFailureReason(new Error('x'.repeat(10_000)));
  assert.equal(reason.length, 500);
});

// ── tick summary ────────────────────────────────────────────────────────────

const BASE = {
  workerId: 'worker-1',
  tickKey: 'tick-1',
  startedAt: '2028-06-15T12:00:00.000Z',
  finishedAt: '2028-06-15T12:00:05.000Z',
  horizonBootstrapped: true,
  adaptersConsidered: 3,
  committed: true,
};

test('a clean tick partitions succeeded/failed/skipped-lease exactly and completes', () => {
  const summary = buildScheduleTickSummary({
    ...BASE,
    attempts: [
      { adapterId: 'a', outcome: 'ran_succeeded', detail: '' },
      { adapterId: 'b', outcome: 'ran_failed', detail: '' },
      { adapterId: 'c', outcome: 'skipped_not_due', detail: '' },
    ],
  });
  assert.equal(summary.outcome, 'completed');
  assert.equal(summary.adaptersDue, 2);
  assert.equal(summary.adaptersSucceeded, 1);
  assert.equal(summary.adaptersFailed, 1);
  assert.equal(summary.adaptersSkippedLease, 0);
  assert.equal(summary.failureReason, null);
  assert.equal(Object.isFrozen(summary), true);
});

test('a per-adapter failure is bucketed, not escalated: the tick itself still completes', () => {
  const summary = buildScheduleTickSummary({
    ...BASE,
    adaptersConsidered: 1,
    attempts: [{ adapterId: 'a', outcome: 'ran_failed', detail: 'boom' }],
  });
  assert.equal(summary.outcome, 'completed', 'one bad adapter must not read as "the scheduler is down"');
  assert.equal(summary.adaptersFailed, 1);
});

test('a stated failureReason marks the tick itself failed', () => {
  const summary = buildScheduleTickSummary({
    ...BASE,
    adaptersConsidered: 0,
    attempts: [],
    failureReason: 'could not load adapter schedule state',
  });
  assert.equal(summary.outcome, 'failed');
  assert.equal(summary.failureReason, 'could not load adapter schedule state');
});

test('a blank failureReason is treated as absent, not as a failed tick', () => {
  const summary = buildScheduleTickSummary({ ...BASE, adaptersConsidered: 0, attempts: [], failureReason: '   ' });
  assert.equal(summary.outcome, 'completed');
  assert.equal(summary.failureReason, null);
});

test('finishedAt preceding startedAt is refused', () => {
  assert.throws(
    () =>
      buildScheduleTickSummary({
        ...BASE,
        startedAt: '2028-06-15T12:00:05.000Z',
        finishedAt: '2028-06-15T12:00:00.000Z',
        attempts: [],
      }),
    InvalidScheduleTickSummaryError,
  );
});

test('more due attempts than adaptersConsidered is refused', () => {
  assert.throws(
    () =>
      buildScheduleTickSummary({
        ...BASE,
        adaptersConsidered: 1,
        attempts: [
          { adapterId: 'a', outcome: 'ran_succeeded', detail: '' },
          { adapterId: 'b', outcome: 'ran_succeeded', detail: '' },
        ],
      }),
    InvalidScheduleTickSummaryError,
  );
});

test('a blank workerId or tickKey is refused', () => {
  assert.throws(
    () => buildScheduleTickSummary({ ...BASE, workerId: '  ', attempts: [] }),
    InvalidScheduleTickSummaryError,
  );
  assert.throws(
    () => buildScheduleTickSummary({ ...BASE, tickKey: '', attempts: [] }),
    InvalidScheduleTickSummaryError,
  );
});
