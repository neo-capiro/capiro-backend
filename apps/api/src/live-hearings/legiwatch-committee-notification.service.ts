import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerEmailService } from '../tracker/notifications/tracker-email.service.js';

const MAX_ATTEMPTS = 6;
const PAGE_SIZE = 100;
const CATCHUP_SIZE = 20;

export interface IntakeCounts {
  recipients: number;
  inserted: number;
}
export interface DrainResult {
  scanned: number;
  sent: number;
  retryScheduled: number;
  terminalFailures: number;
  suppressed: number;
}
interface Follow {
  id: string;
  tenantId: string;
  userId: string;
  startedAt: Date | null;
}
interface Claim {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string | null;
  deepLink: string;
  dedupKey: string;
  attempts: number;
  leaseId: string;
  claimedAt: Date;
}

// These are the same observations shown in a committee's publications feed.
// Flags apply to their source category even when no canonical hearing exists yet.
const categoryEnabled = Prisma.sql`CASE
  WHEN u.update_type='hearing_announced' THEN f.notify_on_new_hearing
  WHEN u.update_type IN ('date_changed','time_changed','room_changed','postponed','canceled')
    THEN f.notify_on_schedule_change
  WHEN u.update_type='official_transcript_posted'
    THEN (f.notify_on_publication OR f.notify_on_transcript_ready)
  ELSE f.notify_on_publication END`;

const lifecycleCategoryEnabled = Prisma.sql`CASE
  WHEN n.event_type IN ('schedule_changed','location_changed','witnesses_changed') THEN f.notify_on_schedule_change
  WHEN n.event_type IN ('transcript_ready','intelligence_ready') THEN f.notify_on_transcript_ready
  WHEN n.event_type='high_priority_match' THEN f.notify_on_high_priority_match
  ELSE false END`;

const lifecycleRecipient = Prisma.sql`
  SELECT account.email FROM users account
  JOIN tenant_memberships m ON m.user_id=account.id AND m.tenant_id=n.tenant_id AND m.status='active'
  JOIN legiwatch_committee_email_preference p ON p.user_id=account.id::text AND p.tenant_id=m.tenant_id
    AND p.committee_email_enabled=true
  JOIN legiwatch_committee_follow f ON f.user_id=account.id::text AND f.tenant_id=m.tenant_id
    AND lower(f.committee_system_code)=lower(n.committee_system_code)
  WHERE account.id::text=n.user_id AND (${lifecycleCategoryEnabled})
    AND n.created_at>p.updated_at AND n.created_at>f.updated_at
    AND n.created_at>f.alert_started_at
    AND (n.client_id IS NULL OR cardinality(f.client_ids)=0 OR n.client_id=ANY(f.client_ids))`;

/** Durable committee inbox intake and opt-in email delivery.
 * Inserts and initial catch-up boundaries commit together. Later ticks reconcile
 * every unrepresented observation, including observations committed after an
 * earlier tick. Delivery is at least once: SES acceptance followed by a process
 * crash before persistence can cause a duplicate email on recovery.
 */
