import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/*
 * Stage F2 outbox consumer. VersioningService.logActivity emits an
 * sp_event_outbox row in the SAME tx as every strategy/node mutation; this
 * loop drains those rows and brings the affected strategies' active cadence
 * missions FORWARD (nextRunAt = now()), so a plan edit triggers a watcher
 * check within one scheduler poll instead of waiting out the cadence.
 *
 * Same shape as WatcherSchedulerService: plain setInterval (no
 * @nestjs/schedule), dark unless BOTH env switches are on, re-entrancy
 * guarded, claim-on-read via FOR UPDATE SKIP LOCKED inside withSystem
 * (cross-tenant drain). consumedAt is stamped in the same statement that
 * claims, and — like the scheduler — that ONE statement is the ENTIRE claim
 * tx: it commits before any per-target work. withSystem exposes no timeout
 * option, so an interactive tx runs under Prisma's default 5s limit; keeping
 * the tx to a single statement means the drain can never outgrow it however
 * large the batch, and a poisoned bump can never roll consumption back (no
 * eternal re-claim of the same oversized batch every interval). A crash
 * BEFORE the claim commits rolls back (rows stay unconsumed; a later drain
 * re-claims via SKIP LOCKED). A failure AFTER it commits consumes the batch
 * with some bumps missed — acceptable by design: the bring-forward is a
 * best-effort latency optimization and every missed target is still covered
 * by its missions' regular cadence. A committed drain never reprocesses:
 * consumedAt IS NULL filters it out forever (idempotent).
 */

/**
 * Activity actions that should wake a strategy's watcher missions. Everything
 * else in the outbox (mission.*, run.*, changeset.* bookkeeping) is consumed
 * and ignored — critically, the watcher's OWN writes are non-triggering, so
 * the loop cannot feed itself.
 */
export const WATCH_TRIGGERING_TYPES: ReadonlySet<string> = new Set([
  'node.created',
  'node.updated',
  'node.deleted',
  'strategy.assisted',
  'version.restored',
  'reference.forked',
  'steward.extracted',
]);
// MEETING-COMPLETION SEAM (deferred): when the meetings association lands
// (Phase 2 backlog), its sync should emit e.g. 'meeting.completed' with a
// payload.strategyId (via sp_node_artifact back-links); adding that action to
// WATCH_TRIGGERING_TYPES is the ONLY change this consumer needs.

/** One claimed outbox row (payload shape per VersioningService.logActivity). */
interface ClaimedEvent {
  id: string;
  tenantId: string;
  type: string;
  payload: {
    entityType?: string;
    entityId?: string;
    strategyId?: string;
    [k: string]: unknown;
  } | null;
}

export interface DrainResult {
  claimed: number;
  triggering: number;
  missionsBumped: number;
}

const CLAIM_BATCH = 500;
const DEFAULT_OUTBOX_MS = 30_000;
// The outbox drain is cheap (indexed claim + a few updates); still, never
// allow a sub-5s stampede from a fat-fingered env value.
const MIN_OUTBOX_MS = 5_000;

