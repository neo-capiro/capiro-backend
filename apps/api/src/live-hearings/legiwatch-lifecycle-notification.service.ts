/**
 * LegiWatch V2 Wave 1 (W1-5) — lifecycle notifications.
 *
 * ── Why this is not a parallel notification system ──
 *
 * Capiro already has notification delivery: `NotificationLog`, unique on
 * (alertId, userId, channel), is the idempotency claim that tracker alerts use
 * — insert wins the right to send, P2002 means somebody already did. Digest
 * batching lives in `AlertDigestQueue`. Wave 1 reuses BOTH: `claimDelivery()`
 * below is the same claim-then-send pattern, so a LegiWatch notification can
 * never be delivered twice through a channel.
 *
 * What it adds is the in-app inbox row, because `NotificationLog` structurally
 * cannot carry one:
 *
 *   - its `clientId` is NOT NULL, so it cannot represent a hearing-level event
 *     ("this hearing is starting") that belongs to no single client;
 *   - it has no deep-link target and no read state, so it cannot back an inbox.
 *
 * `legiwatch_notification_event` is that row, and it is FORCE-RLS isolated.
 *
 * ── Idempotency ──
 *
 * `dedupKey` encodes the STATE TRANSITION, not the observation. A schedule
 * change keys on the new value, so re-observing the same schedule an unlimited
 * number of times produces one notification, while a genuine second change
 * produces a second one. This is the specific requirement that "no duplicate
 * schedule-change notifications from repeated observations".
 *
 * ── Preference gating ──
 *
 * Every emit filters recipients by the notification flag for its own category
 * on their follow row. A user who turned a category off is not a recipient, so
 * no row is written and no delivery is claimed for them at all.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

/** The lifecycle transitions Wave 1 emits. */
export type LegiWatchLifecycleEvent =
  | 'schedule_changed'
  | 'location_changed'
  | 'witnesses_changed'
  | 'hearing_starting'
  | 'capture_started'
  | 'capture_failed'
  | 'transcript_ready'
  | 'intelligence_ready'
  | 'high_priority_match';

/**
 * Which follow flag gates each event.
 *
 * `hearing_starting` maps to notifyOnHearingStarting; the capture and
 * intelligence events ride the transcript-ready preference because they are
 * the same "the recording pipeline did something" interest, and Wave 1 does
 * not offer separate switches for them.
 */
const HEARING_FOLLOW_FLAG: Record<LegiWatchLifecycleEvent, string> = {
  schedule_changed: 'notify_on_schedule_change',
  location_changed: 'notify_on_schedule_change',
  witnesses_changed: 'notify_on_schedule_change',
  hearing_starting: 'notify_on_hearing_starting',
  capture_started: 'notify_on_transcript_ready',
  capture_failed: 'notify_on_transcript_ready',
  transcript_ready: 'notify_on_transcript_ready',
  intelligence_ready: 'notify_on_transcript_ready',
  high_priority_match: 'notify_on_high_priority_match',
};

/** The committee-follow flag for each event, where the category exists. */
const COMMITTEE_FOLLOW_FLAG: Partial<Record<LegiWatchLifecycleEvent, string>> = {
  schedule_changed: 'notify_on_schedule_change',
  location_changed: 'notify_on_schedule_change',
  witnesses_changed: 'notify_on_schedule_change',
  transcript_ready: 'notify_on_transcript_ready',
  intelligence_ready: 'notify_on_transcript_ready',
  high_priority_match: 'notify_on_high_priority_match',
};

export interface EmitLifecycleInput {
  tenantId: string;
  eventType: LegiWatchLifecycleEvent;
  hearingId: string;
  /** Set for events that reach committee followers too. */
  committeeSystemCode?: string | null;
  /**
   * Restrict the fan-out to followers who named this client. Required for
   * `high_priority_match`, which is client-specific by definition.
   */
  clientId?: string | null;
  title: string;
  body?: string | null;
  /**
   * The transition identity. Must be derived from the NEW STATE, never from
   * the observation time — a timestamp here would defeat deduplication and
   * every poll would notify again.
   */
  dedupKey: string;
}

