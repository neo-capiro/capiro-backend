import { describe, expect, jest, test } from '@jest/globals';
import { ProgramElementReadService } from './program-element-read.service.js';

/**
 * Step 2.4 follow-on — getProvisionsForPe ordering + shape + exclusion contract.
 *
 * Self-contained mock prisma (only provisionPeLink.findMany is exercised) so the shared
 * makePrisma in program-element-read.service.spec.ts is left untouched. Asserts:
 *   - accepted links sort before candidate; within a status, newest FY first
 *   - the ProvisionItem shape (incl. sourceUrl resolved from the provision's SourceDocument)
 *   - the read FILTERS to reviewStatus in (accepted, candidate) — rejected/quarantined excluded
 */

interface FakeLinkRow {
  matchBasis: string;
  reviewStatus: string;
  confidence: number;
  provision: {
    id: string;
    committee: string;
    fy: number;
    heading: string;
    text: string;
    pageStart: number | null;
    pageEnd: number | null;
    actionType: string | null;
    sourceDocument: { sourceUrl: string } | null;
  };
}

function makePrisma(rows: FakeLinkRow[]) {
  const findMany = jest.fn(async (_args: unknown) => rows);
  return {
    prisma: {
      provisionPeLink: { findMany },
      // Program-level attribution expansion is optional for these focused
      // provision tests. An empty crosswalk lets the method reach the contract
      // assertions instead of crashing on an undefined delegate.
      peProgramMatch: { findMany: jest.fn(async () => []) },
    },
    findMany,
  };
}

function makeService(prisma: unknown) {
  // ConferenceProbabilityService + relevanceService are unused on this path; pass stubs.
  return new ProgramElementReadService(prisma as never, { predict: jest.fn() } as never);
}

describe('ProgramElementReadService.getProvisionsForPe (Step 2.4)', () => {
  const rows: FakeLinkRow[] = [
    {
      matchBasis: 'program_alias',
      reviewStatus: 'candidate',
      confidence: 0.55,
      provision: {
        id: 'cand-2025',
        committee: 'SASC',
        fy: 2025,
        heading: 'Concern over schedule',
        text: 'The committee is concerned ...',
        pageStart: 10,
        pageEnd: 10,
        actionType: 'expresses_concern',
        sourceDocument: null,
      },
    },
    {
      matchBasis: 'project_title',
      reviewStatus: 'candidate',
      confidence: 0.7,
      provision: {
        id: 'cand-2027',
        committee: 'HASC',
        fy: 2027,
        heading: 'Briefing directed',
        text: 'The committee directs a briefing ...',
        pageStart: 20,
        pageEnd: 21,
        actionType: 'directs_briefing',
        sourceDocument: { sourceUrl: 'https://congress.gov/cand.pdf' },
      },
    },
    {
      matchBasis: 'pe_code',
      reviewStatus: 'accepted',
      confidence: 0.99,
      provision: {
        id: 'acc-2026',
        committee: 'HASC',
        fy: 2026,
        heading: 'Increase',
        text: 'The committee recommends an increase ...',
        pageStart: 30,
        pageEnd: 31,
        actionType: 'adds',
        sourceDocument: { sourceUrl: 'https://congress.gov/acc.pdf' },
      },
    },
  ];

  test('orders accepted first, then candidate; within a status newest FY first', async () => {
    const { prisma } = makePrisma(rows);
    const service = makeService(prisma);

    const result = await service.getProvisionsForPe('0604801F');

    expect(result.map((r) => r.id)).toEqual(['acc-2026', 'cand-2027', 'cand-2025']);
    expect(result[0]?.reviewStatus).toBe('accepted');
  });

  test('returns the full ProvisionItem shape incl. sourceUrl from the SourceDocument (null when absent)', async () => {
    const { prisma } = makePrisma(rows);
    const service = makeService(prisma);

    const result = await service.getProvisionsForPe('0604801F');
    const accepted = result.find((r) => r.id === 'acc-2026')!;

    expect(accepted).toEqual({
      id: 'acc-2026',
      committee: 'HASC',
      fy: 2026,
      heading: 'Increase',
      text: 'The committee recommends an increase ...',
      pageStart: 30,
      pageEnd: 31,
      actionType: 'adds',
      sourceUrl: 'https://congress.gov/acc.pdf',
      matchBasis: 'pe_code',
      reviewStatus: 'accepted',
      confidence: 0.99,
      matchScope: 'pe_specific',
      attributionCaveat: null,
    });
    // A provision with no SourceDocument yields sourceUrl: null.
    expect(result.find((r) => r.id === 'cand-2025')?.sourceUrl).toBeNull();
  });

  test('queries with reviewStatus filtered to accepted/candidate (rejected/quarantined excluded)', async () => {
    const { prisma, findMany } = makePrisma(rows);
    const service = makeService(prisma);

    await service.getProvisionsForPe('0604801F');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { peCode: '0604801F', reviewStatus: { in: ['accepted', 'candidate'] } },
      }),
    );
  });

  test('blank peCode short-circuits to [] (no query)', async () => {
    const { prisma, findMany } = makePrisma(rows);
    const service = makeService(prisma);

    expect(await service.getProvisionsForPe('   ')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
