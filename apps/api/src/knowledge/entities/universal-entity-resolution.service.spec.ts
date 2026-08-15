import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRepository } from './canonical-entity.repository.js';
import type {
  CanonicalEntityRecord,
  EntityResolutionCandidate,
  EntityResolutionRecord,
} from './entity-resolution.types.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

function entity(id: string, name: string): CanonicalEntityRecord {
  return {
    id,
    tenantId: null,
    identityScope: 'global_public',
    entityType: 'organization',
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    status: 'active',
    resolutionConfidence: 1,
    resolutionMethod: 'system_canonical',
    metadata: {},
    mergedIntoEntityId: null,
    createdAt: new Date('2026-08-14T00:00:00Z'),
    updatedAt: new Date('2026-08-14T00:00:00Z'),
  };
}

function candidate(
  value: CanonicalEntityRecord,
  method: EntityResolutionCandidate['resolutionMethod'],
  confidence: number,
): EntityResolutionCandidate {
  return {
    entity: value,
    confidence,
    resolutionMethod: method,
    reasons: ['test'],
    provenance: [{ sourceType: 'test_fixture', sourceId: value.id }],
  };
}

function resolution(overrides: Partial<EntityResolutionRecord> = {}): EntityResolutionRecord {
  return {
    id: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
    idempotencyKey: 'a'.repeat(64),
    actorUserId: null,
    rawInput: 'RTX',
    normalizedInput: 'rtx',
    entityTypeHint: 'organization',
    candidateEntityIds: [],
    selectedEntityId: null,
    status: 'unresolved',
    confidence: 0,
    resolutionMethod: 'unresolved',
    provenance: [],
    correctionOfResolutionId: null,
    createdAt: new Date('2026-08-14T00:00:00Z'),
    ...overrides,
  };
}

function setup() {
  const repository = {
    findExactCandidates: jest.fn(async () => [] as EntityResolutionCandidate[]),
    appendResolution: jest.fn(async () => resolution()),
    findResolutionById: jest.fn(async () => null as EntityResolutionRecord | null),
    findVisibleById: jest.fn(async () => null as CanonicalEntityRecord | null),
    createTenantPrivateEntity: jest.fn(async () =>
      entity('30000000-0000-4000-8000-000000000099', 'Created Entity'),
    ),
  };
  return {
    repository,
    service: new UniversalEntityResolutionService(
      repository as unknown as CanonicalEntityRepository,
    ),
  };
}

const TENANT_ID = '20000000-0000-4000-8000-000000000001';

describe('UniversalEntityResolutionService', () => {
  test('resolves a unique exact identifier without fuzzy/model inference', async () => {
    const { repository, service } = setup();
    const rtx = entity('30000000-0000-4000-8000-000000000001', 'RTX Corporation');
    repository.findExactCandidates.mockResolvedValue([
      candidate(rtx, 'identifier_exact', 1),
    ]);
    repository.appendResolution.mockResolvedValue(
      resolution({
        selectedEntityId: rtx.id,
        status: 'resolved',
        confidence: 1,
        resolutionMethod: 'identifier_exact',
      }),
    );

    const result = await service.resolve(TENANT_ID, {
      query: 'RTX',
      entityTypeHint: 'organization',
      identifiers: [{ type: 'cik', value: '0000101829' }],
    });

    expect(result.status).toBe('resolved');
    expect(result.entity?.id).toBe(rtx.id);
    expect(repository.appendResolution).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        selectedEntityId: rtx.id,
        status: 'resolved',
        resolutionMethod: 'identifier_exact',
      }),
    );
  });

  test('does not silently merge two exact-name candidates', async () => {
    const { repository, service } = setup();
    repository.findExactCandidates.mockResolvedValue([
      candidate(
        entity('30000000-0000-4000-8000-000000000001', 'Kinetic Industries'),
        'canonical_name_exact',
        0.98,
      ),
      candidate(
        entity('30000000-0000-4000-8000-000000000002', 'Kinetic Industries'),
        'canonical_name_exact',
        0.98,
      ),
    ]);
    repository.appendResolution.mockResolvedValue(
      resolution({
        status: 'ambiguous',
        confidence: 0.98,
        resolutionMethod: 'multiple_exact_candidates',
      }),
    );

    const result = await service.resolve(TENANT_ID, {
      query: 'Kinetic Industries',
      entityTypeHint: 'organization',
    });

    expect(result.status).toBe('ambiguous');
    expect(result.entity).toBeNull();
    expect(result.requiresUserConfirmation).toBe(true);
  });

  test('records a correction as a new append-only decision', async () => {
    const { repository, service } = setup();
    const selected = entity(
      '30000000-0000-4000-8000-000000000002',
      'Kinetic Industries Holdings',
    );
    repository.findResolutionById.mockResolvedValue(
      resolution({
        id: '10000000-0000-4000-8000-000000000009',
        status: 'ambiguous',
        candidateEntityIds: ['30000000-0000-4000-8000-000000000001'],
      }),
    );
    repository.findVisibleById.mockResolvedValue(selected);
    repository.appendResolution.mockResolvedValue(
      resolution({
        id: '10000000-0000-4000-8000-000000000010',
        selectedEntityId: selected.id,
        status: 'corrected',
        confidence: 1,
        resolutionMethod: 'user_corrected',
        correctionOfResolutionId: '10000000-0000-4000-8000-000000000009',
      }),
    );

    const result = await service.correctResolution(TENANT_ID, {
      resolutionId: '10000000-0000-4000-8000-000000000009',
      selectedEntityId: selected.id,
      actorUserId: '40000000-0000-4000-8000-000000000001',
      reason: 'The other Kinetic',
    });

    expect(result.entity?.id).toBe(selected.id);
    expect(repository.appendResolution).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        status: 'corrected',
        selectedEntityId: selected.id,
        correctionOfResolutionId: '10000000-0000-4000-8000-000000000009',
      }),
    );
  });

  test('blocks duplicate creation while deterministic candidates are ambiguous', async () => {
    const { repository, service } = setup();
    repository.findExactCandidates.mockResolvedValue([
      candidate(
        entity('30000000-0000-4000-8000-000000000001', 'Kinetic Industries'),
        'alias_exact',
        0.95,
      ),
      candidate(
        entity('30000000-0000-4000-8000-000000000002', 'Kinetic Industries'),
        'alias_exact',
        0.95,
      ),
    ]);
    repository.appendResolution.mockResolvedValue(
      resolution({ status: 'ambiguous', confidence: 0.95 }),
    );

    await expect(
      service.registerTenantPrivateEntity(TENANT_ID, {
        entityType: 'organization',
        canonicalName: 'Kinetic Industries',
        resolutionMethod: 'crm_import',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.createTenantPrivateEntity).not.toHaveBeenCalled();
  });

  test('fails closed when a corrected entity is not visible to the tenant', async () => {
    const { repository, service } = setup();
    repository.findResolutionById.mockResolvedValue(resolution());
    repository.findVisibleById.mockResolvedValue(null);

    await expect(
      service.correctResolution(TENANT_ID, {
        resolutionId: '10000000-0000-4000-8000-000000000001',
        selectedEntityId: '30000000-0000-4000-8000-000000000099',
        actorUserId: '40000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
