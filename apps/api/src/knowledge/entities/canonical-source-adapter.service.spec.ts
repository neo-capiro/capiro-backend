import { describe, expect, jest, test } from '@jest/globals';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import { CanonicalSourceAdapterService } from './canonical-source-adapter.service.js';
import type {
  CanonicalEntityRecord,
  EntityResolutionPreview,
  EntityResolutionResult,
} from './entity-resolution.types.js';
import { UniversalEntityResolutionService } from './universal-entity-resolution.service.js';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTITY: CanonicalEntityRecord = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
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

function preview(
  overrides: Partial<EntityResolutionPreview> = {},
): EntityResolutionPreview {
  return {
    status: 'unresolved',
    entity: null,
    confidence: 0,
    resolutionMethod: 'unresolved',
    candidates: [],
    provenance: [],
    requiresUserConfirmation: false,
    ...overrides,
  };
}

function resolution(
  overrides: Partial<EntityResolutionResult> = {},
): EntityResolutionResult {
  return {
    resolutionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ...preview(),
    ...overrides,
  };
}

function harness() {
  const previewResolution = jest.fn(async () => preview());
  const resolve = jest.fn(async () => resolution());
  const registerTenantPrivateEntity = jest.fn(async () => ({
    ...ENTITY,
    tenantId: TENANT_ID,
    identityScope: 'tenant_private' as const,
  }));
  const resolver = {
    preview: previewResolution,
    resolve,
    registerTenantPrivateEntity,
  } as unknown as UniversalEntityResolutionService;

  const registerGlobalPublicEntity = jest.fn(async () => ENTITY);
  const linkTenantIdentity = jest.fn(async () => ENTITY);
  const registration = {
    registerGlobalPublicEntity,
    linkTenantIdentity,
  } as unknown as CanonicalEntityRegistrationService;

  return {
    service: new CanonicalSourceAdapterService(resolver, registration),
    previewResolution,
    resolve,
    registerTenantPrivateEntity,
    registerGlobalPublicEntity,
    linkTenantIdentity,
  };
}

