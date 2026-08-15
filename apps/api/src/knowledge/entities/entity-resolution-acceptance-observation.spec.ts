import { describe, expect, test } from '@jest/globals';
import {
  toEntityResolutionGoldenObservation,
  toMeriCompatibleEntityResolutionObservation,
} from './entity-resolution-acceptance-observation.js';
import type { UniversalEntityResolutionOrchestrationResult } from './universal-entity-resolution-orchestrator.types.js';

function result(): UniversalEntityResolutionOrchestrationResult {
  return {
    resolutionId: null,
    status: 'ambiguous',
    entity: null,
    confidence: 0.7,
    resolutionMethod: 'fallback_candidates_require_confirmation',
    candidates: [
      {
        candidateKey: 'victory-six-inc',
        entityId: null,
        canonicalName: 'Victory Six, Inc.',
        entityType: 'organization',
        confidence: 0.7,
        stage: 'public_web',
        sourceType: 'fixture_public_web',
        sourceId: 'victory-six-inc',
        sourceUrl: 'https://example.invalid/victory-six',
        evidenceKinds: ['public_web_claim'],
        provenance: [],
      },
    ],
    provenance: [],
    requiresUserConfirmation: true,
    attemptedStages: [
      {
        stage: 'existing_canonical',
        sourceStatus: 'complete',
        status: 'unresolved',
        candidateCount: 0,
        resolutionMethod: 'unresolved',
        stopReason: null,
      },
      {
        stage: 'public_web',
        sourceStatus: 'complete',
        status: 'ambiguous',
        candidateCount: 1,
        resolutionMethod: 'public_web',
        stopReason: null,
      },
    ],
    publicLookupRan: true,
    stopReason: 'human_confirmation_required',
  };
}

describe('entity resolution acceptance observations', () => {
  test('derives the golden observation from real orchestrator output', () => {
    expect(toEntityResolutionGoldenObservation('case-1', result())).toEqual({
      caseId: 'case-1',
      status: 'ambiguous',
      selectedCanonicalName: null,
      candidateCanonicalNames: ['Victory Six, Inc.'],
    });
  });

  test('derives attempted stages and safety flags for compatibility evaluation', () => {
    expect(
      toMeriCompatibleEntityResolutionObservation('case-2', result(), {
        duplicateEntityCreated: false,
        privateIdentityLeaked: false,
      }),
    ).toEqual(
      expect.objectContaining({
        caseId: 'case-2',
        status: 'ambiguous',
        candidateCanonicalNames: ['Victory Six, Inc.'],
        attemptedStages: ['existing_canonical', 'public_web'],
        duplicateEntityCreated: false,
        privateIdentityLeaked: false,
      }),
    );
  });
});
