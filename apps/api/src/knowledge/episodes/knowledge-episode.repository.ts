import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';
import type {
  KnowledgeEpisodeProjectionJobRecord,
  KnowledgeEpisodeProjectionJobStatus,
  KnowledgeEpisodeRecord,
  KnowledgeEpisodeStrategy,
} from './knowledge-episode.types.js';

interface KnowledgeEpisodeProjectionJobRow {
  id: string;
  tenant_id: string;
  event_id: string;
  status: string;
  attempt_count: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  episode_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface KnowledgeEpisodeRow {
  id: string;
  tenant_id: string;
  strategy: string;
  identity_key: string;
  status: string;
  sensitivity: string;
  access_scope: unknown;
  client_refs: unknown;
  grouping_key: unknown;
  event_count: number;
  assertion_count: number;
  entity_count: number;
  first_event_at: Date;
  last_event_at: Date;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

/**
 * Durable, tenant-bound operational state for Phase 7 episode projection —
 * the projection queue, and the episode/membership writes a claimed job
 * performs. Runtime queue transitions use raw tenant-scoped SQL (same
 * pattern as Phase 6) because the migration owns RLS, trigger, and
 * operational-state checks that a plain Prisma client call would bypass.
 *
 * Cross-tenant claiming is an intentional system operation, identical to
 * Phase 4/6. Every claimed row carries tenant_id, and every later read or
 * transition re-enters an explicit tenant transaction (`withTenant`).
 */
@Injectable()
export class KnowledgeEpisodeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claimBatch(
    workerId: string,
    limit: number,
  ): Promise<KnowledgeEpisodeProjectionJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<KnowledgeEpisodeProjectionJobRow[]>`
        WITH stale_terminal AS (
          UPDATE knowledge_episode_projection_jobs
          SET
            status = 'dead_letter',
            locked_at = NULL,
            locked_by = NULL,
            last_error = 'MaxAttemptsExceeded',
            updated_at = CURRENT_TIMESTAMP
          WHERE status = 'processing'
            AND attempt_count >= 100
            AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          RETURNING id
        ),
        candidates AS (
          SELECT id
          FROM knowledge_episode_projection_jobs
          WHERE (
            (status IN ('pending', 'failed') AND available_at <= CURRENT_TIMESTAMP)
            OR
            (
              status = 'processing'
              AND attempt_count < 100
              AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
            )
          )
          -- Fresh due work has priority over stale recovery so one repeatedly
          -- crashed job cannot starve the live pending queue.
          ORDER BY
            CASE WHEN status IN ('pending', 'failed') THEN 0 ELSE 1 END,
            available_at ASC,
            created_at ASC,
            id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${boundedLimit}
        )
        UPDATE knowledge_episode_projection_jobs AS jobs
        SET
          status = 'processing',
          attempt_count = jobs.attempt_count + 1,
          available_at = CASE
            WHEN jobs.status = 'processing' THEN CURRENT_TIMESTAMP
            ELSE jobs.available_at
          END,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = ${workerId},
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        FROM candidates
        WHERE jobs.id = candidates.id
        RETURNING
          jobs.id,
          jobs.tenant_id,
          jobs.event_id,
          jobs.status,
          jobs.attempt_count,
          jobs.available_at,
          jobs.locked_at,
          jobs.locked_by,
          jobs.last_error,
          jobs.episode_id,
          jobs.created_at,
          jobs.updated_at
      `,
    );
    return rows.map(mapJob);
  }

  /**
   * Find an existing open episode by its deterministic identity key, or
   * create one from the founding event's exact scope. `ON CONFLICT DO
   * NOTHING` + re-select makes this race-safe: concurrent projections for
   * the same identity key converge on exactly one row, and the loser simply
   * re-reads the winner within the same tenant transaction.
   */
  async findOrCreateEpisode(input: {
    tenantId: string;
    strategy: KnowledgeEpisodeStrategy;
    identityKey: string;
    sensitivity: string;
    accessScope: KnowledgeJsonObject;
    clientRefs: KnowledgeRef[];
    groupingKey: KnowledgeJsonObject;
    occurredAt: Date;
  }): Promise<KnowledgeEpisodeRecord> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      await tx.$executeRaw`
        INSERT INTO knowledge_episodes (
          tenant_id, strategy, identity_key, sensitivity, access_scope,
          client_refs, grouping_key, first_event_at, last_event_at
        )
        VALUES (
          ${input.tenantId}::uuid,
          ${input.strategy},
          ${input.identityKey},
          ${input.sensitivity},
          CAST(${JSON.stringify(input.accessScope)} AS jsonb),
          CAST(${JSON.stringify(input.clientRefs)} AS jsonb),
          CAST(${JSON.stringify(input.groupingKey)} AS jsonb),
          ${input.occurredAt},
          ${input.occurredAt}
        )
        ON CONFLICT (tenant_id, strategy, identity_key) DO NOTHING
      `;
      const rows = await tx.$queryRaw<KnowledgeEpisodeRow[]>`
        SELECT
          id, tenant_id, strategy, identity_key, status, sensitivity,
          access_scope, client_refs, grouping_key, event_count,
          assertion_count, entity_count, first_event_at, last_event_at,
          metadata, created_at, updated_at
        FROM knowledge_episodes
        WHERE tenant_id = ${input.tenantId}::uuid
          AND strategy = ${input.strategy}
          AND identity_key = ${input.identityKey}
      `;
      if (rows.length !== 1) {
        throw new Error('Failed to find or create the deterministic episode row.');
      }
      return mapEpisode(rows[0]!);
    });
  }

  /**
   * Idempotent event-membership insert. `ON CONFLICT DO NOTHING` against the
   * `(tenant_id, event_id)` unique makes replay of the same projection job a
   * true no-op: the second attempt inserts zero rows and increments zero
   * counts. Counts and episode temporal bounds are updated with SQL
   * `GREATEST`/`LEAST`/increment expressions inside the SAME statement/CTE as
   * the conditional insert, so a duplicate insert can never double-count.
   */
  async addEventMembership(input: {
    tenantId: string;
    episodeId: string;
    eventId: string;
    occurredAt: Date;
  }): Promise<{ inserted: boolean }> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
        WITH inserted_row AS (
          INSERT INTO knowledge_episode_events (tenant_id, episode_id, event_id, occurred_at)
          VALUES (${input.tenantId}::uuid, ${input.episodeId}::uuid, ${input.eventId}::uuid, ${input.occurredAt})
          ON CONFLICT (tenant_id, episode_id, event_id) DO NOTHING
          RETURNING 1
        ),
        updated_episode AS (
          UPDATE knowledge_episodes
          SET
            event_count = event_count + (SELECT count(*) FROM inserted_row),
            first_event_at = LEAST(first_event_at, ${input.occurredAt}),
            last_event_at = GREATEST(last_event_at, ${input.occurredAt}),
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${input.episodeId}::uuid
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM inserted_row) AS inserted
      `;
      return { inserted: rows[0]?.inserted === true };
    });
  }

  /** Idempotent assertion-membership insert; same no-double-count pattern as events. */
  async addAssertionMembership(input: {
    tenantId: string;
    episodeId: string;
    assertionId: string;
    originEventId: string;
  }): Promise<{ inserted: boolean }> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
        WITH inserted_row AS (
          INSERT INTO knowledge_episode_assertions (tenant_id, episode_id, assertion_id, origin_event_id)
          VALUES (${input.tenantId}::uuid, ${input.episodeId}::uuid, ${input.assertionId}::uuid, ${input.originEventId}::uuid)
          ON CONFLICT (tenant_id, episode_id, assertion_id) DO NOTHING
          RETURNING 1
        ),
        updated_episode AS (
          UPDATE knowledge_episodes
          SET
            assertion_count = assertion_count + (SELECT count(*) FROM inserted_row),
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${input.episodeId}::uuid
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM inserted_row) AS inserted
      `;
      return { inserted: rows[0]?.inserted === true };
    });
  }

  /** Idempotent canonical-entity-membership insert; same no-double-count pattern. */
  async addEntityMembership(input: {
    tenantId: string;
    episodeId: string;
    canonicalEntityId: string;
  }): Promise<{ inserted: boolean }> {
    return this.prisma.withTenant(input.tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ inserted: boolean }>>`
        WITH inserted_row AS (
          INSERT INTO knowledge_episode_entities (tenant_id, episode_id, canonical_entity_id)
          VALUES (${input.tenantId}::uuid, ${input.episodeId}::uuid, ${input.canonicalEntityId}::uuid)
          ON CONFLICT (tenant_id, episode_id, canonical_entity_id) DO NOTHING
          RETURNING 1
        ),
        updated_episode AS (
          UPDATE knowledge_episodes
          SET
            entity_count = entity_count + (SELECT count(*) FROM inserted_row),
            updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = ${input.tenantId}::uuid
            AND id = ${input.episodeId}::uuid
          RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM inserted_row) AS inserted
      `;
      return { inserted: rows[0]?.inserted === true };
    });
  }

  async complete(
    job: KnowledgeEpisodeProjectionJobRecord,
    episodeId: string,
  ): Promise<boolean> {
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_episode_projection_jobs
        SET
          status = 'succeeded',
          episode_id = ${episodeId}::uuid,
          locked_at = NULL,
          locked_by = NULL,
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      return updated === 1;
    });
  }

  async skip(job: KnowledgeEpisodeProjectionJobRecord, reason: string): Promise<boolean> {
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_episode_projection_jobs
        SET
          status = 'skipped',
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${reason},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      return updated === 1;
    });
  }

  async fail(
    job: KnowledgeEpisodeProjectionJobRecord,
    error: unknown,
    maxAttempts: number,
  ): Promise<boolean> {
    const terminal = job.attemptCount >= maxAttempts;
    const delaySeconds = Math.min(
      15 * 60,
      Math.max(30, 30 * 2 ** Math.max(0, job.attemptCount - 1)),
    );
    const message = redactError(error);
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_episode_projection_jobs
        SET
          status = ${terminal ? 'dead_letter' : 'failed'},
          available_at = CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second'),
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${message},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      return updated === 1;
    });
  }
}

