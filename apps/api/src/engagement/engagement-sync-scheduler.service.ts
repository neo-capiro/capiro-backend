import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';

/**
 * Auto-sync scheduler: periodic reconciliation syncs for connected M365/Google
 * mailboxes. Before this, syncs ran ONLY on Graph webhooks or a manual "Sync
 * now" — and Graph subscriptions expire after 6 days with renewal happening
 * only during syncs, so a lapsed subscription meant no webhook → no sync → no
 * renewal: connections went permanently silent while still showing
 * "connected" (observed live: mailboxes stale for 2+ weeks). Gmail had no
 * automation at all, which also let its short-lived historyId cursors expire
 * and degraded every manual sync into a full re-backfill.
 *
 * Design:
 *  - Claim-based and multi-instance safe: each tick atomically claims up to
 *    CLAIM_BATCH due connections (`FOR UPDATE SKIP LOCKED`) by pushing their
 *    next_sync_at one interval forward (the claim IS the lease), then syncs
 *    them sequentially. Two api tasks can tick concurrently without
 *    double-syncing; the per-tenant advisory lock (#139) additionally
 *    serializes writes if a webhook sync races a scheduled one.
 *  - status filter: 'connected' plus 'error' (markSyncError sets error with a
 *    15-minute nextSyncAt retry hint — the scheduler honors it). Connections
 *    needing re-consent (needs_configuration) and disabled ones are excluded;
 *    they need a human, not a retry loop.
 *  - M365 subscription renewal piggybacks on every scheduled sync (reuses
 *    subscriptions with >24h left, recreates the rest) — best-effort, never
 *    fails the sync.
 *  - Staleness watchdog: hourly WARN for syncable connections whose
 *    last_sync_at is >24h old — "connected" must mean "actually syncing".
 */
const TICK_MS = 60_000;
const CLAIM_BATCH = 5;
const CLAIM_JITTER_MINUTES = 5;
const STALE_WARN_HOURS = 24;
const STALE_CHECK_EVERY_TICKS = 60;

interface ClaimedConnection {
  id: string;
  tenant_id: string;
  provider: string;
  account_email: string | null;
}

@Injectable()
export class EngagementSyncSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngagementSyncSchedulerService.name);
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private tickCount = 0;
  private readonly enabled: boolean;
  private readonly intervalMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly microsoft: MicrosoftGraphSyncService,
    private readonly google: GoogleSyncService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get('ENGAGEMENT_AUTO_SYNC', { infer: true });
    this.intervalMinutes = config.get('ENGAGEMENT_SYNC_INTERVAL_MINUTES', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('engagement auto-sync disabled (ENGAGEMENT_AUTO_SYNC=off)');
      return;
    }
    this.timer = setInterval(() => {
      if (this.ticking) return; // overlap-skip: a slow batch must not stack ticks
      this.ticking = true;
      this.tick()
        .catch((err) =>
          this.logger.error(`engagement auto-sync tick failed: ${(err as Error).message}`),
        )
        .finally(() => {
          this.ticking = false;
        });
    }, TICK_MS);
    this.timer.unref?.();
    this.logger.log(
      `engagement auto-sync started (every ${this.intervalMinutes}m per connection, tick ${TICK_MS}ms, batch ${CLAIM_BATCH})`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One scheduler pass: claim due connections, sync each, watchdog hourly. */
  async tick(): Promise<void> {
    const claimed = await this.claimDueConnections();
    for (const connection of claimed) {
      await this.syncClaimed(connection);
    }
    this.tickCount += 1;
    if (this.tickCount % STALE_CHECK_EVERY_TICKS === 1) {
      await this.warnOnStaleConnections();
    }
  }

  /**
   * Atomically claim up to CLAIM_BATCH due connections by advancing their
   * next_sync_at one interval (+ jitter to spread mailboxes apart). SKIP
   * LOCKED makes concurrent instances take disjoint sets; the advanced
   * next_sync_at is the lease that keeps the next tick off them.
   */
  private async claimDueConnections(): Promise<ClaimedConnection[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRaw<ClaimedConnection[]>(Prisma.sql`
        UPDATE engagement_connections c
        SET next_sync_at = now()
          + make_interval(mins => ${this.intervalMinutes}::int)
          + (random() * make_interval(mins => ${CLAIM_JITTER_MINUTES}::int))
        WHERE c.id IN (
          SELECT id FROM engagement_connections
          WHERE provider IN ('microsoft_365', 'google_workspace')
            AND status IN ('connected', 'error')
            AND (next_sync_at IS NULL OR next_sync_at <= now())
          ORDER BY next_sync_at ASC NULLS FIRST
          LIMIT ${CLAIM_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING c.id::text AS id, c.tenant_id::text AS tenant_id,
                  c.provider::text AS provider, c.account_email::text AS account_email
      `),
    );
  }

  private async syncClaimed(connection: ClaimedConnection): Promise<void> {
    const label = `${connection.provider} ${connection.account_email ?? connection.id}`;
    try {
      if (connection.provider === 'microsoft_365') {
        await this.microsoft.syncConnectionByTenant(connection.tenant_id, connection.id);
        // Renewal MUST ride on scheduled syncs: it used to happen only at
        // connect time, so 6-day subscriptions expired and webhook delivery
        // died. Best-effort — a subscription failure never fails the sync.
        if (this.microsoft.subscriptionsConfigurable) {
          try {
            await this.microsoft.configureSubscriptionsByTenant(
              connection.tenant_id,
              connection.id,
            );
          } catch (err) {
            this.logger.warn(`subscription renewal failed for ${label}: ${(err as Error).message}`);
          }
        }
      } else if (connection.provider === 'google_workspace') {
        await this.google.syncConnectionByTenant(connection.tenant_id, connection.id);
      } else {
        return;
      }
      this.logger.log(`auto-synced ${label}`);
    } catch (err) {
      // The sync services already recorded the failure (markSyncError → status
      // 'error' + a 15-minute nextSyncAt retry hint, or needs_configuration
      // for consent/invalid_grant deaths, which drops the connection out of
      // scheduling until a human reconnects). Log and move to the next one.
      this.logger.warn(`auto-sync failed for ${label}: ${(err as Error).message}`);
    }
  }

  /** Hourly: surface syncable connections that are silently stale anyway. */
  private async warnOnStaleConnections(): Promise<void> {
    const stale = await this.prisma.withSystem((tx) =>
      tx.$queryRaw<Array<{ account_email: string | null; last_sync_at: Date | null }>>(Prisma.sql`
        SELECT account_email::text AS account_email, last_sync_at
        FROM engagement_connections
        WHERE provider IN ('microsoft_365', 'google_workspace')
          AND status IN ('connected', 'error')
          AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(hours => ${STALE_WARN_HOURS}::int))
        ORDER BY last_sync_at ASC NULLS FIRST
        LIMIT 10
      `),
    );
    if (stale.length > 0) {
      const detail = stale
        .map(
          (c) =>
            `${c.account_email ?? '(no address)'} last=${c.last_sync_at?.toISOString() ?? 'never'}`,
        )
        .join('; ');
      this.logger.warn(
        `engagement connections stale >${STALE_WARN_HOURS}h despite auto-sync: ${detail}`,
      );
    }
  }
}
