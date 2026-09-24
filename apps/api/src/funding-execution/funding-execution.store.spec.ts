import { Prisma } from '@prisma/client';
import { FundingExecutionStore, type FundingSourceEventInput } from './funding-execution.store.js';

const HASH = 'a'.repeat(64);

function event(overrides: Partial<FundingSourceEventInput> = {}): FundingSourceEventInput {
  return {
    sourceEventKey: 'event-1', sourceSystem: 'dfas', sourceRecordId: 'native-1',
    sourceDocumentId: 'doc-1', measureId: 'measure-1', eventType: 'obligation_observed', amountBasis: 'transaction_delta',
    executionMetric: 'obligations', asOfDate: '2026-09-24', signedObligationDelta: '-2.00',
    sourceAmountUsd: null,
    raw: { quote: 'Correction of obligation' }, ...overrides,
  };
}

function allocation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alloc-1', provisionId: 'prov-1', targetType: 'appropriation_account', targetNativeKey: '97X1234', targetId: null,
    allocationStage: 'obligated', mappingMaturity: 'account_level', reviewState: 'verified',
    authoritativeAmountUsd: new Prisma.Decimal('-2.00'), inferredRelevance: false, confidence: null,
    baseRequestStatus: 'not_included', potentialDoubleCount: false, fundingPosture: 'one_time',
    evidenceSourceDocumentId: 'doc-1', evidencePage: 2, evidenceSha256: HASH, obligationReference: 'ob-1',
    executionReference: 'exec-1', sourceEventId: 'source-event-1', amountBasis: 'transaction_delta',
    asOfDate: new Date('2026-09-24T00:00:00Z'), periodStart: null, periodEnd: null, executionMetric: 'obligations',
    correctionOfAllocationId: null, transferPairKey: null, transferSide: null, dedupKey: 'd'.repeat(64),
    sourceEvent: { id: 'source-event-1', measureId: 'measure-1', sourceSystem: 'dfas', sourceRecordId: 'native-1', sourceEventKey: 'event-1', sourceUrl: null, sourceVersion: null, sourceObservedAt: null, contentSha256: HASH, amountBasis: 'transaction_delta', executionMetric: 'obligations', asOfDate: new Date('2026-09-24T00:00:00Z'), periodStart: null, periodEnd: null, sourceAmountUsd: null, signedObligationDelta: new Prisma.Decimal('-2.00'), signedOutlayDelta: null, correctionOfEventId: null, transferPairKey: null, transferSide: null, raw: {}, recordedAt: new Date('2026-09-24T01:00:00Z') },
    provision: {
      tas: '97X1234', availabilityStart: new Date('2025-10-01T00:00:00Z'), availabilityEnd: null,
      measure: { id: 'measure-1', status: 'introduced', fiscalYear: 2026, availabilityStart: null, availabilityEnd: new Date('2027-09-30T00:00:00Z') },
    },
    ...overrides,
  };
}

function harness(txOverrides: Record<string, any> = {}) {
  const tx = {
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
    federalFundingMeasure: { findUnique: jest.fn(async () => ({ id: 'measure-1', status: 'introduced', fiscalYear: 2026 })) },
    federalFundingSourceEvent: {
      findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'source-event-1', recordedAt: new Date('2026-09-24T01:00:00Z'), ...data })),
    },
    federalFundingAllocation: {
      findFirst: jest.fn(async () => ({ id: 'alloc-9' })),
      findMany: jest.fn(async () => [allocation()]),
      findUnique: jest.fn(async () => allocation({ provision: { tas: '97X1234', measure: { id: 'measure-1', status: 'enacted', fiscalYear: 2026 } } })),
    },
    federalFundingCertification: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: 'cert-1', ...data })),
    },
    federalFundingPublication: { create: jest.fn(async ({ data }: any) => ({ id: 'pub-1', ...data })) },
    federalFundingReconciliationResidual: { create: jest.fn(async ({ data }: any) => ({ id: 'res-1', ...data })) },
    ...txOverrides,
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    federalFundingPublicationCheckpoint: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
    ...tx,
  };
  return { store: new FundingExecutionStore(prisma as never), prisma, tx };
}

