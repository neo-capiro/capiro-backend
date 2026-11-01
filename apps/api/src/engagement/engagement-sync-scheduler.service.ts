import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { runInDbLane } from '../prisma/db-lane.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { GoogleSyncService } from './google/google-sync.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import {
  MailboxBusyError,
  MailboxClaimLostError,
  withMailboxSyncClaim,
} from './mailbox-sync-claim.js';

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
 *  - Reads a bounded candidate list. The provider owner acquires its durable
 *    connection claim immediately before execution, shared with manual/webhook
 *    entry points. Queued candidates consume no lease time. next_sync_at only
 *    schedules work; claim tokens fence every provider persistence transaction.
 *  - status filter: 'connected' plus 'error' (markSyncError sets error with a
 *    15-minute nextSyncAt retry hint — the scheduler honors it). Connections
 *    needing re-consent (needs_configuration) and disabled ones are excluded;
 *    they need a human, not a retry loop.
 *  - M365 subscription renewal piggybacks on every scheduled sync under the
 *    same mailbox claim and total budget. Subscription errors are logged;
 *    pending recovery keeps its retry schedule.
 *  - Staleness watchdog: hourly WARN for syncable connections whose
 *    last_sync_at is >24h old — "connected" must mean "actually syncing".
 */
const TICK_MS = 60_000;
const CLAIM_BATCH = 5;
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
    private readonly runtimePolicy: EngagementRuntimePolicyService,
  ) {
    this.enabled = config.get('ENGAGEMENT_AUTO_SYNC', { infer: true });
    this.intervalMinutes = config.get('ENGAGEMENT_SYNC_INTERVAL_MINUTES', { infer: true });
  }

  onModuleInit(): void {
    // Fail-closed runtime policy check. The named check admits only this
    // scheduler under the explicit API-owner integrations_only exception;
    // every other worker and every disabled/engagement-api shadow posture
    // remains blocked.
    if (!this.runtimePolicy.backgroundWorkersEnabled('engagement-sync-scheduler')) {
      this.logger.log(
        'engagement-sync-scheduler disabled by runtime policy ' +
          `(service=${this.runtimePolicy.snapshot().serviceName} ` +
          `owner=${this.runtimePolicy.snapshot().backgroundOwner})`,
      );
      return;
    }
    if (!this.enabled) {
      this.logger.log('engagement auto-sync disabled (ENGAGEMENT_AUTO_SYNC=off)');
      return;
    }
    this.timer = setInterval(() => {
      if (this.ticking) return; // overlap-skip: a slow batch must not stack ticks
      this.ticking = true;
      // Every transaction a scheduled sync opens goes to the background pool,
      // never the request pool (prisma/db-lane.ts).
      runInDbLane('background', () => this.tick())
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
    this.runtimePolicy.assertBackgroundOwner('engagement-sync-scheduler');
    // Own the WHOLE tick: the scheduler_tick record stays live until every candidate
    // has been claimed and synced through the real integration proxies, so their
    // nested tenant work is a continuation of this owner instead of passing through
    // the NEW-work gate again. N's candidate query, per-connection withMailboxSyncClaim
    // execution, error handling and recovery scheduling are unchanged inside it.
    return this.runtimePolicy.runAdmittedMailHandoffWork('scheduler_tick', async () => {
      const claimed = await this.claimDueConnections();
      for (const connection of claimed) {
        await this.syncClaimed(connection);
      }
      this.tickCount += 1;
      if (this.tickCount % STALE_CHECK_EVERY_TICKS === 1) {
        await this.warnOnStaleConnections();
      }
    });
  }

  /** Candidate selection reserves nothing: the common provider claim owns execution. */
  private async claimDueConnections(): Promise<ClaimedConnection[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRaw<ClaimedConnection[]>(Prisma.sql`
          SELECT connection.id::text AS id, connection.tenant_id::text AS tenant_id,
                 connection.provider::text AS provider, connection.account_email::text AS account_email
          FROM engagement_connections AS connection
          WHERE connection.provider IN ('microsoft_365', 'google_workspace')
            AND connection.status IN ('connected', 'error')
            AND (connection.next_sync_at IS NULL OR connection.next_sync_at <= clock_timestamp())
            AND EXISTS (
              SELECT 1 FROM tenant_memberships AS membership
              WHERE membership.tenant_id = connection.tenant_id
                AND membership.user_id = connection.created_by_user_id
                AND membership.status = 'active'
            )
            AND NOT CASE
              WHEN connection.sync_state_jsonb->'oauthAttempt'->>'expiresAt'
                ~ '^[0-9]+([.][0-9]+)?$'
              THEN (connection.sync_state_jsonb->'oauthAttempt'->>'expiresAt')::numeric
                > EXTRACT(EPOCH FROM clock_timestamp())
              ELSE false
            END
          ORDER BY connection.next_sync_at ASC NULLS FIRST, connection.id
          LIMIT ${CLAIM_BATCH}
      `),
    );
  }

  private async syncClaimed(connection: ClaimedConnection): Promise<void> {
    const label = `${connection.provider} ${connection.account_email ?? connection.id}`;
    try {
      if (!['microsoft_365', 'google_workspace'].includes(connection.provider)) return;
      await withMailboxSyncClaim(
        this.prisma,
        connection.tenant_id,
        connection.id,
        async () => {
          if (connection.provider === 'microsoft_365') {
            await this.microsoft.syncConnectionByTenant(connection.tenant_id, connection.id);
            // The common claim remains held through resource sync and subscription
            // reconciliation; another scheduler cannot use this candidate in between.
            if (this.microsoft.subscriptionsConfigurable) {
              try {
                await this.microsoft.configureSubscriptionsByTenant(
                  connection.tenant_id,
                  connection.id,
                );
              } catch (err) {
                this.logger.warn(
                  `subscription renewal failed for ${label}: ${(err as Error).message}`,
                );
              }
            }
          } else {
            await this.google.syncConnectionByTenant(connection.tenant_id, connection.id);
          }
        },
        { requireDue: true, successIntervalMinutes: this.intervalMinutes },
      );
      this.logger.log(`auto-synced ${label}`);
    } catch (err) {
      if (err instanceof MailboxBusyError || err instanceof MailboxClaimLostError) return;
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
