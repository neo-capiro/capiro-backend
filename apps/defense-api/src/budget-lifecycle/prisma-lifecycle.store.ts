/**
 * Prisma-backed LifecycleStore.
 *
 * The Session 7 control-plane tables are deliberately NOT in the curated
 * defense-api HTTP Prisma model subset — same precedent as Session 6's funding
 * foundation, because Session 7 is control-plane/job work rather than an HTTP or
 * product cutover. Access therefore goes through parameterised raw SQL.
 *
 * Every UUID and NUMERIC placeholder is explicitly cast. `$queryRawUnsafe` does
 * not know column types, and during Session 6 closeout every INSERT failed
 * against a real database because bare text placeholders were passed for uuid
 * columns. The casts below are that lesson, not decoration.
 */

import { Injectable } from '@nestjs/common';
import type {
  AuthorityTrack,
  ExpectedSourceState,
  IngestionJobKind,
  LifecycleStage,
  ObservationState,
  SourceFamily,
  SourceRevisionKind,
} from '@capiro/defense-domain';

import { PrismaService } from '../prisma/prisma.service.js';
import type {
  LifecycleStore,
  NewObservation,
  StoredCycle,
  StoredExpectedSource,
  StoredObservation,
} from './lifecycle-ports.js';

interface RawExpectedSource {
  id: string;
  cycle_id: string;
  dedup_key: string;
  fiscal_year: number;
  authority_track: string;
  stage: string;
  source_family: string;
  adapter_id: string;
  expected_state: string;
  optional: boolean;
  expected_to: Date;
}

interface RawObservation {
  id: string;
  expected_source_id: string;
  cycle_id: string;
  discovered_url: string;
  content_sha256: string;
  http_etag: string | null;
  http_last_modified: string | null;
  observation_state: string;
  revision_kind: string;
  dedup_key: string;
  last_seen_at: Date;
  seen_count: number;
  metadata_jsonb: { versionRank?: number | null } | null;
}

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function mapExpected(raw: RawExpectedSource): StoredExpectedSource {
  return {
    id: raw.id,
    cycleId: raw.cycle_id,
    dedupKey: raw.dedup_key,
    fiscalYear: Number(raw.fiscal_year),
    authorityTrack: raw.authority_track as AuthorityTrack,
    stage: raw.stage as LifecycleStage,
    sourceFamily: raw.source_family as SourceFamily,
    adapterId: raw.adapter_id,
    expectedState: raw.expected_state as ExpectedSourceState,
    optional: Boolean(raw.optional),
    expectedTo: new Date(raw.expected_to).toISOString(),
  };
}

function mapObservation(raw: RawObservation): StoredObservation {
  const versionRank = raw.metadata_jsonb?.versionRank;
  return {
    id: raw.id,
    expectedSourceId: raw.expected_source_id,
    cycleId: raw.cycle_id,
    discoveredUrl: raw.discovered_url,
    contentSha256: raw.content_sha256,
    httpEtag: raw.http_etag,
    httpLastModified: raw.http_last_modified,
    observationState: raw.observation_state as ObservationState,
    revisionKind: raw.revision_kind as SourceRevisionKind,
    versionRank: typeof versionRank === 'number' ? versionRank : null,
    dedupKey: raw.dedup_key,
    lastSeenAt: new Date(raw.last_seen_at).toISOString(),
    seenCount: Number(raw.seen_count),
  };
}

@Injectable()
export class PrismaLifecycleStore implements LifecycleStore {
  constructor(private readonly prisma: PrismaService) {}

  async upsertCycle(input: {
    fiscalYear: number;
    authorityTrack: AuthorityTrack;
    templateVersion: string;
    bootstrapOrigin: 'discovery' | 'template' | 'operator';
    dedupKey: string;
  }): Promise<StoredCycle> {
    const result = rows<{ id: string; fiscal_year: number; authority_track: string }>(
      await this.prisma.$queryRawUnsafe(
        `INSERT INTO defense_budget_cycle
           (fiscal_year, authority_track, status, template_version, bootstrap_origin, dedup_key)
         VALUES ($1::int, $2, 'draft', $3, $4, $5)
         ON CONFLICT (fiscal_year, authority_track) DO UPDATE
           SET updated_at = CURRENT_TIMESTAMP
         RETURNING id, fiscal_year, authority_track`,
        input.fiscalYear,
        input.authorityTrack,
        input.templateVersion,
        input.bootstrapOrigin,
        input.dedupKey,
      ),
    );
    const row = result[0];
    if (!row) throw new Error(`Cycle upsert failed for FY${input.fiscalYear}/${input.authorityTrack}`);
    return {
      id: row.id,
      fiscalYear: Number(row.fiscal_year),
      authorityTrack: row.authority_track as AuthorityTrack,
    };
  }

