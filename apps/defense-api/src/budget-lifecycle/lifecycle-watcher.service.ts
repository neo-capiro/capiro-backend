/**
 * DefenseBudgetLifecycleWatcher.
 *
 * The durable control loop:
 *
 *   discover -> identify -> fingerprint -> classify -> compare
 *            -> persist/version -> queue governed ingestion
 *
 * Everything that could quietly fabricate a fact is fail-closed:
 *
 *   * a candidate URL that is not on the adapter's own official host is refused;
 *   * unchanged bytes produce no work at all, so no duplicate parser cost;
 *   * identical bytes at a new URL are a relocation, not new content;
 *   * an ambiguous classification stops in review and cannot be enqueued;
 *   * a superseded version is marked, never deleted;
 *   * no GPU is required, and a run that claims otherwise throws.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  assertObservationQueueable,
  assertWatcherRunnableWithoutGpu,
  billVersionRank,
  canAcquireWatcherLease,
  classifyLifecycleSource,
  conditionalFetchHeaders,
  decideExpectedSourceStateOnDocumentArrivalV1,
  detectSourceRevision,
  evaluateBundleCompletenessV1,
  ingestionOutboxDedupKey,
  nextWatcherCheckAt,
  observationDedupKey,
  parseOfficialPackageId,
  resolveWatcherGpuEnvironment,
  routeAlternativeFundingDiscovery,
  validateClassificationAgainstContent,
  watcherSeasonForInstant,
  type AuthorityTrack,
  type IngestionJobKind,
  type LifecycleStage,
  type ObservationState,
  type SourceFamily,
  type SourceRevisionKind,
} from '@capiro/defense-domain';

import { AnnualDefenseBudgetCycleController } from './annual-cycle-controller.service.js';
import { LIFECYCLE_STORE, SOURCE_DISCOVERY_PORT, SOURCE_FETCH_PORT } from './lifecycle.tokens.js';
import { NonOfficialSourceHostError, SourceAdapterRegistry } from './source-adapter.registry.js';
import type {
  DiscoveredCandidate,
  LifecycleStore,
  SourceDiscoveryPort,
  SourceFetchPort,
} from './lifecycle-ports.js';

export interface WatcherRunOptions {
  readonly adapterId: string;
  readonly nowIso: string;
  readonly leaseOwner: string;
  readonly runKey: string;
  readonly leaseSeconds?: number;
  /** Dry-run reports every decision without persisting or enqueuing anything. */
  readonly commit: boolean;
}

export type CandidateOutcomeKind =
  | 'unchanged'
  | 'replacement_url'
  | 'first_discovery'
  | 'changed'
  | 'superseding_version'
  | 'review_required'
  | 'withdrawn'
  | 'blocked'
  | 'refused_non_official';

export interface CandidateOutcome {
  readonly url: string;
  readonly expectedSourceDedupKey: string;
  readonly outcome: CandidateOutcomeKind;
  readonly revisionKind: SourceRevisionKind | null;
  readonly observationState: ObservationState | null;
  readonly contentSha256: string | null;
  readonly classifiedFiscalYear: number | null;
  readonly classifiedAuthorityTrack: AuthorityTrack | null;
  readonly classifiedStage: LifecycleStage | null;
  readonly classifiedSourceFamily: SourceFamily | null;
  readonly queuedJobKind: IngestionJobKind | null;
  readonly queued: boolean;
  readonly reasons: readonly string[];
}

export interface WatcherRunResult {
  readonly adapterId: string;
  readonly runKey: string;
  readonly leaseAcquired: boolean;
  readonly committed: boolean;
  readonly status: 'succeeded' | 'failed' | 'partial' | 'skipped_not_leased';
  readonly discovered: number;
  readonly unchanged: number;
  readonly changed: number;
  readonly review: number;
  readonly queued: number;
  readonly blocked: number;
  readonly nextCheckAt: string;
  readonly outcomes: readonly CandidateOutcome[];
  readonly gpu: { readonly requiresGpu: false; readonly activeGpuCapacity: 0 };
}

@Injectable()
export class DefenseBudgetLifecycleWatcher {
  private readonly logger = new Logger(DefenseBudgetLifecycleWatcher.name);

