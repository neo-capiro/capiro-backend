import { BadRequestException } from '@nestjs/common';
import {
  clientId,
  harness,
  inputOf,
  installHooks,
  manualInput,
  tenantId,
} from '../../test/fixtures/intelligence-mapping.js';

installHooks();

describe('Manual PAC mapping catalog authority', () => {
  test('normalizes the committee ID and uses catalog name without mutating the caller input', async () => {
    const request = manualInput({
      source: 'fec_committee',
      externalId: ' c12345678 ',
      externalName: 'Caller Alias',
    });
    const h = harness({ rows: { committee: { name: ' Official PAC ', committeeType: 'Q' } } });
    await h.service.createManualMapping(clientId, tenantId, request);
    expect(h.callsOf('committee')[0]).toEqual({
      operation: 'committee',
      scope: 'global',
      args: [{ where: { id: 'C12345678' }, select: { name: true, committeeType: true } }],
    });
    expect(inputOf(h, 'upsert')).toMatchObject({
      where: { clientId_source_externalId: { source: 'fec_committee', externalId: 'C12345678' } },
      update: { externalName: ' Official PAC ' },
      create: { externalName: ' Official PAC ' },
    });
    expect(request.externalId).toBe(' c12345678 ');
    expect(request.externalName).toBe('Caller Alias');
    expect(h.events.indexOf('tenant:commit')).toBeLessThan(h.events.indexOf('committee'));
    expect(h.events.indexOf('committee')).toBeLessThan(h.events.indexOf('upsert'));
    expect(h.callsOf('prepopulate')).toEqual([]);
  });
  test.each(['Q', 'N', 'O', 'V', 'W'])(
    'accepts imported PAC catalog type %s',
    async (committeeType) => {
      const h = harness({ rows: { committee: { name: 'Research PAC', committeeType } } });
      await h.service.createManualMapping(
        clientId,
        tenantId,
        manualInput({ source: 'fec_committee', externalId: 'C12345678' }),
      );
      expect(h.callsOf('upsert')).toHaveLength(1);
    },
  );
  test.each(['C123', 'A12345678', 'C1234567X'])(
    'rejects malformed PAC ID %s before catalog lookup',
    async (externalId) => {
      const h = harness();
      await expect(
        h.service.createManualMapping(
          clientId,
          tenantId,
          manualInput({ source: 'fec_committee', externalId }),
        ),
      ).rejects.toThrow(new BadRequestException('Select a valid FEC PAC committee ID.'));
      expect(h.callsOf('committee')).toEqual([]);
      expect(h.transactions).toHaveLength(1);
    },
  );
});

describe('Manual PAC mapping catalog refusal', () => {
  test.each([
    null,
    { name: 'Candidate', committeeType: 'H' },
    { name: 'Missing type', committeeType: null },
    { name: 'Lowercase type', committeeType: 'q' },
  ])('refuses a missing or non-PAC catalog result %p', async (committee) => {
    const h = harness({ rows: { committee } });
    await expect(
      h.service.createManualMapping(
        clientId,
        tenantId,
        manualInput({ source: 'fec_committee', externalId: 'C12345678' }),
      ),
    ).rejects.toThrow(
      new BadRequestException('Select a PAC from the imported FEC committee catalog.'),
    );
    expect(h.callsOf('upsert')).toEqual([]);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit']);
  });
  test('propagates catalog failure after the tenant guard has committed', async () => {
    const error = new Error('FEC catalog failed');
    const h = harness({ errors: { committee: error } });
    await expect(
      h.service.createManualMapping(
        clientId,
        tenantId,
        manualInput({ source: 'fec_committee', externalId: 'C12345678' }),
      ),
    ).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.outcome)).toEqual(['commit']);
    expect(h.callsOf('audit')).toEqual([]);
  });
});
