import {
  clientId,
  ctx,
  facility,
  harness,
  installHooks,
  now,
  resolved,
  runId,
} from '../../test/fixtures/client-profile-fill-profile-discovery.js';

installHooks();

const oldDistricts = {
  congressionalDistrict: 'VA-07',
  stateHouseDistrict: 'VA-HD-48',
  stateSenateDistrict: 'VA-SD-30',
  geocodeStatus: 'manual_review',
};

describe('District discovery — canonical facility boundary', () => {
  test('uses a scoped addressed-facility page and calls the canonical resolver after read commit', async () => {
    const row = facility(oldDistricts);
    const result = resolved();
    const h = harness({ facilities: [row], resolverOutcomes: [result] });
    expect(await h.districts()).toBe(1);
    expect(h.callsOf('facilities')[0]!.args).toEqual([
      {
        where: {
          tenantId: ctx.tenantId,
          clientId,
          addressLine: { not: null },
          city: { not: null },
          state: { not: null },
        },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          congressionalDistrict: true,
          stateHouseDistrict: true,
          stateSenateDistrict: true,
          geocodeStatus: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 25,
      },
    ]);
    expect(h.facilities.resolveFacilityDistrict).toHaveBeenCalledWith(ctx, clientId, row.id);
    expect(h.callsOf('resolve')[0]!.transaction).toBeNull();
    expect(h.events).toEqual([
      '1:begin',
      '1:facilities',
      '1:commit',
      'outside:resolve',
      '2:begin',
      '2:terminal',
      '2:retire',
      '2:finding',
      '2:commit',
      '3:begin',
      '3:cursor',
      '3:commit',
    ]);
  });
});

describe('District discovery — informational payload', () => {
  test('keeps the original district values and exact authoritative evidence', async () => {
    const row = facility(oldDistricts);
    const result = resolved();
    const h = harness({ facilities: [row], resolverOutcomes: [result] });
    expect(await h.districts()).toBe(1);
    expect(h.findings()[0]).toEqual({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'district_nexus',
      targetKey: 'district-nexus:facility-one',
      source: 'district_nexus',
      factKind: 'fact',
      currentValue: oldDistricts,
      proposedValue: {
        facilityId: row.id,
        facilityName: row.name,
        congressionalDistrict: result.congressionalDistrict,
        stateHouseDistrict: result.stateHouseDistrict,
        stateSenateDistrict: result.stateSenateDistrict,
        geocodeStatus: result.geocodeStatus,
        matchedAddress: result.geocodeMatchedAddress,
        districtSource: result.districtSource,
      },
      confidence: 1,
      status: 'informational',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence: [
        {
          label: 'Resolved Headquarters through the Census-authoritative district pipeline',
          source: 'U.S. Census Geocoder / TIGER geography',
          metadata: { geocodeStatus: 'matched' },
        },
      ],
    });
    expect(h.cursors()).toEqual([
      {
        tenantId: ctx.tenantId,
        clientId,
        source: 'district_nexus',
        watermark: { resolvedAt: now.toISOString(), attemptedFacilities: 1 },
      },
    ]);
  });

  test.each(['no_match', 'manual_review', 'MATCHED', null])(
    'only exact matched status receives full confidence (%p)',
    async (geocodeStatus) => {
      const h = harness({
        facilities: [facility()],
        resolverOutcomes: [resolved({ geocodeStatus })],
      });
      expect(await h.districts()).toBe(1);
      expect(h.findings()[0]!.confidence).toBe(0.8);
      expect(h.findings()[0]!.proposedValue.geocodeStatus).toBe(geocodeStatus);
      expect(h.findings()[0]!.evidence[0].metadata).toEqual({ geocodeStatus });
      expect(h.callsOf('resolve')).toHaveLength(1);
    },
  );
});

describe('District discovery — coverage frontier', () => {
  test('empty eligible coverage still advances a zero-attempt cursor without a resolver', async () => {
    const h = harness();
    expect(await h.districts()).toBe(0);
    expect(h.callsOf('resolve')).toEqual([]);
    expect(h.findings()).toEqual([]);
    expect(h.cursors()[0]!.watermark).toEqual({
      resolvedAt: now.toISOString(),
      attemptedFacilities: 0,
    });
  });

  test('the source cap limits a 26-row input to 25 resolver attempts', async () => {
    const rows = Array.from({ length: 26 }, (_, index) => facility({ id: `facility-${index}` }));
    const h = harness({ facilities: rows });
    expect(await h.districts()).toBe(25);
    expect(h.facilities.resolveFacilityDistrict).toHaveBeenCalledTimes(25);
    expect(h.facilities.resolveFacilityDistrict).toHaveBeenLastCalledWith(
      ctx,
      clientId,
      'facility-24',
    );
    expect(h.cursors()[0]!.watermark.attemptedFacilities).toBe(25);
  });
});

