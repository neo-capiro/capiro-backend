import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AWARD_BEARING_MAPPING_SOURCES } from './intelligence.service.js';
import {
  actorUserId,
  clientId,
  confirmationInput,
  harness,
  inputOf,
  installHooks,
  mappingId,
  mappingRow,
  now,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Mapping confirmation membership and persisted decision', () => {
  test('keeps exact update/audit payloads and saved reference with an owned-client check in the same scope', async () => {
    const before = mappingRow({ source: 'fec_committee', rejectionReason: 'Old decision' });
    const saved = mappingRow({ source: 'fec_committee', confirmed: true });
    const h = harness({ rows: { existing: before, update: saved } });
    expect(await h.service.confirmMapping(mappingId, confirmationInput(), tenantId)).toBe(saved);
    expect(inputOf(h, 'update')).toEqual({
      where: { id: mappingId },
      data: {
        confirmed: true,
        reviewStatus: 'confirmed',
        reviewedBy: actorUserId,
        reviewedAt: now,
        rejectionReason: null,
      },
    });
    expect(inputOf(h, 'audit')).toEqual({
      data: {
        tenantId,
        actorUserId,
        action: 'intelligence_mapping.confirmed',
        entityType: 'client_intel_mapping',
        entityId: mappingId,
        before,
        after: saved,
      },
    });
    const audit = inputOf(h, 'audit').data as Record<string, unknown>;
    expect(audit.before).toBe(before);
    expect(audit.after).toBe(saved);
    expect(h.callsOf('client')[0]).toMatchObject({
      tenantId,
      transaction: 1,
      args: [{ where: { id: clientId }, select: { id: true } }],
    });
    expect(h.events).toEqual([
      'withTenant',
      'tenant:begin',
      'existing',
      'client',
      'update',
      'audit',
      'tenant:commit',
    ]);
    expect(h.callsOf('committee')).toEqual([]);
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
  test('refuses a missing mapping before any client or update read', async () => {
    const h = harness();
    await expect(
      h.service.confirmMapping(mappingId, confirmationInput(), tenantId),
    ).rejects.toThrow(new NotFoundException('Mapping not found'));
    expect(h.callsOf('client')).toEqual([]);
    expect(h.callsOf('update')).toEqual([]);
  });
  test('refuses a mapping whose owning client is absent from the tenant', async () => {
    const foreign = 'foreign-client';
    const h = harness({ rows: { existing: mappingRow({ clientId: foreign }), client: null } });
    await expect(
      h.service.confirmMapping(mappingId, confirmationInput(), tenantId),
    ).rejects.toThrow(new NotFoundException('Mapping not found'));
    expect(inputOf(h, 'client')).toEqual({ where: { id: foreign }, select: { id: true } });
    expect(h.callsOf('update')).toEqual([]);
  });
});

describe('Mapping award confirmation explicit request', () => {
  test.each(['contracting', 'assistance_recipient'])(
    'does not inherit previous relationship/roll-up values for %s',
    async (source) => {
      const h = harness({
        rows: { existing: mappingRow({ source, relationshipType: 'self', rollUpAwards: true }) },
      });
      await expect(
        h.service.confirmMapping(mappingId, confirmationInput(), tenantId),
      ).rejects.toThrow(
        new BadRequestException(
          'Confirming an award-bearing identity requires an explicit relationship type and an explicit award roll-up decision on this request. Whose money this is cannot be inherited from a previous decision.',
        ),
      );
      expect(h.callsOf('update')).toEqual([]);
      expect(h.transactions[0]!.outcome).toBe('rollback');
    },
  );
  test.each([
    { relationshipType: null, rollUpAwards: false },
    { relationshipType: '', rollUpAwards: null },
  ])('refuses nullish award request fields %p', async (fields) => {
    const h = harness({ rows: { existing: mappingRow({ source: 'contracting' }) } });
    await expect(
      h.service.confirmMapping(mappingId, confirmationInput(fields), tenantId),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
  test('keeps explicit empty relationship/false roll-up and consults the canonical Root Set', async () => {
    const membership = jest.spyOn(AWARD_BEARING_MAPPING_SOURCES, 'has');
    const h = harness({
      rows: {
        existing: mappingRow({ source: 'contracting' }),
        update: mappingRow({ source: 'contracting' }),
      },
    });
    await h.service.confirmMapping(
      mappingId,
      confirmationInput({ relationshipType: '', rollUpAwards: false }),
      tenantId,
    );
    expect(membership).toHaveBeenCalledWith('contracting');
    expect(inputOf(h, 'update')).toMatchObject({
      data: { relationshipType: '', rollUpAwards: false },
    });
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
});

describe('Mapping award rejection review requirements', () => {
  test.each([undefined, '', ' \n '])(
    'requires a written award rejection reason %p',
    async (rejectionReason) => {
      const h = harness({ rows: { existing: mappingRow({ source: 'assistance_recipient' }) } });
      await expect(
        h.service.confirmMapping(
          mappingId,
          confirmationInput({ confirmed: false, rejectionReason }),
          tenantId,
        ),
      ).rejects.toThrow(
        new BadRequestException(
          'Rejecting an award-bearing identity requires a written reason, so the decision is reviewable later.',
        ),
      );
      expect(h.callsOf('audit')).toEqual([]);
    },
  );
  test('validates trimmed reason but saves raw text and does not force omitted roll-up false', async () => {
    const h = harness({
      rows: {
        existing: mappingRow({ source: 'contracting', rollUpAwards: true }),
        update: mappingRow({ source: 'contracting', confirmed: false }),
      },
    });
    await h.service.confirmMapping(
      mappingId,
      confirmationInput({ confirmed: false, rejectionReason: '  Separate entity  ' }),
      tenantId,
    );
    expect(inputOf(h, 'update')).toEqual({
      where: { id: mappingId },
      data: {
        confirmed: false,
        reviewStatus: 'rejected',
        reviewedBy: actorUserId,
        reviewedAt: now,
        rejectionReason: '  Separate entity  ',
      },
    });
    expect(inputOf(h, 'audit')).toMatchObject({
      data: { action: 'intelligence_mapping.rejected' },
    });
  });
});

describe('Mapping non-award review nullish values', () => {
  test.each(['candidate', 'confirmed', 'rejected', 'superseded'])(
    'permits an owned %s mapping to receive a new reviewed decision',
    async (reviewStatus) => {
      const h = harness({
        rows: {
          existing: mappingRow({ source: 'custom', reviewStatus }),
          update: mappingRow({ source: 'custom' }),
        },
      });
      await h.service.confirmMapping(mappingId, confirmationInput(), tenantId);
      expect(inputOf(h, 'update')).toMatchObject({
        data: { confirmed: true, reviewStatus: 'confirmed' },
      });
    },
  );
  test.each([
    { reason: undefined, stored: 'Rejected by reviewer' },
    { reason: null, stored: 'Rejected by reviewer' },
    { reason: '', stored: '' },
  ])('uses only nullish rejection fallback for $reason', async ({ reason, stored }) => {
    const h = harness({
      rows: {
        existing: mappingRow({ source: 'custom' }),
        update: mappingRow({ source: 'custom' }),
      },
    });
    await h.service.confirmMapping(
      mappingId,
      confirmationInput({ confirmed: false, rejectionReason: reason }),
      tenantId,
    );
    expect(inputOf(h, 'update')).toMatchObject({ data: { rejectionReason: stored } });
  });
  test('includes explicit null optional fields on reference sources while omitting undefined fields', async () => {
    const h = harness({
      rows: {
        existing: mappingRow({ source: 'custom' }),
        update: mappingRow({ source: 'custom' }),
      },
    });
    await h.service.confirmMapping(
      mappingId,
      confirmationInput({ relationshipType: null, rollUpAwards: null }),
      tenantId,
    );
    expect(inputOf(h, 'update')).toMatchObject({
      data: { relationshipType: null, rollUpAwards: null },
    });
  });
});

describe('Mapping confirmation failed writes', () => {
  test.each(['existing', 'client', 'update', 'audit'])(
    'propagates %s failure before callback dispatch',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({ rows: { existing: mappingRow() }, errors: { [operation]: error } });
      await expect(h.service.confirmMapping(mappingId, confirmationInput(), tenantId)).rejects.toBe(
        error,
      );
      expect(h.transactions[0]!.outcome).toBe('rollback');
      expect(h.callsOf('prepopulate')).toEqual([]);
    },
  );
});