export interface EmitLifecycleResult {
  /** Inbox rows actually created (duplicates are silently dropped). */
  created: number;
  /** Recipients considered after preference filtering. */
  recipients: number;
  /** Recipients skipped because they had the category switched off. */
  suppressedByPreference: number;
  /** Rows dropped because the same transition had already been emitted. */
  duplicates: number;
}

interface Recipient {
  userId: string;
  clientId: string | null;
}

@Injectable()
export class LegiWatchLifecycleNotificationService {
  private readonly logger = new Logger(LegiWatchLifecycleNotificationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Emit one lifecycle event to every eligible follower.
   *
   * Called AFTER the underlying state transition has actually been persisted —
   * never speculatively. Emitting on intent would notify users about a change
   * that then failed to apply.
   */
  async emit(input: EmitLifecycleInput): Promise<EmitLifecycleResult> {
    const flag = HEARING_FOLLOW_FLAG[input.eventType];
    const committeeFlag = COMMITTEE_FOLLOW_FLAG[input.eventType];

    return this.prisma.withTenant(input.tenantId, async (tx) => {
      // ── recipients from hearing follows ──
      //
      // The flag column is interpolated from the closed HEARING_FOLLOW_FLAG
      // map above, never from caller input, so this is not an injection point.
      const hearingFollows = await tx.$queryRawUnsafe<
        Array<{ userId: string; clientIds: string[]; enabled: boolean }>
      >(
        `SELECT user_id AS "userId", client_ids AS "clientIds", ${flag} AS enabled
         FROM hearing_follow
         WHERE hearing_id = $1`,
        input.hearingId,
      );

      // ── recipients from committee follows ──
      const committeeFollows =
        input.committeeSystemCode && committeeFlag
          ? await tx.$queryRawUnsafe<
              Array<{ userId: string; clientIds: string[]; enabled: boolean }>
            >(
              `SELECT user_id AS "userId", client_ids AS "clientIds", ${committeeFlag} AS enabled
               FROM legiwatch_committee_follow
               WHERE committee_system_code = $1`,
              input.committeeSystemCode,
            )
          : [];

      let suppressedByPreference = 0;
      // One entry per (user, client) so a follow naming three clients produces
      // three client-scoped notifications, not one ambiguous row.
      const recipients = new Map<string, Recipient>();

      for (const row of [...hearingFollows, ...committeeFollows]) {
        if (!row.enabled) {
          suppressedByPreference++;
          continue;
        }

        // A client-specific event only reaches followers who named that client.
        if (input.clientId) {
          if (!row.clientIds.includes(input.clientId)) {
            continue;
          }
          recipients.set(`${row.userId}:${input.clientId}`, {
            userId: row.userId,
            clientId: input.clientId,
          });
          continue;
        }

        // A hearing-level event reaches the follower once per named client, or
        // once with no client when they follow without naming any.
        if (!row.clientIds.length) {
          recipients.set(`${row.userId}:`, { userId: row.userId, clientId: null });
          continue;
        }
        for (const clientId of row.clientIds) {
          recipients.set(`${row.userId}:${clientId}`, { userId: row.userId, clientId });
        }
      }

      const deepLink = `/legiwatch/hearings/${encodeURIComponent(input.hearingId)}`;
      let created = 0;

      for (const recipient of recipients.values()) {
        // The dedup key is per-recipient-client so two clients on one follow
        // each get their own notification, while the same client re-observed
        // collides.
        const dedupKey = recipient.clientId
          ? `${input.dedupKey}:${recipient.clientId}`
          : input.dedupKey;

        const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO legiwatch_notification_event
             (tenant_id, user_id, event_type, hearing_id, committee_system_code,
              client_id, title, body, deep_link, dedup_key, created_at)
           VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8, $9, $10, now())
           ON CONFLICT (tenant_id, user_id, dedup_key) DO NOTHING
           RETURNING id`,
          input.tenantId,
          recipient.userId,
          input.eventType,
          input.hearingId,
          input.committeeSystemCode ?? null,
          recipient.clientId,
          input.title,
          input.body ?? null,
          deepLink,
          dedupKey,
        );
        if (rows.length) created++;
      }

      return {
        created,
        recipients: recipients.size,
        suppressedByPreference,
        duplicates: recipients.size - created,
      };
    });
  }

  /**
   * Claim the right to deliver one notification through one channel.
   *
   * This is the SHIPPED tracker-alert pattern, unchanged: inserting the
   * NotificationLog row is the claim, and a P2002 means another worker already
   * claimed it. Returns the log row id on success, or null when it was already
   * claimed.
   *
   * `NotificationLog.clientId` is NOT NULL, so a hearing-level event with no
   * client cannot be logged there and this returns null for it. That is not a
   * silent drop: the inbox row is already written, and channel delivery for
   * client-less events is out of Wave 1's scope.
   */
  async claimDelivery(input: {
    tenantId: string;
    clientId: string | null;
    userId: string;
    dedupKey: string;
    channel: 'email' | 'sms' | 'in_app';
  }): Promise<string | null> {
    if (!input.clientId) return null;
    try {
      const row = await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.notificationLog.create({
          data: {
            tenantId: input.tenantId,
            clientId: input.clientId!,
            userId: input.userId,
            // The alert id namespace keeps LegiWatch keys from ever colliding
            // with a tracker alert id in the shared unique index.
            alertId: `legiwatch:${input.dedupKey}`,
            channel: input.channel,
            status: 'queued',
          },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // already claimed
      throw e;
    }
  }

  /** The in-app inbox for the calling user. */
  async inbox(
    ctx: TenantContext,
    input: { unreadOnly?: boolean; page?: number; pageSize?: number },
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 25), 1), 100);
    const where = {
      userId: ctx.userId,
      ...(input.unreadOnly ? { readAt: null } : {}),
    };

    const [rows, total, unread] = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      Promise.all([
        tx.legiWatchNotificationEvent.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        tx.legiWatchNotificationEvent.count({ where }),
        tx.legiWatchNotificationEvent.count({ where: { userId: ctx.userId, readAt: null } }),
      ]),
    );

    return {
      rows: rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        hearingId: r.hearingId,
        committeeSystemCode: r.committeeSystemCode,
        clientId: r.clientId,
        title: r.title,
        body: r.body,
        deepLink: r.deepLink,
        read: r.readAt !== null,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      unread,
      page,
      pageSize,
      hasMore: (page - 1) * pageSize + rows.length < total,
    };
  }

  async markRead(ctx: TenantContext, id: string): Promise<{ read: boolean }> {
    const result = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchNotificationEvent.updateMany({
        where: { id, userId: ctx.userId, readAt: null },
        data: { readAt: new Date() },
      }),
    );
    return { read: result.count > 0 };
  }

  // ── transition-keyed emit helpers ────────────────────────────────────────
  //
  // Each helper below builds the dedup key from the NEW STATE so the same
  // transition observed repeatedly collides. Callers should prefer these over
  // hand-building a key.

  /** Schedule moved. Keyed on the new instant, so re-observing it is a no-op. */
  async emitScheduleChanged(input: {
    tenantId: string;
    hearingId: string;
    committeeSystemCode?: string | null;
    hearingTitle: string;
    newStartsAt: Date | null;
    newCalendarDate: string;
  }): Promise<EmitLifecycleResult> {
    // The key is the new schedule value itself.
    const stateToken = input.newStartsAt
      ? input.newStartsAt.toISOString()
      : `date-only:${input.newCalendarDate}`;
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'schedule_changed',
      hearingId: input.hearingId,
      committeeSystemCode: input.committeeSystemCode ?? null,
      title: `Schedule changed: ${input.hearingTitle}`,
      body: input.newStartsAt
        ? `Now scheduled for ${input.newStartsAt.toISOString()}.`
        : // Honest about the unknown time rather than inventing one.
          `Now scheduled for ${input.newCalendarDate}; no time has been announced.`,
      dedupKey: `schedule_changed:${input.hearingId}:${stateToken}`,
    });
  }

  /** Location moved. Keyed on the new location string. */
  async emitLocationChanged(input: {
    tenantId: string;
    hearingId: string;
    committeeSystemCode?: string | null;
    hearingTitle: string;
    newLocation: string;
  }): Promise<EmitLifecycleResult> {
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'location_changed',
      hearingId: input.hearingId,
      committeeSystemCode: input.committeeSystemCode ?? null,
      title: `Location changed: ${input.hearingTitle}`,
      body: `Now at ${input.newLocation}.`,
      dedupKey: `location_changed:${input.hearingId}:${input.newLocation}`,
    });
  }

  /**
   * Witness list changed. Keyed on the new roster, order-insensitive, so a
   * source reordering the same names is not a change.
   */
  async emitWitnessesChanged(input: {
    tenantId: string;
    hearingId: string;
    committeeSystemCode?: string | null;
    hearingTitle: string;
    witnesses: string[];
  }): Promise<EmitLifecycleResult> {
    const roster = [...input.witnesses].map((w) => w.trim()).sort().join('|');
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'witnesses_changed',
      hearingId: input.hearingId,
      committeeSystemCode: input.committeeSystemCode ?? null,
      title: `Witnesses updated: ${input.hearingTitle}`,
      body: input.witnesses.length
        ? `${input.witnesses.length} witness${input.witnesses.length === 1 ? '' : 'es'} listed.`
        : 'The witness list is now empty.',
      dedupKey: `witnesses_changed:${input.hearingId}:${roster}`,
    });
  }

  /**
   * The hearing is starting. Keyed on the hearing and its scheduled instant,
   * so the "starting soon" sweep can run every minute and notify once.
   */
  async emitHearingStarting(input: {
    tenantId: string;
    hearingId: string;
    hearingTitle: string;
    startsAt: Date;
  }): Promise<EmitLifecycleResult> {
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'hearing_starting',
      hearingId: input.hearingId,
      title: `Starting now: ${input.hearingTitle}`,
      body: 'This proceeding is beginning.',
      dedupKey: `hearing_starting:${input.hearingId}:${input.startsAt.toISOString()}`,
    });
  }

  /** Transcript is available. Keyed on the capture, which is one per hearing. */
  async emitTranscriptReady(input: {
    tenantId: string;
    hearingId: string;
    committeeSystemCode?: string | null;
    hearingTitle: string;
    captureId: string;
  }): Promise<EmitLifecycleResult> {
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'transcript_ready',
      hearingId: input.hearingId,
      committeeSystemCode: input.committeeSystemCode ?? null,
      title: `Transcript ready: ${input.hearingTitle}`,
      body: 'The canonical transcript for this proceeding is available.',
      dedupKey: `transcript_ready:${input.hearingId}:${input.captureId}`,
    });
  }

  /** Capture failed. Keyed on the capture and its failure code. */
  async emitCaptureFailed(input: {
    tenantId: string;
    hearingId: string;
    hearingTitle: string;
    captureId: string;
    failureCode: string;
  }): Promise<EmitLifecycleResult> {
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'capture_failed',
      hearingId: input.hearingId,
      title: `Capture failed: ${input.hearingTitle}`,
      body: `Capture ended with ${input.failureCode}. Any partial transcript is shown with its gaps.`,
      dedupKey: `capture_failed:${input.hearingId}:${input.captureId}:${input.failureCode}`,
    });
  }

  /**
   * A HIGH-relevance match was detected for one client.
   *
   * Keyed on the specific insight, so re-running relevance over the same
   * finding does not re-notify, while a genuinely new HIGH finding does.
   */
  async emitHighPriorityMatch(input: {
    tenantId: string;
    hearingId: string;
    committeeSystemCode?: string | null;
    hearingTitle: string;
    clientId: string;
    clientName: string | null;
    insightId: string;
  }): Promise<EmitLifecycleResult> {
    return this.emit({
      tenantId: input.tenantId,
      eventType: 'high_priority_match',
      hearingId: input.hearingId,
      committeeSystemCode: input.committeeSystemCode ?? null,
      clientId: input.clientId,
      title: `High-priority match: ${input.hearingTitle}`,
      body: `A high-relevance finding was detected for ${input.clientName ?? 'this client'}.`,
      dedupKey: `high_priority_match:${input.hearingId}:${input.insightId}`,
    });
  }
}
