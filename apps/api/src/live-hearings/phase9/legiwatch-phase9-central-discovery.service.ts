import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CongressGovAdapter, currentCongress } from '../../hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../../hearing-discovery/adapters/house-repository.adapter.js';
import { SenateScheduleAdapter } from '../../hearing-discovery/adapters/senate-schedule.adapter.js';
import { CommitteeSourceRepository } from '../../hearing-discovery/committee-source.repository.js';
import { HearingReconcilerService } from '../../hearing-discovery/hearing-reconciler.service.js';
import { SourceRegistryService } from '../../hearing-discovery/source-registry.service.js';
import type {
  CommitteeSourceAdapter,
  DiscoveryContext,
  SourceDescriptor,
} from '../../hearing-discovery/hearing-discovery.types.js';

export interface LegiWatchCentralDiscoveryResult {
  sourcesRegistered: number;
  committeeSourcesRegistered: number;
  committeeSourcesMissingUrl: number;
  sourcesAttempted: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  eventsObserved: number;
  hearingsCreated: number;
  hearingsUpdated: number;
  observationsCreated: number;
  observationsChanged: number;
  siteUpdates: number;
  streamCandidates: number;
  reconciliationErrors: number;
  sourceErrors: Array<{ adapterKey: string; sourceUrl: string; error: string }>;
}

@Injectable()
export class LegiWatchPhase9CentralDiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async run(input: {
    now?: Date;
    daysAhead?: number;
    delayMs?: number;
    maxCongressPages?: number;
    log?: (message: string) => void;
  } = {}): Promise<LegiWatchCentralDiscoveryResult> {
    const now = input.now ?? new Date();
    const log = input.log ?? (() => {});
    const congress = currentCongress(now);
    const daysAhead = boundedInteger(input.daysAhead ?? 60, 1, 365);
    const delayMs = boundedInteger(input.delayMs ?? 200, 0, 10_000);
    const registry = new SourceRegistryService(this.prisma);
    const sourceRepository = new CommitteeSourceRepository(this.prisma);
    const reconciler = new HearingReconcilerService(this.prisma);
    const resolveCommitteeName = await registry.committeeNameResolver();
    const resolveHouseCode = await registry.systemCodeByNameResolver('house');
    const centralSources = await registry.ensureCentralSources(congress);
    const committeeRegistration = await registry.ensureCommitteeSiteSources();

    const adapters = new Map<string, CommitteeSourceAdapter>([
      [
        'congress-gov',
        new CongressGovAdapter({
          apiKey: process.env.CONGRESS_API_KEY ?? '',
          congresses: [congress],
          maxPages: boundedInteger(input.maxCongressPages ?? 8, 1, 50),
          resolveCommitteeName,
        }),
      ],
      [
        'house-repository',
        new HouseRepositoryAdapter({
          congress,
          resolveSystemCodeByName: resolveHouseCode,
        }),
      ],
      [
        'senate-schedule',
        new SenateScheduleAdapter({ congress, resolveCommitteeName }),
      ],
    ]);

    const result: LegiWatchCentralDiscoveryResult = {
      sourcesRegistered: centralSources.length,
      committeeSourcesRegistered: committeeRegistration.registered,
      committeeSourcesMissingUrl: committeeRegistration.skippedNoUrl.length,
      sourcesAttempted: 0,
      sourcesSucceeded: 0,
      sourcesFailed: 0,
      eventsObserved: 0,
      hearingsCreated: 0,
      hearingsUpdated: 0,
      observationsCreated: 0,
      observationsChanged: 0,
      siteUpdates: 0,
      streamCandidates: 0,
      reconciliationErrors: 0,
      sourceErrors: [],
    };

    for (const source of centralSources.sort(
      (left, right) => left.priority - right.priority || left.adapterKey.localeCompare(right.adapterKey),
    )) {
      result.sourcesAttempted += 1;
      const adapter = adapters.get(source.adapterKey);
      if (!adapter) {
        const error = `No Phase 9 adapter is registered for ${source.adapterKey}`;
        result.sourcesFailed += 1;
        result.sourceErrors.push({ adapterKey: source.adapterKey, sourceUrl: source.sourceUrl, error });
        await sourceRepository.recordOutcome(source.id, { ok: false, error }, now);
        continue;
      }

      const since = await sourceWatermark(this.prisma, source.id, now);
      const ctx: DiscoveryContext = {
        since,
        daysAhead,
        delayMs,
        log,
      };
      await sourceRepository.markChecked(source.id, now);
      try {
        const events = await adapter.discoverEvents(source, ctx);
        result.eventsObserved += events.length;
        const reconciled = await reconciler.reconcileBatch(source, events, now, log);
        result.hearingsCreated += reconciled.totals.hearingsCreated;
        result.hearingsUpdated += reconciled.totals.hearingsUpdated;
        result.observationsCreated += reconciled.totals.observationsCreated;
        result.observationsChanged += reconciled.totals.observationsChanged;
        result.siteUpdates += reconciled.totals.siteUpdates;
        result.streamCandidates += reconciled.totals.streamCandidates;
        result.reconciliationErrors += reconciled.totals.errors;
        await sourceRepository.recordOutcome(
          source.id,
          {
            ok: reconciled.totals.errors === 0,
            observedEvents: events.length,
            error:
              reconciled.totals.errors > 0
                ? `${reconciled.totals.errors} event(s) failed reconciliation`
                : undefined,
          },
          now,
          adapter.parserVersion,
        );
        if (reconciled.totals.errors > 0) {
          result.sourcesFailed += 1;
          result.sourceErrors.push({
            adapterKey: source.adapterKey,
            sourceUrl: source.sourceUrl,
            error: `${reconciled.totals.errors} event(s) failed reconciliation`,
          });
        } else {
          result.sourcesSucceeded += 1;
        }
      } catch (error) {
        const message = boundedError(error);
        result.sourcesFailed += 1;
        result.sourceErrors.push({
          adapterKey: source.adapterKey,
          sourceUrl: source.sourceUrl,
          error: message,
        });
        await sourceRepository.recordOutcome(source.id, { ok: false, error: message }, now);
        log(`[phase9-central-discovery] ${source.adapterKey} failed: ${message}`);
      }
    }

    return result;
  }
}

async function sourceWatermark(
  prisma: PrismaService,
  sourceId: string,
  now: Date,
): Promise<Date | null> {
  const row = await prisma.committeeSource.findUnique({
    where: { id: sourceId },
    select: { lastSuccessAt: true },
  });
  if (!row?.lastSuccessAt) return new Date(now.getTime() - 7 * 86_400_000);
  // Revisit a small overlap so an upstream event at the exact watermark is not
  // lost to inclusive/exclusive source semantics. Observation idempotency absorbs it.
  return new Date(row.lastSuccessAt.getTime() - 5 * 60_000);
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 1_000);
}
