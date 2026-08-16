import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';

export type CanonicalEntityBackfillCheckpointStatus = 'running' | 'completed' | 'failed';

export interface CanonicalEntityBackfillCheckpointRecord {
  id: string;
  tenantId: string | null;
  source: string;
  cursor: string | null;
  status: CanonicalEntityBackfillCheckpointStatus;
  scanned: number;
  created: number;
  linked: number;
  ambiguous: number;
  skipped: number;
  failed: number;
  lastError: string | null;
  startedAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface CanonicalEntityBackfillPageSummary {
  nextCursor: string | null;
  scanned: number;
  created: number;
  linked: number;
  ambiguous: number;
  skipped: number;
  failed: number;
  /** True when this page exhausted the source cohort with no failure. */
  complete: boolean;
  /** Non-null halts the run in a 'failed' terminal state. */
  errorMessage: string | null;
}

interface CheckpointRow {
  id: string;
  tenant_id: string | null;
  source: string;
  source_cursor: string | null;
  status: CanonicalEntityBackfillCheckpointStatus;
  scanned: number;
  created: number;
  linked: number;
  ambiguous: number;
  skipped: number;
  failed: number;
  last_error: string | null;
  started_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

/**
 * Durable resumability bookkeeping for canonical-entity backfill runs
 * (tenant-scoped CRM sources and the global public-reference sources alike —
 * NULL tenant_id denotes a global/system source). Source rows remain the
 * source of truth for identity; this repository only ever records a
 * high-water-mark cursor and bounded counters, and every mutation is a single
 * atomic statement so a crash between pages can never leave counts ahead of
 * what backfill writes actually committed.
 */
@Injectable()
export class CanonicalEntityBackfillCheckpointRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    tenantId: string | null,
    source: string,
  ): Promise<CanonicalEntityBackfillCheckpointRecord | null> {
    return this.prisma.withSystem(async (tx) => {
      const rows =
        tenantId === null
          ? await tx.$queryRaw<CheckpointRow[]>`
              SELECT id, tenant_id, source, source_cursor, status, scanned, created,
                     linked, ambiguous, skipped, failed, last_error, started_at,
                     updated_at, completed_at
              FROM canonical_entity_backfill_checkpoints
              WHERE tenant_id IS NULL AND source = ${source}
              LIMIT 1
            `
          : await tx.$queryRaw<CheckpointRow[]>`
              SELECT id, tenant_id, source, source_cursor, status, scanned, created,
                     linked, ambiguous, skipped, failed, last_error, started_at,
                     updated_at, completed_at
              FROM canonical_entity_backfill_checkpoints
              WHERE tenant_id = ${tenantId}::uuid AND source = ${source}
              LIMIT 1
            `;
      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /**
   * Idempotent start: creates a fresh 'running' checkpoint the first time a
   * (tenant, source) run begins, otherwise returns whatever is already there
   * (including a prior 'running' row so a restarted process resumes from its
   * persisted cursor, or a 'completed'/'failed' row so the caller can decide
   * whether to treat that as done or to fail loudly rather than silently
   * restarting a finished source from scratch).
   */
  async startOrResume(
    tenantId: string | null,
    source: string,
  ): Promise<CanonicalEntityBackfillCheckpointRecord> {
    await this.prisma.withSystem(async (tx) => {
      if (tenantId === null) {
        await tx.$executeRaw`
          INSERT INTO canonical_entity_backfill_checkpoints (tenant_id, source, status)
          VALUES (NULL, ${source}, 'running')
          ON CONFLICT (source) WHERE tenant_id IS NULL DO NOTHING
        `;
      } else {
        await tx.$executeRaw`
          INSERT INTO canonical_entity_backfill_checkpoints (tenant_id, source, status)
          VALUES (${tenantId}::uuid, ${source}, 'running')
          ON CONFLICT (tenant_id, source) WHERE tenant_id IS NOT NULL DO NOTHING
        `;
      }
    });
    const record = await this.find(tenantId, source);
    if (!record) {
      throw new Error(
        `Failed to start or resume canonical entity backfill checkpoint for source=${source}`,
      );
    }
    return record;
  }

  /**
   * Records one completed page's worth of work. Counters are incremented in
   * place (not overwritten) so they accumulate across every page of a run,
   * including pages replayed after a resume. Called only after the page's own
   * writes have already committed, so the checkpoint never claims progress
   * that was not actually durably persisted.
   */
  async recordPage(
    tenantId: string | null,
    source: string,
    page: CanonicalEntityBackfillPageSummary,
  ): Promise<CanonicalEntityBackfillCheckpointRecord> {
    const status: CanonicalEntityBackfillCheckpointStatus = page.errorMessage
      ? 'failed'
      : page.complete
        ? 'completed'
        : 'running';

    await this.prisma.withSystem(async (tx) => {
      if (tenantId === null) {
        await tx.$executeRaw`
          UPDATE canonical_entity_backfill_checkpoints
          SET source_cursor = ${page.nextCursor},
              status = ${status},
              scanned = scanned + ${page.scanned},
              created = created + ${page.created},
              linked = linked + ${page.linked},
              ambiguous = ambiguous + ${page.ambiguous},
              skipped = skipped + ${page.skipped},
              failed = failed + ${page.failed},
              last_error = ${page.errorMessage},
              completed_at = CASE WHEN ${status} = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE tenant_id IS NULL AND source = ${source}
        `;
      } else {
        await tx.$executeRaw`
          UPDATE canonical_entity_backfill_checkpoints
          SET source_cursor = ${page.nextCursor},
              status = ${status},
              scanned = scanned + ${page.scanned},
              created = created + ${page.created},
              linked = linked + ${page.linked},
              ambiguous = ambiguous + ${page.ambiguous},
              skipped = skipped + ${page.skipped},
              failed = failed + ${page.failed},
              last_error = ${page.errorMessage},
              completed_at = CASE WHEN ${status} = 'completed' THEN CURRENT_TIMESTAMP ELSE NULL END
          WHERE tenant_id = ${tenantId}::uuid AND source = ${source}
        `;
      }
    });

    const record = await this.find(tenantId, source);
    if (!record) {
      throw new Error(
        `Canonical entity backfill checkpoint for source=${source} disappeared mid-run`,
      );
    }
    return record;
  }
}

function toRecord(row: CheckpointRow): CanonicalEntityBackfillCheckpointRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    source: row.source,
    cursor: row.source_cursor,
    status: row.status,
    scanned: row.scanned,
    created: row.created,
    linked: row.linked,
    ambiguous: row.ambiguous,
    skipped: row.skipped,
    failed: row.failed,
    lastError: row.last_error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
