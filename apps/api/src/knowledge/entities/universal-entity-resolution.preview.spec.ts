import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRepository } from './canonical-entity.repository.js';
import type {
  CanonicalEntityRecord,
  EntityResolutionCandidate,
} from './entity-resolution.types.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const ENTITY: CanonicalEntityRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: null,
  identityScope: 'global_public',
  entityType: 'organization',
  canonicalName: 'RTX Corporation',
  normalizedName: 'rtx corporation',
  status: 'active',
  resolutionConfidence: 1,
  resolutionMethod: 'uei_exact',
  metadata: {},
  mergedIntoEntityId: null,
  createdAt: new Date('2026-08-15T00:00:00Z'),
  updatedAt: new Date('2026-08-15T00:00:00Z'),
};

const CANDIDATE: EntityResolutionCandidate = {
  entity: ENTITY,
  confidence: 1,
  resolutionMethod: 'identifier_exact',
  reasons: ['Exact UEI match'],
  provenance: [
    {
      sourceType: 'federal_contractor',
      sourceId: 'contractor-1',
      identifierType: 'uei',
      matchValue: 'ABCDEF123456',
    },
  ],
};

describe('UniversalEntityResolutionService.preview', () => {
  test('evaluates deterministic candidates without appending resolution history', async () => {
    const findExactCandidates = jest.fn(async () => [CANDIDATE]);
    const appendResolution = jest.fn();
    const repository = {
      findExactCandidates,
      appendResolution,
    } as unknown as CanonicalEntityRepository;
    const service = new UniversalEntityResolutionService(repository);

    const result = await service.preview(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      {
        query: 'RTX',
        entityTypeHint: 'organization',
        identifiers: [{ type: 'uei', value: 'ABCDEF123456' }],
      },
    );

    expect(result.status).toBe('resolved');
    expect(result.entity?.id).toBe(ENTITY.id);
    expect(result.resolutionMethod).toBe('identifier_exact');
    expect(appendResolution).not.toHaveBeenCalled();
  });
});
