import { BadRequestException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { EntityIdentityGovernanceRepository } from './entity-identity-governance.repository.js';
import { EntityIdentityGovernanceService } from './entity-identity-governance.service.js';
import type { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const RESOLUTION_ID = '33333333-3333-4333-8333-333333333333';
const CORRECTED_ID = '44444444-4444-4444-8444-444444444444';
const ENTITY_ID = '55555555-5555-4555-8555-555555555555';
const LINK_ID = '66666666-6666-4666-8666-666666666666';

function setup() {
  const repository = {
    recordResolutionConfirmation: jest.fn(async () => 'event-confirm'),
    rejectResolution: jest.fn(async () => ({
      resolutionId: 'rejected-resolution',
      status: 'rejected' as const,
      governanceEventId: 'event-reject',
    })),
    governAlias: jest.fn(async () => 'event-alias'),
    governIdentifier: jest.fn(async () => 'event-identifier'),
    listSubjectEvents: jest.fn(async () => []),
  };
  const resolver = {
    correctResolution: jest.fn(async () => ({
      resolutionId: CORRECTED_ID,
      status: 'resolved' as const,
      entity: {
        id: ENTITY_ID,
        tenantId: null,
        identityScope: 'global_public' as const,
        entityType: 'organization',
        canonicalName: 'RTX Corporation',
        normalizedName: 'rtx corporation',
        status: 'active' as const,
        resolutionConfidence: 1,
        resolutionMethod: 'uei_exact',
        metadata: {},
        mergedIntoEntityId: null,
        createdAt: new Date('2026-08-15T00:00:00Z'),
        updatedAt: new Date('2026-08-15T00:00:00Z'),
      },
      confidence: 1,
      resolutionMethod: 'user_corrected',
      candidates: [],
      provenance: [{ sourceType: 'user_correction', sourceId: ACTOR_ID }],
      requiresUserConfirmation: false,
    })),
  };
  return {
    repository,
    resolver,
    service: new EntityIdentityGovernanceService(
      repository as unknown as EntityIdentityGovernanceRepository,
      resolver as unknown as UniversalEntityResolutionService,
    ),
  };
}

describe('EntityIdentityGovernanceService', () => {
  test('confirms an ambiguous resolution through append-only correction and audit event', async () => {
    const { service, resolver, repository } = setup();

    const result = await service.confirmResolution(TENANT_ID, {
      resolutionId: RESOLUTION_ID,
      selectedEntityId: ENTITY_ID,
      actorUserId: ACTOR_ID,
      reason: 'Confirmed against the client record.',
    });

    expect(resolver.correctResolution).toHaveBeenCalledWith(TENANT_ID, {
      resolutionId: RESOLUTION_ID,
      selectedEntityId: ENTITY_ID,
      actorUserId: ACTOR_ID,
      reason: 'Confirmed against the client record.',
    });
    expect(repository.recordResolutionConfirmation).toHaveBeenCalledWith(
      TENANT_ID,
      RESOLUTION_ID,
      CORRECTED_ID,
      ENTITY_ID,
      ACTOR_ID,
      'Confirmed against the client record.',
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(result.governanceEventId).toBe('event-confirm');
  });

  test('rejects a resolution as a new append-only decision', async () => {
    const { service, repository } = setup();

    const result = await service.rejectResolution(TENANT_ID, {
      resolutionId: RESOLUTION_ID,
      actorUserId: ACTOR_ID,
      reasonCode: 'incorrect-identity',
      reason: 'This is the subsidiary, not the parent.',
    });

    expect(repository.rejectResolution).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ resolutionId: RESOLUTION_ID }),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'incorrect_identity',
    );
    expect(result.status).toBe('rejected');
  });

  test('confirms and withdraws links only through the governed repository boundary', async () => {
    const { service, repository } = setup();
    const input = {
      linkId: LINK_ID,
      actorUserId: ACTOR_ID,
      reasonCode: 'user_confirmed',
      reason: 'Verified in CRM.',
    };

    await service.confirmAlias(TENANT_ID, input);
    await service.withdrawAlias(TENANT_ID, {
      ...input,
      reasonCode: 'stale_source',
    });
    await service.confirmIdentifier(TENANT_ID, input);
    await service.withdrawIdentifier(TENANT_ID, {
      ...input,
      reasonCode: 'privacy_request',
    });

    expect(repository.governAlias).toHaveBeenNthCalledWith(
      1,
      TENANT_ID,
      'confirm',
      input,
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'user_confirmed',
    );
    expect(repository.governAlias).toHaveBeenNthCalledWith(
      2,
      TENANT_ID,
      'withdraw',
      expect.any(Object),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      'stale_source',
    );
    expect(repository.governIdentifier).toHaveBeenCalledTimes(2);
  });

  test('requires an attributable actor and allowlisted reason code', async () => {
    const { service } = setup();

    await expect(
      service.rejectResolution(TENANT_ID, {
        resolutionId: RESOLUTION_ID,
        actorUserId: '',
        reasonCode: 'user_rejected',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.withdrawAlias(TENANT_ID, {
        linkId: LINK_ID,
        actorUserId: ACTOR_ID,
        reasonCode: 'model_suggested',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
