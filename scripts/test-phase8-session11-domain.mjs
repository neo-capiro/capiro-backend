#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
/**
 * Phase 8 Session 11 — product/read domain gate.
 *
 * Runs against the BUILT @capiro/defense-domain output. Session 11 adds
 * exactly one new pure domain function, `buildScheduleTickHealth`: an
 * aggregation over already-persisted `defense_budget_schedule_tick` rows
 * (Session 10's own audit table). It creates no tick, acquires no lease, and
 * calls no adapter — every assertion here is about read-side aggregation
 * correctness, not about scheduling behaviour (that stays Session 10's own
 * gate, re-run separately and unmodified).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

console.error('Usage: node scripts/test-phase8-session11-domain.mjs (no arguments run the domain gate)');
if (process.argv.length > 2) process.exit(2);

const require = createRequire(import.meta.url);
const domain = require('../packages/defense-domain/dist/index.js');

const { buildScheduleTickHealth } = domain;

const NOW = '2028-06-15T12:00:00.000Z';

function tick(overrides) {
  return {
    workerId: 'worker-1',
    tickKey: 'tick-1',
    startedAt: '2028-06-15T00:00:00.000Z',
    finishedAt: '2028-06-15T00:00:05.000Z',
    outcome: 'completed',
    adaptersConsidered: 14,
    adaptersDue: 2,
    adaptersSucceeded: 2,
    adaptersFailed: 0,
    adaptersSkippedLease: 0,
    committed: true,
    failureReason: null,
    ...overrides,
  };
}

test('no ticks at all reports zero history and stale, not a fabricated timestamp', () => {
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks: [] });
  assert.equal(health.ticksConsidered, 0);
  assert.equal(health.lastTickAt, null);
  assert.equal(health.lastTickOutcome, null);
  assert.equal(health.lastTickWorkerId, null);
  assert.equal(health.staleSinceLastTick, true, 'no tick ever recorded must read as stale');
  assert.equal(Object.isFrozen(health), true);
});

test('the most recent tick by finishedAt wins regardless of input order', () => {
  const older = tick({ tickKey: 'a', finishedAt: '2028-06-14T00:00:00.000Z', workerId: 'w-old' });
  const newer = tick({ tickKey: 'b', finishedAt: '2028-06-15T11:00:00.000Z', workerId: 'w-new' });
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks: [older, newer] });
  assert.equal(health.lastTickAt, '2028-06-15T11:00:00.000Z');
  assert.equal(health.lastTickWorkerId, 'w-new');
});

test('a tick within the staleness window is not stale', () => {
  const recent = tick({ finishedAt: '2028-06-15T11:00:00.000Z' });
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks: [recent], staleAfterHours: 26 });
  assert.equal(health.staleSinceLastTick, false);
});

test('a tick older than the staleness window is stale', () => {
  const old = tick({ finishedAt: '2028-06-10T00:00:00.000Z' });
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks: [old], staleAfterHours: 26 });
  assert.equal(health.staleSinceLastTick, true);
});

test('completed/failed tick counts partition the full set exactly', () => {
  const health = buildScheduleTickHealth({
    nowIso: NOW,
    ticks: [
      tick({ tickKey: 'a', outcome: 'completed' }),
      tick({ tickKey: 'b', outcome: 'completed' }),
      tick({ tickKey: 'c', outcome: 'failed', failureReason: 'could not load adapter state' }),
    ],
  });
  assert.equal(health.ticksConsidered, 3);
  assert.equal(health.completedTicks, 2);
  assert.equal(health.failedTicks, 1);
});

test('per-adapter totals sum across every tick, not just the latest', () => {
  const health = buildScheduleTickHealth({
    nowIso: NOW,
    ticks: [
      tick({ tickKey: 'a', adaptersConsidered: 14, adaptersSucceeded: 2, adaptersFailed: 0, adaptersSkippedLease: 0 }),
      tick({ tickKey: 'b', adaptersConsidered: 14, adaptersSucceeded: 1, adaptersFailed: 1, adaptersSkippedLease: 0 }),
    ],
  });
  assert.equal(health.totalAdaptersConsidered, 28);
  assert.equal(health.totalAdaptersSucceeded, 3);
  assert.equal(health.totalAdaptersFailed, 1);
  assert.equal(health.totalAdaptersSkippedLease, 0);
});

test('recent failure reasons are newest-first and capped at 10', () => {
  const ticks = Array.from({ length: 15 }, (_, index) =>
    tick({
      tickKey: `t-${index}`,
      outcome: 'failed',
      failureReason: `reason-${index}`,
      finishedAt: new Date(Date.parse('2028-06-01T00:00:00.000Z') + index * 3_600_000).toISOString(),
    }),
  );
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks });
  assert.equal(health.recentFailureReasons.length, 10);
  assert.equal(health.recentFailureReasons[0], 'reason-14', 'newest failure must lead the list');
});

test('a tick with no failureReason never appears in recentFailureReasons', () => {
  const health = buildScheduleTickHealth({
    nowIso: NOW,
    ticks: [tick({ outcome: 'completed', failureReason: null })],
  });
  assert.deepEqual(health.recentFailureReasons, []);
});

test('an invalid nowIso throws rather than silently reporting fresh', () => {
  assert.throws(() => buildScheduleTickHealth({ nowIso: 'not-a-date', ticks: [] }), RangeError);
});

test('the result is immutable', () => {
  const health = buildScheduleTickHealth({ nowIso: NOW, ticks: [tick({})] });
  assert.throws(() => {
    health.ticksConsidered = 999;
  });
  assert.equal(Object.isFrozen(health.recentFailureReasons), true);
});
