import { LegiWatchPhase9CentralDiscoveryService } from './legiwatch-phase9-central-discovery.service.js';
import { LegiWatchPhase9JobsService } from './legiwatch-phase9-jobs.service.js';
import {
  LegiWatchPhase9PartialFailure,
  LegiWatchPhase9RuntimeService,
} from './legiwatch-phase9-runtime.service.js';
import { CongressGovAdapter } from '../../hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../../hearing-discovery/adapters/house-repository.adapter.js';
import { SenateScheduleAdapter } from '../../hearing-discovery/adapters/senate-schedule.adapter.js';
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
  };
}
afterEach(() => jest.restoreAllMocks());

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
