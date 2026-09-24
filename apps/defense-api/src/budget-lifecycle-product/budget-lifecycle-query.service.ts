/**
 * Phase 8 Session 11 — product/read composition.
 *
 * Composes the new read-only `BudgetLifecycleReadStore` with the existing
 * Session 7 `CycleHealthService` and the Session 11 `buildScheduleTickHealth`
 * domain function, and maps the result onto the `defense-contracts` DTOs.
 * Nothing here writes anything, and nothing here recomputes a number the
 * frozen domain layer already owns — nvidiaQueuedPages/activeGpuJobs/
 * nvidiaRouting/missingSourceMeansUnknownNotZero all flow straight through
 * from `buildCycleHealth`, unmodified.
 */

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  buildDefenseCoverageInventory,
  buildScheduleTickHealth,
  deriveLifecycleSignals,
  type LifecycleObservationRef,
} from '@capiro/defense-domain';
import type {
  DefenseCycleHealthDto,
  DefenseExpectedSourceDetailDto,
  DefenseExpectedSourceListItemDto,
  DefenseLifecycleSignalDto,
  DefenseReviewQueueItemDto,
  DefenseScheduleTickHealthDto,
  DefenseSourceObservationDto,
} from '@capiro/defense-contracts';
import { DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION } from '@capiro/defense-contracts';

import { CycleHealthService } from '../budget-lifecycle/cycle-health.service.js';
import {
  BUDGET_LIFECYCLE_READ_STORE,
  type BudgetLifecycleReadStore,
  type ReadExpectedSource,
  type ReadObservation,
} from './budget-lifecycle-read.port.js';

const SCHEDULE_TICK_HISTORY_LIMIT = 500;

function toExpectedSourceListItem(source: ReadExpectedSource): DefenseExpectedSourceListItemDto {
  return {
    id: source.id,
    fiscalYear: source.fiscalYear,
    authorityTrack: source.authorityTrack,
    stage: source.stage,
    sourceFamily: source.sourceFamily,
    adapterId: source.adapterId,
    label: source.label,
    expectedState: source.expectedState,
    optional: source.optional,
    expectedTo: source.expectedTo,
    reviewReason: source.reviewReason,
    knownFundingPosition: null,
  };
}

function toObservationDto(observation: ReadObservation): DefenseSourceObservationDto {
  return {
    schemaVersion: DEFENSE_BUDGET_LIFECYCLE_SCHEMA_VERSION,
    fiscalYear: observation.fiscalYear,
    authorityTrack: observation.authorityTrack,
    stage: observation.stage,
    sourceFamily: observation.sourceFamily,
    adapterId: observation.adapterId,
    discoveredUrl: observation.discoveredUrl,
    contentSha256: observation.contentSha256,
    byteSize: observation.byteSize,
    httpEtag: observation.httpEtag,
    httpLastModified: observation.httpLastModified,
    observationState: observation.observationState,
    classificationConfidence: observation.classificationConfidence,
    reviewReasons: observation.reviewReasons,
    sourceDocumentId: observation.sourceDocumentId,
    supersededByObservationId: observation.supersededByObservationId,
    firstSeenAt: observation.firstSeenAt,
    lastSeenAt: observation.lastSeenAt,
    seenCount: observation.seenCount,
  };
}

@Injectable()
export class BudgetLifecycleQueryService {
  constructor(
    @Inject(BUDGET_LIFECYCLE_READ_STORE) private readonly store: BudgetLifecycleReadStore,
    private readonly cycleHealthService: CycleHealthService,
  ) {}

