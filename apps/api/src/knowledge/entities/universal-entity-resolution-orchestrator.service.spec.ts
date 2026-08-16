import { BadRequestException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import type {
  CanonicalEntityRecord,
  EntityResolutionPreview,
  EntityResolutionResult,
  ResolveEntityInput,
} from './entity-resolution.types.js';
import type {
  EntityResolutionFallbackProvider,
  EntityResolutionFallbackResult,
} from './universal-entity-resolution-orchestrator.types.js';
import { UniversalEntityResolutionOrchestratorService } from './universal-entity-resolution-orchestrator.service.js';
import type { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function entity(
  id = '22222222-2222-4222-8222-222222222222',
  name = 'Kinetic Industries, Inc.',
): CanonicalEntityRecord {
  return {
    id,
    tenantId: null,
    identityScope: 'global_public',
    entityType: 'organization',
    canonicalName: name,
    normalizedName: name.toLowerCase(),
    status: 'active',
    resolutionConfidence: 1,
    resolutionMethod: 'official_domain',
    metadata: {},
    mergedIntoEntityId: null,
    createdAt: new Date('2026-08-15T00:00:00Z'),
    updatedAt: new Date('2026-08-15T00:00:00Z'),
  };
}

function unresolved(method = 'unresolved'): EntityResolutionPreview {
  return {
    status: 'unresolved',
    entity: null,
    confidence: 0,
    resolutionMethod: method,
    candidates: [],
    provenance: [],
    requiresUserConfirmation: false,
  };
}

function resolved(value: CanonicalEntityRecord): EntityResolutionPreview {
  return {
    status: 'resolved',
    entity: value,
    confidence: 1,
    resolutionMethod: 'identifier_exact',
    candidates: [
      {
        entity: value,
        confidence: 1,
        resolutionMethod: 'identifier_exact',
        reasons: ['exact identifier'],
        provenance: [
          {
            sourceType: 'official_directory',
            identifierType: 'official_domain',
            matchValue: 'kindeticindustries.inc',
          },
        ],
      },
    ],
    provenance: [
      {
        sourceType: 'official_directory',
        identifierType: 'official_domain',
        matchValue: 'kindeticindustries.inc',
      },
    ],
    requiresUserConfirmation: false,
  };
}

function persisted(
  preview: EntityResolutionPreview,
  resolutionId = '33333333-3333-4333-8333-333333333333',
): EntityResolutionResult {
  return { ...preview, resolutionId };
}

function provider(
  stage: EntityResolutionFallbackProvider['stage'],
  result: EntityResolutionFallbackResult,
): EntityResolutionFallbackProvider {
  return { stage, lookup: jest.fn(async () => result) };
}

function setup(input?: {
  preview?: (value: ResolveEntityInput) => Promise<EntityResolutionPreview>;
  resolve?: (value: ResolveEntityInput) => Promise<EntityResolutionResult>;
  providers?: EntityResolutionFallbackProvider[];
  registeredEntity?: CanonicalEntityRecord;
}) {
  const previewImplementation = input?.preview ?? (async () => unresolved());
  const resolveImplementation =
    input?.resolve ?? (async () => persisted(unresolved()));
  const preview = jest.fn(
    async (_tenantId: string, value: ResolveEntityInput) =>
      previewImplementation(value),
  );
  const resolve = jest.fn(
    async (_tenantId: string, value: ResolveEntityInput) =>
      resolveImplementation(value),
  );
  const registerGlobalPublicEntity = jest.fn(async () =>
    input?.registeredEntity ?? entity(),
  );
  const service = new UniversalEntityResolutionOrchestratorService(
    { preview, resolve } as unknown as UniversalEntityResolutionService,
    { registerGlobalPublicEntity } as unknown as CanonicalEntityRegistrationService,
    input?.providers ?? [],
  );
  return { service, preview, resolve, registerGlobalPublicEntity };
}

describe('UniversalEntityResolutionOrchestratorService', () => {
  test('resolves a verified official domain after exact-name lookup misses', async () => {
    const kinetic = entity();
    const { service, preview, resolve } = setup({
      preview: async (value) =>
        value.identifiers?.some((item) => item.type === 'official_domain')
          ? resolved(kinetic)
          : unresolved(),
      resolve: async () => persisted(resolved(kinetic)),
    });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'kindeticindustries.inc',
      entityTypeHint: 'organization',
      identifiers: [
        { type: 'official_domain', value: 'kindeticindustries.inc' },
      ],
    });

    expect(result.status).toBe('resolved');
    expect(result.entity?.id).toBe(kinetic.id);
    expect(result.attemptedStages.map((item) => item.stage)).toEqual([
      'existing_canonical',
      'email_domain',
    ]);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('automatically reaches public web but keeps its candidate review-only', async () => {
    const publicWeb = provider('public_web', {
      stage: 'public_web',
      sourceStatus: 'complete',
      candidates: [
        {
          candidateKey: 'victory-six-result-1',
          canonicalName: 'Victory Six, Inc.',
          entityType: 'organization',
          evidenceKinds: ['public_web_claim'],
          sourceType: 'tavily',
          sourceUrl: 'https://victorysix.example',
          observedAt: new Date('2026-08-15T00:00:00Z'),
          confidence: 0.82,
        },
      ],
    });
    const { service, resolve, registerGlobalPublicEntity } = setup({
      providers: [publicWeb],
    });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Victory Six',
      entityTypeHint: 'organization',
    });

    expect(result.status).toBe('ambiguous');
    expect(result.entity).toBeNull();
    expect(result.requiresUserConfirmation).toBe(true);
    expect(result.publicLookupRan).toBe(true);
    expect(result.attemptedStages.map((item) => item.stage)).toEqual([
      'existing_canonical',
      'public_web',
    ]);
    expect(result.candidates.map((item) => item.canonicalName)).toContain(
      'Victory Six, Inc.',
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(registerGlobalPublicEntity).not.toHaveBeenCalled();
  });

  test('model reconciliation can rank a misspelling candidate but cannot select it', async () => {
    const publicWeb = provider('public_web', {
      stage: 'public_web',
      sourceStatus: 'complete',
      candidates: [
        {
          candidateKey: 'kinetic-web',
          canonicalName: 'Kinetic Industries, Inc.',
          entityType: 'organization',
          evidenceKinds: ['public_web_claim'],
          sourceType: 'serper',
          sourceUrl: 'https://kinetic.example',
          observedAt: new Date('2026-08-15T00:00:00Z'),
          confidence: 0.75,
        },
      ],
    });
    const model = provider('model_candidate_reconciliation', {
      stage: 'model_candidate_reconciliation',
      sourceStatus: 'complete',
      candidates: [
        {
          candidateKey: 'kinetic-model',
          canonicalName: 'Kinetic Industries, Inc.',
          entityType: 'organization',
          evidenceKinds: ['model_suggestion'],
          sourceType: 'model_candidate_reconciliation',
          sourceId: 'candidate-rank-1',
          observedAt: new Date('2026-08-15T00:00:01Z'),
          confidence: 0.97,
        },
      ],
    });
    const { service, registerGlobalPublicEntity } = setup({
      providers: [publicWeb, model],
    });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Kindetic Industries',
      entityTypeHint: 'organization',
    });

    expect(result.status).toBe('ambiguous');
    expect(result.entity).toBeNull();
    expect(result.attemptedStages.map((item) => item.stage)).toEqual([
      'existing_canonical',
      'public_web',
      'model_candidate_reconciliation',
    ]);
    expect(registerGlobalPublicEntity).not.toHaveBeenCalled();
  });

  test('may register a unique authoritative public identifier only with explicit opt-in', async () => {
    const rtx = entity(
      '44444444-4444-4444-8444-444444444444',
      'RTX Corporation',
    );
    const sam = provider('sam_uei_cage', {
      stage: 'sam_uei_cage',
      sourceStatus: 'complete',
      candidates: [
        {
          candidateKey: 'ABCDEF123456',
          canonicalName: 'RTX Corporation',
          entityType: 'organization',
          identifiers: [
            {
              type: 'uei',
              value: 'ABCDEF123456',
              sourceType: 'sam_entity',
              sourceId: 'ABCDEF123456',
              confidence: 1,
            },
          ],
          evidenceKinds: ['exact_authoritative_identifier'],
          sourceType: 'sam_entity',
          sourceId: 'ABCDEF123456',
          observedAt: new Date('2026-08-15T00:00:00Z'),
          confidence: 1,
        },
      ],
    });
    const { service, registerGlobalPublicEntity, resolve } = setup({
      providers: [sam],
      registeredEntity: rtx,
      resolve: async () => persisted(resolved(rtx)),
    });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Raytheon Technologies',
      entityTypeHint: 'organization',
      allowAuthoritativePublicRegistration: true,
    });

    expect(result.status).toBe('resolved');
    expect(result.entity?.id).toBe(rtx.id);
    expect(registerGlobalPublicEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalName: 'RTX Corporation',
        resolutionMethod: 'sam_entity',
      }),
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('hard-stops on conflicting exact identifiers before public/model fallback', async () => {
    const web = provider('public_web', {
      stage: 'public_web',
      sourceStatus: 'complete',
      candidates: [],
    });
    const ambiguous: EntityResolutionPreview = {
      status: 'ambiguous',
      entity: null,
      confidence: 1,
      resolutionMethod: 'conflicting_identifiers',
      candidates: [],
      provenance: [],
      requiresUserConfirmation: true,
    };
    const { service, resolve } = setup({
      preview: async (value) =>
        value.identifiers?.length ? ambiguous : unresolved(),
      resolve: async () => persisted(ambiguous),
      providers: [web],
    });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Acme Defense',
      entityTypeHint: 'organization',
      identifiers: [
        { type: 'uei', value: 'PARENT123456' },
        { type: 'cage', value: 'SUB01' },
      ],
    });

    expect(result.status).toBe('ambiguous');
    expect(result.stopReason).toBe('authoritative_identifier_conflict');
    expect(result.attemptedStages.map((item) => item.stage)).toEqual([
      'existing_canonical',
      'sam_uei_cage',
    ]);
    expect(web.lookup).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  test('fails closed on a cross-tenant private provider candidate', async () => {
    const leaked = {
      ...entity(),
      tenantId: '99999999-9999-4999-8999-999999999999',
      identityScope: 'tenant_private' as const,
    };
    const directory = provider('directory_government_id', {
      stage: 'directory_government_id',
      sourceStatus: 'complete',
      candidates: [
        {
          candidateKey: leaked.id,
          canonicalEntity: leaked,
          canonicalName: leaked.canonicalName,
          entityType: leaked.entityType,
          evidenceKinds: ['exact_authoritative_identifier'],
          sourceType: 'capiro_directory',
          sourceId: leaked.id,
          observedAt: new Date('2026-08-15T00:00:00Z'),
          confidence: 1,
        },
      ],
    });
    const { service } = setup({ providers: [directory] });

    const result = await service.resolveAcrossSources(TENANT_ID, {
      query: 'Private Entity',
      entityTypeHint: 'organization',
    });

    expect(result.status).toBe('unresolved');
    expect(result.candidates).toHaveLength(0);
    expect(result.attemptedStages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: 'directory_government_id',
          sourceStatus: 'error',
        }),
      ]),
    );
  });

  test('rejects multiple providers for one resolution stage', async () => {
    const first = provider('public_web', {
      stage: 'public_web',
      sourceStatus: 'complete',
      candidates: [],
    });
    const second = provider('public_web', {
      stage: 'public_web',
      sourceStatus: 'complete',
      candidates: [],
    });
    const { service } = setup({ providers: [first, second] });

    await expect(
      service.resolveAcrossSources(TENANT_ID, {
        query: 'Victory Six',
        entityTypeHint: 'organization',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
