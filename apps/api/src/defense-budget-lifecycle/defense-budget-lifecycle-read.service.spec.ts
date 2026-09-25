import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { DefenseBudgetLifecycleReadService } from './defense-budget-lifecycle-read.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const EXPECTED_SOURCE = {
  id: 'es-1',
  cycleId: 'cycle-1',
  fiscalYear: 2027,
  authorityTrack: 'appropriations',
  stage: 'hac_d',
  sourceFamily: 'rdte',
  chamber: 'house' as const,
  committee: 'Appropriations',
  component: 'ARMY',
  adapterId: 'house-approps-adapter',
  label: 'FY27 House Defense Appropriations Report',
  expectedState: 'not_filed',
  optional: false,
  expectedFrom: new Date('2026-01-01T00:00:00Z'),
  expectedTo: new Date('2026-12-31T00:00:00Z'),
  reviewReason: null,
  dedupKey: 'a'.repeat(64),
};

function prismaMock(overrides: Partial<Record<string, unknown>> = {}) {
  const base = {
    defenseBudgetExpectedSource: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => null),
    },
    defenseBudgetSourceObservation: { findMany: jest.fn(async () => []) },
    defenseBudgetWatcherAdapter: { findMany: jest.fn(async () => []) },
    defenseBudgetIngestionOutbox: { findMany: jest.fn(async () => []) },
    defenseBudgetScheduleTick: { findMany: jest.fn(async () => []) },
  };
  return { ...base, ...overrides } as unknown as PrismaService;
}