@Injectable()
export class LegiWatchCommitteeNotificationService {
  private readonly appOrigin: string;
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: TrackerEmailService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.appOrigin = config.get('LEGIWATCH_APP_BASE_URL', { infer: true });
  }

  async syncFollow(input: { committeeSystemCode: string }): Promise<IntakeCounts> {
    // Global worker discovery is intentional; every recipient operation below
    // states its tenant explicitly because raw SQL bypasses Prisma's query hook.
    const follows = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<Follow[]>`
      SELECT id::text, tenant_id::text AS "tenantId", user_id AS "userId"
      FROM legiwatch_committee_follow
      WHERE lower(committee_system_code)=lower(${input.committeeSystemCode})`,
    );
    let inserted = 0;
    for (const follow of follows) {
      for (let page = 0; page < 4; page++) {
        const count = await this.intake(follow, false);
        inserted += count;
        if (count < PAGE_SIZE) break;
      }
    }
    return { recipients: follows.length, inserted };
  }

  async catchUpFollow(input: {
    tenantId: string;
    userId: string;
    committeeSystemCode: string;
  }): Promise<{ inserted: number }> {
    const follows = await this.prisma.withTenant(
      input.tenantId,
      (tx) => tx.$queryRaw<Follow[]>`
      SELECT id::text, tenant_id::text AS "tenantId", user_id AS "userId"
      FROM legiwatch_committee_follow
      WHERE tenant_id=${input.tenantId}::uuid AND user_id=${input.userId}
        AND lower(committee_system_code)=lower(${input.committeeSystemCode})`,
    );
    return { inserted: follows[0] ? await this.intake(follows[0], true) : 0 };
  }

  private async intake(follow: Follow, catchupOnly: boolean): Promise<number> {
    return this.prisma.withTenant(follow.tenantId, async (tx) => {
      const locked = await tx.$queryRaw<Follow[]>`
        SELECT id::text, alert_started_at AS "startedAt"
        FROM legiwatch_committee_follow
        WHERE id=${follow.id}::uuid AND tenant_id=${follow.tenantId}::uuid
          AND user_id=${follow.userId} FOR UPDATE`;
      if (!locked[0] || (catchupOnly && locked[0].startedAt)) return 0;
      const initial = !locked[0].startedAt;
      // New follows and existing follows at rollout get bounded recent in-app
      // history. This marker never advances: NOT EXISTS supplies durable progress
      // without dropping late commits or bursts larger than a worker batch.
      if (initial)
        await tx.$executeRaw`
        UPDATE legiwatch_committee_follow SET alert_started_at=now()
        WHERE id=${follow.id}::uuid AND tenant_id=${follow.tenantId}::uuid`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH observations AS (
          SELECT DISTINCT ON (u.content_hash) u.*,
            (NOT ${initial} AND p.committee_email_enabled=true
              AND u.first_seen_at>p.updated_at AND u.first_seen_at>f.updated_at
              AND p.email_address IS NOT NULL) AS queue_email
          FROM legiwatch_committee_follow f
          LEFT JOIN congress_committee c ON lower(c.system_code)=lower(f.committee_system_code)
          JOIN committee_site_update u ON (
            lower(u.committee_system_code)=lower(f.committee_system_code)
            OR lower(u.committee_system_code)=lower(c.parent_system_code))
          LEFT JOIN legiwatch_committee_email_preference p
            ON p.tenant_id=f.tenant_id AND p.user_id=f.user_id
          WHERE f.id=${follow.id}::uuid AND f.tenant_id=${follow.tenantId}::uuid
            AND f.user_id=${follow.userId}
            AND EXISTS (SELECT 1 FROM tenant_memberships m
              WHERE m.tenant_id=f.tenant_id AND m.user_id::text=f.user_id AND m.status='active')
            AND (${categoryEnabled})
            AND ${
              initial
                ? Prisma.sql`u.first_seen_at>=now()-interval '30 days'`
                : Prisma.sql`u.created_at>=f.alert_started_at`
            }
            AND NOT EXISTS (SELECT 1 FROM legiwatch_notification_event n
              WHERE n.tenant_id=f.tenant_id AND n.user_id=f.user_id
                AND n.dedup_key='committee_update:'||u.content_hash)
          ORDER BY u.content_hash,u.first_seen_at DESC,u.id DESC
        ), batch AS (
          SELECT * FROM observations
          ORDER BY ${initial ? Prisma.sql`first_seen_at DESC,id DESC` : Prisma.sql`created_at ASC,id ASC`}
          LIMIT ${initial ? CATCHUP_SIZE : PAGE_SIZE}
        )
        INSERT INTO legiwatch_notification_event
          (tenant_id,user_id,event_type,hearing_id,committee_system_code,title,body,deep_link,dedup_key,
           email_delivery_status,email_delivery_next_attempt_at)
        SELECT ${follow.tenantId}::uuid,${follow.userId},
          CASE WHEN update_type='hearing_announced' THEN 'new_hearing' ELSE 'committee_publication' END,
          hearing_id,committee_system_code,left(normalized_title,500),normalized_summary,
          '/legiwatch/committees/'||committee_system_code||'?tab=updates',
          'committee_update:'||content_hash,
          CASE WHEN queue_email THEN 'queued' ELSE NULL END,
          CASE WHEN queue_email THEN now() ELSE NULL END
        FROM batch ON CONFLICT (tenant_id,user_id,dedup_key) DO NOTHING RETURNING id`);
      return rows.length;
    });
  }

  async drainEmail(now?: Date): Promise<DrainResult> {
    const result: DrainResult = {
      scanned: 0,
      sent: 0,
      retryScheduled: 0,
      terminalFailures: 0,
      suppressed: 0,
    };
    // Existing hearing lifecycle emitters already persist their recipient rows.
    // Reconcile their opted-in committee recipients too, without rewriting those
    // emitters or changing the Clerk-ID contracts used by other inbox producers.
    await this.prisma.withSystem((tx) =>
      tx.$executeRaw(Prisma.sql`
      UPDATE legiwatch_notification_event n
      SET email_delivery_status='queued',email_delivery_next_attempt_at=now()
      WHERE n.email_delivery_status IS NULL
        AND n.event_type IN ('schedule_changed','location_changed','witnesses_changed',
          'transcript_ready','intelligence_ready','high_priority_match')
        AND EXISTS (${lifecycleRecipient})`),
    );
    // Claim one message immediately before sending it, so an earlier slow send
    // cannot consume the lease of messages waiting later in a serial batch.
    for (let i = 0; i < 100; i++) {
      const row = await this.claim(now);
      if (!row) break;
      const at = row.claimedAt;
      result.scanned++;
      if (row.attempts > MAX_ATTEMPTS) {
        await this.finish(row, 'failed_final', 'Delivery attempt limit reached', at);
        result.terminalFailures++;
        continue;
      }
      const recipient = await this.recipient(row);
      if (!recipient) {
        await this.finish(row, 'suppressed', 'Recipient no longer eligible', at);
        result.suppressed++;
        continue;
      }
      // Renew while a transport request is outstanding. Fenced completion keeps
      // an expired or replaced claim from overwriting another worker's result.
      const renewal = setInterval(() => {
        void this.renew(row).catch(() => {
          /* Claim expiry permits recovery after DB outage. */
        });
      }, 30_000);
      renewal.unref();
      try {
        const link = new URL(row.deepLink, this.appOrigin).toString();
        const sent = await this.email.send(
          recipient,
          `[Capiro alerts] ${row.title}`.slice(0, 200),
          `<h2>${escapeHtml(row.title)}</h2><p>${escapeHtml(row.body ?? '')}</p>` +
            `<p><a href="${escapeHtml(link)}">Open in Capiro</a></p>` +
            '<p>You receive this because you follow this committee. Manage email alerts in Settings.</p>',
          `${row.title}\n\n${row.body ?? ''}\n\nOpen in Capiro: ${link}\nManage email alerts in Settings.`,
        );
        if (sent.sent) {
          await this.finish(row, 'sent', null, at);
          result.sent++;
        } else {
          await this.failed(row, sent.error ?? 'Email delivery failed', at, result);
        }
      } catch (error) {
        await this.failed(row, error instanceof Error ? error.message : String(error), at, result);
      } finally {
        clearInterval(renewal);
      }
    }
    return result;
  }

  private async claim(now?: Date): Promise<Claim | undefined> {
    const leaseId = randomUUID();
    const rows = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<Claim[]>`
      WITH candidate AS (
        SELECT id FROM legiwatch_notification_event
        WHERE email_delivery_status IN ('queued','retry_wait','sending')
          AND (email_delivery_next_attempt_at IS NULL OR email_delivery_next_attempt_at<=COALESCE(${now ?? null}::timestamptz,now()))
          AND (email_delivery_lease_until IS NULL OR email_delivery_lease_until<=COALESCE(${now ?? null}::timestamptz,now()))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE legiwatch_notification_event n
      SET email_delivery_status='sending',email_delivery_attempts=email_delivery_attempts+1,
        email_delivery_lease_id=${leaseId},
        email_delivery_lease_until=COALESCE(${now ?? null}::timestamptz,now())+interval '5 minutes'
      FROM candidate WHERE n.id=candidate.id
      RETURNING n.id::text,n.tenant_id::text AS "tenantId",n.user_id AS "userId",n.title,n.body,
        n.deep_link AS "deepLink",n.dedup_key AS "dedupKey",
        n.email_delivery_attempts AS attempts,n.email_delivery_lease_id AS "leaseId",
        COALESCE(${now ?? null}::timestamptz,now()) AS "claimedAt"`,
    );
    return rows[0];
  }

  private async recipient(row: Claim): Promise<string | null> {
    if (!row.dedupKey.startsWith('committee_update:')) {
      const rows = await this.prisma.withTenant(row.tenantId, (tx) =>
        tx.$queryRaw<Array<{ email: string }>>(Prisma.sql`
        SELECT eligible.email FROM legiwatch_notification_event n
        CROSS JOIN LATERAL (${lifecycleRecipient}) eligible
        WHERE n.id=${row.id}::uuid AND n.tenant_id=${row.tenantId}::uuid AND n.user_id=${row.userId}
        LIMIT 1`),
      );
      const email = rows[0]?.email;
      return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
    }
    const rows = await this.prisma.withTenant(row.tenantId, (tx) =>
      tx.$queryRaw<Array<{ email: string }>>(Prisma.sql`
      SELECT account.email FROM users account
      JOIN tenant_memberships m ON m.user_id=account.id AND m.tenant_id=${row.tenantId}::uuid AND m.status='active'
      JOIN legiwatch_committee_email_preference p ON p.user_id=account.id::text AND p.tenant_id=m.tenant_id
        AND p.committee_email_enabled=true
      JOIN legiwatch_committee_follow f ON f.user_id=account.id::text AND f.tenant_id=m.tenant_id
      LEFT JOIN congress_committee c ON lower(c.system_code)=lower(f.committee_system_code)
      JOIN committee_site_update u ON 'committee_update:'||u.content_hash=${row.dedupKey}
        AND (lower(u.committee_system_code)=lower(f.committee_system_code)
          OR lower(u.committee_system_code)=lower(c.parent_system_code))
      WHERE account.id::text=${row.userId} AND (${categoryEnabled})
        AND u.first_seen_at>p.updated_at AND u.first_seen_at>f.updated_at
      LIMIT 1`),
    );
    const email = rows[0]?.email;
    return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  }

  private renew(row: Claim): Promise<number> {
    return this.prisma.withSystem(
      (tx) => tx.$executeRaw`
      UPDATE legiwatch_notification_event SET email_delivery_lease_until=now()+interval '5 minutes'
      WHERE id=${row.id}::uuid AND tenant_id=${row.tenantId}::uuid
        AND email_delivery_status='sending' AND email_delivery_lease_id=${row.leaseId}`,
    );
  }

  private async failed(row: Claim, error: string, now: Date, result: DrainResult): Promise<void> {
    const terminal = row.attempts >= MAX_ATTEMPTS;
    await this.finish(row, terminal ? 'failed_final' : 'retry_wait', error, now);
    if (terminal) result.terminalFailures++;
    else result.retryScheduled++;
  }

  private finish(row: Claim, status: string, error: string | null, now: Date): Promise<number> {
    const nextAt =
      status === 'retry_wait' ? new Date(now.getTime() + 60_000 * 2 ** row.attempts) : null;
    return this.prisma.withSystem(
      (tx) => tx.$executeRaw`
      UPDATE legiwatch_notification_event SET email_delivery_status=${status},
        email_delivery_last_error=${error?.slice(0, 2000) ?? null},
        email_delivery_next_attempt_at=${nextAt},email_delivery_lease_until=NULL,email_delivery_lease_id=NULL,
        email_delivery_sent_at=${status === 'sent' ? now : null}
      WHERE id=${row.id}::uuid AND tenant_id=${row.tenantId}::uuid
        AND email_delivery_status='sending' AND email_delivery_lease_id=${row.leaseId}`,
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
