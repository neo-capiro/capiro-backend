import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import { AuthoritativeFirstUniversalEntityResolutionOrchestratorService } from './authoritative-first-entity-resolution-orchestrator.service.js';
import type { UniversalEntityResolutionOrchestrationResult } from './universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from './universal-entity-resolution-orchestrator.service.js';
import type { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

function result(
  status: UniversalEntityResolutionOrchestrationResult['status'],
  overrides: Partial<UniversalEntityResolutionOrchestrationResult> = {},
): UniversalEntityResolutionOrchestrationResult {
  return {
    resolutionId: null,
    status,
    entity: null,
    confidence: 0,
    resolutionMethod: status === 'unresolved' ? 'unresolved_after_all_available_stages' : 'identifier_exact',
    candidates: [],
    provenance: [],
    requiresUserConfirmation: status === 'ambiguous',
    attemptedStages: [],
    publicLookupRan: false,
    stopReason: status === 'unresolved' ? 'no_candidate_found' : 'deterministic_match',
    ...overrides,
  };
}

function service() {
  return new AuthoritativeFirstUniversalEntityResolutionOrchestratorService(
    null as unknown as UniversalEntityResolutionService,
    null as unknown as CanonicalEntityRegistrationService,
    [],
  );
}

describe('authoritative-first Universal Entity Resolution orchestration', () => {
  test('checks identifiers first and never evaluates the conflicting name after a deterministic identifier hit', async () => {
    const parent = jest
      .spyOn(UniversalEntityResolutionOrchestratorService.prototype, 'resolveAcrossSources')
      .mockResolvedValueOnce(
        result('resolved', {
          resolutionId: 'resolution-id',
          entity: {
            id: '22222222-2222-4222-8222-222222222222',
            tenantId: null,
            identityScope: 'global_public',
            entityType: 'organization',
            canonicalName: 'Identifier Winner',
            normalizedName: 'identifier winner',
            status: 'active',
            resolutionConfidence: 1,
            resolutionMethod: 'cik_exact',
            metadata: {},
            mergedIntoEntityId: null,
            createdAt: new Date('2026-08-15T00:00:00Z'),
            updatedAt: new Date('2026-08-15T00:00:00Z'),
          },
        }),
      );

    const output = await service().resolveAcrossSources(
      '11111111-1111-4111-8111-111111111111',
      {
        query: 'Name That Belongs To Another Entity',
        entityTypeHint: 'organization',
        identifiers: [{ type: 'cik', value: '0000000001' }],
      },
    );

    expect(output.status).toBe('resolved');
    expect(output.entity?.canonicalName).toBe('Identifier Winner');
    expect(parent).toHaveBeenCalledTimes(1);
    expect(parent.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        query: '',
        identifiers: [{ type: 'cik', value: '0000000001' }],
      }),
    );
    parent.mockRestore();
  });

  test('falls back to the name only when identifier preflight finds no candidate', async () => {
    const parent = jest
      .spyOn(UniversalEntityResolutionOrchestratorService.prototype, 'resolveAcrossSources')
      .mockResolvedValueOnce(
        result('unresolved', {
          attemptedStages: [
            {
              stage: 'sec_cik',
              sourceStatus: 'complete',
              status: 'unresolved',
              candidateCount: 0,
              resolutionMethod: 'unresolved',
              stopReason: null,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        result('resolved', {
          attemptedStages: [
            {
              stage: 'existing_canonical',
              sourceStatus: 'complete',
              status: 'resolved',
              candidateCount: 1,
              resolutionMethod: 'canonical_name_exact',
              stopReason: null,
            },
          ],
        }),
      );

    const output = await service().resolveAcrossSources(
      '11111111-1111-4111-8111-111111111111',
      {
        query: 'Fallback Name',
        entityTypeHint: 'organization',
        identifiers: [{ type: 'cik', value: '0000000999' }],
      },
    );

    expect(parent).toHaveBeenCalledTimes(2);
    expect(parent.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ query: '' }));
    expect(parent.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        query: 'Fallback Name',
        identifiers: [],
      }),
    );
    expect(output.attemptedStages.map((trace) => trace.stage)).toEqual([
      'sec_cik',
      'existing_canonical',
    ]);
    parent.mockRestore();
  });

  test('hard-stops before the name when identifier preflight is ambiguous', async () => {
    const parent = jest
      .spyOn(UniversalEntityResolutionOrchestratorService.prototype, 'resolveAcrossSources')
      .mockResolvedValueOnce(
        result('ambiguous', {
          resolutionMethod: 'conflicting_identifiers',
          stopReason: 'authoritative_identifier_conflict',
        }),
      );

    const output = await service().resolveAcrossSources(
      '11111111-1111-4111-8111-111111111111',
      {
        query: 'Tempting Exact Name',
        entityTypeHint: 'organization',
        identifiers: [
          { type: 'uei', value: 'ABCDEF123456' },
          { type: 'cik', value: '0000000002' },
        ],
      },
    );

    expect(output.status).toBe('ambiguous');
    expect(output.stopReason).toBe('authoritative_identifier_conflict');
    expect(parent).toHaveBeenCalledTimes(1);
    parent.mockRestore();
  });
});
