import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import { IntelligenceService } from './intelligence.service.js';
import { withBillKeywordSqlDeadline } from './bill-keyword-deadline.js';
import {
  clientId,
  deferred,
  harness,
  hearing,
  installHooks,
  recommendation,
  tenantId,
  trackedBill,
} from '../../test/fixtures/intelligence-profile-v1.js';

installHooks();

it.each([12_000, 15_000])(
  'inherits the real profile bill deadline at %sms instead of refreshing it',
  async (elapsed) => {
    let clock = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => clock);
    const tx = {
      $executeRaw: jest.fn(async (..._args: unknown[]) => 1),
      $queryRaw: jest.fn(async (_sql: Prisma.Sql) => ({ total: 0, issueCodes: [], bills: [] })),
    };
    const prisma = {
      $transaction: jest.fn(
        async (work: (transaction: typeof tx) => Promise<unknown>, _options: unknown) => work(tx),
      ),
    };
    const h = harness({
      sourceResults: {
        getTrackedBills: async () => {
          await Promise.resolve();
          clock = elapsed;
          return withBillKeywordSqlDeadline(prisma as never, (query) =>
            query(Prisma.sql`SELECT 1`),
          );
        },
      },
    });
    const payload = await h.profile();
    expect(payload.sections.legislativeRegulatory.kanban.total).toBe(0);
    if (elapsed === 12_000) {
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0]![1]).toEqual({ maxWait: 1_000, timeout: 4_000 });
      expect(tx.$executeRaw.mock.calls[0]![1]).toBe('3000ms');
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(h.warnings).toEqual([]);
    } else {
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(h.warnings).toEqual([
        `profile-v1 source "trackedBills" failed for client ${clientId}: Bill keyword query budget exceeded`,
      ]);
    }
  },
);

it('times out an optional source without cancelling its work or changing the returned fallback later', async () => {
  const work = deferred<unknown>();
  const completed: string[] = [];
  const h = harness({
    sourceResults: {
      getExStaffers: async () => {
        const value = await work.promise;
        completed.push('source completed');
        return value;
      },
    },
  });
  const read = h.profile();
  await h.started('getClientRelevantRegulations');
  await jest.advanceTimersByTimeAsync(IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS);
  const payload = await read;
  expect(payload.sections.relationships.exStafferCount).toBe(0);
  expect(completed).toEqual([]);
  expect(h.warnings).toContain(
    `profile-v1 source "exStaffers" took 20000ms for client ${clientId}`,
  );
  expect(h.warnings).toContain(
    `profile-v1 source "exStaffers" failed for client ${clientId}: exceeded its 20000ms budget (still running)`,
  );
  work.resolve({ lobbyists: [{ name: 'Late lobbyist' }] });
  await h.sources.getExStaffers.mock.results[0]!.value;
  expect(completed).toEqual(['source completed']);
  expect(payload.sections.relationships.exStafferCount).toBe(0);
});

