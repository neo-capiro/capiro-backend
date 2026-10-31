import { LegiWatchPhase9CentralDiscoveryService } from './legiwatch-phase9-central-discovery.service.js';
import { LegiWatchPhase9JobsService } from './legiwatch-phase9-jobs.service.js';
import {
  LegiWatchPhase9PartialFailure,
  LegiWatchPhase9RuntimeService,
} from './legiwatch-phase9-runtime.service.js';
import { CongressGovAdapter } from '../../hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../../hearing-discovery/adapters/house-repository.adapter.js';
import { SenateScheduleAdapter } from '../../hearing-discovery/adapters/senate-schedule.adapter.js';
import { SenateCommitteeCalendarAdapter } from '../../hearing-discovery/adapters/senate-committee-calendar.adapter.js';
import * as sourceHttp from '../../hearing-discovery/adapters/source-http.js';
import { CommitteeSourceRepository } from '../../hearing-discovery/committee-source.repository.js';
import { HearingReconcilerService } from '../../hearing-discovery/hearing-reconciler.service.js';
import { SourceRegistryService } from '../../hearing-discovery/source-registry.service.js';
import type { SourceDescriptor } from '../../hearing-discovery/hearing-discovery.types.js';

const now = new Date('2026-10-06T16:00:00Z');
const previous = '2026-10-06T12:00:00.000Z';
const sources = ['congress-gov', 'house-repository', 'senate-schedule'].map((key, index) => ({
  id: key,
  adapterKey: key,
  sourceUrl: `https://official.test/${key}`,
  committeeSystemCode: null,
  chamber: 'house',
  sourceType: 'CONGRESS_GOV',
  priority: index,
})) as SourceDescriptor[];

function harness(
  input: {
    watermarks?: unknown;
    partialCongress?: boolean;
    reconciliationFailure?: boolean;
    listFailure?: boolean;
    committeeSources?: SourceDescriptor[];
  } = {},
) {
  const query = jest.fn(async () => [{ watermarks: input.watermarks ?? {} }]);
  const findUnique = jest.fn(() => {
    throw new Error('Health/probe timestamp must never be read as cursor');
  });
  const prisma = { $queryRawUnsafe: query, committeeSource: { findUnique } };
  jest
    .spyOn(SourceRegistryService.prototype, 'committeeNameResolver')
    .mockResolvedValue(() => null);
  jest
    .spyOn(SourceRegistryService.prototype, 'systemCodeByNameResolver')
    .mockResolvedValue(() => null);
  jest.spyOn(SourceRegistryService.prototype, 'ensureCentralSources').mockResolvedValue(sources);
  jest
    .spyOn(SourceRegistryService.prototype, 'ensureCommitteeSiteSources')
    .mockResolvedValue({ registered: 0, skippedNoUrl: [] } as never);
  jest.spyOn(CommitteeSourceRepository.prototype, 'markChecked').mockResolvedValue();
  const listEnabled = jest
    .spyOn(CommitteeSourceRepository.prototype, 'listEnabled')
    .mockResolvedValue(input.committeeSources ?? []);
  const outcomes = jest
    .spyOn(CommitteeSourceRepository.prototype, 'recordOutcome')
    .mockResolvedValue('healthy');
  const congress = jest
    .spyOn(CongressGovAdapter.prototype, 'discoverEvents')
    .mockImplementation(async function (this: CongressGovAdapter) {
      if (input.listFailure)
        throw new Error('committee-meeting list failed: timeout after 20000ms');
      this.discoveryErrors = input.partialCongress
        ? ['detail fetch failed for event 2: HTTP 503']
        : [];
      return [{}] as never;
    });
  jest.spyOn(HouseRepositoryAdapter.prototype, 'discoverEvents').mockResolvedValue([]);
  jest.spyOn(SenateScheduleAdapter.prototype, 'discoverEvents').mockResolvedValue([]);
  const committee = jest
    .spyOn(SenateCommitteeCalendarAdapter.prototype, 'discoverEvents')
    .mockResolvedValue([{ externalEventId: 'committee-only-announcement' }] as never);
  const reconcile = jest
    .spyOn(HearingReconcilerService.prototype, 'reconcileBatch')
    .mockImplementation(
      async (source) =>
        ({
          totals: {
            hearingsCreated: 0,
            hearingsUpdated: 0,
            observationsCreated: source.id === 'congress-gov' ? 1 : 0,
            observationsChanged: 0,
            siteUpdates: 0,
            streamCandidates: 0,
            errors: input.reconciliationFailure && source.id === 'congress-gov' ? 1 : 0,
          },
        }) as never,
    );
  return {
    service: new LegiWatchPhase9CentralDiscoveryService(prisma as never),
    query,
    findUnique,
    outcomes,
    congress,
    reconcile,
    committee,
    listEnabled,
  };
}
afterEach(() => jest.restoreAllMocks());

