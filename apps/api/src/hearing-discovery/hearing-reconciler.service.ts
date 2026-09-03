/**
 * Hearing reconciler — the heart of Phase 3.
 *
 * Takes what one official source said about one event and folds it into the
 * canonical corpus without ever losing the source's own version:
 *
 *   record observation  → hearing_source_observation (verbatim, idempotent)
 *   resolve identity    → deterministic match ladder over committee_hearing
 *   link observation    → the canonical hearing it belongs to
 *   project             → best-authority value per field over ALL observations
 *   apply               → additive patch + committee_site_update signals (1 tx)
 *   record candidates   → hearing_stream_candidate (advertised only, unprobed)
 *
 * Idempotence is the acceptance property: running the same source twice over an
 * unchanged official page must produce zero new canonical rows, zero new
 * observations, and zero new change-feed rows.
 */
import type { PrismaClient } from '@prisma/client';
import { CanonicalHearingRepository, type MatchOutcome } from './canonical-hearing.repository.js';
import { HearingObservationRepository } from './hearing-observation.repository.js';
import { StreamCandidateRepository } from './stream-candidate.repository.js';
import { projectCanonical } from './canonical-diff.js';
import type { SourceDescriptor, SourceEvent } from './hearing-discovery.types.js';

export interface ReconcileOutcome {
  hearingId: string;
  match: MatchOutcome['kind'];
  observationCreated: boolean;
  observationChanged: boolean;
  hearingCreated: boolean;
  changedFields: string[];
  filledFields: string[];
  siteUpdatesInserted: number;
  streamCandidatesCreated: number;
  /** Set when this event could not be reconciled; never silently swallowed. */
  error?: string;
}

export interface ReconcileTotals {
  events: number;
  hearingsCreated: number;
  hearingsUpdated: number;
  observationsCreated: number;
  observationsChanged: number;
  siteUpdates: number;
  streamCandidates: number;
  errors: number;
  /** Per-rung tally, so "how are we matching" is measurable, not assumed. */
  matches: Record<string, number>;
}

export class HearingReconcilerService {
  private readonly hearings: CanonicalHearingRepository;
  private readonly observations: HearingObservationRepository;
  private readonly candidates: StreamCandidateRepository;

  constructor(
    prisma: PrismaClient,
    deps?: {
      hearings?: CanonicalHearingRepository;
      observations?: HearingObservationRepository;
      candidates?: StreamCandidateRepository;
    },
  ) {
    this.hearings = deps?.hearings ?? new CanonicalHearingRepository(prisma);
    this.observations = deps?.observations ?? new HearingObservationRepository(prisma);
    this.candidates = deps?.candidates ?? new StreamCandidateRepository(prisma);
  }

