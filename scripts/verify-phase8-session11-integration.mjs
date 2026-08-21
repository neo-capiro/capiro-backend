#!/usr/bin/env node
/**
 * Phase 8 Session 11 — real product/read integration check.
 *
 * Runs the REAL compiled `BudgetLifecycleQueryService`, backed by the REAL
 * `PrismaBudgetLifecycleReadStore`, against whatever `DATABASE_URL` this
 * process is given — the disposable rehearsal database, seeded by
 * `verify-phase8-session11-db.sh` with a concrete FY2027 scenario. This is
 * the check that proves the final query RESULT reflects the seeded lifecycle
 * truth (a published PB source, a review_required HASC source, a completed
 * schedule tick), not merely that rows exist in the tables.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'apps/defense-api');

const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));
const { PrismaBudgetLifecycleReadStore } = require(
  path.join(appRoot, 'dist/budget-lifecycle-product/prisma-budget-lifecycle-read.store.js'),
);
const { BudgetLifecycleQueryService } = require(
  path.join(appRoot, 'dist/budget-lifecycle-product/budget-lifecycle-query.service.js'),
);
const { CycleHealthService } = require(path.join(appRoot, 'dist/budget-lifecycle/cycle-health.service.js'));

const PB_SOURCE_ID = '22222222-2222-2222-2222-222222222201';
const HASC_SOURCE_ID = '22222222-2222-2222-2222-222222222202';

const prisma = new PrismaClient();
const store = new PrismaBudgetLifecycleReadStore(prisma);
const service = new BudgetLifecycleQueryService(store, new CycleHealthService());

try {
  const health = await service.getCycleHealth(2027);
  assert.equal(health.fiscalYear, 2027);
  assert.equal(health.expectedSources, 2, 'both seeded expected sources must be counted');
  assert.equal(health.published, 1, 'only the PB source is published');
  assert.equal(health.verified, 1, 'only the PB observation reached ingested');
  assert.equal(health.reviewRequired, 1, 'the HASC observation is review_required');
  assert.equal(health.reviewBacklog, 2, 'both the expected-source AND observation review states count');
  assert.equal(health.notFiled, 0);
  assert.deepEqual(health.staleAdapters, [], 'both seeded adapters ran within the last hour');
  assert.equal(health.missingSourceMeansUnknownNotZero, true);
  assert.equal(health.nvidiaRouting, 'disabled');
  const authTrack = health.tracks.find((track) => track.authorityTrack === 'authorization');
  assert.ok(authTrack, 'authorization track must appear (it has an expected source)');
  assert.equal(authTrack.reviewRequired, 1);
  const appropriationsTrack = health.tracks.find((track) => track.authorityTrack === 'appropriations');
  assert.equal(appropriationsTrack, undefined, 'a track with zero expected sources must not appear at all');
  console.log('  [integration] cycle health reflects the seeded scenario exactly');

  const expectedSources = await service.listExpectedSources(2027);
  assert.equal(expectedSources.length, 2);
  for (const item of expectedSources) assert.equal(item.knownFundingPosition, null);
  console.log('  [integration] expected-sources list carries no fabricated funding position');

  const detail = await service.getExpectedSourceDetail(HASC_SOURCE_ID);
  assert.equal(detail.expectedState, 'review_required');
  assert.equal(detail.reviewReason, 'classifier confidence below threshold');
  assert.equal(detail.observations.length, 1);
  assert.equal(detail.observations[0].observationState, 'review_required');
  assert.deepEqual(detail.observations[0].reviewReasons, [
    'content excerpt did not corroborate metadata',
  ]);
  console.log('  [integration] expected-source detail carries its real review reason and observation history');

  const queue = await service.listReviewQueue(2027);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].expectedSourceId, HASC_SOURCE_ID);
  assert.equal(queue[0].observation.contentSha256, '2'.repeat(64));
  console.log('  [integration] review queue surfaces exactly the seeded HASC hold, with its real content sha');

  const signals = await service.listSignals(2027);
  const pbToHasc = signals.find((signal) => signal.signalKind === 'pb_to_hasc');
  assert.ok(pbToHasc, 'expected a pb_to_hasc signal derived from the two seeded observations');
  assert.equal(pbToHasc.fromContentSha256, '1'.repeat(64));
  assert.equal(pbToHasc.toContentSha256, '2'.repeat(64));
  assert.equal(pbToHasc.carriesFundingAmounts, false);
  console.log('  [integration] a pb_to_hasc signal is derived read-time from real stored observations');

  const tickHealth = await service.getScheduleTickHealth();
  assert.equal(tickHealth.ticksConsidered, 1);
  assert.equal(tickHealth.completedTicks, 1);
  assert.equal(tickHealth.lastTickWorkerId, 'rehearsal-worker');
  assert.equal(tickHealth.staleSinceLastTick, false);
  console.log('  [integration] schedule tick health reflects the seeded tick');

  // Sanity: the PB source itself must still read as published, unaffected by
  // any of the above (only the CLI's own --commit step in the shell rehearsal
  // touches the HASC source).
  const pbDetail = await service.getExpectedSourceDetail(PB_SOURCE_ID);
  assert.equal(pbDetail.expectedState, 'published');

  console.log('SESSION11_INTEGRATION_PASS');
  process.exit(0);
} finally {
  await prisma.$disconnect();
}