function jobsService(central: LegiWatchPhase9CentralDiscoveryService) {
  const runtime = {
    run: jest.fn(async (input: { execute: () => Promise<unknown> }) => input.execute()),
  };
  return new LegiWatchPhase9JobsService(
    {} as never,
    runtime as never,
    central,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('scheduled central discovery runtime wiring', () => {
  const originalApiKey = process.env.CONGRESS_API_KEY;
  const originalCap = process.env.LEGIWATCH_DISCOVERY_MAX_PAGES;
  const originalDelay = process.env.LEGIWATCH_DISCOVERY_DELAY_MS;
  beforeEach(() => {
    jest.spyOn(sourceHttp, 'sleep').mockResolvedValue();
    process.env.CONGRESS_API_KEY = 'test-only';
    delete process.env.LEGIWATCH_DISCOVERY_MAX_PAGES;
    process.env.LEGIWATCH_DISCOVERY_DELAY_MS = '0';
  });
  afterEach(() => {
    for (const [name, value] of [
      ['CONGRESS_API_KEY', originalApiKey],
      ['LEGIWATCH_DISCOVERY_MAX_PAGES', originalCap],
      ['LEGIWATCH_DISCOVERY_DELAY_MS', originalDelay],
    ]) {
      if (value == null) delete process.env[name!];
      else process.env[name!] = value;
    }
  });

  function publisherInventory() {
    return jest.spyOn(sourceHttp, 'fetchJson').mockImplementation(async (url) => {
      const parsed = new URL(url);
      const offset = parsed.searchParams.get('offset');
      const data =
        offset != null
          ? {
              committeeMeetings: Array.from(
                { length: Math.min(250, 2001 - Number(offset)) },
                (_, n) => ({
                  eventId: String(Number(offset) + n),
                  url: `https://api.congress.gov/v3/committee-meeting/119/house/${Number(offset) + n}`,
                }),
              ),
              pagination: { count: 2001, ...(Number(offset) < 2000 ? { next: 'next' } : {}) },
            }
          : {
              committeeMeeting: {
                eventId: parsed.pathname.split('/').pop(),
                congress: 119,
                chamber: 'house',
                title: 'Published hearing',
                date: '2026-10-07T14:00:00Z',
                committees: [{ systemCode: 'hswm00', name: 'Ways and Means' }],
              },
            };
      return { ok: true, status: 200, data, error: null, durationMs: 1 } as never;
    });
  }

  it('runs the actual job through every publisher page beyond eight by default', async () => {
    const h = harness();
    h.congress.mockRestore();
    const read = publisherInventory();
    const result = await jobsService(h.service).run({ job: 'central-discovery' });
    expect(read.mock.calls.filter(([url]) => url.includes('offset='))).toHaveLength(9);
    expect(h.reconcile.mock.calls.find(([s]) => s.id === 'congress-gov')?.[1]).toHaveLength(2001);
    expect(result).toEqual(expect.objectContaining({ sourcesFailed: 0, eventsObserved: 2001 }));
  });

  it('preserves an explicit operator cap as an incomplete pass without advancing its cursor', async () => {
    process.env.LEGIWATCH_DISCOVERY_MAX_PAGES = '2';
    const h = harness({ watermarks: { 'congress-gov': previous } });
    h.congress.mockRestore();
    const read = publisherInventory();
    const error = await jobsService(h.service)
      .run({ job: 'central-discovery' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LegiWatchPhase9PartialFailure);
    expect(read.mock.calls.filter(([url]) => url.includes('offset='))).toHaveLength(2);
    expect(error.runtimeMetrics.discoveryWatermarks['congress-gov']).toBe(previous);
  });

  it('reconciles registered committee-only announcements independently of central Senate failure', async () => {
    const committeeSource = {
      ...sources[2],
      id: 'committee-only',
      adapterKey: 'senate-committee-calendar',
      chamber: 'senate',
    } as SourceDescriptor;
    const h = harness({ committeeSources: [committeeSource] });
    jest
      .mocked(SenateScheduleAdapter.prototype.discoverEvents)
      .mockRejectedValue(new Error('central publisher unavailable'));
    const error = await jobsService(h.service)
      .run({ job: 'central-discovery' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LegiWatchPhase9PartialFailure);
    expect(h.listEnabled).toHaveBeenCalledWith({
      adapterKey: 'senate-committee-calendar',
      chamber: 'senate',
    });
    expect(h.reconcile).toHaveBeenCalledWith(
      committeeSource,
      [{ externalEventId: 'committee-only-announcement' }],
      expect.any(Date),
      expect.any(Function),
    );
    expect(error.runtimeMetrics).toEqual(
      expect.objectContaining({ sourcesAttempted: 4, sourcesSucceeded: 3, sourcesFailed: 1 }),
    );
    expect(error.runtimeMetrics.discoveryWatermarks['committee-only']).toBeDefined();
  });

  it('records unrecognized HTTP200 committee markup as failure without a second fetch or cursor advance', async () => {
    const committeeSource = {
      ...sources[2],
      id: 'unrecognized',
      adapterKey: 'senate-committee-calendar',
      chamber: 'senate',
    } as SourceDescriptor;
    const h = harness({
      committeeSources: [committeeSource],
      watermarks: { unrecognized: previous },
    });
    h.committee.mockRestore();
    const read = jest
      .spyOn(sourceHttp, 'fetchText')
      .mockResolvedValue({
        ok: true,
        status: 200,
        body: '<html><h1>Hearings</h1></html>',
        error: null,
        durationMs: 1,
      });
    const error = await jobsService(h.service)
      .run({ job: 'central-discovery' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(LegiWatchPhase9PartialFailure);
    expect(read).toHaveBeenCalledTimes(1);
    expect(h.outcomes).toHaveBeenCalledWith(
      'unrecognized',
      expect.objectContaining({ ok: false, error: expect.stringContaining('no verifiable dated') }),
      expect.any(Date),
    );
    expect(h.reconcile.mock.calls.some(([s]) => s.id === 'unrecognized')).toBe(false);
    expect(error.runtimeMetrics.discoveryWatermarks.unrecognized).toBe(previous);
  });
});

describe('dedicated complete-discovery cursors', () => {
  it('uses a seven-day bounded recovery window when the dedicated cursor is missing, ignoring probe success', async () => {
    const h = harness();
    const result = await h.service.run({ now });
    expect(h.congress.mock.calls[0]?.[1].since?.toISOString()).toBe('2026-09-29T16:00:00.000Z');
    expect(h.findUnique).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledWith(expect.stringContaining("metrics->'discoveryWatermarks'"));
    expect(result.discoveryWatermarks).toEqual(
      Object.fromEntries(sources.map((s) => [s.id, now.toISOString()])),
    );
  });
  it('uses only the dedicated completed cursor with a five-minute overlap', async () => {
    const h = harness({ watermarks: { 'congress-gov': previous } });
    await h.service.run({ now });
    expect(h.congress.mock.calls[0]?.[1].since?.toISOString()).toBe('2026-10-06T11:55:00.000Z');
    expect(h.findUnique).not.toHaveBeenCalled();
  });
  it.each(['partialCongress', 'reconciliationFailure', 'listFailure'] as const)(
    'does not advance a %s cursor while preserving other complete source progress',
    async (failure) => {
      const h = harness({
        watermarks: { 'congress-gov': previous, 'house-repository': previous },
        [failure]: true,
      });
      const result = await h.service.run({ now });
      expect(result.sourcesFailed).toBe(1);
      expect(result.sourcesSucceeded).toBe(2);
      expect(result.discoveryWatermarks).toEqual({
        'congress-gov': previous,
        'house-repository': now.toISOString(),
        'senate-schedule': now.toISOString(),
      });
      expect(h.outcomes).toHaveBeenCalledWith(
        'congress-gov',
        expect.objectContaining({ ok: false, error: expect.any(String) }),
        now,
        ...(failure === 'listFailure' ? [] : [expect.any(String)]),
      );
      if (failure === 'partialCongress') {
        expect(h.reconcile).toHaveBeenCalledWith(sources[0], [{}], now, expect.any(Function));
        expect(result.observationsCreated).toBe(1);
      }
    },
  );
  it.each([
    null,
    [],
    'invalid',
    { 'congress-gov': 'not a timestamp' },
    { 'congress-gov': '2027-01-01T00:00:00Z' },
  ])('recovers conservatively from invalid cursor metadata: %j', async (watermarks) => {
    const h = harness({ watermarks });
    await h.service.run({ now });
    expect(h.congress.mock.calls[0]?.[1].since?.toISOString()).toBe('2026-09-29T16:00:00.000Z');
  });
});

it('records central partial failure with complete-source cursors and acquires the existing job lease', async () => {
  const result = {
    sourcesFailed: 1,
    sourceErrors: [{ error: 'detail fetch failed' }],
    discoveryWatermarks: { 'congress-gov': previous, 'house-repository': now.toISOString() },
  };
  const runtime = {
    run: jest.fn(async (input: { execute: () => Promise<unknown> }) => input.execute()),
  };
  const central = { run: jest.fn(async () => result) };
  const service = new LegiWatchPhase9JobsService(
    {} as never,
    runtime as never,
    central as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const error = await service.run({ job: 'central-discovery' }).catch((e) => e);
  expect(error).toBeInstanceOf(LegiWatchPhase9PartialFailure);
  if (!(error instanceof LegiWatchPhase9PartialFailure))
    throw new Error('Expected partial failure');
  expect(error.runtimeMetrics).toEqual(result);
  expect(runtime.run).toHaveBeenCalledWith(
    expect.objectContaining({ jobKey: 'central-discovery', skipIfRunning: true }),
  );
});

it('persists successful discovery cursors through the actual jobs and runtime metric boundaries', async () => {
  const execute = jest.fn(async (..._args: unknown[]) => 1);
  const prisma = {
    $queryRawUnsafe: jest.fn(async () => [{ enabled: true, scheduleEnabled: true }]),
    $executeRawUnsafe: execute,
  };
  const cursors = { congress: now.toISOString(), house: now.toISOString() };
  const central = {
    run: jest.fn(async () => ({
      sourcesFailed: 0,
      discoveryWatermarks: cursors,
      arbitrary: { ignored: true },
    })),
  };
  const service = new LegiWatchPhase9JobsService(
    prisma as never,
    new LegiWatchPhase9RuntimeService(prisma as never),
    central as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await service.run({ job: 'central-discovery' });
  const success = execute.mock.calls.find(([sql]) => String(sql).includes("status='succeeded'"));
  expect(success).toBeDefined();
  const persisted = JSON.parse(String(success?.[2]));
  expect(persisted.discoveryWatermarks).toEqual(cursors);
  expect(persisted).not.toHaveProperty('arbitrary');
});