function mapJob(row: KnowledgeEpisodeProjectionJobRow): KnowledgeEpisodeProjectionJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventId: row.event_id,
    status: row.status as KnowledgeEpisodeProjectionJobStatus,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    episodeId: row.episode_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEpisode(row: KnowledgeEpisodeRow): KnowledgeEpisodeRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    strategy: row.strategy as KnowledgeEpisodeStrategy,
    identityKey: row.identity_key,
    status: row.status as KnowledgeEpisodeRecord['status'],
    sensitivity: row.sensitivity,
    accessScope: isJsonObject(row.access_scope) ? row.access_scope : {},
    clientRefs: Array.isArray(row.client_refs) ? (row.client_refs as KnowledgeRef[]) : [],
    groupingKey: isJsonObject(row.grouping_key) ? row.grouping_key : {},
    eventCount: Number(row.event_count),
    assertionCount: Number(row.assertion_count),
    entityCount: Number(row.entity_count),
    firstEventAt: row.first_event_at,
    lastEventAt: row.last_event_at,
    metadata: isJsonObject(row.metadata) ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isJsonObject(value: unknown): value is KnowledgeJsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function redactError(error: unknown): string {
  // Never persist a raw error message/exception into operational state — it
  // could echo private mailbox/source text. Only a stable error class name
  // is retained (same policy as the Phase 6 extraction repository).
  return error instanceof Error ? error.name : 'UnknownError';
}
