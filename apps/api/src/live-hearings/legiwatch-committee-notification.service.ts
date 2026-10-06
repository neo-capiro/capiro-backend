import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/config.schema.js';
import {
  committeeUpdatesDeepLink,
  parseStateCommitteeFollowKey,
  stateCommitteeFollowKey,
  verifiedStateCommitteeAliasIds,
} from '../hearing-discovery/florida-committee-alerts.js';
import { lockCommitteeUpdateStreams } from '../hearing-discovery/committee-update-serialization.js';
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
  committeeSystemCode: string;
}
interface IntakeObservation {
  id: string;
  updateType: string;
  hearingId: string | null;
  committeeSystemCode: string;
  normalizedTitle: string;
  normalizedSummary: string | null;
  contentHash: string;
  queueEmail: boolean | null;
}
interface Claim {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  body: string | null;
  deepLink: string;
  dedupKey: string;
  committeeSystemCode: string | null;
  attempts: number;
  leaseId: string;
  claimedAt: Date;
}

// These are the same observations shown in a committee's publications feed.
// Flags apply to their source category even when no canonical hearing exists yet.
const categoryEnabled = Prisma.sql`CASE
  WHEN u.update_type='committee_news_published'
    THEN (f.notify_on_publication AND u.official_published_at IS NOT NULL
      AND u.official_published_at>=f.alert_started_at)
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
      SELECT id::text, tenant_id::text AS "tenantId", user_id AS "userId",
        alert_started_at AS "startedAt", committee_system_code AS "committeeSystemCode"
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
    return this.prisma.withTenant(input.tenantId, async (tx) => ({
      inserted: await this.initializeFollow(tx, input),
    }));
  }

  /**
   * Expand one canonical follow into the update streams it is allowed to
   * consume. State aliases come only from the official directory evidence and
   * must resolve to rows in the same jurisdiction. This keeps provider aliases
   * useful without turning arbitrary JSON into an alert authorization.
   */
  private async committeeUpdateStreamCodes(
    tx: Prisma.TransactionClient,
    committeeSystemCode: string,
  ): Promise<string[]> {
    const state = parseStateCommitteeFollowKey(committeeSystemCode);
    if (state) {
      const committee = await tx.stateCommittee.findUnique({
        where: { id: state.stateCommitteeId },
        select: {
          id: true,
          state: true,
          officialSourceKey: true,
          sourceEvidence: true,
        },
      });
      if (!committee || committee.state.toUpperCase() !== state.jurisdiction)
        return [committeeSystemCode];
      const aliases = committee.officialSourceKey
        ? verifiedStateCommitteeAliasIds(committee.sourceEvidence)
        : [];
      const verifiedAliases = aliases.length
        ? await tx.stateCommittee.findMany({
            where: {
              id: { in: aliases },
              state: state.jurisdiction,
            },
            select: { id: true, state: true },
          })
        : [];
      return [
        ...new Set([
          stateCommitteeFollowKey(committee.state, committee.id),
          ...verifiedAliases.map((alias) => stateCommitteeFollowKey(alias.state, alias.id)),
        ]),
      ];
    }

    const parent = await tx.$queryRaw<Array<{ parentCode: string | null }>>`
      SELECT parent_system_code AS "parentCode"
      FROM congress_committee
      WHERE lower(system_code)=lower(${committeeSystemCode})
      LIMIT 1`;
    return [
      ...new Set(
        [committeeSystemCode, parent[0]?.parentCode].filter((code): code is string =>
          Boolean(code),
        ),
      ),
    ];
  }

  /**
   * Establish the follow boundary and bounded catch-up inside the caller's
   * follow-create transaction. A publication committed on either side of this
   * boundary is classified by its own database timestamp, so it can never be
   * silently converted from a new/email-eligible update into catch-up history.
   */
  async initializeFollow(
    tx: Prisma.TransactionClient,
    input: { tenantId: string; userId: string; committeeSystemCode: string },
  ): Promise<number> {
    // A subcommittee follow receives its parent committee's publications too,
    // so both update streams participate in the same boundary. State keys have
    // no congress row and lock only their own namespaced stream.
    const streamCodes = await this.committeeUpdateStreamCodes(tx, input.committeeSystemCode);
    await lockCommitteeUpdateStreams(tx, streamCodes);

    const locked = await tx.$queryRaw<Follow[]>`
      SELECT id::text,tenant_id::text AS "tenantId",user_id AS "userId",
        alert_started_at AS "startedAt",committee_system_code AS "committeeSystemCode"
      FROM legiwatch_committee_follow
      WHERE tenant_id=${input.tenantId}::uuid AND user_id=${input.userId}
        AND lower(committee_system_code)=lower(${input.committeeSystemCode})
      FOR UPDATE`;
    if (!locked[0] || locked[0].startedAt) return 0;
    return this.initializeLocked(tx, locked[0], streamCodes);
  }

  private async intake(follow: Follow, catchupOnly: boolean): Promise<number> {
    return this.prisma.withTenant(follow.tenantId, async (tx) => {
      const locked = await tx.$queryRaw<Follow[]>`
        SELECT id::text,tenant_id::text AS "tenantId",user_id AS "userId",
          alert_started_at AS "startedAt",committee_system_code AS "committeeSystemCode"
        FROM legiwatch_committee_follow
        WHERE id=${follow.id}::uuid AND tenant_id=${follow.tenantId}::uuid
          AND user_id=${follow.userId} FOR UPDATE`;
      if (!locked[0]) return 0;
      const streamCodes = await this.committeeUpdateStreamCodes(tx, locked[0].committeeSystemCode);
      if (!locked[0].startedAt) {
        await lockCommitteeUpdateStreams(tx, streamCodes);
        return this.initializeLocked(tx, locked[0], streamCodes);
      }
      if (catchupOnly) return 0;
      return this.insertBatch(tx, locked[0], false, streamCodes);
    });
  }

  private async initializeLocked(
    tx: Prisma.TransactionClient,
    follow: Follow,
    streamCodes: readonly string[],
  ): Promise<number> {
    const initialized = await tx.$queryRaw<Array<{ startedAt: Date }>>`
      UPDATE legiwatch_committee_follow
      SET alert_started_at=clock_timestamp()
      WHERE id=${follow.id}::uuid AND tenant_id=${follow.tenantId}::uuid
        AND user_id=${follow.userId} AND alert_started_at IS NULL
      RETURNING alert_started_at AS "startedAt"`;
    if (!initialized[0]) return 0;
    const bounded = { ...follow, startedAt: initialized[0].startedAt };
    const historical = await this.insertBatch(tx, bounded, true, streamCodes);
    const current = await this.insertBatch(tx, bounded, false, streamCodes);
    return historical + current;
  }

  private async insertBatch(
    tx: Prisma.TransactionClient,
    follow: Follow,
    catchup: boolean,
    streamCodes: readonly string[],
  ): Promise<number> {
    const rows = await tx.$queryRaw<IntakeObservation[]>(Prisma.sql`
        WITH observations AS (
          SELECT DISTINCT ON (u.content_hash) u.id,u.update_type AS "updateType",
            u.hearing_id AS "hearingId",u.committee_system_code AS "committeeSystemCode",
            u.normalized_title AS "normalizedTitle",u.normalized_summary AS "normalizedSummary",
            u.content_hash AS "contentHash",u.first_seen_at,u.created_at,
            (${!catchup} AND p.committee_email_enabled=true
              AND u.created_at>=f.alert_started_at
              AND u.created_at>p.updated_at AND u.created_at>f.updated_at
              AND p.email_address IS NOT NULL) AS queue_email
          FROM legiwatch_committee_follow f
          JOIN committee_site_update u
            ON lower(u.committee_system_code) IN (
              ${Prisma.join(streamCodes.map((code) => Prisma.sql`lower(${code})`))}
            )
          LEFT JOIN legiwatch_committee_email_preference p
            ON p.tenant_id=f.tenant_id AND p.user_id=f.user_id
          WHERE f.id=${follow.id}::uuid AND f.tenant_id=${follow.tenantId}::uuid
            AND f.user_id=${follow.userId}
            AND EXISTS (SELECT 1 FROM tenant_memberships m
              WHERE m.tenant_id=f.tenant_id AND m.user_id::text=f.user_id AND m.status='active')
            AND (${categoryEnabled})
            AND ${
              catchup
                ? Prisma.sql`u.created_at<f.alert_started_at
                  AND u.first_seen_at>=f.alert_started_at-interval '30 days'`
                : Prisma.sql`u.created_at>=f.alert_started_at`
            }
            AND NOT EXISTS (SELECT 1 FROM legiwatch_notification_event n
              WHERE n.tenant_id=f.tenant_id AND n.user_id=f.user_id
                AND n.dedup_key='committee_update:'||u.content_hash)
          ORDER BY u.content_hash,u.first_seen_at DESC,u.id DESC
        ), batch AS (
          SELECT * FROM observations
          ORDER BY ${catchup ? Prisma.sql`first_seen_at DESC,id DESC` : Prisma.sql`created_at ASC,id ASC`}
          LIMIT ${catchup ? CATCHUP_SIZE : PAGE_SIZE}
        )
        SELECT id,"updateType","hearingId","committeeSystemCode","normalizedTitle",
          "normalizedSummary","contentHash",queue_email AS "queueEmail" FROM batch`);
    if (!rows.length) return 0;
    const values = rows.map(
      (row) => Prisma.sql`(
      ${follow.tenantId}::uuid,${follow.userId},
      ${row.updateType === 'hearing_announced' ? 'new_hearing' : 'committee_publication'},
      ${row.hearingId},${follow.committeeSystemCode},${row.normalizedTitle.slice(0, 500)},
      ${row.normalizedSummary},${committeeUpdatesDeepLink(follow.committeeSystemCode)},
      ${`committee_update:${row.contentHash}`},${row.queueEmail ? 'queued' : null},
      ${row.queueEmail ? new Date() : null})`,
    );
    const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      INSERT INTO legiwatch_notification_event
        (tenant_id,user_id,event_type,hearing_id,committee_system_code,title,body,deep_link,dedup_key,
         email_delivery_status,email_delivery_next_attempt_at)
      VALUES ${Prisma.join(values)}
      ON CONFLICT (tenant_id,user_id,dedup_key) DO NOTHING RETURNING id::text`);
    return inserted.length;
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
        n.committee_system_code AS "committeeSystemCode",
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
    if (!row.committeeSystemCode) return null;
    const followRows = await this.prisma.withTenant(
      row.tenantId,
      (tx) =>
        tx.$queryRaw<Follow[]>`
      SELECT id::text,tenant_id::text AS "tenantId",user_id AS "userId",
        alert_started_at AS "startedAt",committee_system_code AS "committeeSystemCode"
      FROM legiwatch_committee_follow
      WHERE tenant_id=${row.tenantId}::uuid AND user_id=${row.userId}
        AND lower(committee_system_code)=lower(${row.committeeSystemCode})
      LIMIT 1`,
    );
    const follow = followRows[0];
    if (!follow) return null;
    const rows = await this.prisma.withTenant(row.tenantId, async (tx) => {
      const streamCodes = await this.committeeUpdateStreamCodes(tx, follow.committeeSystemCode);
      return tx.$queryRaw<Array<{ email: string }>>(Prisma.sql`
      SELECT account.email FROM users account
      JOIN tenant_memberships m ON m.user_id=account.id AND m.tenant_id=${row.tenantId}::uuid AND m.status='active'
      JOIN legiwatch_committee_email_preference p ON p.user_id=account.id::text AND p.tenant_id=m.tenant_id
        AND p.committee_email_enabled=true
      JOIN legiwatch_committee_follow f ON f.user_id=account.id::text AND f.tenant_id=m.tenant_id
        AND lower(f.committee_system_code)=lower(${follow.committeeSystemCode})
      JOIN committee_site_update u ON 'committee_update:'||u.content_hash=${row.dedupKey}
        AND lower(u.committee_system_code) IN (
          ${Prisma.join(streamCodes.map((code) => Prisma.sql`lower(${code})`))}
        )
      WHERE account.id::text=${row.userId} AND (${categoryEnabled})
        AND u.created_at>p.updated_at AND u.created_at>f.updated_at
      LIMIT 1`);
    });
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
