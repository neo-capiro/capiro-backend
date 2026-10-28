import { describe, expect, jest, test } from '@jest/globals';
import { parseSamSyncArgs, descriptionForMatching, persistMatches } from './sync-sam-opportunities.js';
import { matchOpportunity, trigrams, type AliasForMatch } from './sam-opportunity-matcher.js';

describe('retained SAM rematch operator', () => {
  test('accepts only rematching options and rejects retired ingestion flags', () => {
    expect(parseSamSyncArgs(['--match-only', '--commit'])).toEqual({ commit: true, matchOnly: true });
    expect(parseSamSyncArgs([])).toEqual({ commit: false, matchOnly: false });
    for (const flag of ['--backfill', '--all-federal', '--since=2026-01-01', '--skip-descriptions']) {
      expect(() => parseSamSyncArgs([flag])).toThrow('retired');
    }
  });
  test('a description URL cannot become matching evidence', () => {
    expect(descriptionForMatching('https://api.sam.gov/0603270A')).toBeNull();
    expect(descriptionForMatching('  Program 0603270A  ')).toBe('Program 0603270A');
  });
});

describe('SAM opportunity match persistence', () => {
  type Stored = {
    id: string;
    opportunityId: string;
    programId: string | null;
    peCode: string | null;
    matchBasis: string;
    confidence: number;
    reviewStatus: string;
  };

  function client(rows: Stored[]) {
    const update = jest.fn(async ({ where, data }: any) => {
      const row = rows.find((item) => item.id === where.id)!;
      Object.assign(row, data);
      return row;
    });
    const create = jest.fn(async ({ data }: any) => {
      const row = { id: `m-${rows.length + 1}`, ...data } as Stored;
      rows.push(row);
      return row;
    });
    const findFirst = jest.fn(
      async ({ where }: any) =>
        rows.find(
          (row) =>
            row.opportunityId === where.opportunityId &&
            row.programId === where.programId &&
            row.peCode === where.peCode,
        ) ?? null,
    );
    return {
      delegate: { samOpportunityMatch: { findFirst, update, create } },
      findFirst,
      update,
      create,
    };
  }

  test('a human-rejected match is never overwritten by a machine rerun', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.2,
        reviewStatus: 'rejected',
      },
    ];
    const mock = client(rows);
    const written = await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.95,
        reviewStatus: 'accepted',
      },
    ]);
    expect(written).toBe(0);
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(rows[0]?.reviewStatus).toBe('rejected');
  });

  test('a human-accepted match is never modified by a machine rerun', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.9,
        reviewStatus: 'accepted',
      },
    ];
    const mock = client(rows);
    const written = await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: null,
        peCode: '0603270A',
        matchBasis: 'description_pe_code',
        confidence: 0.99,
        reviewStatus: 'accepted',
      },
    ]);
    expect(written).toBe(0);
    expect(mock.update).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
    expect(rows[0]?.confidence).toBe(0.9);
  });

  test('same-basis machine replay refreshes confidence without changing review status', async () => {
    const rows: Stored[] = [
      {
        id: 'm-1',
        opportunityId: 'o-1',
        programId: 'p-1',
        peCode: null,
        matchBasis: 'program_alias',
        confidence: 0.6,
        reviewStatus: 'candidate',
      },
    ];
    const mock = client(rows);
    await persistMatches(mock.delegate as never, 'o-1', [
      {
        programId: 'p-1',
        peCode: null,
        matchBasis: 'program_alias',
        confidence: 0.8,
        reviewStatus: 'candidate',
      },
    ]);
    expect(mock.update).toHaveBeenCalledWith({
      where: { id: 'm-1' },
      data: { confidence: 0.8 },
    });
    expect(rows[0]?.reviewStatus).toBe('candidate');
  });

  test('exact BLIN remains accepted while a fuzzy alias remains candidate', () => {
    const known = new Set(['1242C93000']);
    const alias: AliasForMatch = {
      programId: 'p-1',
      aliasNormalized: 'ADVANCED ELECTRONIC WARFARE SUITE',
      aliasType: 'canonical',
      tg: trigrams('ADVANCED ELECTRONIC WARFARE SUITE'),
      pscHints: new Set(['5865']),
    };
    const exact = matchOpportunity(
      {
        title: 'Solicitation',
        description: 'Funded under BLIN 1242C93000.',
        office: null,
        pscCode: null,
        naicsCode: null,
      },
      known,
      [],
    );
    const fuzzy = matchOpportunity(
      {
        title: 'Advanced Electronic Warfare Suite',
        description: null,
        office: null,
        pscCode: '5865',
        naicsCode: null,
      },
      known,
      [alias],
    );
    expect(exact[0]?.reviewStatus).toBe('accepted');
    expect(fuzzy[0]?.reviewStatus).toBe('candidate');
    expect(fuzzy.some((match) => match.reviewStatus === 'accepted')).toBe(false);
  });
});
