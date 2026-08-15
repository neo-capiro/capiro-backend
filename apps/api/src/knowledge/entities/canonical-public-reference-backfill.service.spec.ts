import { describe, expect, jest, test } from '@jest/globals';
import type { CanonicalEntityRegistrationService } from './canonical-entity-registration.service.js';
import type { CanonicalPublicReferenceBackfillRepository } from './canonical-public-reference-backfill.repository.js';
import {
  authoritativeSourceType,
  CanonicalPublicReferenceBackfillService,
} from './canonical-public-reference-backfill.service.js';
import type { CanonicalPublicReferenceRecord } from './canonical-public-reference-backfill.types.js';
import type { CanonicalEntityRecord } from './entity-resolution.types.js';

function record(
  cursorKey: string,
  overrides: Partial<CanonicalPublicReferenceRecord> = {},
): CanonicalPublicReferenceRecord {
  return {
    cursorKey,
    source: 'congress_members',
    sourceId: cursorKey,
    entityType: 'person',
    canonicalName: `Member ${cursorKey}`,
    identifiers: [{ type: 'congress_id', value: cursorKey }],
    aliases: [],
    metadata: {},
    observedAt: new Date('2026-08-15T00:00:00Z'),
    ...overrides,
  };
}

function entity(id: string): CanonicalEntityRecord {
  return {
    id,
    tenantId: null,
    identityScope: 'global_public',
    entityType: 'person',
    canonicalName: `Member ${id}`,
    normalizedName: `member ${id}`,
    status: 'active',
    resolutionConfidence: 1,
    resolutionMethod: 'congress_member',
    metadata: {},
    mergedIntoEntityId: null,
    createdAt: new Date('2026-08-15T00:00:00Z'),
    updatedAt: new Date('2026-08-15T00:00:00Z'),
  };
}

function setup(rows: CanonicalPublicReferenceRecord[]) {
  const listBatch = jest.fn(async () => rows);
  const registerGlobalPublicEntity = jest.fn(async (input: { canonicalName: string }) =>
    entity(`entity-${input.canonicalName}`),
  );
  const service = new CanonicalPublicReferenceBackfillService(
    { listBatch } as unknown as CanonicalPublicReferenceBackfillRepository,
    { registerGlobalPublicEntity } as unknown as CanonicalEntityRegistrationService,
  );
  return { service, listBatch, registerGlobalPublicEntity };
}

describe('CanonicalPublicReferenceBackfillService', () => {
  test('defaults to dry-run and does not pollute canonical identity history', async () => {
    const { service, listBatch, registerGlobalPublicEntity } = setup([
      record('A000001'),
      record('A000002'),
    ]);

    const result = await service.run({ source: 'congress_members', limit: 10 });

    expect(listBatch).toHaveBeenCalledWith('congress_members', null, 10);
    expect(registerGlobalPublicEntity).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        execute: false,
        scanned: 2,
        eligible: 2,
        processed: 0,
        nextCursor: 'A000002',
        exhausted: true,
      }),
    );
  });

  test('execute sends the canonical registration DTO, not compatibility-only fields', async () => {
    const { service, registerGlobalPublicEntity } = setup([record('A000003')]);

    const result = await service.run({
      source: 'congress_members',
      execute: true,
      limit: 1,
    });

    expect(registerGlobalPublicEntity).toHaveBeenCalledWith({
      entityType: 'person',
      canonicalName: 'Member A000003',
      resolutionMethod: 'congress_member',
      resolutionConfidence: 1,
      identifiers: [
        expect.objectContaining({
          type: 'congress_id',
          value: 'A000003',
          sourceType: 'congress_member',
          sourceId: 'A000003',
        }),
      ],
      aliases: [],
      metadata: expect.objectContaining({
        authoritativeSource: 'congress_members',
        authoritativeSourceId: 'A000003',
      }),
    });
    expect(result.processed).toBe(1);
    expect(result.entityIds).toEqual(['entity-Member A000003']);
  });

  test('maps every reader source to an allowlisted authoritative registration source', () => {
    expect(authoritativeSourceType('federal_contractors')).toBe('federal_contractor');
    expect(authoritativeSourceType('congress_members')).toBe('congress_member');
    expect(authoritativeSourceType('congress_committees')).toBe('congress_committee');
    expect(authoritativeSourceType('acquisition_personnel')).toBe('capiro_directory');
    expect(authoritativeSourceType('program_elements')).toBe('program_element');
    expect(authoritativeSourceType('lda_clients')).toBe('lda_client');
    expect(authoritativeSourceType('sec_companies')).toBe('sec_filing');
  });

  test('stops at the first failure and keeps the last successful retry cursor', async () => {
    const { service, registerGlobalPublicEntity } = setup([
      record('A000010'),
      record('A000011'),
      record('A000012'),
    ]);
    registerGlobalPublicEntity
      .mockResolvedValueOnce(entity('entity-A000010'))
      .mockRejectedValueOnce(new Error('identifier conflict'));

    const result = await service.run({
      source: 'congress_members',
      execute: true,
      cursor: 'A000009',
      limit: 3,
    });

    expect(registerGlobalPublicEntity).toHaveBeenCalledTimes(2);
    expect(result.processed).toBe(1);
    expect(result.nextCursor).toBe('A000010');
    expect(result.exhausted).toBe(false);
    expect(result.failures).toEqual([
      { sourceId: 'A000011', message: 'identifier conflict' },
    ]);
  });

  test('skips structurally ineligible rows without invoking registration', async () => {
    const { service, registerGlobalPublicEntity } = setup([
      record('blank', { canonicalName: '   ' }),
    ]);

    const result = await service.run({
      source: 'congress_members',
      execute: true,
      limit: 10,
    });

    expect(registerGlobalPublicEntity).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.nextCursor).toBe('blank');
  });
});
