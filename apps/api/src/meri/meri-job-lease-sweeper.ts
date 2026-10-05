/**
 * Meri job lease sweeper (program plan §5.2, Stage 2 Release A).
 *
 * A job runs inside the API process that claimed it, under a 120-second lease
 * renewed every 10 seconds. When that process dies (a deploy, a crash), nothing
 * renews the lease, and before this sweeper the stored state stayed `running`
 * or `cancel_requested` forever; only a read-time projection showed
 * "interrupted", and a requested stop never completed.
 *
 * The sweeper reclaims expired leases under the same compare-and-swap the
 * owners use:
 * - `running` becomes `interrupted` with `readyToStart: true`, so the next
 *   signed-in client resumes it under a new epoch without pressing Resume.
 *   The sweeper cannot resume execution itself: every V3 turn needs the
 *   user's session token.
 * - `cancel_requested` becomes `cancelled`, the same observation a live owner
 *   would record; completed and uncertain steps keep their outcomes.
 *
 * Dark unless MERI_JOB_SWEEPER_ENABLED=true. Every API replica may sweep; the
 * compare-and-swap lets exactly one of them reclaim a given lease.
 */
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  observeDurableResearchCancellation,
  readDurableResearchCoordinator,
} from './meri-research-coordinator.js';
import {
  RESEARCH_RUN_LEASE_MS,
  readResearchRun,
  researchMetadata,
  terminalResearchRun,
} from './meri-research-run-state.js';

export const MERI_JOB_SWEEP_INTERVAL_MS = 60_000;
/** Reclaim only well after expiry, so a slow heartbeat is never taken for a dead worker. */
export const MERI_JOB_SWEEP_GRACE_MS = 60_000;
export const MERI_JOB_SWEEP_BATCH = 50;
export const MERI_JOB_REQUEUED_STAGE =
  'The server restarted while this job was running. It continues when you reopen the conversation.';

export function meriJobSweeperEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MERI_JOB_SWEEPER_ENABLED === 'true';
}

export interface MeriJobLeaseReclaim {
  action: 'requeue' | 'cancel';
  status: string;
  metadata: Record<string, unknown>;
}

/** Pure: what to persist for one session, or null when its lease is still live. */
export function reclaimExpiredJobLease(
  session: { status: string; metadata: unknown; reportArtifactId?: string | null },
  now: Date,
): MeriJobLeaseReclaim | null {
  if (session.reportArtifactId) return null;
  const metadata = researchMetadata(session.metadata);
  const raw = metadata.run;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawStatus = (raw as Record<string, unknown>).status;
  if (rawStatus !== 'running' && rawStatus !== 'cancel_requested') return null;
  const heartbeat = Date.parse(String((raw as Record<string, unknown>).heartbeatAt ?? ''));
  if (
    Number.isFinite(heartbeat) &&
    now.getTime() - heartbeat <= RESEARCH_RUN_LEASE_MS + MERI_JOB_SWEEP_GRACE_MS
  )
    return null;
  const run = readResearchRun(metadata, now.getTime());
  if (!run) return null;

  if (rawStatus === 'running') {
    const requeued = {
      ...terminalResearchRun(run, 'interrupted', MERI_JOB_REQUEUED_STAGE, now),
      readyToStart: true,
      failureReason: undefined,
    };
    return {
      action: 'requeue',
      status: session.status,
      metadata: { ...metadata, run: requeued },
    };
  }

  let coordinatorRequested = false;
  try {
    coordinatorRequested =
      readDurableResearchCoordinator(metadata)?.cancellation.state === 'requested';
  } catch {
    coordinatorRequested = false;
  }
  if (coordinatorRequested) {
    const observed = observeDurableResearchCancellation({ metadata, now });
    return { action: 'cancel', status: 'cancelled', metadata: observed.metadata };
  }
  return {
    action: 'cancel',
    status: 'cancelled',
    metadata: {
      ...metadata,
      run: terminalResearchRun(run, 'cancelled', 'Research stopped at your request', now),
    },
  };
}

const EXPIRED_LIVE_RUNS_SQL = `
SELECT id, tenant_id AS "tenantId", status, report_artifact_id AS "reportArtifactId",
       metadata_jsonb AS metadata
  FROM clio_research_sessions
 WHERE (metadata_jsonb #>> '{run,status}') IN ('running', 'cancel_requested')
   AND (metadata_jsonb #>> '{run,heartbeatAt}') < $1
   AND report_artifact_id IS NULL
 ORDER BY (metadata_jsonb #>> '{run,heartbeatAt}')
 LIMIT $2`;

interface ExpiredRow {
  id: string;
  tenantId: string;
  status: string;
  reportArtifactId: string | null;
  metadata: unknown;
}

@Injectable()
export class MeriJobLeaseSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MeriJobLeaseSweeper.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private starter: ReturnType<typeof setTimeout> | undefined;
  private sweeping = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    if (!meriJobSweeperEnabled()) return;
    // Stagger replicas so they do not all sweep in the same second.
    const firstDelay = 30_000 + Math.floor(Math.random() * 30_000);
    this.starter = setTimeout(() => {
      void this.sweep();
      this.timer = setInterval(() => void this.sweep(), MERI_JOB_SWEEP_INTERVAL_MS);
      this.timer.unref?.();
    }, firstDelay);
    this.starter.unref?.();
    this.logger.log('meri_job_sweeper_enabled');
  }

  onModuleDestroy(): void {
    if (this.starter) clearTimeout(this.starter);
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Returns how many leases this replica reclaimed. */
  async sweep(now = new Date()): Promise<{ scanned: number; reclaimed: number }> {
    if (this.sweeping) return { scanned: 0, reclaimed: 0 };
    this.sweeping = true;
    try {
      const cutoff = new Date(
        now.getTime() - RESEARCH_RUN_LEASE_MS - MERI_JOB_SWEEP_GRACE_MS,
      ).toISOString();
      const rows = (await this.prisma.withSystem((tx) =>
        tx.$queryRawUnsafe(EXPIRED_LIVE_RUNS_SQL, cutoff, MERI_JOB_SWEEP_BATCH),
      )) as ExpiredRow[];
      let reclaimed = 0;
      for (const row of rows) {
        const decision = reclaimExpiredJobLease(row, now);
        if (!decision) continue;
        const changed = await this.prisma.withSystem((tx) =>
          tx.clioResearchSession.updateMany({
            where: {
              id: row.id,
              tenantId: row.tenantId,
              reportArtifactId: null,
              metadata: { equals: row.metadata as Prisma.InputJsonValue },
            },
            data: {
              status: decision.status,
              metadata: decision.metadata as unknown as Prisma.InputJsonObject,
              updatedAt: now,
            },
          }),
        );
        if (!changed.count) continue;
        reclaimed += 1;
        this.logger.log(
          `meri_job_lease_reclaimed ${JSON.stringify({
            sessionId: row.id,
            tenantId: row.tenantId,
            action: decision.action,
          })}`,
        );
      }
      return { scanned: rows.length, reclaimed };
    } catch (error) {
      this.logger.warn(
        `meri_job_sweep_failed ${error instanceof Error ? error.message : 'unknown error'}`,
      );
      return { scanned: 0, reclaimed: 0 };
    } finally {
      this.sweeping = false;
    }
  }
}