  async upsertExpectedSource(input: {
    cycleId: string;
    plan: Omit<StoredExpectedSource, 'id' | 'cycleId'> & {
      chamber: string | null;
      committee: string | null;
      component: string | null;
      label: string;
      templateVersion: string;
      expectedFrom: string;
    };
  }): Promise<StoredExpectedSource> {
    const plan = input.plan;
    const result = rows<RawExpectedSource>(
      await this.prisma.$queryRawUnsafe(
        // ON CONFLICT refreshes the template-derived descriptors but NEVER the
        // expected_state: re-running the controller must not walk back a state
        // that real observed evidence established.
        `INSERT INTO defense_budget_expected_source
           (cycle_id, fiscal_year, authority_track, stage, source_family, chamber, committee,
            component, adapter_id, label, expected_state, optional, template_version,
            expected_from, expected_to, dedup_key)
         VALUES ($1::uuid, $2::int, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::boolean, $13,
                 $14::timestamptz, $15::timestamptz, $16)
         ON CONFLICT (dedup_key) DO UPDATE
           SET label = EXCLUDED.label,
               adapter_id = EXCLUDED.adapter_id,
               template_version = EXCLUDED.template_version,
               expected_from = EXCLUDED.expected_from,
               expected_to = EXCLUDED.expected_to,
               optional = EXCLUDED.optional,
               updated_at = CURRENT_TIMESTAMP
         RETURNING id, cycle_id, dedup_key, fiscal_year, authority_track, stage, source_family,
                   adapter_id, expected_state, optional, expected_to`,
        input.cycleId,
        plan.fiscalYear,
        plan.authorityTrack,
        plan.stage,
        plan.sourceFamily,
        plan.chamber,
        plan.committee,
        plan.component,
        plan.adapterId,
        plan.label,
        plan.expectedState,
        plan.optional,
        plan.templateVersion,
        plan.expectedFrom,
        plan.expectedTo,
        plan.dedupKey,
      ),
    );
    const row = result[0];
    if (!row) throw new Error(`Expected-source upsert failed for ${plan.dedupKey}`);
    return mapExpected(row);
  }

  async findExpectedSourceByDedupKey(dedupKey: string): Promise<StoredExpectedSource | null> {
    const result = rows<RawExpectedSource>(
      await this.prisma.$queryRawUnsafe(
        `SELECT id, cycle_id, dedup_key, fiscal_year, authority_track, stage, source_family,
                adapter_id, expected_state, optional, expected_to
           FROM defense_budget_expected_source
          WHERE dedup_key = $1
          LIMIT 1`,
        dedupKey,
      ),
    );
    return result[0] ? mapExpected(result[0]) : null;
  }

  async findLatestObservation(expectedSourceId: string): Promise<StoredObservation | null> {
    const result = rows<RawObservation>(
      await this.prisma.$queryRawUnsafe(
        `SELECT id, expected_source_id, cycle_id, discovered_url, content_sha256, http_etag,
                http_last_modified, observation_state, revision_kind, dedup_key, last_seen_at,
                seen_count, metadata_jsonb
           FROM defense_budget_source_observation
          WHERE expected_source_id = $1::uuid
            AND superseded_by_observation_id IS NULL
          ORDER BY last_seen_at DESC, created_at DESC
          LIMIT 1`,
        expectedSourceId,
      ),
    );
    return result[0] ? mapObservation(result[0]) : null;
  }

