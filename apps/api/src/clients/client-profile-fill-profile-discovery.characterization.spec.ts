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

const matched = { contracting: { matched: true } };

describe('Federal market discovery — matching gate', () => {
  test.each([undefined, null, false, 'true', 1])(
    'only boolean true matches (%p)',
    async (value) => {
      const h = harness({ profile: { contracting: { matched: value } } });
      expect(await h.federal()).toBe(0);
      expect(h.intelligence.getClientProfile).toHaveBeenCalledWith(clientId, ctx.tenantId);
      expect(h.events).toEqual(['outside:profile', '1:begin', '1:cursor', '1:commit']);
      expect(h.cursors()).toEqual([
        {
          tenantId: ctx.tenantId,
          clientId,
          source: 'federal_market',
          watermark: { refreshedAt: now.toISOString(), matched: false },
        },
      ]);
      expect(h.findings()).toEqual([]);
    },
  );

  test.each([null, [], 'profile', { contracting: [] }].map((value) => [value]))(
    'malformed profiles produce an unmatched cursor (%p)',
    async (profile) => {
      const h = harness({ profile });
      expect(await h.federal()).toBe(0);
      expect(h.cursors()[0]!.watermark.matched).toBe(false);
      expect(h.callsOf('client')).toEqual([]);
    },
  );
});

describe('Federal market discovery — scoped footprint write', () => {
  test('cursor commits before the scoped client read and exact pending footprint write', async () => {
    const currentValue = { contractorName: 'Previous', totalContracts: 3 };
    const contracting = {
      matched: true,
      contractorName: 'Example contractor',
      totalContracts: 7,
      rankByContracts: 8,
      noBidTotal: 9,
      topAgencies: [{ name: 'NASA' }],
      yearlySpend: [100],
    };
    const h = harness({
      profile: { contracting },
      client: { intakeData: { federalMarket: currentValue } },
    });
    expect(await h.federal()).toBe(1);
    expect(h.callsOf('client')[0]!.args).toEqual([
      {
        where: { id: clientId, tenantId: ctx.tenantId },
        select: { intakeData: true },
      },
    ]);
    expect(h.events).toEqual([
      'outside:profile',
      '1:begin',
      '1:cursor',
      '1:commit',
      '2:begin',
      '2:client',
      '2:commit',
      '3:begin',
      '3:terminal',
      '3:retire',
      '3:finding',
      '3:commit',
    ]);
    expect(h.transactions.map((tx) => tx.tenantId)).toEqual([
      ctx.tenantId,
      ctx.tenantId,
      ctx.tenantId,
    ]);
    expect(h.findings()[0]).toEqual({
      runId,
      tenantId: ctx.tenantId,
      clientId,
      kind: 'federal_footprint',
      targetKey: 'federalMarket',
      source: 'federal_market',
      factKind: 'fact',
      currentValue,
      proposedValue: {
        contractorName: contracting.contractorName,
        totalContracts: contracting.totalContracts,
        rankByContracts: contracting.rankByContracts,
        noBidTotal: contracting.noBidTotal,
        topAgencies: contracting.topAgencies,
        yearlySpend: contracting.yearlySpend,
        refreshedAt: now.toISOString(),
      },
      confidence: 0.95,
      status: 'pending',
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      evidence: [
        {
          label: 'Resolved federal contracting footprint',
          source: 'Capiro Federal Market / USAspending corpus',
          metadata: { contractorName: 'Example contractor', totalContracts: 7 },
        },
      ],
    });
  });
});

describe('Federal market discovery — defaults and clock', () => {
  test('nullish scalar defaults and non-array totals are projected without extra fields', async () => {
    const h = harness({
      profile: {
        contracting: { matched: true, topAgencies: {}, yearlySpend: 'invalid', extra: 'discard' },
      },
    });
    expect(await h.federal()).toBe(1);
    expect(h.findings()[0]!.proposedValue).toEqual({
      contractorName: null,
      totalContracts: null,
      rankByContracts: null,
      noBidTotal: null,
      topAgencies: [],
      yearlySpend: [],
      refreshedAt: now.toISOString(),
    });
    expect(h.findings()[0]!.currentValue).toBeNull();
  });

  test.each([false, 0, ''])(
    'preserves a non-nullish current footprint (%p)',
    async (federalMarket) => {
      const h = harness({ profile: matched, client: { intakeData: { federalMarket } } });
      expect(await h.federal()).toBe(1);
      expect(h.findings()[0]!.currentValue).toBe(federalMarket);
    },
  );

  test('missing client is tolerated after a matched provider response', async () => {
    const h = harness({ profile: matched, client: null });
    expect(await h.federal()).toBe(1);
    expect(h.findings()[0]!.currentValue).toBeNull();
  });

  test('cursor and proposal clocks are evaluated on their original sides of the client read', async () => {
    const later = new Date('2026-10-13T12:00:01.000Z');
    const h = harness({ profile: matched, afterCursor: () => jest.setSystemTime(later) });
    expect(await h.federal()).toBe(1);
    expect(h.cursors()[0]!.watermark.refreshedAt).toBe(now.toISOString());
    expect(h.findings()[0]!.proposedValue.refreshedAt).toBe(later.toISOString());
  });
});

describe('Federal market discovery — failure and duplicate boundaries', () => {
  test('provider rejection propagates without cursor or database access', async () => {
    const error = new Error('provider failed');
    const h = harness({ profileError: error });
    await expect(h.federal()).rejects.toBe(error);
    expect(h.events).toEqual(['outside:profile']);
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });

  test('cursor rejection prevents the client read and finding', async () => {
    const error = new Error('cursor failed');
    const h = harness({ profile: matched, cursorError: error });
    await expect(h.federal()).rejects.toBe(error);
    expect(h.events).toEqual(['outside:profile', '1:begin', '1:cursor', '1:rollback']);
    expect(h.committed).toEqual([]);
  });

  test('client rejection retains the earlier cursor commit and prevents a finding', async () => {
    const error = new Error('client read failed');
    const h = harness({ profile: matched, clientError: error });
    await expect(h.federal()).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'rollback']);
    expect(h.committed.map((call) => call.operation)).toEqual(['cursor']);
  });

  test.each([{ terminal: true }, { insertOutcomes: [0] }])(
    'existing findings return zero after the cursor ($terminal)',
    async (options) => {
      const h = harness({ profile: matched, ...options });
      expect(await h.federal()).toBe(0);
      expect(h.cursors()).toHaveLength(1);
      expect(h.callsOf('terminal')).toHaveLength(1);
    },
  );

  test('finding rejection retains the earlier cursor commit and propagates', async () => {
    const error = new Error('finding failed');
    const h = harness({ profile: matched, insertOutcomes: [error] });
    await expect(h.federal()).rejects.toBe(error);
    expect(h.transactions.map((tx) => tx.result)).toEqual(['commit', 'commit', 'rollback']);
    expect(h.committed.map((call) => call.operation)).toEqual(['cursor']);
  });
});
