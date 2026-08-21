/**
 * Prisma-backed `BudgetLifecycleReadStore`.
 *
 * Same raw-SQL-with-explicit-casts convention as
 * `../budget-lifecycle/prisma-lifecycle.store.ts` and its Session 8-10
 * siblings: the budget-lifecycle tables are deliberately outside the curated
 * defense-api Prisma model subset (`prisma/defense-model-subset.json`), so
 * every query here goes through `$queryRawUnsafe` with explicit `::uuid` /
 * `::int` / `::timestamptz` casts. Every statement in this file is a SELECT;
 * see `budget-lifecycle-read.port.ts` for why that is a load-bearing fact,
 * not a style choice.
 */

import { Injectable } from '@nestjs/common';
import type { AuthorityTrack, LifecycleStage, SourceFamily } from '@capiro/defense-domain';

import { PrismaService } from '../prisma/prisma.service.js';
import type {
  BudgetLifecycleReadStore,
  ReadExpectedSource,
  ReadObservation,
  ReadOutboxState,
  ReadScheduleTick,
  ReadWatcherRun,
  ReviewQueueEntry,
} from './budget-lifecycle-read.port.js';

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

interface RawExpectedSource {
  id: string;
  cycle_id: string;
  fiscal_year: number;
  authority_track: string;
  stage: string;
  source_family: string;
  chamber: string | null;
  committee: string | null;
  component: string | null;
  adapter_id: string;
  label: string;
  expected_state: string;
  optional: boolean;
  expected_from: Date;
  expected_to: Date;
  review_reason: string | null;
  dedup_key: string;
}

function mapExpectedSource(raw: RawExpectedSource): ReadExpectedSource {
  return {
    id: raw.id,
    cycleId: raw.cycle_id,
    fiscalYear: Number(raw.fiscal_year),
    authorityTrack: raw.authority_track as AuthorityTrack,
    stage: raw.stage as LifecycleStage,
    sourceFamily: raw.source_family as SourceFamily,
    chamber: raw.chamber as ReadExpectedSource['chamber'],
    committee: raw.committee,
    component: raw.component,
    adapterId: raw.adapter_id,
    label: raw.label,
    expectedState: raw.expected_state as ReadExpectedSource['expectedState'],
    optional: Boolean(raw.optional),
    expectedFrom: new Date(raw.expected_from).toISOString(),
    expectedTo: new Date(raw.expected_to).toISOString(),
    reviewReason: raw.review_reason,
    dedupKey: raw.dedup_key,
  };
}

const EXPECTED_SOURCE_COLUMNS = `
  es.id, es.cycle_id, es.fiscal_year, es.authority_track, es.stage, es.source_family,
  es.chamber, es.committee, es.component, es.adapter_id, es.label, es.expected_state,
  es.optional, es.expected_from, es.expected_to, es.review_reason, es.dedup_key
`;

interface RawObservation {
  id: string;
  expected_source_id: string;
  fiscal_year: number;
  authority_track: string;
  stage: string;
  source_family: string;
  adapter_id: string;
  discovered_url: string;
  content_sha256: string;
  byte_size: number | null;
  http_etag: string | null;
  http_last_modified: string | null;
  observation_state: string;
  classification_confidence: string | null;
  review_reasons: unknown;
  source_document_id: string | null;
  superseded_by_observation_id: string | null;
  first_seen_at: Date;
  last_seen_at: Date;
  seen_count: number;
  dedup_key: string;
  supersedes_dedup_key: string | null;
}

function mapObservation(raw: RawObservation): ReadObservation {
  const reviewReasons = Array.isArray(raw.review_reasons) ? (raw.review_reasons as string[]) : [];
  return {
    id: raw.id,
    expectedSourceId: raw.expected_source_id,
    fiscalYear: Number(raw.fiscal_year),
    authorityTrack: raw.authority_track as AuthorityTrack,
    stage: raw.stage as LifecycleStage,
    sourceFamily: raw.source_family as SourceFamily,
    adapterId: raw.adapter_id,
    discoveredUrl: raw.discovered_url,
    contentSha256: raw.content_sha256,
    byteSize: raw.byte_size === null ? null : Number(raw.byte_size),
    httpEtag: raw.http_etag,
    httpLastModified: raw.http_last_modified,
    observationState: raw.observation_state as ReadObservation['observationState'],
    classificationConfidence:
      raw.classification_confidence === null ? null : Number(raw.classification_confidence),
    reviewReasons: Object.freeze(reviewReasons),
    sourceDocumentId: raw.source_document_id,
    supersededByObservationId: raw.superseded_by_observation_id,
    firstSeenAt: new Date(raw.first_seen_at).toISOString(),
    lastSeenAt: new Date(raw.last_seen_at).toISOString(),
    seenCount: Number(raw.seen_count),
    dedupKey: raw.dedup_key,
    supersedesDedupKey: raw.supersedes_dedup_key,
  };
}