  async recordObservation(
    observation: NewObservation,
  ): Promise<{ observation: StoredObservation; created: boolean }> {
    const result = rows<RawObservation & { was_created: boolean }>(
      await this.prisma.$queryRawUnsafe(
        // The unique (expected_source_id, content_sha256) index makes this the
        // idempotency point: identical bytes seen again only bump last_seen_at
        // and seen_count, so no new work is ever created for unchanged content.
        `INSERT INTO defense_budget_source_observation
           (expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
            http_etag, http_last_modified, observation_state, revision_kind,
            classified_fiscal_year, classified_authority_track, classified_stage,
            classified_source_family, classification_confidence, review_reasons,
            first_seen_at, last_seen_at, dedup_key, metadata_jsonb)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::int, $7, $8, $9, $10, $11::int, $12, $13,
                 $14, $15::numeric, $16::jsonb, $17::timestamptz, $17::timestamptz, $18,
                 jsonb_build_object('versionRank', $19::int))
         ON CONFLICT (expected_source_id, content_sha256) DO UPDATE
           SET last_seen_at = GREATEST(defense_budget_source_observation.last_seen_at, EXCLUDED.last_seen_at),
               seen_count = defense_budget_source_observation.seen_count + 1,
               updated_at = CURRENT_TIMESTAMP
         RETURNING id, expected_source_id, cycle_id, discovered_url, content_sha256, http_etag,
                   http_last_modified, observation_state, revision_kind, dedup_key, last_seen_at,
                   seen_count, metadata_jsonb, (seen_count = 1) AS was_created`,
        observation.expectedSourceId,
        observation.cycleId,
        observation.adapterId,
        observation.discoveredUrl,
        observation.contentSha256,
        observation.byteSize,
        observation.httpEtag,
        observation.httpLastModified,
        observation.observationState,
        observation.revisionKind,
        observation.classifiedFiscalYear,
        observation.classifiedAuthorityTrack,
        observation.classifiedStage,
        observation.classifiedSourceFamily,
        observation.classificationConfidence,
        JSON.stringify(observation.reviewReasons),
        observation.observedAt,
        observation.dedupKey,
        observation.versionRank,
      ),
    );
    const row = result[0];
    if (!row) throw new Error(`Observation upsert failed for ${observation.dedupKey}`);
    return { observation: mapObservation(row), created: Boolean(row.was_created) };
  }

  async supersedeObservation(input: { previousId: string; nextId: string }): Promise<void> {
    // The prior version is marked, never deleted: historical provenance stays
    // immutable and auditable.
    await this.prisma.$executeRawUnsafe(
      `UPDATE defense_budget_source_observation
          SET superseded_by_observation_id = $2::uuid,
              observation_state = 'superseded',
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      input.previousId,
      input.nextId,
    );
  }

  async setExpectedSourceState(input: {
    expectedSourceId: string;
    expectedState: ExpectedSourceState;
    reviewReason: string | null;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE defense_budget_expected_source
          SET expected_state = $2,
              review_reason = $3,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1::uuid`,
      input.expectedSourceId,
      input.expectedState,
      input.reviewReason,
    );
  }

  async enqueueIngestion(input: {
    observationId: string;
    observationState: ObservationState;
    cycleId: string;
    jobKind: IngestionJobKind;
    dedupKey: string;
  }): Promise<{ created: boolean }> {
    // DO NOTHING (not DO UPDATE) so a second worker racing on the same
    // observation returns zero rows and reports created:false rather than
    // producing a duplicate governed ingestion job.
    const result = rows<{ id: string }>(
      await this.prisma.$queryRawUnsafe(
        `INSERT INTO defense_budget_ingestion_outbox
           (observation_id, observation_state, cycle_id, job_kind, dedup_key)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5)
         ON CONFLICT (observation_id, job_kind) DO NOTHING
         RETURNING id`,
        input.observationId,
        input.observationState,
        input.cycleId,
        input.jobKind,
        input.dedupKey,
      ),
    );
    return { created: result.length === 1 };
  }

  async loadAdapterState(adapterId: string): Promise<{
    cursor: Record<string, unknown>;
    consecutiveFailures: number;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
  } | null> {
    const result = rows<{
      cursor_jsonb: Record<string, unknown> | null;
      consecutive_failures: number;
      lease_owner: string | null;
      lease_expires_at: Date | null;
    }>(
      await this.prisma.$queryRawUnsafe(
        `SELECT cursor_jsonb, consecutive_failures, lease_owner, lease_expires_at
           FROM defense_budget_watcher_adapter
          WHERE adapter_id = $1
          LIMIT 1`,
        adapterId,
      ),
    );
    const row = result[0];
    if (!row) return null;
    return {
      cursor: row.cursor_jsonb ?? {},
      consecutiveFailures: Number(row.consecutive_failures),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : null,
    };
  }

