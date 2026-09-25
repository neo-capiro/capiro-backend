/**
 * Defense Budget lifecycle/source-coverage reads, served from `apps/api` —
 * the deployed, ALB-routed service — rather than `apps/defense-api`'s
 * `budget-lifecycle-product` module, which has no ECS service, no ALB target
 * group and no task-def anywhere in this repo (see
 * `docs/defense-budget/defense-budget-vnext-implementation-map.md` §2).
 *
 * This is a port, not a reimplementation: the query shapes, the DTO mapping
 * and the pure `@capiro/defense-domain` functions (`buildCycleHealth`,
 * `deriveLifecycleSignals`, `buildScheduleTickHealth`) are the exact ones
 * `apps/defense-api/src/budget-lifecycle-product/budget-lifecycle-query.service.ts`
 * already uses and already has DB-rehearsed. The only thing that changes is
 * the store: that module reads via `$queryRawUnsafe` because its own curated
 * Prisma client deliberately excludes these tables
 * (`apps/defense-api/prisma/defense-model-subset.json`); `apps/api`'s Prisma
 * client has no such exclusion, and `apps/api/prisma/schema.prisma` already
 * carries fully-typed models for every table below, so this reads them
 * through the typed client instead.
 *
 * These tables carry no `tenant_id` (official government budget documents are
 * global reference data, the same posture as `Program`/`ProgramAlias`), so
 * reading them needs no tenant scope and no `withSystem` bypass — only
 * `DefenseBudgetLifecycleInternalGuard`'s own tenant-identity check does.
 *
 * Every method here is a SELECT. Nothing here writes anything, calls a
 * watcher/scheduler/provider, or resolves a review hold — resolution runs
 * through `scripts/run-review-resolution.mjs` as `capiro_defense_job`, never
 * through this HTTP path.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  buildCycleHealth,
  buildScheduleTickHealth,
  deriveLifecycleSignals,
  buildCoverageReconciliation,
  type AuthorityTrack,
  type ExpectedSourceState,
  type LifecycleObservationRef,
  type LifecycleStage,
  type ObservationState,
  type SourceFamily,
  type ReconciliationUnit,
} from '@capiro/defense-domain';
import {
  DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION,
  type DefenseCycleHealthDto,
  type DefenseExpectedSourceDetailDto,
  type DefenseExpectedSourceListItemDto,
  type DefenseLifecycleSignalDto,
  type DefenseReviewQueueItemDto,
  type DefenseScheduleTickHealthDto,
  type DefenseSourceObservationDto,
} from '@capiro/defense-contracts';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

const SCHEDULE_TICK_HISTORY_LIMIT = 500;

type ExpectedSourceRow = Prisma.DefenseBudgetExpectedSourceGetPayload<Record<string, never>>;

type ObservationRow = Prisma.DefenseBudgetSourceObservationGetPayload<{
  include: { expectedSource: true; supersedes: { select: { dedupKey: true } } };
}>;

function toExpectedSourceListItem(source: ExpectedSourceRow): DefenseExpectedSourceListItemDto {
  return {
    id: source.id,
    fiscalYear: source.fiscalYear,
    authorityTrack: source.authorityTrack as AuthorityTrack,
    stage: source.stage as LifecycleStage,
    sourceFamily: source.sourceFamily as SourceFamily,
    adapterId: source.adapterId,
    label: source.label,
    expectedState: source.expectedState as ExpectedSourceState,
    optional: source.optional,
    expectedTo: source.expectedTo.toISOString(),
    reviewReason: source.reviewReason,
    knownFundingPosition: null,
  };
}

function toObservationDto(observation: ObservationRow): DefenseSourceObservationDto {
  const reviewReasons = Array.isArray(observation.reviewReasons)
    ? (observation.reviewReasons as unknown[]).filter((r): r is string => typeof r === 'string')
    : [];
  return {
    schemaVersion: DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION,
    fiscalYear: observation.expectedSource.fiscalYear,
    authorityTrack: observation.expectedSource.authorityTrack as AuthorityTrack,
    stage: observation.expectedSource.stage as LifecycleStage,
    sourceFamily: observation.expectedSource.sourceFamily as SourceFamily,
    adapterId: observation.adapterId,
    discoveredUrl: observation.discoveredUrl,
    contentSha256: observation.contentSha256,
    byteSize: observation.byteSize,
    httpEtag: observation.httpEtag,
    httpLastModified: observation.httpLastModified,
    observationState: observation.observationState as ObservationState,
    classificationConfidence:
      observation.classificationConfidence === null
        ? null
        : Number(observation.classificationConfidence),
    reviewReasons: Object.freeze(reviewReasons),
    sourceDocumentId: observation.sourceDocumentId,
    supersededByObservationId: observation.supersededByObservationId,
    firstSeenAt: observation.firstSeenAt.toISOString(),
    lastSeenAt: observation.lastSeenAt.toISOString(),
    seenCount: observation.seenCount,
  };
}

const OBSERVATION_INCLUDE = {
  expectedSource: true,
  supersedes: { select: { dedupKey: true } as const, take: 1 },
} satisfies Prisma.DefenseBudgetSourceObservationInclude;

@Injectable()
export class DefenseBudgetLifecycleReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** SELECT-only physical coverage report. Catalog completeness is unattested in the live schema. */
  async getCoverageReconciliation(fiscalYear: number) {
    const environment = process.env.APP_ENV?.trim() || process.env.CAPIRO_ENVIRONMENT?.trim() || 'unknown';
    const [sources, observations, members, pointer] = await Promise.all([
      this.prisma.defenseBudgetExpectedSource.findMany({ where: { fiscalYear },
        orderBy: [{ sourceFamily: 'asc' }, { component: 'asc' }, { id: 'asc' }] }),
      this.prisma.defenseBudgetSourceObservation.findMany({
        where: { expectedSource: { fiscalYear } },
        select: { id: true, expectedSourceId: true, sourceDocumentId: true,
          contentSha256: true, supersededByObservationId: true, observationState: true },
      }),
      this.prisma.defenseBudgetSourceBundleMember.findMany({
        where: { expectedSource: { fiscalYear } },
        select: { id: true, expectedSourceId: true, required: true, budgetActivity: true,
          volume: true,
          observationId: true, sourceDocumentId: true, memberStatus: true },
      }),
      environment !== 'unknown' ? this.prisma.defenseBudgetActiveSnapshot.findUnique({
        where: { domain_environment: { domain: 'defense_budget', environment } },
        select: { snapshotId: true },
      }) : Promise.resolve(null),
    ]);
    const observationById = new Map(observations.map((row) => [row.id, row]));
    const linkedObservationIds = new Set(members.flatMap((member) => member.observationId ? [member.observationId] : []));
    const units: ReconciliationUnit[] = members.map((member) => {
      const observation = member.observationId ? observationById.get(member.observationId) : null;
      return { unitId: member.id, slotId: member.expectedSourceId, kind: 'volume',
        required: member.required, account: null, budgetActivity: member.budgetActivity,
        volume: member.volume,
        sourceDocumentId: member.sourceDocumentId,
        sourceSha256: observation?.sourceDocumentId === member.sourceDocumentId
          ? observation?.contentSha256 ?? null : null,
        superseded: observation?.supersededByObservationId !== null && observation !== undefined,
        unavailable: observation?.observationState === 'blocked'
          || observation?.observationState === 'withdrawn' };
    });
    const seenDocumentKeys = new Set<string>();
    for (const observation of observations) {
      if (linkedObservationIds.has(observation.id)) continue;
      const identity = `${observation.expectedSourceId}:${observation.sourceDocumentId ?? observation.id}:${observation.contentSha256}`;
      if (observation.supersededByObservationId === null && seenDocumentKeys.has(identity)) continue;
      if (observation.supersededByObservationId === null) seenDocumentKeys.add(identity);
      units.push({ unitId: observation.id, slotId: observation.expectedSourceId, kind: 'document',
        required: true, account: null, budgetActivity: null, volume: null,
        sourceDocumentId: observation.sourceDocumentId,
        sourceSha256: observation.contentSha256,
        superseded: observation.supersededByObservationId !== null,
        unavailable: observation.observationState === 'blocked'
          || observation.observationState === 'withdrawn' });
    }
    const documentIds = [...new Set(units.flatMap((unit) => unit.sourceDocumentId ? [unit.sourceDocumentId] : []))];
    const [candidateRows, publishedRows] = await Promise.all([
      documentIds.length ? this.prisma.budgetExtractionCandidateV1.findMany({
        where: { sourceDocumentId: { in: documentIds } },
        select: { id: true, sourceDocumentId: true, sourceSha256: true, currentRunId: true,
          runs: { select: { id: true, decision: true } },
          reviewDecisions: { orderBy: { createdAt: 'desc' }, select: { runId: true, decision: true } },
        },
      }) : Promise.resolve([]),
      pointer && documentIds.length ? this.prisma.defenseBudgetCanonicalRow.findMany({
        where: { snapshotId: pointer.snapshotId, sourceDocumentId: { in: documentIds }, fiscalYear },
        select: { sourceDocumentId: true, sourcePdfSha256: true,
          verificationCandidateId: true, verificationRunId: true },
      }) : Promise.resolve([]),
    ]);
    return buildCoverageReconciliation({ fiscalYear, environment,
      activeSnapshotId: pointer?.snapshotId ?? null,
      slots: sources.map((source) => ({ slotId: source.id, fiscalYear,
        sourceFamily: source.sourceFamily, component: source.component,
        optional: source.optional, catalogComplete: false })),
      units,
      candidates: candidateRows.map((candidate) => {
        const run = candidate.runs.find((entry) => entry.id === candidate.currentRunId);
        return run ? { candidateId: candidate.id,
          sourceDocumentId: candidate.sourceDocumentId, sourceSha256: candidate.sourceSha256,
          runId: run.id, verificationDecision: run.decision as 'PASS' | 'REVIEW' | 'REJECT',
          reviewAccepted: candidate.reviewDecisions[0]?.runId === run.id
            && candidate.reviewDecisions[0]?.decision === 'accept' } :
          { candidateId: candidate.id, sourceDocumentId: candidate.sourceDocumentId,
          sourceSha256: candidate.sourceSha256, runId: null,
          verificationDecision: null, reviewAccepted: false };
      }),
      publications: publishedRows.map((row) => ({ sourceDocumentId: row.sourceDocumentId,
        sourceSha256: row.sourcePdfSha256, candidateId: row.verificationCandidateId,
        runId: row.verificationRunId })),
    });
  }

  async getCycleHealth(fiscalYear: number): Promise<DefenseCycleHealthDto> {
    const [expectedSources, observations, watcherRuns, outbox] = await Promise.all([
      this.prisma.defenseBudgetExpectedSource.findMany({ where: { fiscalYear } }),
      this.prisma.defenseBudgetSourceObservation.findMany({
        where: { expectedSource: { fiscalYear } },
        include: OBSERVATION_INCLUDE,
      }),
      this.latestWatcherRunPerAdapter(),
      this.prisma.defenseBudgetIngestionOutbox.findMany({
        where: { cycle: { fiscalYear } },
        select: { state: true },
      }),
    ]);

    const health = buildCycleHealth({
      fiscalYear,
      nowIso: new Date().toISOString(),
      expectedSources: expectedSources.map((source) => ({
        authorityTrack: source.authorityTrack as AuthorityTrack,
        stage: source.stage as LifecycleStage,
        sourceFamily: source.sourceFamily as SourceFamily,
        expectedState: source.expectedState as ExpectedSourceState,
        optional: source.optional,
        adapterId: source.adapterId,
      })),
      observations: observations.map((observation) => ({
        authorityTrack: observation.expectedSource.authorityTrack as AuthorityTrack,
        stage: observation.expectedSource.stage as LifecycleStage,
        observationState: observation.observationState as ObservationState,
        adapterId: observation.adapterId,
        observedAt: observation.lastSeenAt.toISOString(),
      })),
      watcherRuns: watcherRuns.map((run) => ({
        adapterId: run.adapterId,
        status: run.status,
        finishedAt: run.finishedAt,
        nextCheckAt: run.nextCheckAt,
        consecutiveFailures: run.consecutiveFailures,
      })),
      outbox: outbox.map((entry) => ({ state: entry.state as never })),
    });

    // Structurally identical to the domain read model — an explicit widening
    // rather than a re-shape, so a future divergence fails to compile.
    return health;
  }

  async listExpectedSources(
    fiscalYear: number,
    filters: { authorityTrack?: string; expectedState?: string } = {},
  ): Promise<readonly DefenseExpectedSourceListItemDto[]> {
    const sources = await this.prisma.defenseBudgetExpectedSource.findMany({
      where: {
        fiscalYear,
        ...(filters.authorityTrack ? { authorityTrack: filters.authorityTrack } : {}),
        ...(filters.expectedState ? { expectedState: filters.expectedState } : {}),
      },
      orderBy: [{ authorityTrack: 'asc' }, { stage: 'asc' }, { adapterId: 'asc' }],
    });
    return sources.map(toExpectedSourceListItem);
  }

  async getExpectedSourceDetail(id: string): Promise<DefenseExpectedSourceDetailDto> {
    const source = await this.prisma.defenseBudgetExpectedSource.findUnique({ where: { id } });
    if (!source) throw new NotFoundException(`Expected source ${id} not found`);
    const observations = await this.prisma.defenseBudgetSourceObservation.findMany({
      where: { expectedSourceId: id },
      include: OBSERVATION_INCLUDE,
      orderBy: { firstSeenAt: 'asc' },
    });
    return {
      ...toExpectedSourceListItem(source),
      chamber: source.chamber as 'house' | 'senate' | 'joint' | null,
      committee: source.committee,
      component: source.component,
      expectedFrom: source.expectedFrom.toISOString(),
      observations: observations.map(toObservationDto),
    };
  }

  async listReviewQueue(fiscalYear: number): Promise<readonly DefenseReviewQueueItemDto[]> {
    const sources = await this.prisma.defenseBudgetExpectedSource.findMany({
      where: { fiscalYear, expectedState: 'review_required' },
      orderBy: { updatedAt: 'desc' },
      include: {
        observations: {
          where: { observationState: 'review_required' },
          orderBy: { lastSeenAt: 'desc' },
          take: 1,
          include: OBSERVATION_INCLUDE,
        },
      },
    });

    const entries: DefenseReviewQueueItemDto[] = [];
    for (const source of sources) {
      const observation = source.observations[0];
      // The expected-source state and its observation state are set by the
      // same watcher transaction, so a review_required expected source with
      // no review_required observation means the two went out of sync — real
      // evidence of a bug, not a case to paper over with a synthesized row.
      if (!observation) continue;
      entries.push({
        expectedSourceId: source.id,
        fiscalYear: source.fiscalYear,
        authorityTrack: source.authorityTrack as AuthorityTrack,
        stage: source.stage as LifecycleStage,
        sourceFamily: source.sourceFamily as SourceFamily,
        adapterId: source.adapterId,
        label: source.label,
        expectedState: source.expectedState as ExpectedSourceState,
        expectedSourceReviewReason: source.reviewReason,
        observation: toObservationDto(observation),
      });
    }
    return entries;
  }

  /**
   * Signals are derived READ-TIME from stored observation history, never
   * persisted: `defense_budget_lifecycle_signal` has a table and a DTO but no
   * application code ever writes it. `deriveLifecycleSignals` is the exact
   * frozen Session 7 pure function; this method's only job is shaping stored
   * rows into its input and its output into the DTO.
   */
  async listSignals(fiscalYear: number): Promise<readonly DefenseLifecycleSignalDto[]> {
    const observations = await this.prisma.defenseBudgetSourceObservation.findMany({
      where: { expectedSource: { fiscalYear } },
      include: OBSERVATION_INCLUDE,
    });
    const byDedupKey = new Map(observations.map((observation) => [observation.dedupKey, observation]));

    const refs: LifecycleObservationRef[] = observations.map((observation) => ({
      observationDedupKey: observation.dedupKey,
      fiscalYear: observation.expectedSource.fiscalYear,
      authorityTrack: observation.expectedSource.authorityTrack as AuthorityTrack,
      stage: observation.expectedSource.stage as LifecycleStage,
      contentSha256: observation.contentSha256,
      observedAt: observation.firstSeenAt.toISOString(),
      supersedesObservationDedupKey: observation.supersedes[0]?.dedupKey ?? null,
    }));

    const signals = deriveLifecycleSignals(refs);

    return signals.map((signal) => {
      const from = byDedupKey.get(signal.fromObservationDedupKey);
      const to = byDedupKey.get(signal.toObservationDedupKey);
      // deriveLifecycleSignals only ever emits a signal referencing dedup keys
      // drawn from the refs it was given, so a miss here means this method
      // built its input incorrectly — fail loudly rather than emit a signal
      // with a fabricated sha.
      if (!from || !to) {
        throw new Error(`Signal ${signal.signalKind} references an observation outside the fetched set`);
      }
      return {
        schemaVersion: DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION,
        signalKind: signal.signalKind,
        fiscalYear: signal.fiscalYear,
        authorityTrack: signal.authorityTrack,
        fromStage: signal.fromStage,
        toStage: signal.toStage,
        fromContentSha256: from.contentSha256,
        toContentSha256: to.contentSha256,
        emittedAt: to.firstSeenAt.toISOString(),
        carriesFundingAmounts: false,
      };
    });
  }

  async getScheduleTickHealth(): Promise<DefenseScheduleTickHealthDto> {
    const ticks = await this.prisma.defenseBudgetScheduleTick.findMany({
      orderBy: { finishedAt: 'desc' },
      take: SCHEDULE_TICK_HISTORY_LIMIT,
    });
    return buildScheduleTickHealth({
      nowIso: new Date().toISOString(),
      ticks: ticks.map((tick) => ({
        workerId: tick.workerId,
        tickKey: tick.tickKey,
        startedAt: tick.startedAt.toISOString(),
        finishedAt: tick.finishedAt.toISOString(),
        outcome: tick.outcome as 'completed' | 'failed',
        adaptersConsidered: tick.adaptersConsidered,
        adaptersDue: tick.adaptersDue,
        adaptersSucceeded: tick.adaptersSucceeded,
        adaptersFailed: tick.adaptersFailed,
        adaptersSkippedLease: tick.adaptersSkippedLease,
        committed: tick.committed,
        failureReason: tick.failureReason,
      })),
    });
  }

  /** One row per adapter that has run at least once, from its most recent run. */
  private async latestWatcherRunPerAdapter(): Promise<
    Array<{
      adapterId: string;
      status: 'running' | 'succeeded' | 'failed' | 'partial';
      finishedAt: string | null;
      nextCheckAt: string | null;
      consecutiveFailures: number;
    }>
  > {
    const adapters = await this.prisma.defenseBudgetWatcherAdapter.findMany({
      include: { runs: { orderBy: { startedAt: 'desc' }, take: 1 } },
    });
    const withRuns: Array<{
      adapterId: string;
      status: 'running' | 'succeeded' | 'failed' | 'partial';
      finishedAt: string | null;
      nextCheckAt: string | null;
      consecutiveFailures: number;
    }> = [];
    for (const adapter of adapters) {
      const run = adapter.runs[0];
      if (!run) continue;
      withRuns.push({
        adapterId: adapter.adapterId,
        status: run.status as 'running' | 'succeeded' | 'failed' | 'partial',
        finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
        nextCheckAt: adapter.nextCheckAt ? adapter.nextCheckAt.toISOString() : null,
        consecutiveFailures: adapter.consecutiveFailures,
      });
    }
    return withRuns;
  }
}
