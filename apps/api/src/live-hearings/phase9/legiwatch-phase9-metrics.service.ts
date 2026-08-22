import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

interface StateMetricRow {
  phase: string;
  productionDefault: boolean;
  schedulesEnabled: boolean;
  killSwitchEngaged: boolean;
  captureAllPublicEvents: boolean;
  consecutivePasses: number;
}

interface LatestRunMetricRow {
  status: string;
  blockerCount: number;
  totalBodies: number;
  officialObservations: number;
  representedObservations: number;
  explicitConflicts: number;
  eligibleEvents: number;
  eventsWithOutcomes: number;
  duplicateCanonicalEvents: number;
  duplicateGlobalCaptures: number;
  unresolvedEvents: number;
  staleJobs: number;
  laggingIntelligenceJobs: number;
  createdAt: Date;
}

interface QueueMetricRow {
  capturePreflightPending: number;
  capturePending: number;
  captureLeased: number;
  captureFailed: number;
  intelligencePending: number;
  intelligenceLeased: number;
  intelligenceFailed: number;
  relevancePending: number;
  relevanceLeased: number;
  relevanceFailed: number;
}

interface CaptureMetricRow {
  activeCaptures: number;
  failedCaptures24h: number;
  blockedCaptures24h: number;
  completedWithGaps24h: number;
  transcriptGapSeconds24h: number;
  unresolvedUpcoming2h: number;
}

export interface LegiWatchPhase9MetricSnapshot {
  environment: string;
  phase: string;
  generatedAt: string;
  metrics: Record<string, number>;
  emf: Record<string, unknown>;
}

@Injectable()
export class LegiWatchPhase9MetricsService {
  constructor(private readonly prisma: PrismaService) {}