  async acquireAdapterLease(input: {
    adapterId: string;
    leaseOwner: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): Promise<boolean> {
    // Single atomic statement. Two concurrent workers cannot both satisfy the
    // WHERE clause, so exactly one acquires the lease; a crashed worker's lease
    // is reclaimable once it expires.
    const result = rows<{ id: string }>(
      await this.prisma.$queryRawUnsafe(
        `INSERT INTO defense_budget_watcher_adapter
           (adapter_id, status, lease_owner, lease_expires_at, last_check_at)
         VALUES ($1, 'leased', $2, $3::timestamptz, $4::timestamptz)
         ON CONFLICT (adapter_id) DO UPDATE
           SET lease_owner = EXCLUDED.lease_owner,
               lease_expires_at = EXCLUDED.lease_expires_at,
               status = 'leased',
               last_check_at = EXCLUDED.last_check_at,
               updated_at = CURRENT_TIMESTAMP
           WHERE defense_budget_watcher_adapter.lease_owner IS NULL
              OR defense_budget_watcher_adapter.lease_owner = EXCLUDED.lease_owner
              OR defense_budget_watcher_adapter.lease_expires_at <= $4::timestamptz
         RETURNING id`,
        input.adapterId,
        input.leaseOwner,
        input.leaseExpiresAt,
        input.nowIso,
      ),
    );
    return result.length === 1;
  }

  async releaseAdapterLease(input: {
    adapterId: string;
    leaseOwner: string;
    cursor: Record<string, unknown>;
    nextCheckAt: string;
    succeeded: boolean;
    errorClass: string | null;
    errorMessage: string | null;
    nowIso: string;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `UPDATE defense_budget_watcher_adapter
          SET lease_owner = NULL,
              lease_expires_at = NULL,
              status = CASE WHEN $5::boolean THEN 'idle' ELSE 'failing' END,
              cursor_jsonb = $3::jsonb,
              next_check_at = $4::timestamptz,
              last_success_at = CASE WHEN $5::boolean THEN $8::timestamptz ELSE last_success_at END,
              consecutive_failures = CASE WHEN $5::boolean THEN 0 ELSE consecutive_failures + 1 END,
              last_error_class = $6,
              last_error_message = $7,
              updated_at = CURRENT_TIMESTAMP
        WHERE adapter_id = $1 AND (lease_owner = $2 OR lease_owner IS NULL)`,
      input.adapterId,
      input.leaseOwner,
      JSON.stringify(input.cursor),
      input.nextCheckAt,
      input.succeeded,
      input.errorClass,
      input.errorMessage,
      input.nowIso,
    );
  }

  async recordWatcherRun(input: {
    adapterId: string;
    runKey: string;
    status: 'succeeded' | 'failed' | 'partial';
    startedAt: string;
    finishedAt: string;
    discovered: number;
    unchanged: number;
    changed: number;
    review: number;
    queued: number;
    blocked: number;
    attempt: number;
    errorClass: string | null;
    errorMessage: string | null;
    nextCheckAt: string;
  }): Promise<void> {
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_watcher_run
         (adapter_id, run_key, status, started_at, finished_at, discovered_count,
          unchanged_count, changed_count, review_count, queued_count, blocked_count,
          attempt, error_class, error_message, next_check_at)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::int, $7::int, $8::int,
               $9::int, $10::int, $11::int, $12::int, $13, $14, $15::timestamptz)
       ON CONFLICT (adapter_id, run_key) DO UPDATE
         SET status = EXCLUDED.status,
             finished_at = EXCLUDED.finished_at,
             discovered_count = EXCLUDED.discovered_count,
             unchanged_count = EXCLUDED.unchanged_count,
             changed_count = EXCLUDED.changed_count,
             review_count = EXCLUDED.review_count,
             queued_count = EXCLUDED.queued_count,
             blocked_count = EXCLUDED.blocked_count,
             error_class = EXCLUDED.error_class,
             error_message = EXCLUDED.error_message,
             next_check_at = EXCLUDED.next_check_at,
             updated_at = CURRENT_TIMESTAMP`,
      input.adapterId,
      input.runKey,
      input.status,
      input.startedAt,
      input.finishedAt,
      input.discovered,
      input.unchanged,
      input.changed,
      input.review,
      input.queued,
      input.blocked,
      input.attempt,
      input.errorClass,
      input.errorMessage,
      input.nextCheckAt,
    );
  }
}
