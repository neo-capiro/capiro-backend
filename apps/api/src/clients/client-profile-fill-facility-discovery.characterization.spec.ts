import {
  clientId,
  ctx,
  facility,
  harness,
  installHooks,
  now,
  runId,
} from '../../test/fixtures/client-profile-fill-profile-discovery.js';

installHooks();

describe('Facility discovery — tenant snapshot', () => {
  test('reads facilities then pending proposals in one scoped transaction and records an empty frontier', async () => {
    const h = harness();
    expect(await h.facilityResolution()).toBe(0);
    const read = h.callsOf('facilities')[0]!;
    const pending = h.callsOf('pending')[0]!;
    expect(read.transaction).toBe(pending.transaction);
    expect(read.args).toEqual([
      {
        where: { tenantId: ctx.tenantId, clientId },
        select: {
          id: true,
          name: true,
          addressLine: true,
          city: true,
          state: true,
          zip: true,
          geocodeStatus: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
        take: 100,
      },
    ]);
    expect(pending.args.slice(1)).toEqual([ctx.tenantId, clientId, runId]);
    expect(pending.args[0]).toContain(
      'tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid',
    );
    expect(pending.args[0]).toContain("kind = 'facility' AND status = 'pending'");
    expect(h.events).toEqual([
      '1:begin',
      '1:facilities',
      '1:pending',
      '1:commit',
      '2:begin',
      '2:cursor',
      '2:commit',
    ]);
    expect(h.cursors()[0]).toEqual({
      tenantId: ctx.tenantId,
      clientId,
      source: 'facility_resolution',
      watermark: { latestFacilityUpdatedAt: null, facilityCount: 0 },
    });
  });
});

describe('Facility discovery — missing-address findings', () => {
  test.each([
    [{ addressLine: ' ' }, ['street address']],
    [{ city: null }, ['city']],
    [{ state: 42 }, ['state']],
    [{ addressLine: null, city: '', state: null }, ['street address', 'city', 'state']],
  ])('reports missing address parts in their defined order (%p)', async (changes, missing) => {
    const row = facility(changes as Record<string, unknown>);
    const h = harness({ facilities: [row] });
    expect(await h.facilityResolution()).toBe(1);
    expect(h.findings()[0]).toMatchObject({
      kind: 'facility_resolution',
      targetKey: 'facility-resolution:facility-one',
      source: 'facility_resolution',
      factKind: 'fact',
      currentValue: {
        id: row.id,
        name: row.name,
        addressLine: row.addressLine,
        city: row.city,
        state: row.state,
        zip: row.zip,
        geocodeStatus: row.geocodeStatus,
        updatedAt: row.updatedAt.toISOString(),
      },
      proposedValue: {
        facilityId: row.id,
        facilityName: row.name,
        status: 'insufficient_address',
        missing,
      },
      confidence: 1,
      status: 'informational',
      evidence: [
        {
          label: `Cannot resolve Headquarters until ${(missing as string[]).join(', ')} is supplied`,
          source: 'Client facility record',
        },
      ],
    });
  });

  test('complete addresses skip findings while the frontier includes every facility, not proposals', async () => {
    const latest = new Date('2026-10-13T10:00:00.000Z');
    const h = harness({
      facilities: [
        facility({ id: 'missing', state: null }),
        facility({ id: 'complete', updatedAt: latest }),
      ],
      proposals: [
        { name: 'Complete proposal', addressLine: '1 Street', city: 'Town', state: 'TX' },
      ],
    });
    expect(await h.facilityResolution()).toBe(1);
    expect(h.findings()).toHaveLength(1);
    expect(h.cursors()[0]!.watermark).toEqual({
      latestFacilityUpdatedAt: latest.toISOString(),
      facilityCount: 2,
    });
    expect(h.facilities.resolveFacilityDistrict).not.toHaveBeenCalled();
  });
});

describe('Facility discovery — proposed facilities', () => {
  test('reordered proposal keys retain the stable target and trimmed name', async () => {
    const h = harness({
      proposals: [
        { name: ' New office ', city: 'Austin', state: 'TX' },
        { state: 'TX', city: 'Austin', name: ' New office ' },
      ],
      insertOutcomes: [1, 0],
    });
    expect(await h.facilityResolution()).toBe(1);
    expect(h.findings().map((finding) => finding.targetKey)).toEqual([
      'proposed-facility-resolution:444f4c127482fd195b77',
      'proposed-facility-resolution:444f4c127482fd195b77',
    ]);
    expect(h.findings()[0]).toMatchObject({
      currentValue: null,
      proposedValue: {
        facilityName: 'New office',
        status: 'insufficient_address',
        missing: ['street address'],
      },
      evidence: [
        {
          label: 'The proposed facility needs street address before District Nexus can resolve it',
          source: 'Fill with Meri public-web finding',
        },
      ],
    });
    expect(h.findings()[0]!.contentHash).toBe(h.findings()[1]!.contentHash);
  });

  test.each([null, [], 'invalid', {}].map((value) => [value]))(
    'malformed unnamed proposals use the default name and empty-object hash (%p)',
    async (proposal) => {
      const h = harness({ proposals: [proposal] });
      expect(await h.facilityResolution()).toBe(1);
      expect(h.findings()[0]).toMatchObject({
        targetKey: 'proposed-facility-resolution:44136fa355b3678a1146',
        proposedValue: {
          facilityName: 'Proposed facility',
          status: 'insufficient_address',
          missing: ['street address', 'city', 'state'],
        },
      });
      expect(h.cursors()[0]!.watermark.facilityCount).toBe(0);
    },
  );
});

describe('Facility discovery — write order and failures', () => {
  test('canonical facilities precede proposals and counts include only inserted findings', async () => {
    const h = harness({
      facilities: [facility({ id: 'first', city: null }), facility({ id: 'second', state: null })],
      proposals: [{ city: 'Austin', state: 'TX' }],
      insertOutcomes: [0, 1, 1],
    });
    expect(await h.facilityResolution()).toBe(2);
    expect(h.findings().map((finding) => finding.targetKey)).toEqual([
      'facility-resolution:first',
      'facility-resolution:second',
      expect.stringMatching(/^proposed-facility-resolution:/),
    ]);
    expect(h.events.at(-3)).toBe('5:begin');
    expect(h.events.at(-2)).toBe('5:cursor');
    expect(h.events.at(-1)).toBe('5:commit');
  });

  test('a facility read rejection prevents pending reads and effects', async () => {
    const error = new Error('facility read failed');
    const h = harness({ facilityReadError: error });
    await expect(h.facilityResolution()).rejects.toBe(error);
    expect(h.events).toEqual(['1:begin', '1:facilities', '1:rollback']);
    expect(h.callsOf('pending')).toEqual([]);
    expect(h.committed).toEqual([]);
  });

  test('a pending-proposal read rejection rolls back the shared snapshot with no effects', async () => {
    const error = new Error('pending read failed');
    const h = harness({ facilities: [facility({ state: null })], pendingReadError: error });
    await expect(h.facilityResolution()).rejects.toBe(error);
    expect(h.events).toEqual(['1:begin', '1:facilities', '1:pending', '1:rollback']);
    expect(h.findings()).toEqual([]);
    expect(h.cursors()).toEqual([]);
  });

  test('a later finding rejection preserves the earlier commit and prevents frontier advancement', async () => {
    const error = new Error('second finding failed');
    const h = harness({
      facilities: [facility({ id: 'first', state: null }), facility({ id: 'second', city: null })],
      insertOutcomes: [1, error],
    });
    await expect(h.facilityResolution()).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.committed.filter((call) => call.operation === 'finding')).toHaveLength(1);
    expect(h.cursors()).toEqual([]);
  });

  test('a cursor rejection follows committed findings and propagates', async () => {
    const error = new Error('cursor failed');
    const h = harness({ facilities: [facility({ state: null })], cursorError: error });
    await expect(h.facilityResolution()).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.committed.map((call) => call.operation)).toEqual(['retire', 'finding']);
  });
});
