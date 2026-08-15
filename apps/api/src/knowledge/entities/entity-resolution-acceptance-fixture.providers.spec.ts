import { describe, expect, test } from '@jest/globals';
import { createMeriCompatibilityFixtureProviders } from './entity-resolution-acceptance-fixture.providers.js';
import type { EntityResolutionFallbackProvider } from './universal-entity-resolution-orchestrator.types.js';

function byStage(
  stage: EntityResolutionFallbackProvider['stage'],
): EntityResolutionFallbackProvider {
  const provider = createMeriCompatibilityFixtureProviders().find(
    (candidate) => candidate.stage === stage,
  );
  if (!provider) throw new Error(`Missing fixture provider for ${stage}`);
  return provider;
}

const baseInput = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  actorUserId: null,
  entityTypeHint: 'organization',
  identifiers: [],
  priorCandidates: [],
};

describe('attachment-driven entity fallback fixture providers', () => {
  test('returns Victory Six as a public-web candidate only', async () => {
    const result = await byStage('public_web').lookup({
      ...baseInput,
      query: 'Victory Six',
      normalizedQuery: 'victory six',
    });

    expect(result).toEqual(
      expect.objectContaining({
        stage: 'public_web',
        sourceStatus: 'complete',
      }),
    );
    expect(result.candidates).toEqual([
      expect.objectContaining({
        canonicalName: 'Victory Six, Inc.',
        evidenceKinds: ['public_web_claim'],
        canonicalEntity: undefined,
      }),
    ]);
  });

  test('returns misspelled Kinetic candidates from public and model stages', async () => {
    const input = {
      ...baseInput,
      query: 'Kindetic Industries',
      normalizedQuery: 'kindetic industries',
    };

    const publicResult = await byStage('public_web').lookup(input);
    const modelResult = await byStage('model_candidate_reconciliation').lookup(input);

    expect(publicResult.candidates[0]).toEqual(
      expect.objectContaining({
        canonicalName: 'Kinetic Industries, Inc.',
        evidenceKinds: ['public_web_claim'],
      }),
    );
    expect(modelResult.candidates[0]).toEqual(
      expect.objectContaining({
        canonicalName: 'Kinetic Industries, Inc.',
        evidenceKinds: ['model_suggestion'],
      }),
    );
  });

  test('does not invent candidates for unrelated queries', async () => {
    const result = await byStage('public_web').lookup({
      ...baseInput,
      query: 'Unrelated Company',
      normalizedQuery: 'unrelated company',
    });
    expect(result.candidates).toEqual([]);
  });
});
