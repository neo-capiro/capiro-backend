import type {
  EntityResolutionFallbackLookupInput,
  EntityResolutionFallbackProvider,
  EntityResolutionFallbackResult,
} from './universal-entity-resolution-orchestrator.types.js';

const OBSERVED_AT = new Date('2026-08-15T00:00:00.000Z');

/**
 * Test-only fallback providers for the attachment-driven external-company
 * acceptance cases. Production code must register real provider adapters.
 */
export function createMeriCompatibilityFixtureProviders(): readonly EntityResolutionFallbackProvider[] {
  return [publicWebFixtureProvider(), modelCandidateFixtureProvider()];
}

function publicWebFixtureProvider(): EntityResolutionFallbackProvider {
  return {
    stage: 'public_web',
    async lookup(
      input: EntityResolutionFallbackLookupInput,
    ): Promise<EntityResolutionFallbackResult> {
      switch (input.normalizedQuery) {
        case 'victory six':
          return {
            stage: 'public_web',
            sourceStatus: 'complete',
            candidates: [
              {
                candidateKey: 'victory-six-inc',
                canonicalName: 'Victory Six, Inc.',
                entityType: 'organization',
                evidenceKinds: ['public_web_claim'],
                sourceType: 'fixture_public_web',
                sourceId: 'victory-six-inc',
                sourceUrl: 'https://example.invalid/victory-six',
                observedAt: OBSERVED_AT,
                confidence: 0.74,
              },
            ],
          };
        case 'kindetic industries':
          return {
            stage: 'public_web',
            sourceStatus: 'complete',
            candidates: [
              {
                candidateKey: 'kinetic-industries-inc',
                canonicalName: 'Kinetic Industries, Inc.',
                entityType: 'organization',
                evidenceKinds: ['public_web_claim'],
                sourceType: 'fixture_public_web',
                sourceId: 'kinetic-industries-inc',
                sourceUrl: 'https://example.invalid/kinetic-industries',
                observedAt: OBSERVED_AT,
                confidence: 0.69,
              },
            ],
          };
        default:
          return emptyResult('public_web');
      }
    },
  };
}

function modelCandidateFixtureProvider(): EntityResolutionFallbackProvider {
  return {
    stage: 'model_candidate_reconciliation',
    async lookup(
      input: EntityResolutionFallbackLookupInput,
    ): Promise<EntityResolutionFallbackResult> {
      if (input.normalizedQuery !== 'kindetic industries') {
        return emptyResult('model_candidate_reconciliation');
      }
      return {
        stage: 'model_candidate_reconciliation',
        sourceStatus: 'complete',
        candidates: [
          {
            candidateKey: 'kinetic-industries-inc',
            canonicalName: 'Kinetic Industries, Inc.',
            entityType: 'organization',
            evidenceKinds: ['model_suggestion'],
            sourceType: 'fixture_model_reconciliation',
            sourceId: 'kinetic-industries-inc',
            observedAt: OBSERVED_AT,
            confidence: 0.8,
          },
        ],
      };
    },
  };
}

function emptyResult(
  stage: 'public_web' | 'model_candidate_reconciliation',
): EntityResolutionFallbackResult {
  return {
    stage,
    sourceStatus: 'complete',
    candidates: [],
  };
}