// `es.*` supplies the identity fields (fiscal year / track / stage / family):
// they are always known even when the observation's own classified_* columns
// are null under review_required. `prev.dedup_key` is the reverse of
// `superseded_by_observation_id` — the version this observation replaces.
const OBSERVATION_SELECT = `
  SELECT o.id, o.expected_source_id, es.fiscal_year, es.authority_track, es.stage, es.source_family,
         o.adapter_id, o.discovered_url, o.content_sha256, o.byte_size, o.http_etag,
         o.http_last_modified, o.observation_state, o.classification_confidence,
         o.review_reasons, o.source_document_id, o.superseded_by_observation_id,
         o.first_seen_at, o.last_seen_at, o.seen_count, o.dedup_key,
         prev.dedup_key AS supersedes_dedup_key
    FROM defense_budget_source_observation o
    JOIN defense_budget_expected_source es ON es.id = o.expected_source_id
    LEFT JOIN defense_budget_source_observation prev
      ON prev.superseded_by_observation_id = o.id
`;

@Injectable()
export class PrismaBudgetLifecycleReadStore implements BudgetLifecycleReadStore {
  constructor(private readonly prisma: PrismaService) {}

  async listExpectedSourcesByFiscalYear(
    fiscalYear: number,
  ): Promise<readonly ReadExpectedSource[]> {
    const result = rows<RawExpectedSource>(
      await this.prisma.$queryRawUnsafe(
        `SELECT ${EXPECTED_SOURCE_COLUMNS}
           FROM defense_budget_expected_source es
          WHERE es.fiscal_year = $1::int
          ORDER BY es.authority_track, es.stage, es.adapter_id`,
        fiscalYear,
      ),
    );
    return Object.freeze(result.map(mapExpectedSource));
  }

  async getExpectedSourceById(id: string): Promise<ReadExpectedSource | null> {
    const result = rows<RawExpectedSource>(
      await this.prisma.$queryRawUnsafe(
        `SELECT ${EXPECTED_SOURCE_COLUMNS}
           FROM defense_budget_expected_source es
          WHERE es.id = $1::uuid
          LIMIT 1`,
        id,
      ),
    );
    return result[0] ? mapExpectedSource(result[0]) : null;
  }

  async listObservationsByExpectedSourceId(
    expectedSourceId: string,
  ): Promise<readonly ReadObservation[]> {
    const result = rows<RawObservation>(
      await this.prisma.$queryRawUnsafe(
        `${OBSERVATION_SELECT}
          WHERE o.expected_source_id = $1::uuid
          ORDER BY o.first_seen_at ASC`,
        expectedSourceId,
      ),
    );
    return Object.freeze(result.map(mapObservation));
  }

  async listObservationsByFiscalYear(fiscalYear: number): Promise<readonly ReadObservation[]> {
    const result = rows<RawObservation>(
      await this.prisma.$queryRawUnsafe(
        `${OBSERVATION_SELECT}
          WHERE es.fiscal_year = $1::int
          ORDER BY o.last_seen_at ASC`,
        fiscalYear,
      ),
    );
    return Object.freeze(result.map(mapObservation));
  }

