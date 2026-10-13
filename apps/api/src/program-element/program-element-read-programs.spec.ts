import { describe, expect, jest, test } from '@jest/globals';
import { ProgramElementReadService } from './program-element-read.service.js';

describe('ProgramElementReadService.getProgramsForPe', () => {
  test('preserves evidence wording, malformed-evidence handling and accepted/candidate buckets', async () => {
    const evidence = [
      null,
      1,
      'invalid',
      {},
      { kind: 'mdap_curated' },
      { kind: 'other_funding_link', pageNumber: 0 },
      { kind: 'alias_trigram' },
      { kind: 'alias_trigram_exact', quote: 'PATRIOT', pageNumber: 99 },
      { quote: 'R-2A', pageNumber: 144 },
      { kind: 'exact_pe_number', pageNumber: 7 },
    ];
    const match = {
      id: 'accepted',
      programId: 'p1',
      peCode: '0604801F',
      projectCode: null,
      score: 0.95,
      evidenceTier: 'mdap_curated',
      status: 'accepted',
      evidence,
      resolvedAt: null,
    };
    const findMatches = jest.fn(async () => [
      match,
      { ...match, id: 'candidate', programId: 'missing', status: 'candidate', evidence: null },
    ]);
    const program = {
      id: 'p1',
      canonicalName: 'PATRIOT',
      component: 'ARMY',
      mdapCode: null,
      status: 'active',
    };
    const findPrograms = jest.fn(async () => [program]);
    const service = new ProgramElementReadService(
      {
        peProgramMatch: { findMany: findMatches },
        program: { findMany: findPrograms },
      } as never,
      { predict: jest.fn() } as never,
    );

    const result = await service.getProgramsForPe(' 0604801F ');

    expect(result.peCode).toBe('0604801F');
    expect(result.acceptedMatches).toEqual([
      {
        ...match,
        program,
        confidenceBand: 'high',
        whyShown:
          'curated MDAP map + shared P-1 line p.0 + alias match + PATRIOT + R-2A p.144 + exact_pe_number p.7',
      },
    ]);
    expect(result.candidateMatches).toEqual([
      {
        ...match,
        id: 'candidate',
        programId: 'missing',
        status: 'candidate',
        evidence: null,
        program: null,
        confidenceBand: 'high',
        whyShown: '',
      },
    ]);
    expect(findMatches).toHaveBeenCalledWith({
      where: { peCode: '0604801F', status: { in: ['accepted', 'candidate'] } },
      orderBy: [{ status: 'asc' }, { score: 'desc' }],
    });
    expect(findPrograms).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'missing'] } },
      select: { id: true, canonicalName: true, component: true, mdapCode: true, status: true },
    });
  });

  test('blank peCode returns empty buckets without querying', async () => {
    const findMany = jest.fn();
    const service = new ProgramElementReadService(
      {
        peProgramMatch: { findMany },
        program: { findMany },
      } as never,
      { predict: jest.fn() } as never,
    );

    expect(await service.getProgramsForPe('   ')).toEqual({
      peCode: '',
      acceptedMatches: [],
      candidateMatches: [],
    });
    expect(findMany).not.toHaveBeenCalled();
  });
});
