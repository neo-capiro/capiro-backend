import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import type { EntityResolutionPreview, EntityResolutionResult } from './entity-resolution.types.js';
import type { EntityResolutionFallbackProvider } from './universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from './universal-entity-resolution-orchestrator.service.js';
import type { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function unresolved(): EntityResolutionPreview {
  return {
    status: 'unresolved',
    entity: null,
    confidence: 0,
    resolutionMethod: 'unresolved',
    candidates: [],
    provenance: [],
    requiresUserConfirmation: false,
  };
}

function externalProvider(stage: 'official_website' | 'public_web' | 'model_candidate_reconciliation') {
  const lookup = jest.fn(async () => ({
    stage,
    sourceStatus: 'complete' as const,
    candidates: [],
  }));
  return { stage, lookup } satisfies EntityResolutionFallbackProvider;
}

describe('UniversalEntityResolutionOrchestratorService private-evidence scope', () => {
  test('does not send a private source-language identity to external lookup stages', async () => {
    const preview = jest.fn(async () => unresolved());
    const resolve = jest.fn(async () => ({
      ...unresolved(),
      resolutionId: '22222222-2222-4222-8222-222222222222',
    } as EntityResolutionResult));
    const officialWebsite = externalProvider('official_website');
    const publicWeb = externalProvider('public_web');
    const model = externalProvider('model_candidate_reconciliation');

    const service = new UniversalEntityResolutionOrchestratorService(
      { preview, resolve } as unknown as UniversalEntityResolutionService,
      { registerGlobalPublicEntity: jest.fn() } as unknown as CanonicalEntityRegistrationService,
      [officialWebsite, publicWeb, model],
    );

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Private Mailbox Person',
      entityTypeHint: 'person',
      allowExternalLookup: false,
      allowAuthoritativePublicRegistration: false,
    });

    expect(result.status).toBe('unresolved');
    expect(result.publicLookupRan).toBe(false);
    expect(result.attemptedStages.map((trace) => trace.stage)).toEqual([
      'existing_canonical',
    ]);
    expect(officialWebsite.lookup).not.toHaveBeenCalled();
    expect(publicWeb.lookup).not.toHaveBeenCalled();
    expect(model.lookup).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
});