  async getCycleHealth(fiscalYear: number): Promise<DefenseCycleHealthDto> {
    const [expectedSources, observations, watcherRuns, outbox] = await Promise.all([
      this.store.listExpectedSourcesByFiscalYear(fiscalYear),
      this.store.listObservationsByFiscalYear(fiscalYear),
      this.store.listLatestWatcherRunPerAdapter(),
      this.store.listOutboxStatesByFiscalYear(fiscalYear),
    ]);

    const health = this.cycleHealthService.build({
      fiscalYear,
      nowIso: new Date().toISOString(),
      expectedSources: expectedSources.map((source) => ({
        authorityTrack: source.authorityTrack,
        stage: source.stage,
        sourceFamily: source.sourceFamily,
        expectedState: source.expectedState,
        optional: source.optional,
        adapterId: source.adapterId,
      })),
      observations: observations.map((observation) => ({
        authorityTrack: observation.authorityTrack,
        stage: observation.stage,
        observationState: observation.observationState,
        adapterId: observation.adapterId,
        observedAt: observation.lastSeenAt,
      })),
      watcherRuns: watcherRuns.map((run) => ({
        adapterId: run.adapterId,
        status: run.status,
        finishedAt: run.finishedAt,
        nextCheckAt: run.nextCheckAt,
        consecutiveFailures: run.consecutiveFailures,
      })),
      outbox: outbox.map((entry) => ({ state: entry.state })),
    });

    return this.cycleHealthService.toDto(health);
  }

  async listExpectedSources(
    fiscalYear: number,
    filters: { authorityTrack?: string; expectedState?: string } = {},
  ): Promise<readonly DefenseExpectedSourceListItemDto[]> {
    const sources = await this.store.listExpectedSourcesByFiscalYear(fiscalYear);
    return sources
      .filter((source) => !filters.authorityTrack || source.authorityTrack === filters.authorityTrack)
      .filter((source) => !filters.expectedState || source.expectedState === filters.expectedState)
      .map(toExpectedSourceListItem);
  }

  /** Read-only inventory of logical slots and known physical-document identities. */
  async getCoverageInventory(fiscalYear: number) {
    const [sources, observations, bundleMembers] = await Promise.all([
      this.store.listExpectedSourcesByFiscalYear(fiscalYear),
      this.store.listObservationsByFiscalYear(fiscalYear),
      this.store.listBundleMembersByFiscalYear?.(fiscalYear) ?? Promise.resolve([]),
    ]);
    return buildDefenseCoverageInventory({
      fiscalYear,
      // The store records source observations, but does not yet assert that its
      // physical-unit catalog is complete. Keep absent volume/section detail unknown.
      inventoryKnowledge: 'unknown',
      expectedSlots: sources.map((source) => ({
        slotId: source.id,
        fiscalYear: source.fiscalYear,
        sourceFamily: source.sourceFamily,
        adapterId: source.adapterId,
        label: source.label,
        optional: source.optional,
      })),
      observations: observations.map((observation) => ({
        observationId: observation.id,
        slotId: observation.expectedSourceId,
        sourceDocumentId: observation.sourceDocumentId,
        discoveredUrl: observation.discoveredUrl,
        observationState: observation.observationState,
        supersededByObservationId: observation.supersededByObservationId,
        classification: observation.observationState === 'review_required'
          ? 'review_required'
          : observation.classificationConfidence === null || observation.sourceDocumentId === null
            ? 'unavailable'
            : 'classified',
      })),
      inventoriedUnits: bundleMembers.flatMap((member) => [
        ...(member.volume ? [{
          slotId: member.expectedSourceId,
          unitId: `${member.id}:volume`,
          kind: 'volume' as const,
          label: `Volume ${member.volume}`,
          sourceDocumentId: member.sourceDocumentId,
          observationId: member.observationId,
          memberStatus: member.memberStatus,
        }] : []),
        ...(member.budgetActivity ? [{
          slotId: member.expectedSourceId,
          unitId: `${member.id}:section`,
          kind: 'section' as const,
          label: `Budget Activity ${member.budgetActivity}`,
          sourceDocumentId: member.sourceDocumentId,
          observationId: member.observationId,
          memberStatus: member.memberStatus,
        }] : []),
        {
          slotId: member.expectedSourceId,
          unitId: member.id,
          kind: 'exhibit' as const,
          label: member.title,
          sourceDocumentId: member.sourceDocumentId,
          observationId: member.observationId,
          memberStatus: member.memberStatus,
        },
      ]),
    });
  }

