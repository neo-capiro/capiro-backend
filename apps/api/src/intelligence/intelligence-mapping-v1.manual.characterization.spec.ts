import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AWARD_BEARING_MAPPING_SOURCES } from './intelligence.service.js';
import {
  actorUserId,
  clientId,
  harness,
  inputOf,
  installHooks,
  manualInput,
  mappingId,
  mappingRow,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Manual mapping persisted decision and audit', () => {
  test('keeps exact upsert payloads, JsonNull audit before, saved identity and two committed scopes', async () => {
    const saved = mappingRow({ confidence: 1, confirmed: true });
    const h = harness({ prepopulation: false, rows: { upsert: saved } });
    expect(await h.service.createManualMapping(clientId, tenantId, manualInput())).toBe(saved);
    const decision = {
      externalName: 'Acme Research',
      confirmed: true,
      matchBasis: 'manual_pin',
      matchTier: 1,
      reviewStatus: 'confirmed',
      reviewedBy: actorUserId,
      reviewedAt: now,
      rejectionReason: null,
    };
    expect(inputOf(h, 'upsert')).toEqual({
      where: { clientId_source_externalId: { clientId, source: 'lda', externalId: '12' } },
      update: decision,
      create: { tenantId, clientId, source: 'lda', externalId: '12', confidence: 1, ...decision },
    });
    expect(inputOf(h, 'audit')).toEqual({
      data: {
        tenantId,
        actorUserId,
        action: 'intelligence_mapping.confirmed',
        entityType: 'client_intel_mapping',
        entityId: mappingId,
        before: Prisma.JsonNull,
        after: saved,
      },
    });
    expect((inputOf(h, 'audit').data as Record<string, unknown>).after).toBe(saved);
    expect(h.callsOf('client')[0]).toMatchObject({
      tenantId,
      transaction: 1,
      args: [{ where: { id: clientId }, select: { id: true } }],
    });
    expect(h.callsOf('existing')[0]).toMatchObject({
      tenantId,
      transaction: 2,
      args: [
        { where: { clientId_source_externalId: { clientId, source: 'lda', externalId: '12' } } },
      ],
    });
    expect(h.events).toEqual([
      'withTenant',
      'tenant:begin',
      'client',
      'tenant:commit',
      'withTenant',
      'tenant:begin',
      'existing',
      'upsert',
      'audit',
      'tenant:commit',
    ]);
  });
  test('retains raw names/IDs and existing confidence on update while auditing the original before object', async () => {
    const before = mappingRow({ confidence: 0.2, reviewStatus: 'superseded' });
    const h = harness({ prepopulation: false, rows: { existing: before } });
    await h.service.createManualMapping(
      clientId,
      tenantId,
      manualInput({ source: 'custom', externalId: ' raw-id ', externalName: ' Raw Name ' }),
    );
    const input = inputOf(h, 'upsert') as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(input.update).toMatchObject({ externalName: ' Raw Name ' });
    expect(input.update).not.toHaveProperty('confidence');
    expect(input.create).toMatchObject({
      source: 'custom',
      externalId: ' raw-id ',
      externalName: ' Raw Name ',
      confidence: 1,
    });
    expect((inputOf(h, 'audit').data as Record<string, unknown>).before).toBe(before);
  });
});

describe('Manual award mapping explicit decisions', () => {
  test.each(['contracting', 'assistance_recipient'])(
    'requires the relationship and roll-up request for %s',
    async (source) => {
      const h = harness();
      await expect(
        h.service.createManualMapping(clientId, tenantId, manualInput({ source })),
      ).rejects.toThrow(
        new BadRequestException(
          'Award-bearing federal mappings require a reviewed relationship type and an explicit award roll-up decision.',
        ),
      );
      expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit']);
      expect(h.callsOf('upsert')).toEqual([]);
    },
  );
  test.each([
    { relationshipType: null, rollUpAwards: false },
    { relationshipType: '', rollUpAwards: null },
  ])('refuses nullish explicit fields %p', async (fields) => {
    const h = harness();
    await expect(
      h.service.createManualMapping(
        clientId,
        tenantId,
        manualInput({ source: 'contracting', ...fields }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  test('accepts an explicit empty relationship and false roll-up and consults the canonical Root Set', async () => {
    const membership = jest.spyOn(AWARD_BEARING_MAPPING_SOURCES, 'has');
    const h = harness();
    await h.service.createManualMapping(
      clientId,
      tenantId,
      manualInput({ source: 'contracting', relationshipType: '', rollUpAwards: false }),
    );
    expect(membership).toHaveBeenCalledWith('contracting');
    const input = inputOf(h, 'upsert') as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    expect(input.update).toMatchObject({ relationshipType: '', rollUpAwards: false });
    expect(input.create).toMatchObject({ relationshipType: '', rollUpAwards: false });
  });
  test.each([
    { name: 'absent', fields: {}, present: false },
    {
      name: 'undefined',
      fields: { relationshipType: undefined, rollUpAwards: undefined },
      present: false,
    },
    {
      name: 'explicit null',
      fields: { relationshipType: null, rollUpAwards: null },
      present: true,
    },
  ])('preserves $name optional flags for a non-award source', async ({ fields, present }) => {
    const h = harness({ prepopulation: false });
    await h.service.createManualMapping(clientId, tenantId, manualInput(fields));
    const input = inputOf(h, 'upsert') as {
      update: Record<string, unknown>;
      create: Record<string, unknown>;
    };
    for (const payload of [input.update, input.create]) {
      expect(Object.hasOwn(payload, 'relationshipType')).toBe(present);
      expect(Object.hasOwn(payload, 'rollUpAwards')).toBe(present);
      if (present) expect(payload).toMatchObject({ relationshipType: null, rollUpAwards: null });
    }
  });
});

describe('Manual mapping transaction failures', () => {
  test('refuses a foreign client before inspecting source-specific input', async () => {
    const h = harness({ rows: { client: null } });
    await expect(
      h.service.createManualMapping(
        clientId,
        tenantId,
        manualInput({ source: 'fec_committee', externalId: 'bad' }),
      ),
    ).rejects.toThrow(new NotFoundException('Client not found'));
    expect(h.callsOf('committee')).toEqual([]);
    expect(h.callsOf('upsert')).toEqual([]);
  });
  test.each(['client', 'existing', 'upsert', 'audit'])(
    'propagates %s failure with the current transaction rolled back',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(h.service.createManualMapping(clientId, tenantId, manualInput())).rejects.toBe(
        error,
      );
      expect(h.transactions.at(-1)!.outcome).toBe('rollback');
      expect(h.callsOf('prepopulate')).toEqual([]);
    },
  );
});
