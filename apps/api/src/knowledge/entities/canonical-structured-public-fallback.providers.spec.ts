import { describe, expect, jest, test } from '@jest/globals';
import { CanonicalStructuredPublicLookupRepository } from './canonical-structured-public-lookup.repository.js';
import {
  DirectoryGovernmentEntityResolutionProvider,
  LdaEntityResolutionProvider,
  SamUeiEntityResolutionProvider,
  SecCikEntityResolutionProvider,
  UsaSpendingEntityResolutionProvider,
} from './canonical-structured-public-fallback.providers.js';

const observedAt = new Date('2026-08-15T00:00:00.000Z');

function lookupInput(identifiers: Array<{ type: string; normalizedValue: string }>) {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorUserId: null,
    query: '',
    normalizedQuery: '',
    entityTypeHint: null,
    identifiers: identifiers.map((identifier) => ({
      ...identifier,
      value: identifier.normalizedValue,
    })),
    priorCandidates: [],
  };
}

function repository() {
  return {
    findDirectoryGovernment: jest.fn(async () => []),
    findSamUei: jest.fn(async () => []),
    findUsaSpending: jest.fn(async () => []),
    findLda: jest.fn(async () => []),
    findSec: jest.fn(async () => []),
  } as unknown as CanonicalStructuredPublicLookupRepository;
}

describe('structured public entity fallback providers', () => {
  test('maps an exact UEI hit to an authoritative registration candidate', async () => {
    const repo = repository();
    jest.spyOn(repo, 'findSamUei').mockResolvedValue([
      {
        canonicalName: 'Example Defense, Inc.',
        entityType: 'organization',
        sourceType: 'federal_contractor',
        sourceId: 'contractor-1',
        identifierType: 'uei',
        identifierValue: 'ABCDEF123456',
        aliases: [],
        observedAt,
      },
    ]);

    const result = await new SamUeiEntityResolutionProvider(repo).lookup(
      lookupInput([{ type: 'uei', normalizedValue: 'ABCDEF123456' }]),
    );

    expect(result.stage).toBe('sam_uei_cage');
    expect(result.conflictingIdentifiers).toBe(false);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        canonicalName: 'Example Defense, Inc.',
        sourceType: 'federal_contractor',
        evidenceKinds: ['exact_authoritative_identifier'],
        confidence: 1,
      }),
    ]);
  });

  test('marks distinct authoritative identities as a hard conflict', async () => {
    const repo = repository();
    jest.spyOn(repo, 'findSec').mockResolvedValue([
      {
        canonicalName: 'Company One',
        entityType: 'organization',
        sourceType: 'sec_filing',
        sourceId: '0000000001',
        identifierType: 'cik',
        identifierValue: '0000000001',
        aliases: [],
        observedAt,
      },
      {
        canonicalName: 'Company Two',
        entityType: 'organization',
        sourceType: 'sec_filing',
        sourceId: '0000000002',
        identifierType: 'cik',
        identifierValue: '0000000002',
        aliases: [],
        observedAt,
      },
    ]);

    const result = await new SecCikEntityResolutionProvider(repo).lookup(
      lookupInput([
        { type: 'cik', normalizedValue: '0000000001' },
        { type: 'cik', normalizedValue: '0000000002' },
      ]),
    );

    expect(result.conflictingIdentifiers).toBe(true);
    expect(result.candidates).toHaveLength(2);
  });

  test('exposes the required structured stages without fuzzy lookup behavior', () => {
    const repo = repository();
    expect([
      new DirectoryGovernmentEntityResolutionProvider(repo).stage,
      new SamUeiEntityResolutionProvider(repo).stage,
      new UsaSpendingEntityResolutionProvider(repo).stage,
      new LdaEntityResolutionProvider(repo).stage,
      new SecCikEntityResolutionProvider(repo).stage,
    ]).toEqual([
      'directory_government_id',
      'sam_uei_cage',
      'usaspending',
      'lda',
      'sec_cik',
    ]);
  });
});
