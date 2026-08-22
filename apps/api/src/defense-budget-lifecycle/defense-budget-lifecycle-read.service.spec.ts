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