describe('District discovery — resolver and finding errors share the original catch', () => {
  test('resolver rejection produces an exact no-match finding with redacted error evidence', async () => {
    const row = facility(oldDistricts);
    const error = new Error('authorization: secret api_key=private resolution failed');
    const h = harness({ facilities: [row], resolverOutcomes: [error] });
    expect(await h.districts()).toBe(1);
    expect(h.findings()[0]).toMatchObject({
      kind: 'facility_resolution',
      targetKey: 'district-resolution-failed:facility-one',
      source: 'district_nexus',
      factKind: 'fact',
      currentValue: {
        id: row.id,
        name: row.name,
        addressLine: row.addressLine,
        city: row.city,
        state: row.state,
        zip: row.zip,
        ...oldDistricts,
      },
      proposedValue: { facilityId: row.id, facilityName: row.name, status: 'no_match' },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: 'District resolution did not produce an authoritative match for Headquarters',
          source: 'Capiro facility geocoder',
          metadata: { error: 'authorization=[redacted] api_key=[redacted] resolution failed' },
        },
      ],
    });
    expect(h.cursors()[0]!.watermark.attemptedFacilities).toBe(1);
  });

  test('resolver evidence errors are bounded to the canonical 800-character limit', async () => {
    const h = harness({ facilities: [facility()], resolverOutcomes: [new Error('x'.repeat(900))] });
    expect(await h.districts()).toBe(1);
    expect(h.findings()[0]!.evidence[0].metadata.error).toBe('x'.repeat(800));
  });
});

describe('District discovery — write-failure fallback', () => {
  test('a success-finding insert rejection rolls back that write and emits a no-match fallback', async () => {
    const error = new Error('finding storage failed');
    const h = harness({ facilities: [facility()], insertOutcomes: [error, 1] });
    expect(await h.districts()).toBe(1);
    expect(h.callsOf('resolve')).toHaveLength(1);
    expect(h.findings().map((finding) => finding.kind)).toEqual([
      'district_nexus',
      'facility_resolution',
    ]);
    expect(h.findings()[1]!.evidence[0].metadata.error).toBe('finding storage failed');
    expect(h.transactions.map((tx) => tx.result)).toEqual([
      'commit',
      'rollback',
      'commit',
      'commit',
    ]);
    expect(h.committed.filter((call) => call.operation === 'finding')).toHaveLength(1);
    expect(h.cursors()).toHaveLength(1);
  });

  test.each([{ terminal: true }, { insertOutcomes: [0] }])(
    'an uninserted success returns zero without a failure fallback ($terminal)',
    async (options) => {
      const h = harness({ facilities: [facility()], ...options });
      expect(await h.districts()).toBe(0);
      expect(h.callsOf('resolve')).toHaveLength(1);
      expect(h.findings().every((finding) => finding.kind === 'district_nexus')).toBe(true);
      expect(h.callsOf('terminal')).toHaveLength(1);
      expect(h.cursors()[0]!.watermark.attemptedFacilities).toBe(1);
    },
  );
});

describe('District discovery — sequential attempts and failures', () => {
  test('a handled resolver error continues in source order and counts both inserted findings', async () => {
    const h = harness({
      facilities: [facility({ id: 'first' }), facility({ id: 'second' })],
      resolverOutcomes: [new Error('first unresolved'), resolved()],
    });
    expect(await h.districts()).toBe(2);
    expect(h.callsOf('resolve').map((call) => call.args[2])).toEqual(['first', 'second']);
    expect(h.findings().map((finding) => finding.targetKey)).toEqual([
      'district-resolution-failed:first',
      'district-nexus:second',
    ]);
    expect(h.cursors()[0]!.watermark.attemptedFacilities).toBe(2);
  });

  test('an uninserted fallback contributes zero while allowing later attempts', async () => {
    const h = harness({
      facilities: [facility({ id: 'first' }), facility({ id: 'second' })],
      resolverOutcomes: [new Error('unresolved'), resolved()],
      insertOutcomes: [0, 1],
    });
    expect(await h.districts()).toBe(1);
    expect(h.callsOf('resolve')).toHaveLength(2);
    expect(h.cursors()[0]!.watermark.attemptedFacilities).toBe(2);
  });

  test('a fallback insert rejection stops later facilities and prevents the cursor', async () => {
    const error = new Error('fallback storage failed');
    const h = harness({
      facilities: [facility({ id: 'first' }), facility({ id: 'second' })],
      resolverOutcomes: [new Error('unresolved')],
      insertOutcomes: [error],
    });
    await expect(h.districts()).rejects.toBe(error);
    expect(h.callsOf('resolve').map((call) => call.args[2])).toEqual(['first']);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'rollback']);
    expect(h.committed).toEqual([]);
    expect(h.cursors()).toEqual([]);
  });

  test('a source read rejection propagates before resolver or cursor effects', async () => {
    const error = new Error('read failed');
    const h = harness({ facilityReadError: error });
    await expect(h.districts()).rejects.toBe(error);
    expect(h.events).toEqual(['1:begin', '1:facilities', '1:rollback']);
    expect(h.callsOf('resolve')).toEqual([]);
    expect(h.cursors()).toEqual([]);
  });

  test('a cursor rejection occurs after a successful informational finding commits', async () => {
    const error = new Error('cursor failed');
    const h = harness({ facilities: [facility()], cursorError: error });
    await expect(h.districts()).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.committed.map((call) => call.operation)).toEqual(['retire', 'finding']);
  });
});