  constructor(
    private readonly adapters: SourceAdapterRegistry,
    private readonly controller: AnnualDefenseBudgetCycleController,
    @Inject(LIFECYCLE_STORE) private readonly store: LifecycleStore,
    @Inject(SOURCE_DISCOVERY_PORT) private readonly discovery: SourceDiscoveryPort,
    @Inject(SOURCE_FETCH_PORT) private readonly fetcher: SourceFetchPort,
  ) {}

  async runAdapter(options: WatcherRunOptions): Promise<WatcherRunResult> {
    // Fail-closed GPU independence check before anything else happens. The
    // provider-routing environment is resolved by the domain, which owns the
    // accepted provider decision; this service names no provider at all.
    const providerEnv = resolveWatcherGpuEnvironment(process.env);
    const gpu = assertWatcherRunnableWithoutGpu({
      providerRouting: providerEnv.providerRouting,
      activeGpuCapacity: providerEnv.activeGpuCapacity,
      requiresGpu: this.adapters.get(options.adapterId).requiresGpu,
    });

    const cadence = this.adapters.cadenceFor(options.adapterId);
    const season = watcherSeasonForInstant(options.nowIso, options.adapterId);
    const startedAt = options.nowIso;
    const leaseSeconds = options.leaseSeconds ?? 900;
    const leaseExpiresAt = new Date(
      new Date(options.nowIso).getTime() + leaseSeconds * 1_000,
    ).toISOString();

    const adapterState = await this.store.loadAdapterState(options.adapterId);
    const leaseCheck = canAcquireWatcherLease({
      existing:
        adapterState?.leaseOwner && adapterState.leaseExpiresAt
          ? {
              adapterId: options.adapterId,
              leaseOwner: adapterState.leaseOwner,
              leaseExpiresAt: adapterState.leaseExpiresAt,
            }
          : null,
      candidateOwner: options.leaseOwner,
      nowIso: options.nowIso,
    });

    const nextCheckAt = nextWatcherCheckAt({
      nowIso: options.nowIso,
      cadence,
      season,
      consecutiveFailures: adapterState?.consecutiveFailures ?? 0,
    });

    if (!leaseCheck.acquired) {
      this.logger.warn(`Skipping ${options.adapterId}: ${leaseCheck.reason}`);
      return this.emptyResult(options, 'skipped_not_leased', nextCheckAt, gpu, false);
    }

    if (options.commit) {
      const acquired = await this.store.acquireAdapterLease({
        adapterId: options.adapterId,
        leaseOwner: options.leaseOwner,
        leaseExpiresAt,
        nowIso: options.nowIso,
      });
      if (!acquired) {
        // Lost an atomic race against a concurrent worker. Correct behaviour is
        // to do nothing: the other worker owns this adapter's run.
        this.logger.warn(`Lost lease race for ${options.adapterId}`);
        return this.emptyResult(options, 'skipped_not_leased', nextCheckAt, gpu, false);
      }
    }

    const outcomes: CandidateOutcome[] = [];
    let cursor = adapterState?.cursor ?? {};
    let status: WatcherRunResult['status'] = 'succeeded';
    let errorClass: string | null = null;
    let errorMessage: string | null = null;

    try {
      const discovered = await this.discovery.discover({
        adapterId: options.adapterId,
        cursor,
        nowIso: options.nowIso,
      });
      cursor = discovered.cursor;

      for (const candidate of discovered.candidates) {
        try {
          outcomes.push(await this.processCandidate(candidate, options));
        } catch (error) {
          status = 'partial';
          const reason = error instanceof Error ? error.message : String(error);
          outcomes.push({
            url: candidate.url,
            expectedSourceDedupKey: candidate.expectedSourceDedupKey,
            outcome:
              error instanceof NonOfficialSourceHostError ? 'refused_non_official' : 'blocked',
            revisionKind: null,
            observationState: null,
            contentSha256: null,
            classifiedFiscalYear: null,
            classifiedAuthorityTrack: null,
            classifiedStage: null,
            classifiedSourceFamily: null,
            queuedJobKind: null,
            queued: false,
            reasons: Object.freeze([reason]),
          });
        }
      }
    } catch (error) {
      status = 'failed';
      errorClass = error instanceof Error ? error.name : 'UnknownError';
      errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Watcher run failed for ${options.adapterId}: ${errorMessage}`);
    }

    const tally = {
      discovered: outcomes.length,
      unchanged: outcomes.filter(
        (outcome) => outcome.outcome === 'unchanged' || outcome.outcome === 'replacement_url',
      ).length,
      changed: outcomes.filter(
        (outcome) =>
          outcome.outcome === 'first_discovery' ||
          outcome.outcome === 'changed' ||
          outcome.outcome === 'superseding_version',
      ).length,
      review: outcomes.filter((outcome) => outcome.outcome === 'review_required').length,
      queued: outcomes.filter((outcome) => outcome.queued).length,
      blocked: outcomes.filter(
        (outcome) =>
          outcome.outcome === 'blocked' ||
          outcome.outcome === 'withdrawn' ||
          outcome.outcome === 'refused_non_official',
      ).length,
    };

    const failuresAfter = status === 'failed' ? (adapterState?.consecutiveFailures ?? 0) + 1 : 0;
    const resolvedNextCheckAt = nextWatcherCheckAt({
      nowIso: options.nowIso,
      cadence,
      season,
      consecutiveFailures: failuresAfter,
    });

    if (options.commit) {
      await this.store.recordWatcherRun({
        adapterId: options.adapterId,
        runKey: options.runKey,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        discovered: tally.discovered,
        unchanged: tally.unchanged,
        changed: tally.changed,
        review: tally.review,
        queued: tally.queued,
        blocked: tally.blocked,
        attempt: (adapterState?.consecutiveFailures ?? 0) + 1,
        errorClass,
        errorMessage,
        nextCheckAt: resolvedNextCheckAt,
      });
      await this.store.releaseAdapterLease({
        adapterId: options.adapterId,
        leaseOwner: options.leaseOwner,
        cursor,
        nextCheckAt: resolvedNextCheckAt,
        succeeded: status === 'succeeded',
        errorClass,
        errorMessage,
        nowIso: options.nowIso,
      });
    }

    return Object.freeze({
      adapterId: options.adapterId,
      runKey: options.runKey,
      leaseAcquired: true,
      committed: options.commit,
      status,
      ...tally,
      nextCheckAt: resolvedNextCheckAt,
      outcomes: Object.freeze(outcomes),
      gpu: Object.freeze({
        requiresGpu: gpu.requiresGpu,
        activeGpuCapacity: gpu.activeGpuCapacity,
      }),
    });
  }

  private async processCandidate(
    candidate: DiscoveredCandidate,
    options: WatcherRunOptions,
  ): Promise<CandidateOutcome> {
    // 1. Official host. A non-official host can never satisfy an expected source.
    this.adapters.assertAuthoritativeHost(candidate.adapterId, candidate.url);

    let expected = await this.store.findExpectedSourceByDedupKey(candidate.expectedSourceDedupKey);
    let previous = expected ? await this.store.findLatestObservation(expected.id) : null;

    // 2. A publisher-reported withdrawal is recorded as a fact. It is not zero.
    if (candidate.withdrawn) {
      if (options.commit && expected) {
        await this.store.setExpectedSourceState({
          expectedSourceId: expected.id,
          expectedState: 'withdrawn',
          reviewReason: null,
        });
      }
      return this.outcome(candidate, 'withdrawn', {
        reasons: ['publisher reports the document withdrawn; recorded as withdrawn, not as zero'],
      });
    }

    // 3. Conditional fetch, purely as a bandwidth optimisation.
    const fetched = await this.fetcher.fetch({
      url: candidate.url,
      conditionalHeaders: conditionalFetchHeaders(
        previous
          ? {
              discoveredUrl: previous.discoveredUrl,
              contentSha256: previous.contentSha256,
              httpEtag: previous.httpEtag,
              httpLastModified: previous.httpLastModified,
            }
          : null,
      ),
    });

    if (fetched.blocked) {
      return this.outcome(candidate, 'blocked', {
        reasons: [fetched.blockedReason ?? 'retrieval failed'],
      });
    }

    // A 304 means the publisher claims no change. We trust it only to skip the
    // download; the authoritative identity remains the SHA we already hold.
    if (fetched.notModified) {
      if (!previous) {
        return this.outcome(candidate, 'blocked', {
          reasons: ['publisher returned 304 for a source we have never downloaded'],
        });
      }
      return this.outcome(candidate, 'unchanged', {
        contentSha256: previous.contentSha256,
        revisionKind: 'unchanged',
        reasons: ['conditional request answered 304; retained prior authoritative content sha'],
      });
    }

    if (!fetched.contentSha256) {
      return this.outcome(candidate, 'blocked', {
        reasons: ['retrieval produced no content sha'],
      });
    }

    // 4. Bytes decide. ETag/Last-Modified never do.
    const versionRank =
      candidate.versionRank ??
      billVersionRank(parseOfficialPackageId(candidate.packageId).billVersion);

    const revision = detectSourceRevision({
      previous: previous
        ? {
            discoveredUrl: previous.discoveredUrl,
            contentSha256: previous.contentSha256,
            httpEtag: previous.httpEtag,
            httpLastModified: previous.httpLastModified,
            versionRank: previous.versionRank,
          }
        : null,
      next: {
        discoveredUrl: candidate.url,
        contentSha256: fetched.contentSha256,
        httpEtag: fetched.httpEtag,
        httpLastModified: fetched.httpLastModified,
        versionRank,
      },
    });

    if (revision.kind === 'unchanged' || revision.kind === 'replacement_url') {
      // No new content: no observation row, no ingestion, no provider cost.
      return this.outcome(
        candidate,
        revision.kind === 'unchanged' ? 'unchanged' : 'replacement_url',
        {
          contentSha256: fetched.contentSha256,
          revisionKind: revision.kind,
          reasons: [revision.reason],
        },
      );
    }

    // 5. Classify, then corroborate against the document's own content.
    const classified = classifyLifecycleSource({
      url: candidate.url,
      packageId: candidate.packageId ?? null,
      title: candidate.title ?? null,
      declaredFiscalYear: candidate.declaredFiscalYear ?? null,
      contentExcerpt: fetched.contentExcerpt ?? null,
      contentExcerptAvailable: fetched.contentExcerptAvailable,
      divisionEvidence: candidate.divisionEvidence ?? null,
      adapterId: candidate.adapterId,
    });

    const reasons = [...classified.reasons];
    let ambiguous = classified.decision === 'review' || classified.classification === null;

    // The independent second check only runs when there is real text to check
    // against. When the publisher offers none, corroboration is deferred to
    // deterministic parsing and Phase 2 — not silently skipped.
    if (!ambiguous && classified.classification && !classified.corroborationDeferred) {
      const corroborated = validateClassificationAgainstContent(classified.classification, {
        contentExcerpt: fetched.contentExcerpt ?? '',
      });
      if (!corroborated.valid) {
        ambiguous = true;
        reasons.push(...corroborated.reasons);
      }
    }

    const observedAt = options.nowIso;
    const dedupKey = observationDedupKey({
      expectedSourceDedupKey: expected?.dedupKey ?? candidate.expectedSourceDedupKey,
      contentSha256: fetched.contentSha256,
    });

    // 6. Ambiguity stops here. The row is recorded so the backlog is visible,
    // with no resolved FY/track/stage and no queue entry.
    if (ambiguous) {
      if (options.commit && expected) {
        await this.store.recordObservation({
          expectedSourceId: expected.id,
          cycleId: expected.cycleId,
          adapterId: candidate.adapterId,
          discoveredUrl: candidate.url,
          contentSha256: fetched.contentSha256,
          byteSize: fetched.byteSize,
          httpEtag: fetched.httpEtag,
          httpLastModified: fetched.httpLastModified,
          observationState: 'review_required',
          revisionKind: revision.kind,
          classifiedFiscalYear: null,
          classifiedAuthorityTrack: null,
          classifiedStage: null,
          classifiedSourceFamily: null,
          classificationConfidence: classified.classification?.confidence ?? null,
          reviewReasons: reasons.length ? reasons : ['ambiguous classification'],
          versionRank,
          dedupKey,
          observedAt,
        });
        await this.store.setExpectedSourceState({
          expectedSourceId: expected.id,
          expectedState: 'review_required',
          reviewReason: (reasons[0] ?? 'ambiguous classification').slice(0, 500),
        });
      }
      return this.outcome(candidate, 'review_required', {
        contentSha256: fetched.contentSha256,
        revisionKind: revision.kind,
        observationState: 'review_required',
        reasons,
      });
    }

    const classification = classified.classification!;

    // 7. An unseen fiscal year bootstraps itself rather than failing.
    if ((!expected || classification.fiscalYear !== expected.fiscalYear) && options.commit) {
      await this.controller.ensureFromFirstDiscovery({
        fiscalYear: classification.fiscalYear,
        authorityTrack: classification.authorityTrack,
      });
      expected = await this.store.findExpectedSourceByDedupKey(candidate.expectedSourceDedupKey);
      if (
        !expected ||
        expected.fiscalYear !== classification.fiscalYear ||
        expected.authorityTrack !== classification.authorityTrack ||
        expected.stage !== classification.stage ||
        expected.sourceFamily !== classification.sourceFamily
      ) {
        throw new Error(
          `First discovery did not resolve to its exact template expected source ` +
            `${candidate.expectedSourceDedupKey}`,
        );
      }
      previous = await this.store.findLatestObservation(expected.id);
      reasons.push(
        `bootstrapped FY${classification.fiscalYear} ${classification.authorityTrack} from this discovery`,
      );
    }

    if (!expected && !options.commit) {
      return this.outcome(
        candidate,
        revision.kind === 'first_discovery' ? 'first_discovery' : 'changed',
        {
          contentSha256: fetched.contentSha256,
          revisionKind: revision.kind,
          observationState: 'changed',
          classification,
          queuedJobKind: revision.queuesIngestion ? this.jobKindFor(classification) : null,
          queued: false,
          reasons: [...reasons, revision.reason, 'dry run: nothing persisted or enqueued'],
        },
      );
    }
    if (!expected)
      throw new Error(
        `No expected source registered for dedup key ${candidate.expectedSourceDedupKey}`,
      );

    const observationState: ObservationState = 'changed';
    assertObservationQueueable(observationState);

    const outcomeKind: CandidateOutcomeKind =
      revision.kind === 'first_discovery'
        ? 'first_discovery'
        : revision.kind === 'superseding_version'
          ? 'superseding_version'
          : 'changed';

    if (!options.commit) {
      return this.outcome(candidate, outcomeKind, {
        contentSha256: fetched.contentSha256,
        revisionKind: revision.kind,
        observationState,
        classification,
        queuedJobKind: revision.queuesIngestion ? this.jobKindFor(classification) : null,
        queued: false,
        reasons: [...reasons, revision.reason, 'dry run: nothing persisted or enqueued'],
      });
    }

    const recorded = await this.store.recordObservation({
      expectedSourceId: expected.id,
      cycleId: expected.cycleId,
      adapterId: candidate.adapterId,
      discoveredUrl: candidate.url,
      contentSha256: fetched.contentSha256,
      byteSize: fetched.byteSize,
      httpEtag: fetched.httpEtag,
      httpLastModified: fetched.httpLastModified,
      observationState,
      revisionKind: revision.kind,
      classifiedFiscalYear: classification.fiscalYear,
      classifiedAuthorityTrack: classification.authorityTrack,
      classifiedStage: classification.stage,
      classifiedSourceFamily: classification.sourceFamily,
      classificationConfidence: classification.confidence,
      reviewReasons: [],
      versionRank,
      dedupKey,
      observedAt,
    });

    // 8. Supersede the prior version. It is marked, never deleted.
    if (revision.supersedesPrevious && previous && recorded.created) {
      await this.store.supersedeObservation({
        previousId: previous.id,
        nextId: recorded.observation.id,
      });
    }

    // Phase 10B-18 Part D: a document arriving for an expected source that
    // owns a registered multi-member bundle (currently: none seeded in
    // production) must not flip the WHOLE expected source to `published`
    // while required members remain outstanding. An expected source with no
    // bundle members resolves to `no_bundle`, which is `published` — exactly
    // the pre-existing behavior, unchanged.
    const bundleMembers = (await this.store.loadBundleMembers?.(expected.id)) ?? [];
    await this.store.setExpectedSourceState({
      expectedSourceId: expected.id,
      expectedState: decideExpectedSourceStateOnDocumentArrivalV1(
        evaluateBundleCompletenessV1(bundleMembers),
      ),
      reviewReason: null,
    });

    // 9. Queue exactly one governed ingestion job — and only for new content.
    let queued = false;
    let jobKind: IngestionJobKind | null = null;
    if (revision.queuesIngestion && recorded.created) {
      jobKind = this.jobKindFor(classification);
      const enqueued = await this.store.enqueueIngestion({
        observationId: recorded.observation.id,
        observationState: recorded.observation.observationState,
        cycleId: expected.cycleId,
        jobKind,
        dedupKey: ingestionOutboxDedupKey({ observationDedupKey: dedupKey, jobKind }),
      });
      queued = enqueued.created;
      if (!enqueued.created) {
        reasons.push('governed ingestion job already existed for this observation; not duplicated');
      }
    } else if (!recorded.created) {
      reasons.push('these exact bytes were already recorded; no new ingestion work created');
    }

    return this.outcome(candidate, outcomeKind, {
      contentSha256: fetched.contentSha256,
      revisionKind: revision.kind,
      observationState: recorded.observation.observationState,
      classification,
      queuedJobKind: jobKind,
      queued,
      reasons: [...reasons, revision.reason],
    });
  }

  private jobKindFor(classification: {
    authorityTrack: AuthorityTrack;
    stage: LifecycleStage;
    sourceFamily: SourceFamily;
  }): IngestionJobKind {
    if (classification.authorityTrack === 'alternative_funding') {
      // Routes into the Session 6 domain. Discovery states that a vehicle of
      // this type exists; it cannot create provisions, allocations or dollars.
      return routeAlternativeFundingDiscovery({
        stage: classification.stage,
        sourceFamily: classification.sourceFamily,
        authorityTrack: classification.authorityTrack,
      }).jobKind;
    }
    return 'governed_source_ingestion';
  }

  private outcome(
    candidate: DiscoveredCandidate,
    outcome: CandidateOutcomeKind,
    extra: {
      contentSha256?: string | null;
      revisionKind?: SourceRevisionKind | null;
      observationState?: ObservationState | null;
      classification?: {
        fiscalYear: number;
        authorityTrack: AuthorityTrack;
        stage: LifecycleStage;
        sourceFamily: SourceFamily;
      } | null;
      queuedJobKind?: IngestionJobKind | null;
      queued?: boolean;
      reasons?: readonly string[];
    } = {},
  ): CandidateOutcome {
    return Object.freeze({
      url: candidate.url,
      expectedSourceDedupKey: candidate.expectedSourceDedupKey,
      outcome,
      revisionKind: extra.revisionKind ?? null,
      observationState: extra.observationState ?? null,
      contentSha256: extra.contentSha256 ?? null,
      classifiedFiscalYear: extra.classification?.fiscalYear ?? null,
      classifiedAuthorityTrack: extra.classification?.authorityTrack ?? null,
      classifiedStage: extra.classification?.stage ?? null,
      classifiedSourceFamily: extra.classification?.sourceFamily ?? null,
      queuedJobKind: extra.queuedJobKind ?? null,
      queued: extra.queued ?? false,
      reasons: Object.freeze([...(extra.reasons ?? [])]),
    });
  }

  private emptyResult(
    options: WatcherRunOptions,
    status: WatcherRunResult['status'],
    nextCheckAt: string,
    gpu: { requiresGpu: false; activeGpuCapacity: 0 },
    leaseAcquired: boolean,
  ): WatcherRunResult {
    return Object.freeze({
      adapterId: options.adapterId,
      runKey: options.runKey,
      leaseAcquired,
      committed: false,
      status,
      discovered: 0,
      unchanged: 0,
      changed: 0,
      review: 0,
      queued: 0,
      blocked: 0,
      nextCheckAt,
      outcomes: Object.freeze([]),
      gpu: Object.freeze({
        requiresGpu: gpu.requiresGpu,
        activeGpuCapacity: gpu.activeGpuCapacity,
      }),
    });
  }
}