@Injectable()
export class OutboxConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxConsumerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard shared across this consumer's interval fires. */
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Same double env gate as the scheduler — dark by default. */
  onModuleInit(): void {
    if (
      process.env.STRATEGY_AGENTS_ENABLED !== 'true' ||
      process.env.STRATEGY_WATCHER_SCHEDULER !== 'true'
    ) {
      return;
    }
    const raw = Number(process.env.STRATEGY_WATCHER_OUTBOX_MS);
    const intervalMs = Math.max(
      Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OUTBOX_MS,
      MIN_OUTBOX_MS,
    );
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
    this.logger.log(`outbox consumer armed (drain every ${intervalMs}ms)`);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Interval callback: guarded so a slow drain is never overlapped. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(`outbox drain failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * One claim+process pass (exposed for tests). The claim is its own
   * SINGLE-STATEMENT withSystem tx and commits first; node resolution and
   * each per-target mission bump then run in separate short transactions
   * with per-target error isolation — the scheduler's claim-then-isolate
   * shape, so an oversized or poisoned batch can neither hit the 5s
   * interactive-tx timeout (P2028) nor be re-claimed identically forever.
   */
  async drainOnce(): Promise<DrainResult> {
    // ATOMIC CLAIM: stamp consumedAt and return the batch in one statement;
    // SKIP LOCKED keeps concurrent pods off the same rows (mirrors
    // intel-alert flushDigests and the scheduler claim). This statement is
    // deliberately the ENTIRE transaction — see header.
    const claimed = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<ClaimedEvent[]>`
        UPDATE sp_event_outbox o
           SET consumed_at = now()
          FROM (
            SELECT id FROM sp_event_outbox
             WHERE consumed_at IS NULL
             ORDER BY created_at ASC
             LIMIT ${CLAIM_BATCH}
             FOR UPDATE SKIP LOCKED
          ) c
         WHERE o.id = c.id
        RETURNING o.id, o.tenant_id AS "tenantId", o.type, o.payload`,
    );
    if (claimed.length === 0) return { claimed: 0, triggering: 0, missionsBumped: 0 };

    // Resolve each watch-triggering event to (tenantId, strategyId).
    //  - an explicit payload.strategyId wins (node.deleted MUST set it — the
    //    sp_node row is deleted in the emitting tx, so the node lookup below
    //    can never resolve it; future emitters may set it too);
    //  - entityType 'strategy' => entityId IS the strategy;
    //  - entityType 'node' => batch-resolve node -> strategy below.
    // Unresolvable events (steward.extracted's context_document,
    // reference.forked's calendar row) are consumed without a bump —
    // documented best-effort: those surfaces are covered by the missions'
    // regular cadence, and firm-level calendar missions poll on cadence
    // through the scheduler anyway.
    const triggering = claimed.filter((e) => WATCH_TRIGGERING_TYPES.has(e.type));
    const nodeIdToEvent = new Map<string, ClaimedEvent[]>();
    const targets = new Set<string>(); // "tenantId|strategyId"
    for (const evt of triggering) {
      const p = evt.payload ?? {};
      if (typeof p.strategyId === 'string' && p.strategyId) {
        targets.add(`${evt.tenantId}|${p.strategyId}`);
      } else if (p.entityType === 'strategy' && typeof p.entityId === 'string') {
        targets.add(`${evt.tenantId}|${p.entityId}`);
      } else if (p.entityType === 'node' && typeof p.entityId === 'string') {
        const list = nodeIdToEvent.get(p.entityId) ?? [];
        list.push(evt);
        nodeIdToEvent.set(p.entityId, list);
      }
    }
    if (nodeIdToEvent.size > 0) {
      // Own short tx (single indexed read). withSystem = bypass scope: the
      // tenant hook injects nothing, so this cross-tenant read works; the
      // tenantId re-check below pins each node to its event's tenant
      // (defense-in-depth against payload confusion). Best-effort: a failed
      // lookup only costs this batch's node-derived bumps (cadence covers
      // them) — the claim is already committed, so nothing is re-claimed.
      try {
        const nodes = await this.prisma.withSystem((tx) =>
          tx.spNode.findMany({
            where: { id: { in: [...nodeIdToEvent.keys()] } },
            select: { id: true, tenantId: true, strategyId: true },
          }),
        );
        for (const node of nodes) {
          for (const evt of nodeIdToEvent.get(node.id) ?? []) {
            if (evt.tenantId === node.tenantId) {
              targets.add(`${node.tenantId}|${node.strategyId}`);
            }
          }
        }
      } catch (err) {
        this.logger.error(
          `outbox node resolution failed (${nodeIdToEvent.size} node id(s)): ${(err as Error).message}`,
        );
      }
    }

    // Bring each target strategy's ACTIVE CADENCE missions forward: the
    // scheduler's next poll claims them immediately. Only forward — a
    // mission already due (nextRunAt <= now) is left alone. Manual-only
    // missions (cadence null) are deliberately untouched: they run ONLY on
    // an explicit run-check request, never from events.
    // Each target gets its OWN short tx + try/catch (per-target isolation,
    // like the scheduler's per-mission loop): a poisoned target is logged and
    // skipped — its missions still fire on cadence — and can never roll back
    // the claim, starve the other targets, or blow a batch-wide tx timeout.
    const now = new Date();
    let missionsBumped = 0;
    for (const key of targets) {
      const [tenantId, strategyId] = key.split('|');
      try {
        const res = await this.prisma.withSystem((tx) =>
          tx.spAgentMission.updateMany({
            where: {
              tenantId, // bypass scope injects nothing — scope explicitly
              strategyId,
              state: 'active',
              cadence: { not: null },
              OR: [{ nextRunAt: null }, { nextRunAt: { gt: now } }],
            },
            data: { nextRunAt: now },
          }),
        );
        missionsBumped += res.count;
      } catch (err) {
        this.logger.error(
          `outbox mission bump failed (tenant ${tenantId}, strategy ${strategyId}): ${(err as Error).message}`,
        );
      }
    }

    return { claimed: claimed.length, triggering: triggering.length, missionsBumped };
  }
}