  async snapshot(now = new Date()): Promise<LegiWatchPhase9MetricSnapshot> {
    const [stateRows, runRows, queueRows, captureRows, runtimeRows] = await Promise.all([
      this.prisma.$queryRawUnsafe<StateMetricRow[]>(
        `SELECT phase,
                production_default AS "productionDefault",
                schedules_enabled AS "schedulesEnabled",
                kill_switch_engaged AS "killSwitchEngaged",
                capture_all_public_events AS "captureAllPublicEvents",
                consecutive_passes AS "consecutivePasses"
         FROM legiwatch_cutover_state
         WHERE id='global'
         LIMIT 1`,
      ),
      this.prisma.$queryRawUnsafe<LatestRunMetricRow[]>(
        `SELECT status,
                blocker_count AS "blockerCount",
                total_bodies AS "totalBodies",
                official_observations AS "officialObservations",
                represented_observations AS "representedObservations",
                explicit_conflicts AS "explicitConflicts",
                eligible_events AS "eligibleEvents",
                events_with_outcomes AS "eventsWithOutcomes",
                duplicate_canonical_events AS "duplicateCanonicalEvents",
                duplicate_global_captures AS "duplicateGlobalCaptures",
                unresolved_events AS "unresolvedEvents",
                stale_jobs AS "staleJobs",
                lagging_intelligence_jobs AS "laggingIntelligenceJobs",
                created_at AS "createdAt"
         FROM legiwatch_cutover_run
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ),
      this.prisma.$queryRawUnsafe<QueueMetricRow[]>(
        `SELECT
           (SELECT COUNT(*)::int FROM public_hearing_capture_job
             WHERE job_type='preflight' AND status='pending') AS "capturePreflightPending",
           (SELECT COUNT(*)::int FROM public_hearing_capture_job
             WHERE job_type='capture' AND status='pending') AS "capturePending",
           (SELECT COUNT(*)::int FROM public_hearing_capture_job
             WHERE status='leased') AS "captureLeased",
           (SELECT COUNT(*)::int FROM public_hearing_capture_job
             WHERE status='failed') AS "captureFailed",
           (SELECT COUNT(*)::int FROM public_hearing_intelligence_job
             WHERE status='pending') AS "intelligencePending",
           (SELECT COUNT(*)::int FROM public_hearing_intelligence_job
             WHERE status='leased') AS "intelligenceLeased",
           (SELECT COUNT(*)::int FROM public_hearing_intelligence_job
             WHERE status='failed') AS "intelligenceFailed",
           (SELECT COUNT(*)::int FROM tenant_hearing_relevance_job
             WHERE status='pending') AS "relevancePending",
           (SELECT COUNT(*)::int FROM tenant_hearing_relevance_job
             WHERE status='leased') AS "relevanceLeased",
           (SELECT COUNT(*)::int FROM tenant_hearing_relevance_job
             WHERE status='failed') AS "relevanceFailed"`,
      ),
      this.prisma.$queryRawUnsafe<CaptureMetricRow[]>(
        `SELECT
           COUNT(*) FILTER (
             WHERE domain_status IN (
               'SCHEDULED','PREPARING','WAITING_FOR_STREAM','READY',
               'CAPTURING','RECOVERING','FINALIZING'
             )
           )::int AS "activeCaptures",
           COUNT(*) FILTER (
             WHERE domain_status='FAILED'
               AND COALESCE(last_outcome_at, updated_at) >= $1 - interval '24 hours'
           )::int AS "failedCaptures24h",
           COUNT(*) FILTER (
             WHERE domain_status='BLOCKED'
               AND COALESCE(last_outcome_at, updated_at) >= $1 - interval '24 hours'
           )::int AS "blockedCaptures24h",
           COUNT(*) FILTER (
             WHERE domain_status='COMPLETE_WITH_GAPS'
               AND COALESCE(last_outcome_at, updated_at) >= $1 - interval '24 hours'
           )::int AS "completedWithGaps24h",
           COALESCE(SUM(transcript_gap_seconds) FILTER (
             WHERE COALESCE(last_outcome_at, updated_at) >= $1 - interval '24 hours'
           ), 0)::int AS "transcriptGapSeconds24h",
           (
             SELECT COUNT(*)::int
             FROM (
               SELECT h.id
               FROM committee_hearing h
               LEFT JOIN hearing_stream_candidate candidate ON candidate.hearing_id=h.id
               LEFT JOIN public_hearing_capture capture ON capture.hearing_id=h.id
               WHERE h.visibility='public'
                 AND h.event_status IN ('scheduled','postponed','in_progress')
                 AND h.starts_at BETWEEN $1 AND $1 + interval '2 hours'
               GROUP BY h.id
               HAVING COUNT(candidate.id)=0
                  AND MAX(capture.terminal_reason_code) IS NULL
             ) unresolved
           ) AS "unresolvedUpcoming2h"
         FROM public_hearing_capture`,
        now,
      ),
      this.prisma.$queryRawUnsafe<Array<{ stale: number; failed: number }>>(
        `SELECT COUNT(*) FILTER (
                  WHERE enabled=true
                    AND schedule_enabled=true
                    AND (
                      last_heartbeat_at IS NULL OR
                      max_lag_seconds IS NULL OR
                      last_heartbeat_at < $1 - (max_lag_seconds * interval '1 second')
                    )
                )::int AS stale,
                COUNT(*) FILTER (WHERE status='failed')::int AS failed
         FROM legiwatch_runtime_heartbeat`,
        now,
      ),
    ]);

    const state = stateRows[0] ?? {
      phase: 'MISSING',
      productionDefault: false,
      schedulesEnabled: false,
      killSwitchEngaged: true,
      captureAllPublicEvents: false,
      consecutivePasses: 0,
    };
    const run = runRows[0];
    const queue = queueRows[0] ?? zeroQueue();
    const capture = captureRows[0] ?? zeroCapture();
    const runtime = runtimeRows[0] ?? { stale: 0, failed: 0 };
    const observationDisposition = run?.officialObservations
      ? ((run.representedObservations + run.explicitConflicts) / run.officialObservations) * 100
      : 0;
    const captureOutcomeCoverage = run?.eligibleEvents
      ? (run.eventsWithOutcomes / run.eligibleEvents) * 100
      : 0;
    const metrics: Record<string, number> = {
      ProductionDefault: state.productionDefault ? 1 : 0,
      SchedulesEnabled: state.schedulesEnabled ? 1 : 0,
      KillSwitchEngaged: state.killSwitchEngaged ? 1 : 0,
      CaptureAllPublicEvents: state.captureAllPublicEvents ? 1 : 0,
      ConsecutivePassingRuns: state.consecutivePasses,
      ReadinessPass: run?.status === 'PASS' ? 1 : 0,
      ReadinessBlockers: run?.blockerCount ?? 1,
      ReadinessAgeSeconds: run
        ? Math.max(0, Math.floor((now.getTime() - run.createdAt.getTime()) / 1_000))
        : 2_147_483_647,
      CurrentBodies: run?.totalBodies ?? 0,
      OfficialObservations: run?.officialObservations ?? 0,
      ObservationDispositionPercent: round2(observationDisposition),
      CaptureOutcomePercent: round2(captureOutcomeCoverage),
      DuplicateCanonicalEvents: run?.duplicateCanonicalEvents ?? 0,
      DuplicateGlobalCaptures: run?.duplicateGlobalCaptures ?? 0,
      UnresolvedEvents: run?.unresolvedEvents ?? 0,
      StaleRequiredJobs: Math.max(run?.staleJobs ?? 0, runtime.stale),
      FailedRuntimeJobs: runtime.failed,
      LaggingIntelligenceJobs: run?.laggingIntelligenceJobs ?? 0,
      CapturePreflightPending: queue.capturePreflightPending,
      CapturePending: queue.capturePending,
      CaptureLeased: queue.captureLeased,
      CaptureFailed: queue.captureFailed,
      IntelligencePending: queue.intelligencePending,
      IntelligenceLeased: queue.intelligenceLeased,
      IntelligenceFailed: queue.intelligenceFailed,
      RelevancePending: queue.relevancePending,
      RelevanceLeased: queue.relevanceLeased,
      RelevanceFailed: queue.relevanceFailed,
      ActiveCaptures: capture.activeCaptures,
      FailedCaptures24h: capture.failedCaptures24h,
      BlockedCaptures24h: capture.blockedCaptures24h,
      CompleteWithGaps24h: capture.completedWithGaps24h,
      TranscriptGapSeconds24h: capture.transcriptGapSeconds24h,
      UnresolvedUpcoming2h: capture.unresolvedUpcoming2h ?? 0,
    };
    const environment = boundedDimension(
      process.env.CAPIRO_ENV ?? process.env.NODE_ENV ?? 'unknown',
    );
    const phase = boundedDimension(state.phase);
    const emf = {
      _aws: {
        Timestamp: now.getTime(),
        CloudWatchMetrics: [
          {
            Namespace: 'Capiro/LegiWatch',
            // Environment is the stable alarm dimension. Phase remains an EMF
            // property for logs/dashboards but does not fork every alarm time series.
            Dimensions: [['Environment']],
            Metrics: Object.keys(metrics).map((Name) => ({ Name, Unit: unitFor(Name) })),
          },
        ],
      },
      Environment: environment,
      Phase: phase,
      ...metrics,
    };
    return {
      environment,
      phase,
      generatedAt: now.toISOString(),
      metrics,
      emf,
    };
  }

  async emit(
    now = new Date(),
    log: (line: string) => void = console.log,
  ): Promise<LegiWatchPhase9MetricSnapshot> {
    const snapshot = await this.snapshot(now);
    log(JSON.stringify(snapshot.emf));
    return snapshot;
  }
}

function zeroQueue(): QueueMetricRow {
  return {
    capturePreflightPending: 0,
    capturePending: 0,
    captureLeased: 0,
    captureFailed: 0,
    intelligencePending: 0,
    intelligenceLeased: 0,
    intelligenceFailed: 0,
    relevancePending: 0,
    relevanceLeased: 0,
    relevanceFailed: 0,
  };
}

function zeroCapture(): CaptureMetricRow {
  return {
    activeCaptures: 0,
    failedCaptures24h: 0,
    blockedCaptures24h: 0,
    completedWithGaps24h: 0,
    transcriptGapSeconds24h: 0,
    unresolvedUpcoming2h: 0,
  };
}

function unitFor(name: string): string {
  if (name.endsWith('Percent')) return 'Percent';
  if (name.endsWith('Seconds') || name.endsWith('Seconds24h')) return 'Seconds';
  return 'Count';
}

function round2(value: number): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(2));
}

function boundedDimension(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 255) || 'unknown';
}
