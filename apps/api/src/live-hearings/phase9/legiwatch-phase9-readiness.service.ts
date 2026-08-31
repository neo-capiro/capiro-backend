import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  assessCaptureOutcome,
  canonicalEventFingerprint,
  classifyBodyCoverage,
  deriveRunStatus,
  evidenceSourceSatisfiesCutover,
  isRuntimeJobFresh,
  percentage,
  requiredEvidenceTypes,
  TERMINAL_CAPTURE_STATES,
} from './legiwatch-phase9-gates.js';
import {
  LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS,
  type LegiWatchPhase9AuditOptions,
  type LegiWatchPhase9BodyCoverage,
  type LegiWatchPhase9Exception,
  type LegiWatchPhase9Gate,
  type LegiWatchPhase9PersistedRun,
  type LegiWatchPhase9ReadinessReport,
  type LegiWatchPhase9RuntimeJob,
} from './legiwatch-phase9.types.js';

const HEALTHY_SOURCE_STATES = new Set(['healthy', 'success', 'ok']);
const FAILING_SOURCE_STATES = new Set(['degraded', 'failing', 'failed', 'error', 'unavailable']);
const DUE_EVENT_STATUSES = new Set(['scheduled', 'in_progress', 'completed']);
/// A committee_hearing.coverage_status value that represents a TERMINAL,
/// explicit hearing-level stream disposition — set by classifyStreamResolution()
/// via either the normal capture flow or the demand-free disposition path.
/// A hearing in one of these states has an explicit, resolved stream
/// disposition even with zero hearing_stream_candidate rows and zero
/// public_hearing_capture rows (e.g. a genuinely no-public-stream hearing
/// with no capture demand). 'discovered'/'stream_ready'/'capturing'/
/// 'captured'/'not_covered' are all NON-terminal for this purpose — they
/// still need a candidate or capture outcome to count as explicit.
const TERMINAL_HEARING_COVERAGE_STATUSES = new Set(['no_public_stream', 'blocked']);
const MAX_EXCEPTIONS = 10_000;

// The default Prisma interactive-transaction timeout is 5000ms. This trusted
// system transaction persists a readiness run, its event-audit exceptions,
// and the cutover-state update atomically; on real Aurora latency it can
// legitimately exceed the default budget. Use PrismaService.withSystem's
// timeoutMs escape hatch for this one persistence transaction only — do not
// change the default timeout used elsewhere.
const READINESS_PERSIST_TIMEOUT_MS = 30_000;

interface BodyRow {
  systemCode: string;
  name: string;
  chamber: string;
  parentSystemCode: string | null;
}

interface SourceRow {
  id: string;
  committeeSystemCode: string | null;
  chamber: string;
  sourceHealth: string;
  lastSuccessAt: Date | null;
  /// A generic, reviewed committee_source_exception row currently applies to
  /// this source (expires_at IS NULL) — e.g. UPSTREAM_ACCESS_BLOCKED. This is
  /// never keyed on source identity in code; it's purely "does this row have
  /// an active exception record".
  hasAcceptedException: boolean;
  exceptionType: string | null;
  exceptionReasonCode: string | null;
}

interface ObservationRow {
  id: string;
  hearingId: string | null;
  bodyCode: string | null;
  reconciliationStatus: string;
  reconciliationReasonCode: string | null;
  observedAt: Date;
}

interface HearingRow {
  id: string;
  chamber: string;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  title: string;
  eventStatus: string;
  visibility: string;
  startsAt: Date | null;
  calendarDate: Date;
  /// Canonical hearing-level stream disposition rollup (committee_hearing.
  /// coverage_status). 'no_public_stream' / 'blocked' are TERMINAL,
  /// explicit dispositions in their own right — set by the demand-free
  /// disposition path (or the automatic resolver during normal capture
  /// flow) via classifyStreamResolution(), independent of whether any
  /// hearing_stream_candidate or public_hearing_capture row exists.
  coverageStatus: string;
}

interface CandidateRow {
  hearingId: string;
  capturePolicy: string;
  resolutionState: string;
  failureReason: string | null;
}

interface CaptureRow {
  id: string;
  hearingId: string;
  domainStatus: string;
  terminalReasonCode: string | null;
  failureCode: string | null;
  transcriptGapSeconds: number;
  gapLedgerCount: number;
}

interface CountByHearingRow {
  hearingId: string;
  count: number;
}

interface TranscriptRow {
  hearingId: string;
  captureId: string;
  segmentCount: number;
  gapMarkers: number;
}

interface DuplicateSequenceRow {
  hearingId: string;
  captureId: string;
  sequence: number;
  count: number;
}

interface RuntimeRow {
  jobKey: string;
  jobType: string;
  status: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  expectedIntervalSeconds: number | null;
  maxLagSeconds: number | null;
  lastStartedAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFinishedAt: Date | null;
  consecutiveFailures: number;
  lastError: string | null;
  metrics: unknown;
}

interface LaggingJobRow {
  queue: string;
  hearingId: string;
  status: string;
  count: number;
}

interface EvidenceRow {
  evidenceType: string;
  evidenceSource: string;
  status: string;
  observedAt: Date;
  expiresAt: Date | null;
  hearingId: string | null;
  captureId: string | null;
}

interface CutoverStateRow {
  captureAllPublicEvents: boolean;
}

interface Snapshot {
  bodies: BodyRow[];
  sources: SourceRow[];
  observations: ObservationRow[];
  hearings: HearingRow[];
  candidates: CandidateRow[];
  captures: CaptureRow[];
  demand: CountByHearingRow[];
  transcript: TranscriptRow[];
  duplicateSequences: DuplicateSequenceRow[];
  runtime: RuntimeRow[];
  laggingJobs: LaggingJobRow[];
  evidence: EvidenceRow[];
  captureAllPublicEvents: boolean;
}

