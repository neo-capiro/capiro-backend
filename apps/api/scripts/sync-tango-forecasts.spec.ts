import { describe, expect, jest, test } from '@jest/globals';
import { parseArgs, runForecastSync, type ForecastSyncDeps } from './sync-tango-forecasts.js';
import { TangoRequestCeilingExceededError } from '../src/external/tango/tango-resilience.service.js';
import { computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import type { TangoForecast } from '../src/external/tango/tango.types.js';

describe('CLI parsing', () => {
  test('dry run is the default, no limit (page to exhaustion), 4h overlap', () => {
    expect(parseArgs([])).toEqual({ commit: false, limit: undefined, overlapHours: 4 });
  });

  test('--commit, --limit, --overlap-hours', () => {
    expect(parseArgs(['--commit'])).toEqual({ commit: true, limit: undefined, overlapHours: 4 });
    expect(parseArgs(['--limit=500']).limit).toBe(500);
    expect(parseArgs(['--limit=999999']).limit).toBe(50_000);
    expect(parseArgs(['--limit=0']).limit).toBeUndefined();
    expect(parseArgs(['--overlap-hours=12']).overlapHours).toBe(12);
    expect(parseArgs(['--overlap-hours=0']).overlapHours).toBe(0);
  });
});

function forecast(id: string, overrides: Partial<TangoForecast> = {}): TangoForecast {
  return {
    provenance: { provider: 'tango', resourceType: 'forecast', externalId: id, fetchedAt: 'x', providerUpdatedAt: null },
    forecastId: id,
    externalId: `EXT-${id}`,
    title: `Forecast ${id}`,
    description: null,
    agency: null,
    departmentCode: null,
    departmentName: null,
    organizationAgencyCode: null,
    organizationAgencyName: null,
    officeCode: null,
    officeName: null,
    organizationId: null,
    anticipatedAwardDate: null,
    estimatedPeriod: null,
    fiscalYear: null,
    naicsCode: null,
    pscCode: null,
    setAside: null,
    contractVehicle: null,
    placeOfPerformance: null,
    primaryContact: null,
    status: null,
    isActive: null,
    sourceSystem: null,
    sourceUrl: null,
    ...overrides,
  };
}

function fakeGateway(pages: Array<{ items: TangoForecast[]; nextCursor: string | null }>) {
  let call = 0;
  return {
    listForecasts: jest.fn(async (options?: { limit?: number; cursor?: string | null; changedSince?: string }) => {
      const page = pages[Math.min(call, pages.length - 1)]!;
      call += 1;
      const limit = options?.limit;
      if (limit != null && page.items.length > limit) {
        return { items: page.items.slice(0, limit), totalCount: null, nextCursor: `__truncated__${call}`, rate: null };
      }
      return { items: page.items, totalCount: null, nextCursor: page.nextCursor, rate: null };
    }),
    configured: true,
    lastRate: null,
    getVersion: jest.fn(async () => ({})),
    getEntity: jest.fn(async () => null),
    listEntities: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listOpportunities: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listNotices: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listVehicles: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
    listVehicleAwardees: jest.fn(async () => ({ items: [], totalCount: null, nextCursor: null, rate: null })),
  } as any;
}

function fakeStore(initialCheckpoint: { cursor: string | null; windowStart: Date | null; windowEnd: Date | null } | null = null) {
  const checkpoints: unknown[] = [];
  let storedCheckpoint = initialCheckpoint;
  const store = {
    readCheckpoint: jest.fn(async () => storedCheckpoint),
    writeCheckpoint: jest.fn(async (input: any) => {
      checkpoints.push(input);
      storedCheckpoint = {
        cursor: input.cursor ?? storedCheckpoint?.cursor ?? null,
        windowStart: input.windowStart !== undefined
          ? (input.windowStart ? new Date(input.windowStart) : null)
          : (storedCheckpoint?.windowStart ?? null),
        windowEnd: input.windowEnd !== undefined
          ? (input.windowEnd ? new Date(input.windowEnd) : null)
          : (storedCheckpoint?.windowEnd ?? null),
      };
      return {};
    }),
  };
  return { store: store as unknown as ForecastSyncDeps['store'], checkpoints };
}

const NOW = new Date('2026-08-07T12:00:00.000Z');

describe('runForecastSync — first run (no checkpoint)', () => {
  test('no modifiedAfter at all — a full historical walk, by design', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1')], nextCursor: null }]);
    const { store } = fakeStore(null);
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync(
      { gateway, store, upsertForecast, now: () => NOW },
      { commit: true },
    );
    expect(summary.isFirstRun).toBe(true);
    expect(summary.modifiedAfter).toBeNull();
    expect(gateway.listForecasts).toHaveBeenCalledWith(expect.not.objectContaining({ changedSince: expect.anything() }));
  });
});