  async getExpectedSourceDetail(id: string): Promise<DefenseExpectedSourceDetailDto> {
    const source = await this.store.getExpectedSourceById(id);
    if (!source) throw new NotFoundException(`Expected source ${id} not found`);
    const observations = await this.store.listObservationsByExpectedSourceId(id);
    return {
      ...toExpectedSourceListItem(source),
      chamber: source.chamber,
      committee: source.committee,
      component: source.component,
      expectedFrom: source.expectedFrom,
      observations: observations.map(toObservationDto),
    };
  }

  async listReviewQueue(fiscalYear: number): Promise<readonly DefenseReviewQueueItemDto[]> {
    const entries = await this.store.listReviewQueue(fiscalYear);
    return entries.map((entry) => ({
      expectedSourceId: entry.expectedSource.id,
      fiscalYear: entry.expectedSource.fiscalYear,
      authorityTrack: entry.expectedSource.authorityTrack,
      stage: entry.expectedSource.stage,
      sourceFamily: entry.expectedSource.sourceFamily,
      adapterId: entry.expectedSource.adapterId,
      label: entry.expectedSource.label,
      expectedState: entry.expectedSource.expectedState,
      expectedSourceReviewReason: entry.expectedSource.reviewReason,
      observation: toObservationDto(entry.observation),
    }));
  }

  /**
   * Signals are derived READ-TIME from stored observation history, never
   * persisted: `defense_budget_lifecycle_signal` has a table and a DTO
   * (Session 7) but no application code ever writes it, and this method does
   * not change that. `deriveLifecycleSignals` is the exact frozen Session 7
   * pure function; this method's only job is shaping stored rows into its
   * input and its output into the DTO.
   */
  async listSignals(fiscalYear: number): Promise<readonly DefenseLifecycleSignalDto[]> {
    const observations = await this.store.listObservationsByFiscalYear(fiscalYear);
    const byDedupKey = new Map(observations.map((observation) => [observation.dedupKey, observation]));

    const refs: LifecycleObservationRef[] = observations.map((observation) => ({
      observationDedupKey: observation.dedupKey,
      fiscalYear: observation.fiscalYear,
      authorityTrack: observation.authorityTrack,
      stage: observation.stage,
      contentSha256: observation.contentSha256,
      observedAt: observation.firstSeenAt,
      supersedesObservationDedupKey: observation.supersedesDedupKey,
    }));

    const signals = deriveLifecycleSignals(refs);

    return signals.map((signal) => {
      const from = byDedupKey.get(signal.fromObservationDedupKey);
      const to = byDedupKey.get(signal.toObservationDedupKey);
      // deriveLifecycleSignals only ever emits a signal referencing dedup keys
      // drawn from the very refs it was given, so a miss here would mean this
      // method built its input incorrectly — fail loudly rather than emit a
      // signal with a fabricated sha.
      if (!from || !to) {
        throw new Error(
          `Signal ${signal.signalKind} references an observation outside the fetched set`,
        );
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
        emittedAt: to.firstSeenAt,
        carriesFundingAmounts: false,
      };
    });
  }

  async getScheduleTickHealth(): Promise<DefenseScheduleTickHealthDto> {
    const ticks = await this.store.listRecentScheduleTicks(SCHEDULE_TICK_HISTORY_LIMIT);
    return buildScheduleTickHealth({
      nowIso: new Date().toISOString(),
      ticks: ticks.map((tick) => ({
        workerId: tick.workerId,
        tickKey: tick.tickKey,
        startedAt: tick.startedAt,
        finishedAt: tick.finishedAt,
        outcome: tick.outcome,
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
}