describe('FundingExecutionStore', () => {
  test('source event append is idempotent on canonical event content', async () => {
    const { store, tx } = harness();
    (tx.federalFundingSourceEvent.findUnique as jest.Mock).mockResolvedValue({ id: 'existing-event', recordedAt: new Date('2026-09-23T00:00:00Z') });
    const first = await store.appendSourceEvent(event());
    const second = await store.appendSourceEvent(event());
    expect(first).toEqual({ id: 'existing-event', inserted: false });
    expect(second).toEqual(first);
    expect(tx.federalFundingSourceEvent.create).not.toHaveBeenCalled();
  });

  test('appends balanced transfer source-event legs together in one transaction', async () => {
    const { store, tx, prisma } = harness();
    const legs = [
      event({ sourceEventKey: 'transfer-out', sourceRecordId: 'out', eventType: 'transfer_leg', transferPairKey: 'pair-1', transferSide: 'out', signedObligationDelta: '-5.00', signedOutlayDelta: null }),
      event({ sourceEventKey: 'transfer-in', sourceRecordId: 'in', eventType: 'transfer_leg', transferPairKey: 'pair-1', transferSide: 'in', signedObligationDelta: '5.00', signedOutlayDelta: null }),
    ];
    const result = await store.appendSourceEvents(legs);
    expect(result).toHaveLength(2);
    expect(tx.federalFundingSourceEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await expect(store.appendSourceEvent(legs[0]!)).rejects.toThrow(/equal signed out\/in legs/);
  });

  test('keeps budget-authority rescissions and transfer legs metricless', async () => {
    const { store, tx, prisma } = harness();
    const authorityLegs = [
      event({ sourceEventKey: 'authority-out', sourceRecordId: 'out', eventType: 'alternative_funding_transfer', executionMetric: null, signedObligationDelta: null, signedOutlayDelta: null, sourceAmountUsd: '-7.00', transferPairKey: 'authority-pair', transferSide: 'out' }),
      event({ sourceEventKey: 'authority-in', sourceRecordId: 'in', eventType: 'alternative_funding_transfer', executionMetric: null, signedObligationDelta: null, signedOutlayDelta: null, sourceAmountUsd: '7.00', transferPairKey: 'authority-pair', transferSide: 'in' }),
    ];
    await store.appendSourceEvents(authorityLegs);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.federalFundingSourceEvent.create).toHaveBeenCalledTimes(2);

    const rescission = allocation({
      authoritativeAmountUsd: new Prisma.Decimal('-7.00'),
      amountBasis: 'transaction_delta', executionMetric: null,
      sourceEvent: { ...allocation().sourceEvent, executionMetric: null, sourceAmountUsd: new Prisma.Decimal('-7.00'), signedObligationDelta: null, signedOutlayDelta: null },
    });
    tx.federalFundingAllocation.findMany.mockResolvedValue([rescission] as never);
    const result = await store.certifyAndPublish({
      certificationKey: 'authority-rescission', revision: 1, measureId: 'measure-1', sourceEvents: [
        event({ sourceEventKey: 'rescission', eventType: 'alternative_funding_rescission', executionMetric: null, signedObligationDelta: null, signedOutlayDelta: null, sourceAmountUsd: '-7.00' }),
      ], allocationIds: ['alloc-1'], scope: {}, residuals: [],
    });
    expect(result).toMatchObject({ inserted: true, allocationCount: 1 });
    expect(tx.federalFundingPublication.create).toHaveBeenCalledTimes(1);
  });

  test('rejects metricless authority deltas without an explicit signed source amount', async () => {
    const { store } = harness();
    await expect(store.appendSourceEvent(event({ executionMetric: null, signedObligationDelta: null, sourceAmountUsd: null })))
      .rejects.toThrow(/metricless authority deltas require sourceAmountUsd/);
  });

  test('rejects a non-negative rescission at the store boundary', async () => {
    const { store } = harness();
    await expect(store.appendSourceEvent(event({
      eventType: 'alternative_funding_rescission', amountBasis: 'transaction_delta', executionMetric: null,
      signedObligationDelta: null, sourceAmountUsd: '1.00',
    }))).rejects.toThrow(/rescission.*negative/i);
  });

  test('certifies proposed authority without relabeling it and persists residual separately', async () => {
    const { store, tx } = harness();
    const result = await store.certifyAndPublish({
      certificationKey: 'cycle-2026', revision: 1, measureId: 'measure-1', sourceEvents: [event()], allocationIds: ['alloc-1'],
      scope: { fiscalYear: 2026, account: '97X1234' },
      residuals: [{ scopeKey: 'fy2026:97x1234', scope: { fiscalYear: 2026, account: '97X1234', subjectType: 'pe', subjectId: 'PE-1' }, basis: 'transaction_delta', residualAmountUsd: '-3.00', reason: 'unmatched source correction', coverageState: 'partial' }],
    });
    expect(result).toMatchObject({ inserted: true, allocationCount: 1, residualCount: 1 });
    expect(tx.federalFundingCertification.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ measureStatus: 'introduced' }) }));
    expect(tx.federalFundingPublication.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      allocationId: 'alloc-1',
      allocationSnapshot: expect.objectContaining({
        fiscalYear: 2026,
        availabilityStart: '2025-10-01',
        availabilityEnd: '2027-09-30',
      }),
    }) }));
    const residualData = tx.federalFundingReconciliationResidual.create.mock.calls[0]![0].data;
    expect(residualData.residualAmountUsd.toString()).toBe('-3');
    expect(residualData).not.toHaveProperty('allocationId');
    expect(residualData).not.toHaveProperty('targetId');
  });

  test('refuses candidate allocations and rolls back the certification transaction', async () => {
    const { store, tx, prisma } = harness({ federalFundingAllocation: { findMany: jest.fn(async () => [allocation({ reviewState: 'candidate' })]) } });
    await expect(store.certifyAndPublish({ certificationKey: 'bad', revision: 1, measureId: 'measure-1', sourceEvents: [], allocationIds: ['alloc-1'], scope: {}, residuals: [] })).rejects.toThrow(/must be verified/);
    expect(tx.federalFundingCertification.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  test('refuses an unbalanced transfer pair before certification', async () => {
    const out = allocation({ transferPairKey: 'transfer-1', transferSide: 'out', sourceEvent: { ...allocation().sourceEvent, transferPairKey: 'transfer-1', transferSide: 'out' } });
    const { store, tx } = harness({ federalFundingAllocation: { findMany: jest.fn(async () => [out]) } });
    await expect(store.certifyAndPublish({ certificationKey: 'unbalanced', revision: 1, measureId: 'measure-1', sourceEvents: [], allocationIds: ['alloc-1'], scope: {}, residuals: [] })).rejects.toThrow(/equal signed out\/in legs/);
    expect(tx.federalFundingCertification.create).not.toHaveBeenCalled();
  });

  test('rejects event/allocation amount or measure mismatches before publication', async () => {
    const mismatched = allocation({ sourceEvent: { ...allocation().sourceEvent, signedObligationDelta: new Prisma.Decimal('-1.00') } });
    const { store, tx } = harness({ federalFundingAllocation: { findMany: jest.fn(async () => [mismatched]) } });
    await expect(store.certifyAndPublish({ certificationKey: 'mismatch', revision: 1, measureId: 'measure-1', sourceEvents: [], allocationIds: ['alloc-1'], scope: {}, residuals: [] })).rejects.toThrow(/does not match its immutable source-event amount/);
    expect(tx.federalFundingCertification.create).not.toHaveBeenCalled();

    const wrongMeasure = allocation({ sourceEvent: { ...allocation().sourceEvent, measureId: 'measure-other' } });
    tx.federalFundingAllocation.findMany.mockResolvedValue([wrongMeasure] as never);
    await expect(store.certifyAndPublish({ certificationKey: 'wrong-measure', revision: 1, measureId: 'measure-1', sourceEvents: [], allocationIds: ['alloc-1'], scope: {}, residuals: [] })).rejects.toThrow(/source event belongs to a different measure/);
  });

  test('certifies signed negative obligation correction and balanced allocation transfer legs', async () => {
    const out = allocation({ id: 'out-alloc', authoritativeAmountUsd: new Prisma.Decimal('-10.00'), transferPairKey: 'alloc-pair', transferSide: 'out', sourceEvent: { ...allocation().sourceEvent, transferPairKey: 'alloc-pair', transferSide: 'out', signedObligationDelta: new Prisma.Decimal('-10.00') } });
    const incoming = allocation({ id: 'in-alloc', authoritativeAmountUsd: new Prisma.Decimal('10.00'), transferPairKey: 'alloc-pair', transferSide: 'in', sourceEvent: { ...allocation().sourceEvent, transferPairKey: 'alloc-pair', transferSide: 'in', signedObligationDelta: new Prisma.Decimal('10.00') } });
    const { store, tx } = harness({ federalFundingAllocation: { findMany: jest.fn(async () => [out, incoming]) } });
    const result = await store.certifyAndPublish({ certificationKey: 'signed-pair', revision: 1, measureId: 'measure-1', sourceEvents: [
      event({ sourceEventKey: 'pair-out', sourceRecordId: 'transfer-out', eventType: 'transfer_leg', transferPairKey: 'source-pair', transferSide: 'out', signedObligationDelta: '-10.00', signedOutlayDelta: null }),
      event({ sourceEventKey: 'pair-in', sourceRecordId: 'transfer-in', eventType: 'transfer_leg', transferPairKey: 'source-pair', transferSide: 'in', signedObligationDelta: '10.00', signedOutlayDelta: null }),
    ], allocationIds: ['out-alloc', 'in-alloc'], scope: {}, residuals: [] });
    expect(result).toMatchObject({ inserted: true, allocationCount: 2 });
    expect(tx.federalFundingPublication.create).toHaveBeenCalledTimes(2);
  });

  test('worker publication is enacted-only and idempotent; checkpoint survives independently', async () => {
    const { store, tx, prisma } = harness();
    const publication = { factId: 'alloc-1', authorityState: 'enacted' as const, accountId: '97X1234', amountUsd: '-2.00', certification: 'certified' as const, verification: 'verified' as const, exactAccountLevel: true as const, sourceNativeIds: ['native-1'] };
    await expect(store.publishCertified([publication])).rejects.toThrow(/does not match/);
    tx.federalFundingAllocation.findUnique.mockResolvedValue(allocation({
      targetType: 'appropriation_account', mappingMaturity: 'account_level', targetNativeKey: '97X1234',
      authoritativeAmountUsd: new Prisma.Decimal('2.00'),
      executionMetric: 'obligations', amountBasis: 'transaction_delta', asOfDate: new Date('2026-09-24T00:00:00Z'),
      sourceEvent: { ...allocation().sourceEvent, signedObligationDelta: new Prisma.Decimal('2.00') },
      provision: { tas: '97X1234', measure: { id: 'measure-1', status: 'enacted', fiscalYear: 2026 } },
    }));
    const valid = { ...publication, amountUsd: '2.00' };
    const result = await store.publishCertified([valid]);
    expect(result.published).toBe(1);
    expect(tx.federalFundingPublication.create).toHaveBeenCalledTimes(1);
    await store.saveCheckpoint({ version: 1, cursor: 'alloc-1', throughId: 'alloc-9', complete: false });
    expect(prisma.federalFundingPublicationCheckpoint.upsert).toHaveBeenCalled();
  });

  test('one eligible bounded worker row is publishable and retry is idempotent', async () => {
    const eligible = allocation({
      authoritativeAmountUsd: new Prisma.Decimal('2.00'), amountBasis: 'transaction_delta', asOfDate: new Date('2026-09-24T00:00:00Z'),
      allocationStage: 'service_budget_exhibit', obligationReference: null,
      sourceEvent: { ...allocation().sourceEvent, signedObligationDelta: new Prisma.Decimal('2.00') },
      provision: { tas: '97X1234', measure: { id: 'measure-1', status: 'enacted', fiscalYear: 2026 } },
    });
    const { store, tx, prisma } = harness({ federalFundingAllocation: {
      findMany: jest.fn(async () => [eligible]), findUnique: jest.fn(async () => eligible),
    } });
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ watermark: '2026-09-24T01:00:00.000000Z|00000000-0000-4000-8000-000000000009' }])
      .mockResolvedValueOnce([{ id: eligible.id, watermark: '2026-09-24T00:30:00.000000Z|00000000-0000-4000-8000-000000000001' }]);
    const page = await store.readBoundedPage({ cursor: null, throughId: null, take: 2 });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ allocationCertification: 'certified', authorityState: 'enacted', exactAccountLevel: true, amountUsd: '2' });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(((tx.$executeRaw as jest.Mock).mock.calls[0]![0] as Prisma.Sql).strings.join(' ')).toContain('LOCK TABLE federal_funding_allocation IN SHARE MODE');
    const publication = { factId: eligible.id, authorityState: 'enacted' as const, accountId: '97X1234', amountUsd: '2', certification: 'certified' as const, verification: 'verified' as const, exactAccountLevel: true as const, sourceNativeIds: ['native-1'] };
    expect(await store.publishCertified([publication])).toEqual({ published: 1 });
    const certHash = (tx.federalFundingCertification.create as jest.Mock).mock.calls[0]![0].data.contentSha256;
    (tx.federalFundingCertification.findUnique as jest.Mock).mockResolvedValue({ id: 'worker-cert', contentSha256: certHash });
    expect(await store.publishCertified([publication])).toEqual({ published: 0 });
    expect(tx.federalFundingPublication.create).toHaveBeenCalledTimes(1);
  });

  test('createdAt+UUID watermarks defer behind-cursor UUID inserts to the next complete cycle', async () => {
    const { store, prisma, tx } = harness();
    const firstHigh = '2026-09-24T01:00:00.000000Z|ffffffff-ffff-4fff-8fff-ffffffffffff';
    const pageOneCursor = '2026-09-24T00:30:00.000000Z|00000000-0000-4000-8000-000000000100';
    const insertedBehindUuid = '2026-09-24T01:30:00.000000Z|00000000-0000-4000-8000-000000000001';
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([{ watermark: firstHigh }])
      .mockResolvedValueOnce([
        { id: 'old-1', watermark: pageOneCursor },
        { id: 'old-2', watermark: '2026-09-24T00:45:00.000000Z|00000000-0000-4000-8000-000000000200' },
      ])
      .mockResolvedValueOnce([{ id: 'old-2', watermark: '2026-09-24T00:45:00.000000Z|00000000-0000-4000-8000-000000000200' }])
      .mockResolvedValueOnce([{ watermark: insertedBehindUuid }])
      .mockResolvedValueOnce([{ id: 'new-1', watermark: insertedBehindUuid }]);
    const makeRecord = (id: string) => allocation({
      id,
      sourceEvent: { ...allocation().sourceEvent, id: `event-${id}` },
      provision: { tas: '97X1234', measure: { id: 'measure-1', status: 'enacted', fiscalYear: 2026 } },
    });
    (tx.federalFundingAllocation.findMany as jest.Mock)
      .mockResolvedValueOnce([makeRecord('old-1')])
      .mockResolvedValueOnce([makeRecord('old-2')])
      .mockResolvedValueOnce([makeRecord('new-1')]);
    const page1 = await store.readBoundedPage({ cursor: null, throughId: null, take: 2 });
    expect(page1).toMatchObject({ throughId: firstHigh, hasMore: true, nextCursor: pageOneCursor });
    const page2 = await store.readBoundedPage({ cursor: page1.nextCursor, throughId: page1.throughId, take: 2 });
    expect(page2.rows.map((row) => row.factId)).toEqual(['old-2']);
    const nextCycle = await store.readBoundedPage({ cursor: firstHigh, throughId: null, take: 2 });
    expect(nextCycle.throughId).toBe(insertedBehindUuid);
    expect(nextCycle.rows.map((row) => row.factId)).toEqual(['new-1']);
    const secondPageSql = (prisma.$queryRaw as jest.Mock).mock.calls[4]![0] as Prisma.Sql;
    expect(secondPageSql.values).toContain('2026-09-24T01:00:00.000000Z');
    expect(secondPageSql.values).toContain('ffffffff-ffff-4fff-8fff-ffffffffffff');
  });

  test('reads both certified transfer legs when only the PE-A leg directly matches', async () => {
    const { store, prisma } = harness();
    (prisma.$queryRaw as jest.Mock)
      .mockResolvedValueOnce([
        { stable_key: 'transfer:pair-a:0:alloc-out', fact_id: 'alloc-out', snapshot: { transferPairKey: 'pair-a', transferSide: 'out', fiscalYear: 2026, availabilityStart: '2025-10-01', availabilityEnd: '2027-09-30', targetType: 'program_element', targetNativeKey: 'PE-A', reviewState: 'verified', amountBasis: 'transaction_delta', authoritativeAmountUsd: '-8.00', mappingMaturity: 'exact_identifier', inferredRelevance: false }, measure_status: 'enacted', certified_at: new Date('2026-09-24T00:00:00Z'), source_system: 'budget', source_record_id: 'native-out', source_url: null, source_version: null, source_observed_at: null, source_hash: HASH, source_raw: {}, account_id: '97X1234' },
        { stable_key: 'transfer:pair-a:1:alloc-in', fact_id: 'alloc-in', snapshot: { transferPairKey: 'pair-a', transferSide: 'in', fiscalYear: 2026, targetType: 'program_element', targetNativeKey: 'PE-B', reviewState: 'verified', amountBasis: 'transaction_delta', authoritativeAmountUsd: '8.00', mappingMaturity: 'exact_identifier', inferredRelevance: false }, measure_status: 'enacted', certified_at: new Date('2026-09-24T00:00:00Z'), source_system: 'budget', source_record_id: 'native-in', source_url: null, source_version: null, source_observed_at: null, source_hash: HASH, source_raw: {}, account_id: '97X1235' },
      ])
      .mockResolvedValueOnce([]);
    const page = await store.readPage({ subject: { type: 'pe', id: 'PE-A' }, asOfFy: 2026, knownAt: new Date('2026-09-25T00:00:00Z'), afterStableKey: null, take: 4 });
    expect(page.rows.map((row) => [row.factId, row.transferLeg])).toEqual([['alloc-out', 'outflow'], ['alloc-in', 'inflow']]);
    expect(page.rows[1]!.accountId).toBe('97X1235');
    expect(page.rows[0]).toMatchObject({
      availabilityStart: '2025-10-01', availabilityEnd: '2027-09-30', validFromFy: 2025, validToFy: 2027,
    });
    const publicationSql = (prisma.$queryRaw as jest.Mock).mock.calls[0]![0] as Prisma.Sql;
    expect(publicationSql.strings.join(' ')).toContain('p.published_at <=');
    expect(publicationSql.strings.join(' ')).toContain('tp.published_at <=');
    expect(publicationSql.strings.join(' ')).toContain('np.published_at <=');
    const residualSql = (prisma.$queryRaw as jest.Mock).mock.calls[1]![0] as Prisma.Sql;
    expect(residualSql.strings.join(' ')).toContain('c.measure_status');
    expect(residualSql.strings.join(' ')).not.toContain('m.status');
  });
});