describe('DefenseBudgetLifecycleReadService', () => {
  test('coverage reconciliation uses the current run and does not promote a stale PASS', async () => {
    const original = process.env.APP_ENV;
    process.env.APP_ENV = 'capiro-dev';
    try {
      const prisma = prismaMock({
        defenseBudgetExpectedSource: { findMany: jest.fn(async () => [{ ...EXPECTED_SOURCE,
          sourceFamily: 'pb_r2', component: 'ARMY' }]) },
        defenseBudgetSourceObservation: { findMany: jest.fn(async () => [{ id: 'observation',
          expectedSourceId: 'es-1', sourceDocumentId: 'doc-1', contentSha256: 'sha-1',
          supersededByObservationId: null, observationState: 'ingested' }]) },
        defenseBudgetSourceBundleMember: { findMany: jest.fn(async () => []) },
        defenseBudgetActiveSnapshot: { findUnique: jest.fn(async () => ({ snapshotId: 'snap-1' })) },
        budgetExtractionCandidateV1: { findMany: jest.fn(async () => [{ id: 'candidate-1',
          sourceDocumentId: 'doc-1', sourceSha256: 'sha-1', currentRunId: 'run-new',
          runs: [{ id: 'run-old', decision: 'PASS' }, { id: 'run-new', decision: 'REVIEW' }],
          reviewDecisions: [] }]) },
        defenseBudgetCanonicalRow: { findMany: jest.fn(async () => []) },
      });
      const report = await new DefenseBudgetLifecycleReadService(prisma).getCoverageReconciliation(2027);
      expect(report.rows[0]).toMatchObject({ parsed: 1, verified: 0, reviewed: 0, published: 0,
        denominator: null });
      expect(report.rows[0]?.units[0]).toMatchObject({ kind: 'document', account: null,
        budgetActivity: null });
    } finally {
      if (original === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = original;
    }
  });

  test('coverage reconciliation preserves linked unavailable and superseded history without duplicating linked observations', async () => {
    const original = process.env.APP_ENV;
    process.env.APP_ENV = 'capiro-dev';
    try {
      const observations = [
        { id: 'old-observation', expectedSourceId: 'es-1', sourceDocumentId: 'doc-old',
          contentSha256: 'sha-old', supersededByObservationId: 'new-observation', observationState: 'ingested' },
        { id: 'blocked-observation', expectedSourceId: 'es-1', sourceDocumentId: 'doc-blocked',
          contentSha256: 'sha-blocked', supersededByObservationId: null, observationState: 'blocked' },
        { id: 'new-observation', expectedSourceId: 'es-1', sourceDocumentId: 'doc-new',
          contentSha256: 'sha-new', supersededByObservationId: null, observationState: 'ingested' },
        { id: 'duplicate-new-observation', expectedSourceId: 'es-1', sourceDocumentId: 'doc-new',
          contentSha256: 'sha-new', supersededByObservationId: null, observationState: 'ingested' },
      ];
      const prisma = prismaMock({
        defenseBudgetExpectedSource: { findMany: jest.fn(async () => [{ ...EXPECTED_SOURCE,
          sourceFamily: 'pb_r2', component: 'ARMY' }]) },
        defenseBudgetSourceObservation: { findMany: jest.fn(async () => observations) },
        defenseBudgetSourceBundleMember: { findMany: jest.fn(async () => [
          { id: 'member-old', expectedSourceId: 'es-1', required: true, budgetActivity: '1',
            volume: '1', observationId: 'old-observation', sourceDocumentId: 'doc-old', memberStatus: 'verified' },
          { id: 'member-blocked', expectedSourceId: 'es-1', required: true, budgetActivity: '2',
            volume: '1', observationId: 'blocked-observation', sourceDocumentId: 'doc-blocked', memberStatus: 'observed' },
        ]) },
        defenseBudgetActiveSnapshot: { findUnique: jest.fn(async () => ({ snapshotId: 'snap-1' })) },
        budgetExtractionCandidateV1: { findMany: jest.fn(async () => []) },
        defenseBudgetCanonicalRow: { findMany: jest.fn(async () => []) },
      });
      const report = await new DefenseBudgetLifecycleReadService(prisma).getCoverageReconciliation(2027);
      const units = report.rows[0]?.units ?? [];
      expect(units).toHaveLength(3);
      expect(units.find((unit) => unit.unitId === 'member-old')).toMatchObject({
        sourceDocumentId: 'doc-old', sourceSha256: 'sha-old', superseded: true, published: false,
      });
      expect(units.find((unit) => unit.unitId === 'member-old')?.exceptions).toContain('source_superseded');
      expect(units.find((unit) => unit.unitId === 'member-blocked')).toMatchObject({
        sourceDocumentId: 'doc-blocked', sourceSha256: 'sha-blocked', published: false,
      });
      expect(units.find((unit) => unit.unitId === 'member-blocked')?.exceptions).toContain('source_unavailable');
      expect(units.filter((unit) => unit.sourceDocumentId === 'doc-new')).toHaveLength(1);
    } finally {
      if (original === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = original;
    }
  });
  test('listExpectedSources never renders knownFundingPosition as anything but null', async () => {
    const prisma = prismaMock({
      defenseBudgetExpectedSource: {
        findMany: jest.fn(async () => [EXPECTED_SOURCE]),
        findUnique: jest.fn(async () => null),
      },
    });
    const service = new DefenseBudgetLifecycleReadService(prisma);
    const rows = await service.listExpectedSources(2027);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.knownFundingPosition).toBeNull();
    expect(row.expectedTo).toBe('2026-12-31T00:00:00.000Z');
    expect(row.reviewReason).toBeNull();
  });

  test('listExpectedSources passes authorityTrack/expectedState filters into the where clause', async () => {
    const findMany = jest.fn(async () => []);
    const prisma = prismaMock({
      defenseBudgetExpectedSource: { findMany, findUnique: jest.fn(async () => null) },
    });
    const service = new DefenseBudgetLifecycleReadService(prisma);
    await service.listExpectedSources(2027, { authorityTrack: 'appropriations', expectedState: 'not_filed' });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fiscalYear: 2027,
          authorityTrack: 'appropriations',
          expectedState: 'not_filed',
        }),
      }),
    );
  });

  test('getExpectedSourceDetail 404s on a missing id rather than fabricating a row', async () => {
    const service = new DefenseBudgetLifecycleReadService(prismaMock());
    await expect(service.getExpectedSourceDetail('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('listReviewQueue skips a review_required expected source with no review_required observation instead of synthesizing one', async () => {
    const prisma = prismaMock({
      defenseBudgetExpectedSource: {
        findMany: jest.fn(async () => [{ ...EXPECTED_SOURCE, expectedState: 'review_required', observations: [] }]),
        findUnique: jest.fn(async () => null),
      },
    });
    const service = new DefenseBudgetLifecycleReadService(prisma);
    const rows = await service.listReviewQueue(2027);
    expect(rows).toEqual([]);
  });

  test('getCycleHealth resolves with the frozen never-zero invariants intact', async () => {
    const service = new DefenseBudgetLifecycleReadService(prismaMock());
    const health = await service.getCycleHealth(2027);
    expect(health.fiscalYear).toBe(2027);
    expect(health.missingSourceMeansUnknownNotZero).toBe(true);
    expect(health.nvidiaRouting).toBe('disabled');
  });

  test('getScheduleTickHealth maps Date fields to ISO strings before handing them to the domain function', async () => {
    const tick = {
      workerId: 'w1',
      tickKey: 'tick-1',
      startedAt: new Date('2026-08-01T00:00:00Z'),
      finishedAt: new Date('2026-08-01T00:05:00Z'),
      outcome: 'completed',
      adaptersConsidered: 3,
      adaptersDue: 1,
      adaptersSucceeded: 1,
      adaptersFailed: 0,
      adaptersSkippedLease: 0,
      committed: true,
      failureReason: null,
    };
    const prisma = prismaMock({
      defenseBudgetScheduleTick: { findMany: jest.fn(async () => [tick]) },
    });
    const service = new DefenseBudgetLifecycleReadService(prisma);
    const health = await service.getScheduleTickHealth();
    expect(health.lastTickOutcome).toBe('completed');
    expect(health.lastTickWorkerId).toBe('w1');
  });

  test('the read service never calls a mutating Prisma operation', () => {
    const source = readFileSync(join(__dirname, 'defense-budget-lifecycle-read.service.ts'), 'utf8');
    for (const op of ['.create(', '.createMany(', '.update(', '.updateMany(', '.delete(', '.deleteMany(', '.upsert(']) {
      expect(source).not.toContain(op);
    }
  });
});
