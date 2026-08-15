import { BadRequestException, ConflictException } from '@nestjs/common';
import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRecord } from './entity-resolution.types.js';
import { CanonicalEntityRegistrationRepository } from './canonical-entity-registration.repository.js';
import { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';

const ENTITY: CanonicalEntityRecord = {
  id: '11111111-1111-4111-8111-111111111111',
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

function input() {
  return {
    entityType: 'organization',
    canonicalName: 'RTX Corporation',
    resolutionMethod: 'sam_entity',
    identifiers: [
      {
        type: 'uei',
        value: 'ABCDEF123456',
        sourceType: 'sam_entity',
        sourceId: 'ABCDEF123456',
        confidence: 1,
      },
    ],
    aliases: [
      {
        value: 'Raytheon Technologies',
        sourceType: 'sec_filing',
        sourceId: '0000101829',
        confidence: 1,
      },
    ],
  };
}

function harness(existing: CanonicalEntityRecord[] = []) {
  const findGlobalByIdentifiers = jest.fn(async () => existing);
  const findGlobalByExactName = jest.fn(async () => [] as CanonicalEntityRecord[]);
  const createGlobalPublicEntity = jest.fn(async () => ENTITY);
  const attachGlobalIdentity = jest.fn(async () => ENTITY);
  const attachTenantPrivateIdentity = jest.fn(async () => ENTITY);
  const mergeTenantPrivateEntity = jest.fn(async () => ENTITY);
  const repository = {
    findGlobalByIdentifiers,
    findGlobalByExactName,
    createGlobalPublicEntity,
    attachGlobalIdentity,
    attachTenantPrivateIdentity,
    mergeTenantPrivateEntity,
  } as unknown as CanonicalEntityRegistrationRepository;
  return {
    service: new CanonicalEntityRegistrationService(repository),
    findGlobalByIdentifiers,
    findGlobalByExactName,
    createGlobalPublicEntity,
    attachGlobalIdentity,
    attachTenantPrivateIdentity,
    mergeTenantPrivateEntity,
  };
}

describe('CanonicalEntityRegistrationService', () => {
  test('creates a global entity only from an authoritative identifier', async () => {
    const { service, createGlobalPublicEntity } = harness();

    await expect(service.registerGlobalPublicEntity(input())).resolves.toEqual(
      ENTITY,
    );
    expect(createGlobalPublicEntity).toHaveBeenCalledTimes(1);
  });

  test('reuses and enriches an existing global entity by exact identifier', async () => {
    const { service, createGlobalPublicEntity, attachGlobalIdentity } = harness([
      ENTITY,
    ]);

    await expect(service.registerGlobalPublicEntity(input())).resolves.toEqual(
      ENTITY,
    );
    expect(createGlobalPublicEntity).not.toHaveBeenCalled();
    expect(attachGlobalIdentity).toHaveBeenCalledWith(ENTITY.id, input());
  });

  test('fails closed when authoritative identifiers disagree', async () => {
    const other = {
      ...ENTITY,
      id: '22222222-2222-4222-8222-222222222222',
      canonicalName: 'Other Company',
      normalizedName: 'other company',
    };
    const { service } = harness([ENTITY, other]);

    await expect(service.registerGlobalPublicEntity(input())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  test('rejects name-only, model-derived, and private-email global identity', async () => {
    const { service } = harness();

    await expect(
      service.registerGlobalPublicEntity({
        ...input(),
        identifiers: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.registerGlobalPublicEntity({
        ...input(),
        resolutionMethod: 'model_output',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.registerGlobalPublicEntity({
        ...input(),
        resolutionMethod: 'crm_client',
        identifiers: [
          {
            type: 'uei',
            value: 'ABCDEF123456',
            sourceType: 'crm_client',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.registerGlobalPublicEntity({
        ...input(),
        identifiers: [
          {
            type: 'email',
            value: 'person@example.com',
            sourceType: 'official_directory',
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('refuses a same-name global duplicate when identifiers do not corroborate', async () => {
    const { service, findGlobalByExactName, createGlobalPublicEntity } = harness();
    findGlobalByExactName.mockResolvedValue([ENTITY]);

    await expect(service.registerGlobalPublicEntity(input())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(createGlobalPublicEntity).not.toHaveBeenCalled();
  });

  test('delegates deterministic tenant-private convergence to the merge ledger', async () => {
    const { service, mergeTenantPrivateEntity } = harness();

    await expect(
      service.mergeTenantPrivateEntity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        sourceEntityId: '22222222-2222-4222-8222-222222222222',
        targetEntityId: ENTITY.id,
        reasonCode: 'confirmed_public_mapping',
        provenance: [{ sourceType: 'client_intel_mapping', sourceId: 'mapping-1' }],
      }),
    ).resolves.toEqual(ENTITY);
    expect(mergeTenantPrivateEntity).toHaveBeenCalledTimes(1);
  });

  test('rejects an unreviewed merge reason code', async () => {
    const { service, mergeTenantPrivateEntity } = harness();

    await expect(
      service.mergeTenantPrivateEntity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        sourceEntityId: '22222222-2222-4222-8222-222222222222',
        targetEntityId: ENTITY.id,
        reasonCode: 'model_suggested',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(mergeTenantPrivateEntity).not.toHaveBeenCalled();
  });

  test('links tenant-private source identity to an existing visible entity', async () => {
    const { service, attachTenantPrivateIdentity } = harness();

    await expect(
      service.linkTenantIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        entityId: ENTITY.id,
        identifiers: [
          {
            type: 'crm_client_id',
            value: 'client-42',
            sourceType: 'crm_client',
            sourceId: 'client-42',
          },
        ],
      }),
    ).resolves.toEqual(ENTITY);

    expect(attachTenantPrivateIdentity).toHaveBeenCalledTimes(1);
  });

  test('refuses an empty tenant identity link', async () => {
    const { service } = harness();

    await expect(
      service.linkTenantIdentity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
        entityId: ENTITY.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
