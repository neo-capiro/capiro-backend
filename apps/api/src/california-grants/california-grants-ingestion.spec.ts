import { describe, expect, test } from '@jest/globals';
import sampleRows from './california-public-sample.fixture.json';
import {
  mapCaliforniaGrantRow,
  parseCaliforniaCalendarDate,
  requireDatabaseUrl,
  syncCaliforniaGrants,
  type CaliforniaGrantRow,
  type CaliforniaSearchResult,
} from './california-grants-ingestion.js';

const SAMPLE_ROWS = sampleRows as CaliforniaGrantRow[];

function makePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    californiaGrantOpportunity: {
      async findUnique({ where }: { where: { portalId: string } }) {
        return rows.has(where.portalId) ? { portalId: where.portalId } : null;
      },
      async upsert({ where, create }: { where: { portalId: string }; create: Record<string, unknown> }) {
        rows.set(where.portalId, create);
        return create;
      },
    },
  };
}

describe('California Grants Portal mapping', () => {
  test('maps exact cached records and retains every source field', () => {
    const first = mapCaliforniaGrantRow(SAMPLE_ROWS[0]!);
    const second = mapCaliforniaGrantRow(SAMPLE_ROWS[1]!);
    expect(first.raw).toEqual(SAMPLE_ROWS[0]);
    expect(second.raw).toEqual(SAMPLE_ROWS[1]);
    expect(Object.keys(first.raw)).toHaveLength(37);
    expect(first.lastUpdatedRaw).toBe('2026-09-15 19:46:27');
    expect(first.lastUpdatedCalendarDate?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
    expect(first.applicantTypeRaw).toBe(SAMPLE_ROWS[0]!.ApplicantType);
    expect(first.applicantTypes).toEqual(['Business', 'Nonprofit', 'Other Legal Entity', 'Public Agency', 'Tribal Government']);
    expect(first.estimatedAmountMin).toBe(300000);
    expect(first.estimatedAmountMax).toBe(1500000);
    expect(first.electronicSubmissionUrls).toEqual(['https://dbw.parks.ca.gov/?page_id=28821']);
    expect(first.grantUrl).toBe(SAMPLE_ROWS[0]!.GrantURL);
    expect(second.awardPeriod).toBe('June 31, 2027');
    expect(second.applicationDeadlineRaw).toBe('2026-10-15 11:59:00');
    expect(second.estimatedAmountMin).toBeNull();
    expect(second.estimatedAmountMax).toBeNull();
    expect(second.electronicSubmissionEmails).toEqual(['capacitygrants@cpuc.ca.gov']);
  });

  test('rejects malformed values without rollover or invented precision', () => {
    expect(parseCaliforniaCalendarDate('June 31, 2027')).toBeNull();
    expect(parseCaliforniaCalendarDate('2026-02-30 10:00:00')).toBeNull();
    expect(parseCaliforniaCalendarDate('2026-09-15 24:00:00')).toBeNull();
    expect(mapCaliforniaGrantRow({ ...SAMPLE_ROWS[0]!, EstAmounts: 'See $10,000 and $20,000 in appendix.' }).estimatedAmountMin).toBeNull();
    expect(mapCaliforniaGrantRow({ ...SAMPLE_ROWS[0]!, EstAmounts: 'Between $20,000 and $10,000' }).estimatedAmountMax).toBeNull();
    expect(mapCaliforniaGrantRow({ ...SAMPLE_ROWS[0]!, EstAvailFunds: '$1,23' }).estimatedAvailableFundsAmount).toBeNull();
    expect(() => mapCaliforniaGrantRow({ Title: 'missing key' })).toThrow('missing PortalID');
  });
});

describe('California catalog pagination and idempotency', () => {
  test('does not mistake duplicate records for complete coverage', async () => {
    const prisma = makePrisma();
    const fetchPage = async (offset: number, limit: number): Promise<CaliforniaSearchResult> => ({ records: [SAMPLE_ROWS[0]!], total: 2, limit, offset });
    const result = await syncCaliforniaGrants(prisma, { fetchPage, pageSize: 1, maxPages: 3, maxRecords: 2 });
    expect(prisma.rows.size).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('unique PortalIDs');
  });

  test('preserves successful writes and records later page failure as partial', async () => {
    const prisma = makePrisma();
    const calls: number[] = [];
    const fetchPage = async (offset: number, limit: number): Promise<CaliforniaSearchResult> => {
      calls.push(offset);
      if (offset === 1) throw new Error('simulated page failure');
      return { records: [SAMPLE_ROWS[0]!], total: 3, limit, offset };
    };
    const result = await syncCaliforniaGrants(prisma, { fetchPage, pageSize: 1, maxPages: 3, maxRecords: 3 });
    expect(calls).toEqual([0, 1]);
    expect(prisma.rows.size).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.errors).toBe(1);
  });

  test('accepts legitimate empty catalog and rejects invalid bounds', async () => {
    const empty = await syncCaliforniaGrants(makePrisma(), { pageSize: 2, fetchPage: async (offset, limit) => ({ records: [], total: 0, limit, offset }) });
    expect(empty.complete).toBe(true);
    expect(empty.errors).toBe(0);
    const fetchPage = async () => { throw new Error('must not fetch'); };
    await expect(syncCaliforniaGrants(makePrisma(), { fetchPage, pageSize: 0 })).rejects.toThrow('positive integers');
    await expect(syncCaliforniaGrants(makePrisma(), { fetchPage, maxPages: 1.5 })).rejects.toThrow('positive integers');
  });

  test('marks max-pages walk incomplete while preserving rows', async () => {
    const prisma = makePrisma();
    const result = await syncCaliforniaGrants(prisma, { pageSize: 1, maxPages: 1, maxRecords: 5, fetchPage: async (offset, limit) => ({ records: [SAMPLE_ROWS[0]!], total: 5, limit, offset }) });
    expect(prisma.rows.size).toBe(1);
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toContain('Bounded');
  });

  test('is idempotent on a complete repeat', async () => {
    const prisma = makePrisma();
    const fetchPage = async (offset: number, limit: number): Promise<CaliforniaSearchResult> => ({ records: [SAMPLE_ROWS[0]!, SAMPLE_ROWS[1]!], total: 2, limit, offset });
    await syncCaliforniaGrants(prisma, { fetchPage, pageSize: 2 });
    const repeat = await syncCaliforniaGrants(prisma, { fetchPage, pageSize: 2 });
    expect(repeat.inserted).toBe(0);
    expect(repeat.updated).toBe(2);
    expect(repeat.complete).toBe(true);
  });
});

describe('California CLI guard', () => {
  test('requires PostgreSQL DATABASE_URL before client setup', () => {
    expect(() => requireDatabaseUrl({})).toThrow('DATABASE_URL is required');
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'https://example.test' })).toThrow('valid PostgreSQL URL');
    expect(requireDatabaseUrl({ DATABASE_URL: 'postgresql://example.test/catalog' })).toBe('postgresql://example.test/catalog');
  });
});