  async listReviewQueue(fiscalYear: number): Promise<readonly ReviewQueueEntry[]> {
    const expectedResult = rows<RawExpectedSource>(
      await this.prisma.$queryRawUnsafe(
        `SELECT ${EXPECTED_SOURCE_COLUMNS}
           FROM defense_budget_expected_source es
          WHERE es.fiscal_year = $1::int
            AND es.expected_state = 'review_required'
          ORDER BY es.updated_at DESC`,
        fiscalYear,
      ),
    );
    const entries: ReviewQueueEntry[] = [];
    for (const raw of expectedResult) {
      const expectedSource = mapExpectedSource(raw);
      const observationResult = rows<RawObservation>(
        await this.prisma.$queryRawUnsafe(
          `${OBSERVATION_SELECT}
            WHERE o.expected_source_id = $1::uuid
              AND o.observation_state = 'review_required'
            ORDER BY o.last_seen_at DESC
            LIMIT 1`,
          expectedSource.id,
        ),
      );
      const observation = observationResult[0];
      // The expected-source state and its observation state are set by the same
      // watcher transaction (lifecycle-watcher.service.ts), so a review_required
      // expected source with no review_required observation would mean the two
      // went out of sync — real evidence of a bug, not a case to paper over with
      // a synthesized row.
      if (!observation) continue;
      entries.push({ expectedSource, observation: mapObservation(observation) });
    }
    return Object.freeze(entries);
  }

  async listLatestWatcherRunPerAdapter(): Promise<readonly ReadWatcherRun[]> {
    interface Raw {
      adapter_id: string;
      status: string;
      finished_at: Date | null;
      next_check_at: Date | null;
      consecutive_failures: number;
    }
    const result = rows<Raw>(
      await this.prisma.$queryRawUnsafe(
        `SELECT wa.adapter_id, r.status, r.finished_at, wa.next_check_at, wa.consecutive_failures
           FROM defense_budget_watcher_adapter wa
           JOIN LATERAL (
             SELECT status, finished_at
               FROM defense_budget_watcher_run wr
              WHERE wr.adapter_id = wa.adapter_id
              ORDER BY wr.started_at DESC
              LIMIT 1
           ) r ON true`,
      ),
    );
    return Object.freeze(
      result.map((raw) => ({
        adapterId: raw.adapter_id,
        status: raw.status as ReadWatcherRun['status'],
        finishedAt: raw.finished_at ? new Date(raw.finished_at).toISOString() : null,
        nextCheckAt: raw.next_check_at ? new Date(raw.next_check_at).toISOString() : null,
        consecutiveFailures: Number(raw.consecutive_failures),
      })),
    );
  }

  async listOutboxStatesByFiscalYear(fiscalYear: number): Promise<readonly ReadOutboxState[]> {
    const result = rows<{ state: string }>(
      await this.prisma.$queryRawUnsafe(
        `SELECT o.state
           FROM defense_budget_ingestion_outbox o
           JOIN defense_budget_cycle c ON c.id = o.cycle_id
          WHERE c.fiscal_year = $1::int`,
        fiscalYear,
      ),
    );
    return Object.freeze(result.map((raw) => ({ state: raw.state as ReadOutboxState['state'] })));
  }

  async listRecentScheduleTicks(limit: number): Promise<readonly ReadScheduleTick[]> {
    interface Raw {
      worker_id: string;
      tick_key: string;
      started_at: Date;
      finished_at: Date;
      outcome: string;
      adapters_considered: number;
      adapters_due: number;
      adapters_succeeded: number;
      adapters_failed: number;
      adapters_skipped_lease: number;
      committed: boolean;
      failure_reason: string | null;
    }
    const result = rows<Raw>(
      await this.prisma.$queryRawUnsafe(
        `SELECT worker_id, tick_key, started_at, finished_at, outcome, adapters_considered,
                adapters_due, adapters_succeeded, adapters_failed, adapters_skipped_lease,
                committed, failure_reason
           FROM defense_budget_schedule_tick
          ORDER BY finished_at DESC
          LIMIT $1::int`,
        limit,
      ),
    );
    return Object.freeze(
      result.map((raw) => ({
        workerId: raw.worker_id,
        tickKey: raw.tick_key,
        startedAt: new Date(raw.started_at).toISOString(),
        finishedAt: new Date(raw.finished_at).toISOString(),
        outcome: raw.outcome as ReadScheduleTick['outcome'],
        adaptersConsidered: Number(raw.adapters_considered),
        adaptersDue: Number(raw.adapters_due),
        adaptersSucceeded: Number(raw.adapters_succeeded),
        adaptersFailed: Number(raw.adapters_failed),
        adaptersSkippedLease: Number(raw.adapters_skipped_lease),
        committed: Boolean(raw.committed),
        failureReason: raw.failure_reason,
      })),
    );
  }
}
