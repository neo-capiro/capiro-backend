import { describe, expect, jest, test } from '@jest/globals';
import type { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
import type { LlmCompletionService } from '../../engagement/llm-completion.service.js';
import { ModelCandidateReconciliationEntityResolutionProvider } from './canonical-model-candidate-reconciliation.provider.js';
import { decideEntityResolutionStagePolicy } from './entity-resolution-stage-policy.js';
import type {
  EntityResolutionFallbackLookupInput,
  EntityResolutionOrchestrationCandidate,
} from './universal-entity-resolution-orchestrator.types.js';

function credential(overrides: Partial<{ provider: 'openai' | 'anthropic'; apiKey: string; model: string }> = {}) {
  return {
    provider: 'openai' as const,
    apiKey: 'sk-test',
    model: 'gpt-test',
    usedTenantKey: false,
    modelOverridden: false,
    ...overrides,
  };
}

function aiCredentials(
  resolve: (provider: 'openai' | 'anthropic') => Promise<ReturnType<typeof credential> | null>,
): AiCredentialResolverService {
  return {
    resolveProviderByTenantId: jest.fn(resolve),
  } as unknown as AiCredentialResolverService;
}

function llm(complete: (...args: unknown[]) => Promise<{ text: string }>): LlmCompletionService {
  return { complete: jest.fn(complete) } as unknown as LlmCompletionService;
}

function priorCandidate(
  overrides: Partial<EntityResolutionOrchestrationCandidate> = {},
): EntityResolutionOrchestrationCandidate {
  return {
    candidateKey: 'public_web:https://kineticindustries.example/',
    entityId: null,
    canonicalName: 'Kinetic Industries, Inc.',
    entityType: 'organization',
    confidence: 0.6,
    stage: 'public_web',
    sourceType: 'public_web:tavily',
    sourceId: 'https://kineticindustries.example/',
    sourceUrl: 'https://kineticindustries.example/',
    evidenceKinds: ['public_web_claim'],
    provenance: [],
    ...overrides,
  };
}

function lookupInput(
  overrides: Partial<EntityResolutionFallbackLookupInput> = {},
): EntityResolutionFallbackLookupInput {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    actorUserId: null,
    query: 'Kindetic Industries',
    normalizedQuery: 'kindetic industries',
    entityTypeHint: 'organization',
    identifiers: [],
    priorCandidates: [priorCandidate()],
    ...overrides,
  };
}

describe('ModelCandidateReconciliationEntityResolutionProvider', () => {
  test('normalizes a misspelled mention to the matched corroborated candidate name', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => ({
      text: JSON.stringify({
        candidates: [
          {
            canonicalName: 'Kinetic Industries',
            matchesCandidateKey: 'public_web:https://kineticindustries.example/',
            confidence: 0.82,
            rationale: 'Likely misspelling of a corroborated public-web candidate.',
          },
        ],
      }),
    }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.stage).toBe('model_candidate_reconciliation');
    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(
      expect.objectContaining({
        canonicalName: 'Kinetic Industries, Inc.',
        evidenceKinds: ['model_suggestion'],
        sourceType: 'model_candidate_reconciliation:openai',
        sourceUrl: null,
        sourceId: null,
      }),
    );
  });

  test('ranks and bounds multiple candidate suggestions, deduplicating by name', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => ({
      text: JSON.stringify({
        candidates: [
          { canonicalName: 'Kinetic Industries, Inc.', confidence: 0.9 },
          { canonicalName: 'Kinetic Industries, Inc.', confidence: 0.5 },
          { canonicalName: 'Kinetic Holdings', confidence: 0.4 },
          { canonicalName: 'Kinetic Group', confidence: 0.3 },
          { canonicalName: 'Kinetic Ventures', confidence: 0.2 },
        ],
      }),
    }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('complete');
    // deduped (5 raw -> 4 distinct names) then bounded to MAX_CANDIDATES (3)
    expect(result.candidates).toHaveLength(3);
    expect(result.candidates.map((c) => c.canonicalName)).toEqual([
      'Kinetic Industries, Inc.',
      'Kinetic Holdings',
      'Kinetic Group',
    ]);
  });

  test('reports error on malformed model output', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => ({ text: 'not json at all' }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('model_candidate_reconciliation_malformed_output');
    expect(result.candidates).toEqual([]);
  });

  test('reports error on malformed output missing the candidates array', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => ({ text: JSON.stringify({ notCandidates: [] }) }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('model_candidate_reconciliation_malformed_output');
  });

  test('reports error when the model call times out or fails', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => {
      throw new Error('anthropic completion timed out after 10s');
    });

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('error');
    expect(result.stopReason).toBe('model_candidate_reconciliation_provider_error');
    expect(result.candidates).toEqual([]);
  });

  test('reports unavailable and never calls the model when no credential is configured', async () => {
    const credentials = aiCredentials(async () => null);
    const completeSpy = jest.fn(async () => ({ text: '{}' }));
    const model = llm(completeSpy);

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());

    expect(result.sourceStatus).toBe('unavailable');
    expect(result.stopReason).toBe('model_candidate_reconciliation_no_credential');
    expect(result.candidates).toEqual([]);
    expect(completeSpy).not.toHaveBeenCalled();
  });

  test('returns no candidates for an empty mention without resolving credentials', async () => {
    const resolveSpy = jest.fn(async () => credential());
    const credentials = aiCredentials(resolveSpy);
    const model = llm(async () => ({ text: '{}' }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput({ query: '   ' }));

    expect(result.sourceStatus).toBe('complete');
    expect(result.candidates).toEqual([]);
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  test('model-suggestion evidence alone can never force a canonical resolution', async () => {
    const credentials = aiCredentials(async () => credential());
    const model = llm(async () => ({
      text: JSON.stringify({ candidates: [{ canonicalName: 'Kinetic Industries, Inc.', confidence: 0.97 }] }),
    }));

    const provider = new ModelCandidateReconciliationEntityResolutionProvider(credentials, model);
    const result = await provider.lookup(lookupInput());
    expect(result.candidates).toHaveLength(1);

    const decision = decideEntityResolutionStagePolicy('model_candidate_reconciliation', {
      candidateCount: result.candidates.length,
      evidenceKinds: result.candidates.flatMap((candidate) => candidate.evidenceKinds),
    });
    expect(decision.autoResolve).toBe(false);
    expect(decision.candidateOnly).toBe(true);
    expect(decision.mayRegisterGlobalPublic).toBe(false);
  });
});