describe('CanonicalSourceAdapterService', () => {
  test('dry-run reports a new CRM client without writing identity', async () => {
    const {
      service,
      previewResolution,
      resolve,
      registerTenantPrivateEntity,
      linkTenantIdentity,
    } = harness();
    previewResolution.mockResolvedValue(preview());

    const result = await service.syncClient(
      {
        id: 'client-1',
        tenantId: TENANT_ID,
        name: 'Kinetic Industries',
        website: 'https://www.kinetic.example/about',
        uei: 'ABCDEF123456',
      },
      { dryRun: true },
    );

    expect(result.status).toBe('would_create');
    expect(resolve).not.toHaveBeenCalled();
    expect(registerTenantPrivateEntity).not.toHaveBeenCalled();
    expect(linkTenantIdentity).not.toHaveBeenCalled();
    expect(previewResolution).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        entityTypeHint: 'organization',
        identifiers: expect.arrayContaining([
          { type: 'crm_client_id', value: 'client-1' },
          { type: 'domain', value: 'kinetic.example' },
          { type: 'uei', value: 'ABCDEF123456' },
        ]),
      }),
    );
  });

  test('links an existing exact entity instead of creating a duplicate', async () => {
    const {
      service,
      previewResolution,
      resolve,
      registerTenantPrivateEntity,
      linkTenantIdentity,
    } = harness();
    previewResolution.mockResolvedValue(
      preview({ status: 'resolved', entity: ENTITY, confidence: 1 }),
    );
    resolve.mockResolvedValue(
      resolution({ status: 'resolved', entity: ENTITY, confidence: 1 }),
    );

    const result = await service.syncClient({
      id: 'client-1',
      tenantId: TENANT_ID,
      name: 'RTX',
      uei: 'ABCDEF123456',
    });

    expect(result.status).toBe('linked');
    expect(result.entityId).toBe(ENTITY.id);
    expect(linkTenantIdentity).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ entityId: ENTITY.id }),
    );
    expect(registerTenantPrivateEntity).not.toHaveBeenCalled();
  });

  test('creates a tenant-private person when deterministic identity is absent', async () => {
    const { service, registerTenantPrivateEntity } = harness();

    const result = await service.syncClientPerson({
      id: 'person-1',
      tenantId: TENANT_ID,
      clientId: 'client-1',
      name: 'Jane Smith',
      email: 'jane@example.com',
    });

    expect(result.status).toBe('created');
    expect(registerTenantPrivateEntity).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({
        entityType: 'person',
        canonicalName: 'Jane Smith',
        identifiers: expect.arrayContaining([
          expect.objectContaining({ type: 'email', value: 'jane@example.com' }),
        ]),
      }),
    );
  });

  test('does not manufacture a person from a generic mailbox', async () => {
    const { service, previewResolution } = harness();

    const result = await service.syncEngagementContact({
      id: 'contact-1',
      tenantId: TENANT_ID,
      email: 'info@example.com',
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('Generic mailbox');
    expect(previewResolution).not.toHaveBeenCalled();
  });

  test('does not auto-create when deterministic signals are ambiguous', async () => {
    const { service, previewResolution, resolve, registerTenantPrivateEntity } = harness();
    previewResolution.mockResolvedValue(
      preview({
        status: 'ambiguous',
        confidence: 0.98,
        requiresUserConfirmation: true,
        candidates: [
          {
            entity: ENTITY,
            confidence: 0.98,
            resolutionMethod: 'canonical_name_exact',
            reasons: ['test'],
            provenance: [],
          },
        ],
      }),
    );

    const result = await service.syncClient({
      id: 'client-1',
      tenantId: TENANT_ID,
      name: 'Kinetic Industries',
    });

    expect(result.status).toBe('ambiguous');
    expect(resolve).not.toHaveBeenCalled();
    expect(registerTenantPrivateEntity).not.toHaveBeenCalled();
  });

  test('promotes only confirmed reviewed public mappings', async () => {
    const {
      service,
      previewResolution,
      resolve,
      registerGlobalPublicEntity,
      linkTenantIdentity,
    } = harness();
    previewResolution.mockResolvedValue(preview());
    resolve.mockResolvedValue(
      resolution({ status: 'resolved', entity: ENTITY, confidence: 1 }),
    );

    const skipped = await service.syncConfirmedClientMapping({
      id: 'mapping-1',
      tenantId: TENANT_ID,
      clientId: 'client-1',
      clientName: 'RTX',
      source: 'contracting',
      externalId: 'contractor-1',
      externalName: 'RTX Corporation',
      confirmed: true,
      reviewStatus: 'candidate',
      publicIdentifiers: [
        {
          type: 'uei',
          value: 'ABCDEF123456',
          sourceType: 'federal_contractor',
          sourceId: 'contractor-1',
        },
      ],
    });
    expect(skipped.status).toBe('skipped');

    const linked = await service.syncConfirmedClientMapping({
      id: 'mapping-1',
      tenantId: TENANT_ID,
      clientId: 'client-1',
      clientName: 'RTX',
      source: 'contracting',
      externalId: 'contractor-1',
      externalName: 'RTX Corporation',
      confirmed: true,
      reviewStatus: 'confirmed',
      publicIdentifiers: [
        {
          type: 'uei',
          value: 'ABCDEF123456',
          sourceType: 'federal_contractor',
          sourceId: 'contractor-1',
        },
      ],
    });

    expect(linked.status).toBe('created');
    expect(registerGlobalPublicEntity).toHaveBeenCalledTimes(1);
    expect(linkTenantIdentity).toHaveBeenCalledWith(
      TENANT_ID,
      expect.objectContaining({ entityId: ENTITY.id }),
    );
  });
});