describe('runForecastSync — incremental window with overlap', () => {
  test('modifiedAfter is windowEnd minus the overlap, not windowEnd itself', async () => {
    const windowEnd = new Date('2026-08-07T08:00:00.000Z');
    const gateway = fakeGateway([{ items: [], nextCursor: null }]);
    const { store } = fakeStore({ cursor: null, windowStart: null, windowEnd });
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync(
      { gateway, store, upsertForecast, now: () => NOW },
      { commit: true, overlapHours: 4 },
    );
    expect(summary.modifiedAfter).toBe('2026-08-07T04:00:00.000Z');
    expect(gateway.listForecasts).toHaveBeenCalledWith(
      expect.objectContaining({ changedSince: '2026-08-07T04:00:00.000Z' }),
    );
  });

  test('a fully exhausted run advances windowEnd to THIS run\'s own start time', async () => {
    const windowEnd = new Date('2026-08-06T00:00:00.000Z');
    const gateway = fakeGateway([{ items: [forecast('F1')], nextCursor: null }]);
    const { store, checkpoints } = fakeStore({ cursor: null, windowStart: null, windowEnd });
    const upsertForecast = jest.fn(async () => {});
    await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: true });
    expect(checkpoints).toHaveLength(1);
    expect((checkpoints[0] as any).windowEnd).toBe(NOW.toISOString());
    expect((checkpoints[0] as any).completeness).toBe('complete');
  });

  test('a ceiling-interrupted run does NOT advance the window — the retry reuses the same one', async () => {
    const windowEnd = new Date('2026-08-06T00:00:00.000Z');
    const gateway = fakeGateway([{ items: [forecast('F1'), forecast('F2')], nextCursor: 'more' }]);
    (gateway.listForecasts as jest.Mock).mockImplementationOnce(async () => {
      throw new TangoRequestCeilingExceededError('listForecasts', 100);
    });
    const { store, checkpoints } = fakeStore({ cursor: null, windowStart: null, windowEnd });
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: true });
    expect(summary.ceilingReached).toBe(true);
    expect(summary.completeness).toBe('in_progress');
    // No checkpoint write at all — the ceiling was hit on the very first page fetch.
    expect(checkpoints).toHaveLength(0);
  });
});

describe('runForecastSync — pagination is capped to what remains, never a full batch that gets discarded', () => {
  test('a page is requested for exactly the remaining --limit, not a flat batch size', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1'), forecast('F2'), forecast('F3')], nextCursor: null }]);
    const { store, checkpoints } = fakeStore(null);
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync(
      { gateway, store, upsertForecast, now: () => NOW },
      { commit: true, limit: 2 },
    );
    expect(summary.processed).toBe(2);
    expect(gateway.listForecasts).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    // Regression shape (decision-log D-43): the truncated page still carries
    // a real cursor, and completeness correctly stays in_progress — not a
    // false 'complete' from a cursor that a mid-page break skipped.
    expect(checkpoints).toHaveLength(1);
    expect((checkpoints[0] as any).completeness).toBe('in_progress');
    expect((checkpoints[0] as any).cursor).not.toBeNull();
    expect(summary.completeness).toBe('in_progress');
  });

  test('multiple pages walk to exhaustion when no --limit is given', async () => {
    const gateway = fakeGateway([
      { items: [forecast('F1')], nextCursor: 'page-2' },
      { items: [forecast('F2')], nextCursor: null },
    ]);
    const { store } = fakeStore(null);
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: true });
    expect(gateway.listForecasts).toHaveBeenCalledTimes(2);
    expect(summary.processed).toBe(2);
    expect(summary.completeness).toBe('complete');
  });
});

describe('runForecastSync — mapping and writes', () => {
  test('a forecast with no title is unmappable, counted, and never upserted', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1', { title: null }), forecast('F2')], nextCursor: null }]);
    const { store } = fakeStore(null);
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: true });
    expect(summary.processed).toBe(2);
    expect(summary.unmappable).toBe(1);
    expect(summary.written).toBe(1);
    expect(upsertForecast).toHaveBeenCalledTimes(1);
  });

  test('dry run still calls Tango and reports what WOULD be written, but writes nothing', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1')], nextCursor: null }]);
    const { store, checkpoints } = fakeStore(null);
    const upsertForecast = jest.fn(async () => {});
    const summary = await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: false });
    expect(gateway.listForecasts).toHaveBeenCalledTimes(1);
    expect(summary.written).toBe(1);
    expect(upsertForecast).not.toHaveBeenCalled();
    expect(checkpoints).toHaveLength(0);
  });

  test('a real upsert failure is counted as errored, decremented from written, and does not stop the run', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1'), forecast('F2')], nextCursor: null }]);
    const { store } = fakeStore(null);
    const upsertForecast = jest.fn(async (row: any) => {
      if (row.tangoForecastId === 'F1') throw new Error('constraint violation');
    });
    const summary = await runForecastSync({ gateway, store, upsertForecast, now: () => NOW }, { commit: true });
    expect(summary.processed).toBe(2);
    expect(summary.errored).toBe(1);
    expect(summary.written).toBe(1);
    expect(upsertForecast).toHaveBeenCalledTimes(2);
  });

  test('the checkpoint uses this sync verb, resourceType forecast, and an empty filter fingerprint', async () => {
    const gateway = fakeGateway([{ items: [forecast('F1')], nextCursor: null }]);
    const { store } = fakeStore(null);
    await runForecastSync(
      { gateway, store, upsertForecast: jest.fn(async () => {}), now: () => NOW },
      { commit: true },
    );
    expect(store.readCheckpoint).toHaveBeenCalledWith('sync-tango-forecasts', 'forecast', computeFilterFingerprint({}));
  });
});