  /** Reconcile one observed event. */
  async reconcileEvent(
    source: SourceDescriptor,
    event: SourceEvent,
    now: Date,
  ): Promise<ReconcileOutcome> {
    const observation = await this.observations.recordObservation(source, event, now);

    // STRONGEST identity rung, ahead of the whole match ladder: if THIS source
    // already reported THIS external event id and we linked it to a hearing,
    // that IS the hearing. The same official source calling something the same
    // event is better evidence than any structural predicate — and it is what
    // keeps a RESCHEDULED event on its original row for adapters whose
    // synthetic id is derived from the schedule. Skipping this rung forked a
    // duplicate canonical row every time a Senate hearing moved (found by the
    // disposable-Postgres verification, section H, before this existed).
    const match: MatchOutcome = observation.existingHearingId
      ? { kind: 'observation', hearingId: observation.existingHearingId }
      : await this.hearings.resolveHearingId(event, source.adapterKey);
    await this.observations.linkToHearing(observation.observationId, match.hearingId);

    // Project over the WHOLE ledger for this hearing, not just this event, so a
    // lower-priority source can never win a field a better source already
    // reported — and so the canonical row stays reproducible from the ledger.
    const projectable = await this.observations.loadProjectable(match.hearingId);
    const projected = projectCanonical(
      projectable.length > 0
        ? projectable
        : // First observation may not be visible yet if the link raced; fall back
          // to this event alone rather than projecting an empty set onto the row.
          [
            {
              sourceId: source.id,
              adapterKey: source.adapterKey,
              sourcePriority: source.priority,
              lastSeenAt: now,
              sourceUpdatedAt: event.sourceUpdatedAt ?? null,
              congress: event.congress ?? null,
              chamber: event.chamber,
              committeeSystemCode: event.committeeSystemCode ?? null,
              subcommitteeSystemCode: event.subcommitteeSystemCode ?? null,
              committeeName: event.committeeName ?? null,
              title: event.title ?? null,
              eventType: event.eventType ?? null,
              eventStatus: event.eventStatus ?? null,
              visibility: event.visibility ?? null,
              startsAt: event.startsAt ?? null,
              calendarDate: event.calendarDate ?? null,
              displayTime: event.displayTime ?? null,
              timeZone: event.timeZone ?? null,
              timeAuthority: event.timeAuthority ?? null,
              location: event.location ?? null,
              officialPageUrl: event.officialPageUrl ?? null,
              witnesses: event.witnesses ?? [],
              agendaBillIds: event.agendaBillIds ?? [],
              streamCandidates: event.streamCandidates ?? [],
            },
          ],
    );

    const applied = await this.hearings.applyProjection(match.hearingId, projected, {
      now,
      sourceUrl: event.officialPageUrl ?? source.sourceUrl,
      parserVersion: source.parserVersion ?? 'unversioned',
      sourceId: source.id,
    });

    let streamCandidatesCreated = 0;
    if (projected.streamCandidates.length > 0) {
      const res = await this.candidates.recordCandidates(
        match.hearingId,
        projected.streamCandidates,
        { now, sourceId: source.id },
      );
      streamCandidatesCreated = res.created;
      if (res.created > 0) {
        await this.hearings.refreshStreamAvailability(match.hearingId);
      }
    }

    return {
      hearingId: match.hearingId,
      match: match.kind,
      observationCreated: observation.created,
      observationChanged: observation.contentChanged,
      hearingCreated: applied.created,
      changedFields: applied.plan.changedFields,
      filledFields: applied.plan.filledFields,
      siteUpdatesInserted: applied.updatesInserted,
      streamCandidatesCreated,
    };
  }

  /**
   * Reconcile a batch, best-priority source first. One bad event never aborts
   * the run — the error is counted and reported, because a discovery job that
   * dies on the first malformed committee notice covers nothing.
   */
  async reconcileBatch(
    source: SourceDescriptor,
    events: SourceEvent[],
    now: Date,
    log: (msg: string) => void = () => {},
  ): Promise<{ totals: ReconcileTotals; outcomes: ReconcileOutcome[] }> {
    const totals: ReconcileTotals = {
      events: 0,
      hearingsCreated: 0,
      hearingsUpdated: 0,
      observationsCreated: 0,
      observationsChanged: 0,
      siteUpdates: 0,
      streamCandidates: 0,
      errors: 0,
      matches: {},
    };
    const outcomes: ReconcileOutcome[] = [];

    for (const event of events) {
      totals.events += 1;
      try {
        const outcome = await this.reconcileEvent(source, event, now);
        outcomes.push(outcome);
        totals.matches[outcome.match] = (totals.matches[outcome.match] ?? 0) + 1;
        if (outcome.hearingCreated) totals.hearingsCreated += 1;
        else if (outcome.changedFields.length || outcome.filledFields.length) {
          totals.hearingsUpdated += 1;
        }
        if (outcome.observationCreated) totals.observationsCreated += 1;
        if (outcome.observationChanged) totals.observationsChanged += 1;
        totals.siteUpdates += outcome.siteUpdatesInserted;
        totals.streamCandidates += outcome.streamCandidatesCreated;
      } catch (err) {
        totals.errors += 1;
        const message = err instanceof Error ? err.message : String(err);
        outcomes.push({
          hearingId: '',
          match: 'new',
          observationCreated: false,
          observationChanged: false,
          hearingCreated: false,
          changedFields: [],
          filledFields: [],
          siteUpdatesInserted: 0,
          streamCandidatesCreated: 0,
          error: message,
        });
        log(`[reconcile] ${source.adapterKey} event ${event.externalEventId} FAILED: ${message}`);
      }
    }
    return { totals, outcomes };
  }
}