@Injectable()
export class LegiWatchPhase9ReadinessService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(
    input: LegiWatchPhase9AuditOptions,
  ): Promise<LegiWatchPhase9ReadinessReport> {
    const now = validDate(input.now) ?? new Date();
    const lookbackDays = boundedInteger(input.lookbackDays ?? 60, 1, 365);
    const lookaheadDays = boundedInteger(input.lookaheadDays ?? 30, 1, 365);
    const captureGraceMinutes = boundedInteger(input.captureGraceMinutes ?? 15, 1, 24 * 60);
    const intelligenceLagMinutes = boundedInteger(
      input.intelligenceLagMinutes ?? 10,
      1,
      24 * 60,
    );
    const mode = input.mode ?? 'READINESS';
    const windowStart = new Date(now.getTime() - lookbackDays * 86_400_000);
    const windowEnd = new Date(now.getTime() + lookaheadDays * 86_400_000);
    const dueBefore = new Date(now.getTime() - captureGraceMinutes * 60_000);
    const intelligenceDueBefore = new Date(
      now.getTime() - intelligenceLagMinutes * 60_000,
    );

    const snapshot = await this.loadSnapshot({
      windowStart,
      windowEnd,
      intelligenceDueBefore,
      now,
    });
    const exceptions: LegiWatchPhase9Exception[] = [];
    const pushException = (exception: LegiWatchPhase9Exception): void => {
      if (exceptions.length < MAX_EXCEPTIONS) exceptions.push(exception);
    };

    const hearingsById = new Map(snapshot.hearings.map((row) => [row.id, row]));
    const candidatesByHearing = groupBy(snapshot.candidates, (row) => row.hearingId);
    const capturesByHearing = groupBy(snapshot.captures, (row) => row.hearingId);
    const demandByHearing = new Map(snapshot.demand.map((row) => [row.hearingId, row.count]));
    const transcriptByCapture = new Map(
      snapshot.transcript.map((row) => [row.captureId, row]),
    );
    const provenanceByHearing = new Map<string, number>();
    for (const observation of snapshot.observations) {
      if (observation.reconciliationStatus === 'RECONCILED' && observation.hearingId) {
        provenanceByHearing.set(
          observation.hearingId,
          (provenanceByHearing.get(observation.hearingId) ?? 0) + 1,
        );
      }
    }

    const observations = snapshot.observations.map((observation) => {
      if (observation.bodyCode) return observation;
      const hearing = observation.hearingId
        ? hearingsById.get(observation.hearingId)
        : undefined;
      return {
        ...observation,
        bodyCode:
          hearing?.subcommitteeSystemCode ?? hearing?.committeeSystemCode ?? null,
      };
    });
    const observationsByBody = groupBy(
      observations.filter((row) => Boolean(row.bodyCode)),
      (row) => row.bodyCode as string,
    );
    const hearingsByBody = groupBy(
      snapshot.hearings.filter(
        (row) => Boolean(row.subcommitteeSystemCode ?? row.committeeSystemCode),
      ),
      (row) => (row.subcommitteeSystemCode ?? row.committeeSystemCode) as string,
    );

    const directSources = groupBy(
      snapshot.sources.filter((source) => Boolean(source.committeeSystemCode)),
      (source) => source.committeeSystemCode as string,
    );
    const centralSources = snapshot.sources.filter(
      (source) => source.committeeSystemCode === null,
    );
    const bodies: LegiWatchPhase9BodyCoverage[] = snapshot.bodies.map((body) => {
      const direct = directSources.get(body.systemCode) ?? [];
      const parent = body.parentSystemCode
        ? directSources.get(body.parentSystemCode) ?? []
        : [];
      const central = centralSources.filter(
        (source) => source.chamber === body.chamber || source.chamber === 'joint',
      );
      const sources = direct.length ? direct : parent.length ? parent : central;
      const sourceInheritance = direct.length
        ? 'DIRECT'
        : parent.length
          ? 'PARENT'
          : central.length
            ? 'CENTRAL'
            : 'NONE';
      const bodyObservations = observationsByBody.get(body.systemCode) ?? [];
      const bodyHearings = hearingsByBody.get(body.systemCode) ?? [];
      const candidateRows = bodyHearings.flatMap(
        (hearing) => candidatesByHearing.get(hearing.id) ?? [],
      );
      const captureRows = bodyHearings.flatMap(
        (hearing) => capturesByHearing.get(hearing.id) ?? [],
      );
      const sourcesHealthy = sources.filter((source) =>
        HEALTHY_SOURCE_STATES.has(source.sourceHealth.toLowerCase()),
      ).length;
      const sourcesFailing = sources.filter(
        (source) =>
          FAILING_SOURCE_STATES.has(source.sourceHealth.toLowerCase()) &&
          !source.hasAcceptedException,
      ).length;
      const sourcesAcceptedException = sources.filter(
        (source) =>
          FAILING_SOURCE_STATES.has(source.sourceHealth.toLowerCase()) &&
          source.hasAcceptedException,
      ).length;
      const representedObservations = bodyObservations.filter(
        (row) => row.reconciliationStatus === 'RECONCILED' && Boolean(row.hearingId),
      ).length;
      const explicitConflicts = bodyObservations.filter(
        (row) => row.reconciliationStatus === 'CONFLICT',
      ).length;
      const pendingObservations = bodyObservations.filter(
        (row) => row.reconciliationStatus === 'PENDING',
      ).length;
      const classification = classifyBodyCoverage({
        sourcesRegistered: sources.length,
        sourcesHealthy,
        sourcesFailing,
        sourcesAcceptedException,
        officialObservations: bodyObservations.length,
        pendingObservations,
      });
      if (!['HEALTHY', 'HEALTHY_NO_EVENTS_OBSERVED', 'HEALTHY_WITH_ACCEPTED_EXCEPTION'].includes(classification.status)) {
        pushException({
          committeeSystemCode: body.systemCode,
          gateKey: 'SOURCE_COVERAGE_READY',
          status: 'FAIL',
          reasonCode: classification.reasonCode,
          details: {
            name: body.name,
            chamber: body.chamber,
            sourceInheritance,
            sourcesRegistered: sources.length,
            sourcesHealthy,
            sourcesFailing,
            sourcesAcceptedException,
            officialObservations: bodyObservations.length,
            pendingObservations,
          },
        });
      }
      const lastSourceSuccessAt = sources
        .map((source) => source.lastSuccessAt)
        .filter((value): value is Date => value instanceof Date)
        .sort((left, right) => right.getTime() - left.getTime())[0];
      return {
        systemCode: body.systemCode,
        name: body.name,
        chamber: body.chamber,
        parentSystemCode: body.parentSystemCode,
        isSubcommittee: Boolean(body.parentSystemCode),
        sourceInheritance,
        sourcesRegistered: sources.length,
        sourcesHealthy,
        sourcesFailing,
        lastSourceSuccessAt: lastSourceSuccessAt?.toISOString() ?? null,
        hearingsObserved: bodyHearings.length,
        officialObservations: bodyObservations.length,
        representedObservations,
        explicitConflicts,
        pendingObservations,
        streamCandidates: candidateRows.length,
        serverCaptureCandidates: candidateRows.filter(
          (row) => row.capturePolicy === 'SERVER_CAPTURE_ALLOWED',
        ).length,
        captureOutcomes: captureRows.filter((row) =>
          TERMINAL_CAPTURE_STATES.has(row.domainStatus),
        ).length,
        ...classification,
      };
    });

    const officialObservations = observations.length;
    const representedObservations = observations.filter(
      (row) => row.reconciliationStatus === 'RECONCILED' && Boolean(row.hearingId),
    ).length;
    const explicitConflicts = observations.filter(
      (row) => row.reconciliationStatus === 'CONFLICT',
    ).length;
    const ignoredInvalidObservations = observations.filter(
      (row) => row.reconciliationStatus === 'IGNORED_INVALID',
    ).length;
    const pendingObservations = observations.filter(
      (row) => row.reconciliationStatus === 'PENDING',
    ).length;
    for (const observation of observations) {
      if (observation.reconciliationStatus === 'PENDING') {
        pushException({
          observationId: observation.id,
          committeeSystemCode: observation.bodyCode ?? undefined,
          gateKey: 'OFFICIAL_OBSERVATIONS_DISPOSITIONED',
          status: 'FAIL',
          reasonCode: 'OFFICIAL_OBSERVATION_PENDING',
          details: { observedAt: observation.observedAt.toISOString() },
        });
      }
      if (!observation.bodyCode) {
        pushException({
          observationId: observation.id,
          gateKey: 'OFFICIAL_OBSERVATION_BODY_IDENTIFIED',
          status: 'FAIL',
          reasonCode: 'OBSERVATION_BODY_UNRESOLVED',
          details: {
            hearingId: observation.hearingId,
            reconciliationStatus: observation.reconciliationStatus,
          },
        });
      }
    }

    const canonicalEvents = snapshot.hearings.length;
    const canonicalEventsWithProvenance = snapshot.hearings.filter(
      (hearing) => (provenanceByHearing.get(hearing.id) ?? 0) > 0,
    ).length;
    const legacyOnlyCanonicalEvents = canonicalEvents - canonicalEventsWithProvenance;
    for (const hearing of snapshot.hearings) {
      if ((provenanceByHearing.get(hearing.id) ?? 0) === 0) {
        pushException({
          hearingId: hearing.id,
          committeeSystemCode:
            hearing.subcommitteeSystemCode ?? hearing.committeeSystemCode ?? undefined,
          gateKey: 'CANONICAL_PROVENANCE',
          status: 'FAIL',
          reasonCode: 'CANONICAL_EVENT_WITHOUT_OFFICIAL_OBSERVATION',
          details: {
            title: hearing.title,
            eventStatus: hearing.eventStatus,
            startsAt: hearing.startsAt?.toISOString() ?? null,
            calendarDate: hearing.calendarDate.toISOString(),
          },
        });
      }
    }

    const duplicateGroups = new Map<string, HearingRow[]>();
    for (const hearing of snapshot.hearings) {
      const key = canonicalEventFingerprint(hearing);
      const rows = duplicateGroups.get(key) ?? [];
      rows.push(hearing);
      duplicateGroups.set(key, rows);
    }
    const duplicateCanonicalGroups = [...duplicateGroups.values()].filter(
      (rows) => rows.length > 1,
    );
    const duplicateCanonicalEvents = duplicateCanonicalGroups.reduce(
      (sum, rows) => sum + rows.length - 1,
      0,
    );
    for (const rows of duplicateCanonicalGroups) {
      for (const hearing of rows) {
        pushException({
          hearingId: hearing.id,
          committeeSystemCode:
            hearing.subcommitteeSystemCode ?? hearing.committeeSystemCode ?? undefined,
          gateKey: 'NO_DUPLICATE_CANONICAL_EVENTS',
          status: 'FAIL',
          reasonCode: 'DUPLICATE_CANONICAL_EVENT_FINGERPRINT',
          details: { title: hearing.title, duplicateIds: rows.map((row) => row.id) },
        });
      }
    }

    const duplicateCaptureGroups = [...capturesByHearing.entries()].filter(
      ([, rows]) => rows.length > 1,
    );
    const duplicateGlobalCaptures = duplicateCaptureGroups.reduce(
      (sum, [, rows]) => sum + rows.length - 1,
      0,
    );
    for (const [hearingId, rows] of duplicateCaptureGroups) {
      pushException({
        hearingId,
        gateKey: 'ONE_GLOBAL_CAPTURE',
        status: 'FAIL',
        reasonCode: 'MULTIPLE_GLOBAL_CAPTURE_ROWS',
        details: { captureIds: rows.map((row) => row.id) },
      });
    }

    let duePublicEvents = 0;
    let eligibleEvents = 0;
    let eventsWithOutcomes = 0;
    let unresolvedEvents = 0;
    let captureFailures = 0;
    let capturesWithGaps = 0;
    let gapsWithoutMarkers = 0;
    for (const hearing of snapshot.hearings) {
      const effectiveStart = hearing.startsAt ?? hearing.calendarDate;
      const due = effectiveStart.getTime() <= dueBefore.getTime();
      const publicDue =
        due &&
        hearing.visibility === 'public' &&
        DUE_EVENT_STATUSES.has(hearing.eventStatus);
      if (!publicDue) continue;
      duePublicEvents += 1;
      const candidates = candidatesByHearing.get(hearing.id) ?? [];
      const captures = capturesByHearing.get(hearing.id) ?? [];
      const capture = captures[0];
      const demand = demandByHearing.get(hearing.id) ?? 0;
      // Capture-outcome eligibility must mirror the Phase 9 runtime contract:
      // scheduled stream-preflight only plans captures when capture_all is on
      // OR hearing demand exists. A SERVER_CAPTURE_ALLOWED candidate proves a
      // stream is technically capturable — NOT that the system was authorized
      // to capture it. Historical completed hearings discovered by the
      // disposition backfill get READY first-party candidates with demand=0;
      // counting them as "eligible but uncaptured" would make the outcome gate
      // permanently unpassable for events no capture could ever have covered.
      const eligible =
        snapshot.captureAllPublicEvents ||
        demand > 0 ||
        Boolean(capture);
      const explicitStreamPath =
        candidates.length > 0 ||
        Boolean(capture?.terminalReasonCode || capture?.failureCode) ||
        TERMINAL_HEARING_COVERAGE_STATUSES.has(hearing.coverageStatus);
      if (!explicitStreamPath) {
        unresolvedEvents += 1;
        pushException({
          hearingId: hearing.id,
          committeeSystemCode:
            hearing.subcommitteeSystemCode ?? hearing.committeeSystemCode ?? undefined,
          gateKey: 'STREAM_PATH_EXPLICIT',
          status: 'FAIL',
          reasonCode: 'DUE_PUBLIC_EVENT_WITHOUT_STREAM_DISPOSITION',
          details: { title: hearing.title, demand, captureAll: snapshot.captureAllPublicEvents },
        });
      }
      if (!eligible) continue;
      eligibleEvents += 1;
      const outcome = assessCaptureOutcome({
        captureStatus: capture?.domainStatus,
        terminalReasonCode: capture?.terminalReasonCode,
        failureCode: capture?.failureCode,
        candidates,
      });
      if (outcome.complete) {
        eventsWithOutcomes += 1;
      } else {
        pushException({
          hearingId: hearing.id,
          committeeSystemCode:
            hearing.subcommitteeSystemCode ?? hearing.committeeSystemCode ?? undefined,
          gateKey: 'CAPTURE_OUTCOMES_EXPLICIT',
          status: 'FAIL',
          reasonCode: outcome.reasonCode,
          details: {
            title: hearing.title,
            captureId: capture?.id ?? null,
            captureStatus: capture?.domainStatus ?? null,
            demand,
            candidatePolicies: candidates.map((candidate) => ({
              capturePolicy: candidate.capturePolicy,
              resolutionState: candidate.resolutionState,
              failureReason: candidate.failureReason,
            })),
          },
        });
      }
      if (capture && ['FAILED', 'BLOCKED'].includes(capture.domainStatus)) {
        captureFailures += 1;
      }
      if (capture && capture.transcriptGapSeconds > 0) {
        capturesWithGaps += 1;
        const transcript = transcriptByCapture.get(capture.id);
        if (capture.gapLedgerCount === 0 && (transcript?.gapMarkers ?? 0) === 0) {
          gapsWithoutMarkers += 1;
          pushException({
            hearingId: hearing.id,
            gateKey: 'GAP_MARKERS_DURABLE',
            status: 'FAIL',
            reasonCode: 'CAPTURE_GAP_WITHOUT_DURABLE_MARKER',
            details: {
              captureId: capture.id,
              transcriptGapSeconds: capture.transcriptGapSeconds,
            },
          });
        }
      }
    }

    const duplicateTranscriptSequences = snapshot.duplicateSequences.reduce(
      (sum, row) => sum + row.count - 1,
      0,
    );
    for (const row of snapshot.duplicateSequences) {
      pushException({
        hearingId: row.hearingId,
        gateKey: 'ONE_TRANSCRIPT_TIMELINE',
        status: 'FAIL',
        reasonCode: 'DUPLICATE_TRANSCRIPT_SEQUENCE',
        details: {
          captureId: row.captureId,
          sequence: row.sequence,
          count: row.count,
        },
      });
    }

    const runtimeByKey = new Map(snapshot.runtime.map((row) => [row.jobKey, row]));
    const runtimeJobs: LegiWatchPhase9RuntimeJob[] = LEGIWATCH_PHASE9_REQUIRED_JOB_KEYS.map(
      (jobKey) => {
        const row = runtimeByKey.get(jobKey);
        const stale = row
          ? !isRuntimeJobFresh({
              enabled: row.enabled,
              scheduleEnabled: row.scheduleEnabled,
              status: row.status,
              maxLagSeconds: row.maxLagSeconds,
              lastHeartbeatAt: row.lastHeartbeatAt,
              now,
            })
          : true;
        if (stale) {
          pushException({
            gateKey: 'JOB_FRESHNESS',
            status: 'FAIL',
            reasonCode: row ? 'RUNTIME_JOB_DISABLED_OR_STALE' : 'RUNTIME_JOB_NOT_REGISTERED',
            details: {
              jobKey,
              enabled: row?.enabled ?? false,
              scheduleEnabled: row?.scheduleEnabled ?? false,
              status: row?.status ?? 'missing',
              lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
              maxLagSeconds: row?.maxLagSeconds ?? null,
            },
          });
        }
        return mapRuntimeJob(row, jobKey, stale);
      },
    );
    const staleJobs = runtimeJobs.filter((job) => job.stale).length;
    const laggingIntelligenceJobs = snapshot.laggingJobs.reduce(
      (sum, row) => sum + row.count,
      0,
    );
    for (const row of snapshot.laggingJobs) {
      pushException({
        hearingId: row.hearingId,
        gateKey: 'INTELLIGENCE_LATENCY',
        status: 'FAIL',
        reasonCode: 'INTELLIGENCE_JOB_EXCEEDS_LATENCY_BUDGET',
        details: { queue: row.queue, status: row.status, count: row.count },
      });
    }

    const evidenceByType = new Map<string, EvidenceRow>();
    for (const row of snapshot.evidence) {
      if (!evidenceByType.has(row.evidenceType)) evidenceByType.set(row.evidenceType, row);
    }

    const parentBodies = bodies.filter((body) => !body.isSubcommittee).length;
    const subcommitteeBodies = bodies.filter((body) => body.isSubcommittee).length;
    const totalBodies = bodies.length;
    const bodyStatusExplicit = percentage(bodies.length, totalBodies);
    const observationDisposition = percentage(
      representedObservations + explicitConflicts + ignoredInvalidObservations,
      officialObservations,
    );
    const canonicalProvenance = percentage(
      canonicalEventsWithProvenance,
      canonicalEvents,
    );
    const captureOutcome = percentage(eventsWithOutcomes, eligibleEvents);
    const badBodies = bodies.filter(
      (body) =>
        !['HEALTHY', 'HEALTHY_NO_EVENTS_OBSERVED', 'HEALTHY_WITH_ACCEPTED_EXCEPTION'].includes(
          body.status,
        ),
    );

    const gates: LegiWatchPhase9Gate[] = [
      gate(
        'BODY_DIRECTORY_COMPLETE',
        totalBodies > 0 && parentBodies > 0 && subcommitteeBodies > 0,
        true,
        totalBodies,
        '> 0 parents and > 0 subcommittees',
        'CURRENT_COMMITTEE_DIRECTORY_INCOMPLETE',
        `${parentBodies} parent committee(s) and ${subcommitteeBodies} subcommittee(s) are represented.`,
      ),
      gate(
        'BODY_STATUS_EXPLICIT',
        bodyStatusExplicit === 100,
        true,
        bodyStatusExplicit,
        100,
        'BODY_STATUS_NOT_EXPLICIT',
        'Every current committee and subcommittee must receive an explicit coverage state.',
      ),
      gate(
        'SOURCE_COVERAGE_READY',
        badBodies.length === 0,
        true,
        totalBodies - badBodies.length,
        totalBodies,
        'BODY_SOURCE_COVERAGE_NOT_READY',
        `${badBodies.length} current body/bodies are unavailable, degraded, or require review.`,
      ),
      gate(
        'OFFICIAL_OBSERVATIONS_PRESENT',
        officialObservations > 0,
        true,
        officialObservations,
        '> 0',
        'ZERO_EVENT_EVIDENCE',
        'A zero-observation window is insufficient evidence and cannot pass coverage.',
      ),
      gate(
        'OFFICIAL_OBSERVATIONS_DISPOSITIONED',
        officialObservations > 0 && pendingObservations === 0 && observationDisposition === 100,
        true,
        observationDisposition,
        100,
        'OFFICIAL_OBSERVATION_DISPOSITION_INCOMPLETE',
        `${pendingObservations} official observation(s) remain pending.`,
      ),
      gate(
        'CANONICAL_PROVENANCE',
        canonicalEvents > 0 && legacyOnlyCanonicalEvents === 0,
        true,
        canonicalProvenance,
        100,
        'CANONICAL_EVENTS_MISSING_PROVENANCE',
        `${legacyOnlyCanonicalEvents} canonical event(s) have no reconciled official observation.`,
      ),
      gate(
        'NO_DUPLICATE_CANONICAL_EVENTS',
        duplicateCanonicalEvents === 0,
        true,
        duplicateCanonicalEvents,
        0,
        'DUPLICATE_CANONICAL_EVENTS',
        `${duplicateCanonicalEvents} duplicate canonical event row(s) were detected.`,
      ),
      gate(
        'ONE_GLOBAL_CAPTURE',
        duplicateGlobalCaptures === 0,
        true,
        duplicateGlobalCaptures,
        0,
        'DUPLICATE_GLOBAL_CAPTURES',
        `${duplicateGlobalCaptures} duplicate global capture row(s) were detected.`,
      ),
      gate(
        'STREAM_PATH_EXPLICIT',
        unresolvedEvents === 0,
        true,
        unresolvedEvents,
        0,
        'DUE_EVENTS_WITHOUT_STREAM_DISPOSITION',
        `${unresolvedEvents} due public event(s) have no explicit stream/capture disposition.`,
      ),
      gate(
        'CAPTURE_OUTCOMES_EXPLICIT',
        eligibleEvents > 0 && eventsWithOutcomes === eligibleEvents,
        true,
        captureOutcome,
        100,
        'ELIGIBLE_CAPTURE_OUTCOME_INCOMPLETE',
        `${eligibleEvents - eventsWithOutcomes} eligible event(s) lack a terminal capture result or explicit non-capture reason.`,
      ),
      gate(
        'GAP_MARKERS_DURABLE',
        gapsWithoutMarkers === 0,
        true,
        gapsWithoutMarkers,
        0,
        'TRANSCRIPT_GAP_MARKER_MISSING',
        `${gapsWithoutMarkers} capture(s) record gap duration without a durable gap ledger/marker.`,
      ),
      gate(
        'ONE_TRANSCRIPT_TIMELINE',
        duplicateTranscriptSequences === 0,
        true,
        duplicateTranscriptSequences,
        0,
        'DUPLICATE_TRANSCRIPT_SEQUENCE',
        `${duplicateTranscriptSequences} duplicate transcript sequence row(s) were detected.`,
      ),
      gate(
        'JOB_FRESHNESS',
        staleJobs === 0,
        true,
        staleJobs,
        0,
        'RUNTIME_JOBS_DISABLED_OR_STALE',
        `${staleJobs} required job(s) are disabled, unscheduled, missing, failed, or stale.`,
      ),
      gate(
        'INTELLIGENCE_LATENCY',
        laggingIntelligenceJobs === 0,
        true,
        laggingIntelligenceJobs,
        0,
        'INTELLIGENCE_QUEUE_LAG',
        `${laggingIntelligenceJobs} intelligence/relevance job(s) exceed the latency budget.`,
      ),
      gate(
        'REAL_EVIDENCE_SOURCE',
        input.evidenceSource !== 'NONE',
        true,
        input.evidenceSource,
        'LIVE, OFFICIAL_ARCHIVE, LOCAL_FIXTURE, or MIXED',
        'EVIDENCE_SOURCE_NOT_STATED',
        'Every readiness run must state whether evidence is live, archive, fixture, or mixed.',
      ),
      gate(
        'LIVE_CUTOVER_EVIDENCE_SOURCE',
        evidenceSourceSatisfiesCutover(input.evidenceSource),
        mode === 'CUTOVER_VERIFICATION',
        input.evidenceSource,
        'LIVE or MIXED',
        'CUTOVER_REQUIRES_LIVE_EVIDENCE',
        'Production cutover cannot rely only on archive or local-fixture evidence.',
      ),
    ];

    for (const evidenceType of requiredEvidenceTypes(mode)) {
      const evidence = evidenceByType.get(evidenceType);
      const requiresLive = evidenceType.startsWith('LIVE_');
      const sourceReady =
        !requiresLive ||
        evidence?.evidenceSource === 'LIVE' ||
        evidence?.evidenceSource === 'MIXED';
      const passed = Boolean(evidence && evidence.status === 'PASS' && sourceReady);
      gates.push(
        gate(
          `EVIDENCE_${evidenceType}`,
          passed,
          true,
          evidence
            ? `${evidence.evidenceSource}:${evidence.observedAt.toISOString()}`
            : null,
          requiresLive ? 'non-expired LIVE/MIXED PASS' : 'non-expired PASS',
          'REQUIRED_VERIFICATION_EVIDENCE_MISSING',
          passed
            ? `${evidenceType} has current passing evidence.`
            : `${evidenceType} lacks current, source-appropriate passing evidence.`,
        ),
      );
      if (!passed) {
        pushException({
          hearingId: evidence?.hearingId ?? undefined,
          gateKey: `EVIDENCE_${evidenceType}`,
          status: 'FAIL',
          reasonCode: 'REQUIRED_VERIFICATION_EVIDENCE_MISSING',
          details: {
            evidenceType,
            requiresLive,
            latestSource: evidence?.evidenceSource ?? null,
            latestObservedAt: evidence?.observedAt.toISOString() ?? null,
          },
        });
      }
    }

    const status = deriveRunStatus({
      mode,
      evidenceSource: input.evidenceSource,
      officialObservations,
      canonicalEvents,
      gates,
    });
    const blockers = unique(
      gates
        .filter((item) => item.required && item.status !== 'PASS')
        .map((item) => `${item.key}: ${item.message}`),
    );
    const counts = {
      parentBodies,
      subcommitteeBodies,
      totalBodies,
      officialObservations,
      representedObservations,
      explicitConflicts,
      ignoredInvalidObservations,
      pendingObservations,
      canonicalEvents,
      canonicalEventsWithProvenance,
      legacyOnlyCanonicalEvents,
      duePublicEvents,
      eligibleEvents,
      eventsWithOutcomes,
      duplicateCanonicalEvents,
      duplicateGlobalCaptures,
      unresolvedEvents,
      captureFailures,
      capturesWithGaps,
      gapsWithoutMarkers,
      duplicateTranscriptSequences,
      staleJobs,
      laggingIntelligenceJobs,
    };
    return {
      generatedAt: now.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      mode,
      evidenceSource: input.evidenceSource,
      status,
      counts,
      percentages: {
        bodyStatusExplicit,
        observationDisposition,
        canonicalProvenance,
        captureOutcome,
      },
      gates,
      bodies,
      blockers,
      exceptions,
      summary: {
        sourceCoverageReady: badBodies.length === 0,
        officialCorpusRepresented:
          officialObservations > 0 && pendingObservations === 0 && observationDisposition === 100,
        capturePathReady:
          unresolvedEvents === 0 && eligibleEvents > 0 && eventsWithOutcomes === eligibleEvents,
        transcriptContinuityReady:
          gapsWithoutMarkers === 0 && duplicateTranscriptSequences === 0,
        workersFresh: staleJobs === 0,
        intelligenceFresh: laggingIntelligenceJobs === 0,
        cutoverEligible: status === 'PASS' && mode === 'CUTOVER_VERIFICATION',
      },
    };
  }

  async evaluateAndPersist(
    actor: string,
    input: LegiWatchPhase9AuditOptions,
  ): Promise<{ report: LegiWatchPhase9ReadinessReport; run: LegiWatchPhase9PersistedRun }> {
    const report = await this.evaluate(input);
    const run = await this.prisma.withSystem(
      async (tx) => {
        const rows = await tx.$queryRawUnsafe<
          Array<{ id: string; mode: string; status: string; evidenceSource: string; createdAt: Date }>
        >(
          `INSERT INTO legiwatch_cutover_run (
             mode, status, evidence_source, window_start, window_end,
             parent_bodies, subcommittee_bodies, total_bodies,
             official_observations, represented_observations, explicit_conflicts,
             eligible_events, events_with_outcomes, duplicate_canonical_events,
             duplicate_global_captures, unresolved_events, stale_jobs,
             lagging_intelligence_jobs, blocker_count, summary, blockers,
             created_by, created_at
           ) VALUES (
             $1, $2, $3, $4::timestamptz, $5::timestamptz,
             $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
             $19, $20::jsonb, $21::text[], $22, now()
           )
           RETURNING id::text AS id,
                     mode,
                     status,
                     evidence_source AS "evidenceSource",
                     created_at AS "createdAt"`,
          report.mode,
          report.status,
          report.evidenceSource,
          report.windowStart,
          report.windowEnd,
          report.counts.parentBodies,
          report.counts.subcommitteeBodies,
          report.counts.totalBodies,
          report.counts.officialObservations,
          report.counts.representedObservations,
          report.counts.explicitConflicts,
          report.counts.eligibleEvents,
          report.counts.eventsWithOutcomes,
          report.counts.duplicateCanonicalEvents,
          report.counts.duplicateGlobalCaptures,
          report.counts.unresolvedEvents,
          report.counts.staleJobs,
          report.counts.laggingIntelligenceJobs,
          report.blockers.length,
          JSON.stringify({
            counts: report.counts,
            percentages: report.percentages,
            gates: report.gates,
            summary: report.summary,
          }),
          report.blockers,
          boundedText(actor, 200),
        );
        const row = rows[0];
        if (!row) throw new Error('Phase 9 readiness run did not persist');

        for (const exception of report.exceptions) {
          await tx.$executeRawUnsafe(
            `INSERT INTO legiwatch_event_audit (
               run_id, hearing_id, observation_id, committee_system_code,
               gate_key, status, reason_code, details, created_at
             ) VALUES (
               $1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, now()
             )`,
            row.id,
            exception.hearingId ?? null,
            exception.observationId ?? null,
            exception.committeeSystemCode ?? null,
            exception.gateKey,
            exception.status,
            exception.reasonCode,
            JSON.stringify(exception.details),
          );
        }

        await tx.$executeRawUnsafe(
          `UPDATE legiwatch_cutover_state
           SET last_run_id=$1::uuid,
               last_passing_run_id=CASE WHEN $2='PASS' THEN $1::uuid ELSE last_passing_run_id END,
               consecutive_passes=CASE WHEN $2='PASS' THEN consecutive_passes+1 ELSE 0 END,
               updated_by=$3,
               updated_at=now()
           WHERE id='global'`,
          row.id,
          report.status,
          boundedText(actor, 200),
        );

        return {
          id: row.id,
          mode: row.mode as LegiWatchPhase9PersistedRun['mode'],
          status: row.status as LegiWatchPhase9PersistedRun['status'],
          evidenceSource: row.evidenceSource as LegiWatchPhase9PersistedRun['evidenceSource'],
          createdAt: row.createdAt.toISOString(),
        };
      },
      { timeoutMs: READINESS_PERSIST_TIMEOUT_MS },
    );
    return { report, run };
  }

  async listRecentRuns(limit = 25): Promise<Array<Record<string, unknown>>> {
    const boundedLimit = boundedInteger(limit, 1, 200);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        mode: string;
        status: string;
        evidenceSource: string;
        blockerCount: number;
        summary: unknown;
        blockers: string[];
        createdBy: string;
        createdAt: Date;
      }>
    >(
      `SELECT id::text AS id,
              mode,
              status,
              evidence_source AS "evidenceSource",
              blocker_count AS "blockerCount",
              summary,
              blockers,
              created_by AS "createdBy",
              created_at AS "createdAt"
       FROM legiwatch_cutover_run
       ORDER BY created_at DESC, id DESC
       LIMIT $1`,
      boundedLimit,
    );
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async getRun(runId: string): Promise<Record<string, unknown>> {
    const rows = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id::text AS id,
              mode,
              status,
              evidence_source AS "evidenceSource",
              window_start AS "windowStart",
              window_end AS "windowEnd",
              summary,
              blockers,
              created_by AS "createdBy",
              created_at AS "createdAt"
       FROM legiwatch_cutover_run
       WHERE id=$1::uuid
       LIMIT 1`,
      runId,
    );
    const row = rows[0];
    if (!row) throw new NotFoundException(`Phase 9 run ${runId} not found`);
    const exceptions = await this.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT id::text AS id,
              hearing_id AS "hearingId",
              observation_id AS "observationId",
              committee_system_code AS "committeeSystemCode",
              gate_key AS "gateKey",
              status,
              reason_code AS "reasonCode",
              details,
              created_at AS "createdAt"
       FROM legiwatch_event_audit
       WHERE run_id=$1::uuid
       ORDER BY gate_key, created_at, id`,
      runId,
    );
    return { ...row, exceptions };
  }

  async dispositionObservation(input: {
    observationId: string;
    disposition: 'CONFLICT' | 'IGNORED_INVALID';
    reasonCode: string;
    actor: string;
  }): Promise<Record<string, unknown>> {
    const reasonCode = boundedReasonCode(input.reasonCode);
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        id: string;
        status: string;
        reasonCode: string;
        reviewedAt: Date;
        reviewedBy: string;
      }>
    >(
      `UPDATE hearing_source_observation
       SET reconciliation_status=$2,
           reconciliation_reason_code=$3,
           reconciliation_reviewed_at=now(),
           reconciliation_reviewed_by=$4,
           updated_at=now()
       WHERE id=$1::uuid
         AND hearing_id IS NULL
         AND reconciliation_status='PENDING'
       RETURNING id::text AS id,
                 reconciliation_status AS status,
                 reconciliation_reason_code AS "reasonCode",
                 reconciliation_reviewed_at AS "reviewedAt",
                 reconciliation_reviewed_by AS "reviewedBy"`,
      input.observationId,
      input.disposition,
      reasonCode,
      boundedText(input.actor, 200),
    );
    const row = rows[0];
    if (!row) {
      throw new NotFoundException(
        `pending unlinked observation ${input.observationId} not found`,
      );
    }
    return { ...row, reviewedAt: row.reviewedAt.toISOString() };
  }

  private async loadSnapshot(input: {
    windowStart: Date;
    windowEnd: Date;
    intelligenceDueBefore: Date;
    now: Date;
  }): Promise<Snapshot> {
    // This read-only transaction gathers bodies/sources/observations/
    // candidates/captures across the full lookback window. As the historical
    // disposition backlog is worked down (more hearings carry candidate/
    // capture join rows), its real Aurora duration grows past Prisma's
    // default 5000ms interactive-transaction timeout even though no query is
    // individually slow — confirmed live 2026-08-30 (two consecutive runs at
    // 5642ms/6012ms). Reuse the same escape hatch already applied to the
    // persist transaction below (READINESS_PERSIST_TIMEOUT_MS) rather than
    // inventing a second constant for what is the same underlying tradeoff.
    return this.prisma.withSystem(async (tx) => {
      const bodies = await tx.$queryRawUnsafe<BodyRow[]>(
        `SELECT system_code AS "systemCode",
                name,
                chamber,
                parent_system_code AS "parentSystemCode"
         FROM congress_committee
         WHERE is_current=true
         ORDER BY chamber, parent_system_code NULLS FIRST, name, system_code`,
      );
      const sources = await tx.$queryRawUnsafe<SourceRow[]>(
        `SELECT s.id::text AS id,
                s.committee_system_code AS "committeeSystemCode",
                s.chamber,
                s.source_health AS "sourceHealth",
                s.last_success_at AS "lastSuccessAt",
                (ex.id IS NOT NULL) AS "hasAcceptedException",
                ex.exception_type AS "exceptionType",
                ex.reason_code AS "exceptionReasonCode"
         FROM committee_source s
         LEFT JOIN committee_source_exception ex
           ON ex.source_id = s.id AND ex.expires_at IS NULL
         WHERE s.enabled=true
         ORDER BY s.priority, s.id`,
      );
      const observations = await tx.$queryRawUnsafe<ObservationRow[]>(
        `SELECT o.id::text AS id,
                o.hearing_id AS "hearingId",
                COALESCE(
                  NULLIF(o.source_metadata #>> '{event,subcommitteeSystemCode}', ''),
                  NULLIF(o.source_metadata #>> '{event,committeeSystemCode}', '')
                ) AS "bodyCode",
                o.reconciliation_status AS "reconciliationStatus",
                o.reconciliation_reason_code AS "reconciliationReasonCode",
                COALESCE(
                  NULLIF(o.source_metadata #>> '{event,startsAt}', '')::timestamptz,
                  o.observed_date::timestamptz,
                  o.first_seen_at
                ) AS "observedAt"
         FROM hearing_source_observation o
         WHERE COALESCE(
                 NULLIF(o.source_metadata #>> '{event,startsAt}', '')::timestamptz,
                 o.observed_date::timestamptz,
                 o.first_seen_at
               ) BETWEEN $1 AND $2
         ORDER BY "observedAt", o.id`,
        input.windowStart,
        input.windowEnd,
      );
      const hearings = await tx.$queryRawUnsafe<HearingRow[]>(
        `SELECT id,
                chamber,
                committee_system_code AS "committeeSystemCode",
                subcommittee_system_code AS "subcommitteeSystemCode",
                title,
                event_status AS "eventStatus",
                visibility,
                starts_at AS "startsAt",
                date::timestamp AS "calendarDate",
                coverage_status AS "coverageStatus"
         FROM committee_hearing
         WHERE COALESCE(starts_at, date::timestamp) BETWEEN $1 AND $2
         ORDER BY COALESCE(starts_at, date::timestamp), id`,
        input.windowStart,
        input.windowEnd,
      );
      const hearingIds = hearings.map((row) => row.id);
      const candidates = hearingIds.length
        ? await tx.$queryRawUnsafe<CandidateRow[]>(
            `SELECT hearing_id AS "hearingId",
                    capture_policy AS "capturePolicy",
                    resolution_state AS "resolutionState",
                    failure_reason AS "failureReason"
             FROM hearing_stream_candidate
             WHERE hearing_id = ANY($1::text[])
             ORDER BY hearing_id, priority, id`,
            hearingIds,
          )
        : [];
      const captures = hearingIds.length
        ? await tx.$queryRawUnsafe<CaptureRow[]>(
            `SELECT id,
                    hearing_id AS "hearingId",
                    domain_status AS "domainStatus",
                    terminal_reason_code AS "terminalReasonCode",
                    failure_code AS "failureCode",
                    transcript_gap_seconds AS "transcriptGapSeconds",
                    CASE
                      WHEN jsonb_typeof(gaps)='array' THEN jsonb_array_length(gaps)
                      ELSE 0
                    END::int AS "gapLedgerCount"
             FROM public_hearing_capture
             WHERE hearing_id = ANY($1::text[])
             ORDER BY hearing_id, id`,
            hearingIds,
          )
        : [];
      const demand = hearingIds.length
        ? await tx.$queryRawUnsafe<CountByHearingRow[]>(
            `SELECT hearing_id AS "hearingId", COUNT(*)::int AS count
             FROM hearing_subscription
             WHERE hearing_id = ANY($1::text[])
             GROUP BY hearing_id`,
            hearingIds,
          )
        : [];
      const transcript = hearingIds.length
        ? await tx.$queryRawUnsafe<TranscriptRow[]>(
            `SELECT c.hearing_id AS "hearingId",
                    s.capture_id AS "captureId",
                    COUNT(*)::int AS "segmentCount",
                    COUNT(*) FILTER (WHERE s.has_gap_before=true)::int AS "gapMarkers"
             FROM public_hearing_transcript_segment s
             JOIN public_hearing_capture c ON c.id=s.capture_id
             WHERE c.hearing_id = ANY($1::text[])
             GROUP BY c.hearing_id, s.capture_id`,
            hearingIds,
          )
        : [];
      const duplicateSequences = hearingIds.length
        ? await tx.$queryRawUnsafe<DuplicateSequenceRow[]>(
            `SELECT c.hearing_id AS "hearingId",
                    s.capture_id AS "captureId",
                    s.sequence,
                    COUNT(*)::int AS count
             FROM public_hearing_transcript_segment s
             JOIN public_hearing_capture c ON c.id=s.capture_id
             WHERE c.hearing_id = ANY($1::text[])
             GROUP BY c.hearing_id, s.capture_id, s.sequence
             HAVING COUNT(*) > 1
             ORDER BY c.hearing_id, s.capture_id, s.sequence`,
            hearingIds,
          )
        : [];
      const runtime = await tx.$queryRawUnsafe<RuntimeRow[]>(
        `SELECT job_key AS "jobKey",
                job_type AS "jobType",
                status,
                enabled,
                schedule_enabled AS "scheduleEnabled",
                expected_interval_seconds AS "expectedIntervalSeconds",
                max_lag_seconds AS "maxLagSeconds",
                last_started_at AS "lastStartedAt",
                last_heartbeat_at AS "lastHeartbeatAt",
                last_success_at AS "lastSuccessAt",
                last_failure_at AS "lastFailureAt",
                last_finished_at AS "lastFinishedAt",
                consecutive_failures AS "consecutiveFailures",
                last_error AS "lastError",
                metrics
         FROM legiwatch_runtime_heartbeat
         ORDER BY job_key`,
      );
      const laggingJobs = await tx.$queryRawUnsafe<LaggingJobRow[]>(
        `SELECT 'public'::text AS queue,
                hearing_id AS "hearingId",
                status,
                COUNT(*)::int AS count
         FROM public_hearing_intelligence_job
         WHERE (
           status IN ('pending','failed') AND due_at < $1
         ) OR (
           status='leased' AND lease_expires_at < $2
         )
         GROUP BY hearing_id, status
         UNION ALL
         SELECT 'tenant'::text AS queue,
                hearing_id AS "hearingId",
                status,
                COUNT(*)::int AS count
         FROM tenant_hearing_relevance_job
         WHERE (
           status IN ('pending','failed') AND due_at < $1
         ) OR (
           status='leased' AND lease_expires_at < $2
         )
         GROUP BY hearing_id, status
         ORDER BY "hearingId", queue, status`,
        input.intelligenceDueBefore,
        input.now,
      );
      const evidence = await tx.$queryRawUnsafe<EvidenceRow[]>(
        `SELECT evidence_type AS "evidenceType",
                evidence_source AS "evidenceSource",
                status,
                observed_at AS "observedAt",
                expires_at AS "expiresAt",
                hearing_id AS "hearingId",
                capture_id AS "captureId"
         FROM legiwatch_verification_evidence
         WHERE status='PASS'
           AND (expires_at IS NULL OR expires_at > $1)
         ORDER BY evidence_type, observed_at DESC, id DESC`,
        input.now,
      );
      const cutoverRows = await tx.$queryRawUnsafe<CutoverStateRow[]>(
        `SELECT capture_all_public_events AS "captureAllPublicEvents"
         FROM legiwatch_cutover_state
         WHERE id='global'
         LIMIT 1`,
      );
      return {
        bodies,
        sources,
        observations,
        hearings,
        candidates,
        captures,
        demand,
        transcript,
        duplicateSequences,
        runtime,
        laggingJobs,
        evidence,
        captureAllPublicEvents: cutoverRows[0]?.captureAllPublicEvents ?? false,
      };
    }, { timeoutMs: READINESS_PERSIST_TIMEOUT_MS });
  }
}