it('consumes late source rejection after the public response has already degraded', async () => {
  const work = deferred<unknown>();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const h = harness({ sourceResults: { getExStaffers: work.promise } });
    const read = h.profile();
    await h.started('getClientRelevantRegulations');
    await jest.advanceTimersByTimeAsync(IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS);
    expect((await read).sections.relationships.exStafferCount).toBe(0);
    work.reject(new Error('late failure'));
    await jest.advanceTimersByTimeAsync(1);
    expect(unhandled).toEqual([]);
    expect(h.warnings.filter((warning) => warning.includes('failed for client'))).toHaveLength(1);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

it.each([2_999, 3_000])(
  'retains successful source data and logs only at the %sms slow boundary',
  async (elapsed) => {
    const work = deferred<unknown>();
    const h = harness({ sourceResults: { getDistrictNexus: work.promise } });
    const read = h.profile();
    await h.started('getClientRelevantRegulations');
    await jest.advanceTimersByTimeAsync(elapsed);
    work.resolve({ capabilities: ['Systems integration'] });
    const payload = await read;
    expect(payload.sections.financialFootprint.districtNexus.capabilities).toEqual([
      'Systems integration',
    ]);
    expect(h.warnings).toEqual(
      elapsed === 3_000
        ? [`profile-v1 source "districtNexus" took 3000ms for client ${clientId}`]
        : [],
    );
  },
);

it('awaits committee join then recommendation then quarter ROI before returning their joined payload', async () => {
  const join = deferred<unknown>();
  const recommend = deferred<unknown>();
  const quarter = deferred<unknown>();
  const bill = trackedBill();
  const office = recommendation();
  const h = harness({
    sourceResults: {
      getTrackedBills: { total: 1, issueCodes: ['DEF'], bills: [bill] },
      buildRoiQuarterSeries: quarter.promise,
    },
    rows: { hearings: [hearing({ title: 'Committee oversight' })] },
    ioResults: { committeeJoin: join.promise, recommend: recommend.promise },
  });
  const read = h.profile();
  await h.started('committeeJoin');
  expect(h.recommender.recommend).not.toHaveBeenCalled();
  expect(h.sources.buildRoiQuarterSeries).not.toHaveBeenCalled();
  join.resolve([{ committee_name: 'Science', committee_code: 'HSCI' }]);
  await h.started('recommend');
  expect(h.sources.buildRoiQuarterSeries).not.toHaveBeenCalled();
  recommend.resolve([office]);
  await h.started('buildRoiQuarterSeries');
  const series = [{ label: 'Q3 2026', lobbying: 10, obligations: 20 }];
  quarter.resolve(series);
  const payload = await read;
  expect(h.events.indexOf('committeeJoin')).toBeLessThan(h.events.indexOf('recommend'));
  expect(h.events.indexOf('recommend')).toBeLessThan(h.events.indexOf('buildRoiQuarterSeries'));
  expect(h.recommender.recommend).toHaveBeenCalledWith({
    clientId,
    tenantId,
    trackedBillIds: [bill.identifier],
    trackedBills: [{ identifier: bill.identifier, subjectNames: bill.subjectNames }],
    issueCodes: ['DEF'],
  });
  expect(payload.sections.legislativeRegulatory.hearingsAndMarkups).toEqual([
    expect.objectContaining({ id: 'hearing-one' }),
  ]);
  expect(payload.sections.relationships.officeRecommender).toEqual([office]);
  expect(payload.sections.financialFootprint.series.quarterSeries).toEqual(series);
});

it('degrades committee join failure while retaining bill-title hearing linkage and later effects', async () => {
  const h = harness({
    committeeError: new Error('committee catalog unavailable'),
    sourceResults: { getTrackedBills: { total: 1, issueCodes: ['DEF'], bills: [trackedBill()] } },
    rows: { hearings: [hearing()] },
    recommendations: [recommendation()],
  });
  const payload = await h.profile();
  expect(payload.sections.legislativeRegulatory.hearingsAndMarkups).toEqual([
    expect.objectContaining({ id: 'hearing-one' }),
  ]);
  expect(payload.sections.relationships.officeRecommender).toHaveLength(1);
  expect(h.sources.buildRoiQuarterSeries).toHaveBeenCalledTimes(1);
  expect(h.warnings).toEqual([
    `hearings client-scoping committee join failed for client ${clientId}: committee catalog unavailable`,
  ]);
});

it('preserves fatal recommendation failure after the join and before quarter ROI', async () => {
  const error = new Error('recommendation failed');
  const h = harness({
    recommenderError: error,
    sourceResults: { getTrackedBills: { total: 1, issueCodes: [], bills: [trackedBill()] } },
  });
  await expect(h.profile()).rejects.toBe(error);
  expect(h.callsOf('committeeJoin')).toHaveLength(1);
  expect(h.recommender.recommend).toHaveBeenCalledTimes(1);
  expect(h.sources.buildRoiQuarterSeries).not.toHaveBeenCalled();
  expect(h.warnings).toEqual([]);
});

it('degrades quarter ROI rejection while preserving completed recommendation and sections', async () => {
  const h = harness({
    sourceResults: { buildRoiQuarterSeries: new Error('quarter aggregate failed') },
    recommendations: [recommendation()],
  });
  const payload = await h.profile();
  expect(payload.sections.relationships.officeRecommender).toHaveLength(1);
  expect(payload.sections.financialFootprint.series.quarterSeries).toEqual([]);
  expect(h.warnings).toEqual([
    `profile-v1 source "roiQuarterSeries" failed for client ${clientId}: quarter aggregate failed`,
  ]);
});

it('applies the same named noncancelling source budget to quarter ROI after recommendation', async () => {
  const quarter = deferred<unknown>();
  const h = harness({
    sourceResults: { buildRoiQuarterSeries: quarter.promise },
    recommendations: [recommendation()],
  });
  const read = h.profile();
  await h.started('buildRoiQuarterSeries');
  expect(h.recommender.recommend).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(IntelligenceService.PROFILE_V1_SOURCE_BUDGET_MS);
  const payload = await read;
  expect(payload.sections.relationships.officeRecommender).toHaveLength(1);
  expect(payload.sections.financialFootprint.series.quarterSeries).toEqual([]);
  expect(h.warnings).toEqual([
    `profile-v1 source "roiQuarterSeries" took 20000ms for client ${clientId}`,
    `profile-v1 source "roiQuarterSeries" failed for client ${clientId}: exceeded its 20000ms budget (still running)`,
  ]);
  quarter.resolve([{ label: 'late', lobbying: 1, obligations: 2 }]);
  await h.sources.buildRoiQuarterSeries.mock.results[0]!.value;
  expect(payload.sections.financialFootprint.series.quarterSeries).toEqual([]);
});
