import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  actorUserId,
  clientId,
  harness,
  inputOf,
  installHooks,
  mappingId,
  mappingRow,
  now,
  rejectionInput,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Mapping candidate rejected decision', () => {
  test('writes the exact rejection payload and JsonNull audit in a second tenant scope', async () => {
    const saved = mappingRow({ source: 'contracting', confirmed: false });
    const h = harness({ rows: { upsert: saved } });
    expect(await h.service.rejectMappingCandidate(clientId, tenantId, rejectionInput())).toBe(
      saved,
    );
    const decision = {
      externalName: 'Acme Research',
      confirmed: false,
      reviewStatus: 'rejected',
      reviewedBy: actorUserId,
      reviewedAt: now,
      rejectionReason: 'Rejected by reviewer',
      rollUpAwards: false,
    };
    expect(inputOf(h, 'upsert')).toEqual({
      where: {
        clientId_source_externalId: {
          clientId,
          source: 'contracting',
          externalId: 'contractor-one',
        },
      },
      update: decision,
      create: {
        tenantId,
        clientId,
        source: 'contracting',
        externalId: 'contractor-one',
        confidence: 0,
        ...decision,
        matchBasis: 'fuzzy_name',
        matchTier: 4,
      },
    });
    expect(inputOf(h, 'audit')).toEqual({
      data: {
        tenantId,
        actorUserId,
        action: 'intelligence_mapping.rejected',
        entityType: 'client_intel_mapping',
        entityId: mappingId,
        before: Prisma.JsonNull,
        after: saved,
      },
    });
    expect((inputOf(h, 'audit').data as Record<string, unknown>).after).toBe(saved);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit', 'commit']);
    expect(h.callsOf('upsert')[0]!.transaction).toBe(2);
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
});

describe('Mapping candidate rejection reference and nullish values', () => {
  test('preserves before identity and leaves prior confidence/basis/relationship out of the update', async () => {
    const before = mappingRow({
      source: 'contracting',
      confidence: 0.75,
      matchBasis: 'exact_uei',
      relationshipType: 'subsidiary',
    });
    const h = harness({ rows: { existing: before } });
    await h.service.rejectMappingCandidate(clientId, tenantId, rejectionInput());
    const update = inputOf(h, 'upsert').update as Record<string, unknown>;
    expect(update).not.toHaveProperty('confidence');
    expect(update).not.toHaveProperty('matchBasis');
    expect(update).not.toHaveProperty('relationshipType');
    expect((inputOf(h, 'audit').data as Record<string, unknown>).before).toBe(before);
  });
  test.each([
    { reason: null, stored: 'Rejected by reviewer' },
    { reason: '', stored: '' },
    { reason: '  Written reason  ', stored: '  Written reason  ' },
  ])('retains candidate reason $reason with nullish fallback only', async ({ reason, stored }) => {
    const h = harness();
    await h.service.rejectMappingCandidate(clientId, tenantId, rejectionInput({ reason }));
    expect(inputOf(h, 'upsert')).toMatchObject({
      update: { rejectionReason: stored, rollUpAwards: false },
      create: { rejectionReason: stored, rollUpAwards: false },
    });
  });
});

describe('Mapping candidate rejection failed writes', () => {
  test('checks the client before beginning a rejection transaction', async () => {
    const h = harness({ rows: { client: null } });
    await expect(
      h.service.rejectMappingCandidate(clientId, tenantId, rejectionInput()),
    ).rejects.toThrow(new NotFoundException('Client not found'));
    expect(h.callsOf('existing')).toEqual([]);
    expect(h.callsOf('upsert')).toEqual([]);
  });
  test.each(['client', 'existing', 'upsert', 'audit'])(
    'propagates %s failure and rolls back its scope',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ errors: { [operation]: error } });
      await expect(
        h.service.rejectMappingCandidate(clientId, tenantId, rejectionInput()),
      ).rejects.toBe(error);
      expect(h.transactions.at(-1)!.outcome).toBe('rollback');
      expect(h.callsOf('prepopulate')).toEqual([]);
    },
  );
});