function gate(
  key: string,
  passed: boolean,
  required: boolean,
  measured: number | string | boolean | null,
  target: number | string | boolean,
  reasonCode: string,
  message: string,
): LegiWatchPhase9Gate {
  return {
    key,
    status: passed ? 'PASS' : required ? 'FAIL' : 'NOT_APPLICABLE',
    required,
    measured,
    target,
    reasonCode: passed ? 'GATE_SATISFIED' : reasonCode,
    message,
  };
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const output = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const values = output.get(key) ?? [];
    values.push(row);
    output.set(key, values);
  }
  return output;
}

function mapRuntimeJob(
  row: RuntimeRow | undefined,
  jobKey: string,
  stale: boolean,
): LegiWatchPhase9RuntimeJob {
  return {
    jobKey,
    jobType: row?.jobType ?? 'missing',
    status: row?.status ?? 'missing',
    enabled: row?.enabled ?? false,
    scheduleEnabled: row?.scheduleEnabled ?? false,
    expectedIntervalSeconds: row?.expectedIntervalSeconds ?? null,
    maxLagSeconds: row?.maxLagSeconds ?? null,
    lastStartedAt: row?.lastStartedAt?.toISOString() ?? null,
    lastHeartbeatAt: row?.lastHeartbeatAt?.toISOString() ?? null,
    lastSuccessAt: row?.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: row?.lastFailureAt?.toISOString() ?? null,
    lastFinishedAt: row?.lastFinishedAt?.toISOString() ?? null,
    consecutiveFailures: row?.consecutiveFailures ?? 0,
    lastError: row?.lastError ?? null,
    metrics: safeRecord(row?.metrics),
    stale,
  };
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validDate(value: Date | undefined): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function boundedText(value: string, maximum: number): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, maximum);
  if (!clean) throw new Error('actor is required');
  return clean;
}

function boundedReasonCode(value: string): string {
  const clean = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_:-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160);
  if (!clean) throw new Error('reasonCode is required');
  return clean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
