import { Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import { CommitteeSiteAdapter } from '../../hearing-discovery/adapters/committee-site.adapter.js';
import { CongressGovAdapter, currentCongress } from '../../hearing-discovery/adapters/congress-gov.adapter.js';
import { HouseRepositoryAdapter } from '../../hearing-discovery/adapters/house-repository.adapter.js';
import { SenateScheduleAdapter } from '../../hearing-discovery/adapters/senate-schedule.adapter.js';
import { DiscoveryJobsService, type ProbeAdapterMap, type ProbeableAdapter } from '../../hearing-discovery/discovery-jobs.service.js';
import { SourceRegistryService } from '../../hearing-discovery/source-registry.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { LegiWatchPhase9CentralDiscoveryService } from './legiwatch-phase9-central-discovery.service.js';
import { LegiWatchPhase9MetricsService } from './legiwatch-phase9-metrics.service.js';
import { LegiWatchPhase9PreflightService } from './legiwatch-phase9-preflight.service.js';
import { LegiWatchPhase9ProvenanceBackfillService } from './legiwatch-phase9-provenance-backfill.service.js';
import { LegiWatchPhase9OfficialTimeObservationService } from './legiwatch-phase9-official-time-observation.service.js';
import { LegiWatchPhase9ReadinessService } from './legiwatch-phase9-readiness.service.js';
import { LegiWatchPhase9RuntimeService } from './legiwatch-phase9-runtime.service.js';
import type {
  LegiWatchPhase9EvidenceSource,
  LegiWatchPhase9Mode,
} from './legiwatch-phase9.types.js';

export const LEGIWATCH_PHASE9_API_JOBS = [
  'central-discovery',
  'committee-enrichment',
  'committee-updates',
  'source-probe',
  'coverage-audit',
  'stream-preflight',
  'archive-reconciliation',
  'parallel-comparison',
  'metrics',
  'provenance-backfill',
  'official-time-observation',
] as const;

export type LegiWatchPhase9ApiJob = (typeof LEGIWATCH_PHASE9_API_JOBS)[number];

@Injectable()
export class LegiWatchPhase9JobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtime: LegiWatchPhase9RuntimeService,
    private readonly central: LegiWatchPhase9CentralDiscoveryService,
    private readonly readiness: LegiWatchPhase9ReadinessService,
    private readonly preflight: LegiWatchPhase9PreflightService,
    private readonly provenanceBackfill: LegiWatchPhase9ProvenanceBackfillService,
    private readonly officialTimeObservation: LegiWatchPhase9OfficialTimeObservationService,
    private readonly metrics: LegiWatchPhase9MetricsService,
  ) {}

  async run(input: {
    job: LegiWatchPhase9ApiJob;
    workerId?: string;
    manual?: boolean;
    evidenceSource?: LegiWatchPhase9EvidenceSource;
    limit?: number;
  }): Promise<unknown> {
    const workerId =
      input.workerId?.trim() ||
      `phase9-api:${hostname()}:${process.pid}:${input.job}`;
    const discovery = new DiscoveryJobsService(this.prisma);

    return this.runtime.run({
      jobKey: input.job,
      workerId,
      manual: input.manual,
      execute: async () => {
        if (input.job === 'central-discovery') {
          return this.central.run({
            daysAhead: integerEnv('LEGIWATCH_DISCOVERY_DAYS_AHEAD', 60),
            delayMs: integerEnv('LEGIWATCH_DISCOVERY_DELAY_MS', 200),
            maxCongressPages: integerEnv('LEGIWATCH_DISCOVERY_MAX_PAGES', 8),
            log: console.log,
          });
        }
        if (input.job === 'committee-enrichment') {
          return discovery.enrichCommitteeHearings({
            withinHours: integerEnv('LEGIWATCH_ENRICHMENT_WITHIN_HOURS', 168),
            limit: input.limit ?? integerEnv('LEGIWATCH_ENRICHMENT_LIMIT', 500),
            delayMs: integerEnv('LEGIWATCH_ENRICHMENT_DELAY_MS', 250),
            log: console.log,
          });
        }
        if (input.job === 'committee-updates') {
          return discovery.detectCommitteeUpdates({
            limit: input.limit ?? integerEnv('LEGIWATCH_UPDATE_LIMIT', 500),
            delayMs: integerEnv('LEGIWATCH_UPDATE_DELAY_MS', 400),
            log: console.log,
          });
        }
        if (input.job === 'source-probe') {
          return discovery.probeSources({
            adapters: await this.probeAdapters(),
            limit: input.limit ?? integerEnv('LEGIWATCH_PROBE_LIMIT', 2_000),
            delayMs: integerEnv('LEGIWATCH_PROBE_DELAY_MS', 200),
            log: console.log,
          });
        }
        if (input.job === 'coverage-audit') {
          return this.readiness.evaluateAndPersist(workerId, {
            evidenceSource: input.evidenceSource ?? evidenceSourceFromEnv(),
            mode: 'READINESS',
            lookbackDays: integerEnv('LEGIWATCH_AUDIT_LOOKBACK_DAYS', 60),
            lookaheadDays: integerEnv('LEGIWATCH_AUDIT_LOOKAHEAD_DAYS', 30),
            captureGraceMinutes: integerEnv('LEGIWATCH_CAPTURE_GRACE_MINUTES', 15),
            intelligenceLagMinutes: integerEnv('LEGIWATCH_INTELLIGENCE_LAG_MINUTES', 10),
          });
        }
        if (input.job === 'stream-preflight') {
          return this.preflight.plan({
            lookaheadDays: integerEnv('LEGIWATCH_PREFLIGHT_LOOKAHEAD_DAYS', 14),
            delayedStartHours: integerEnv('LEGIWATCH_DELAYED_START_HOURS', 6),
            limit: input.limit ?? integerEnv('LEGIWATCH_PREFLIGHT_LIMIT', 2_000),
          });
        }
        if (input.job === 'archive-reconciliation') {
          return discovery.reconcileArchives({
            lookbackDays: integerEnv('LEGIWATCH_ARCHIVE_LOOKBACK_DAYS', 30),
            limit: input.limit ?? integerEnv('LEGIWATCH_ARCHIVE_LIMIT', 2_000),
            log: console.log,
          });
        }
        if (input.job === 'parallel-comparison') {
          return this.readiness.evaluateAndPersist(workerId, {
            evidenceSource: input.evidenceSource ?? evidenceSourceFromEnv(),
            mode: rolloutAuditMode(),
            lookbackDays: integerEnv('LEGIWATCH_PARALLEL_LOOKBACK_DAYS', 14),
            lookaheadDays: integerEnv('LEGIWATCH_PARALLEL_LOOKAHEAD_DAYS', 14),
            captureGraceMinutes: integerEnv('LEGIWATCH_CAPTURE_GRACE_MINUTES', 15),
            intelligenceLagMinutes: integerEnv('LEGIWATCH_INTELLIGENCE_LAG_MINUTES', 10),
          });
        }
        if (input.job === 'metrics') return this.metrics.emit();
        if (input.job === 'provenance-backfill') {
          // MANUAL-ONLY. Never scheduled, never registered as a required job.
          return this.provenanceBackfill.run({
            manual: input.manual === true,
            lookbackDays: integerEnv('LEGIWATCH_AUDIT_LOOKBACK_DAYS', 60),
            limit: input.limit ?? integerEnv('LEGIWATCH_PROVENANCE_BACKFILL_LIMIT', 25),
            cursor: stringEnv('LEGIWATCH_PROVENANCE_BACKFILL_CURSOR'),
            reportOnly: booleanEnv('LEGIWATCH_PROVENANCE_BACKFILL_REPORT_ONLY', false),
          });
        }
        if (input.job === 'official-time-observation') {
          // MANUAL-ONLY. Re-observes window hearings through their committee's
          // official site and reconciles explicit local-time+zone statements
          // (field-hearing corrections). Never scheduled.
          return this.officialTimeObservation.run({
            manual: input.manual === true,
            lookbackDays: integerEnv('LEGIWATCH_OFFICIAL_TIME_LOOKBACK_DAYS', 7),
            lookaheadDays: integerEnv('LEGIWATCH_OFFICIAL_TIME_LOOKAHEAD_DAYS', 30),
            limit: input.limit ?? integerEnv('LEGIWATCH_OFFICIAL_TIME_LIMIT', 25),
            reportOnly: booleanEnv('LEGIWATCH_OFFICIAL_TIME_REPORT_ONLY', false),
          });
        }
        return assertNever(input.job);
      },
      metrics: (result) => resultMetrics(result),
    });
  }

  private async probeAdapters(): Promise<ProbeAdapterMap> {
    const registry = new SourceRegistryService(this.prisma);
    const congress = currentCongress();
    const resolveCommitteeName = await registry.committeeNameResolver();
    const resolveHouseCode = await registry.systemCodeByNameResolver('house');
    return new Map<string, ProbeableAdapter>([
      [
        'congress-gov',
        new CongressGovAdapter({
          apiKey: process.env.CONGRESS_API_KEY ?? '',
          congresses: [congress],
          maxPages: 1,
          listLimit: 1,
          resolveCommitteeName,
        }),
      ],
      [
        'house-repository',
        new HouseRepositoryAdapter({ congress, resolveSystemCodeByName: resolveHouseCode }),
      ],
      ['senate-schedule', new SenateScheduleAdapter({ congress, resolveCommitteeName })],
      ['committee-site', new CommitteeSiteAdapter()],
    ]);
  }
}

function evidenceSourceFromEnv(): LegiWatchPhase9EvidenceSource {
  const value = (process.env.LEGIWATCH_EVIDENCE_SOURCE ?? 'NONE').toUpperCase();
  if (['LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED', 'NONE'].includes(value)) {
    return value as LegiWatchPhase9EvidenceSource;
  }
  return 'NONE';
}

function rolloutAuditMode(): LegiWatchPhase9Mode {
  const value = (process.env.LEGIWATCH_PARALLEL_MODE ?? 'SHADOW').toUpperCase();
  if (['SHADOW', 'CANARY', 'READINESS', 'CUTOVER_VERIFICATION', 'ROLLBACK_VERIFICATION'].includes(value)) {
    return value as LegiWatchPhase9Mode;
  }
  return 'SHADOW';
}

function integerEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stringEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function resultMetrics(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'number' || typeof item === 'boolean' || typeof item === 'string') {
      output[key] = item;
    }
  }
  return output;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Phase 9 job: ${String(value)}`);
}
