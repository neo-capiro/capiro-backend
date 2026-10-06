import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { CommitteeDirectoryService } from './committee-directory.service.js';
import { LiveHearingsService } from './live-hearings.service.js';
import { assessStrictSchedulePolicy } from './live-hearings-phase7-schedule.guard.js';
import { stateCapturePolicy } from './legiwatch-state-capture-policy.js';

import {
  selectBrowserSource,
  strictOfficialSourceUrl,
  type BrowserSourceCandidate,
} from './live-hearings-browser-source.js';

const TRANSCRIPT_MAX_PAGE_SIZE = 500;
const LIST_MAX_PAGE_SIZE = 100;
const ACTIVE_CAPTURE_STATES = new Set([
  'SCHEDULED',
  'PREPARING',
  'WAITING_FOR_STREAM',
  'READY',
  'CAPTURING',
  'RECOVERING',
  'FINALIZING',
]);
const ATTACHABLE_CAPTURE_STATES = new Set([
  ...ACTIVE_CAPTURE_STATES,
  'COMPLETE',
  'COMPLETE_WITH_GAPS',
]);

interface CanonicalHearingRow {
  id: string;
  geographicJurisdiction?: string | null;
  title: string;
  type: string | null;
  eventStatus: string;
  visibility: string;
  startsAt: Date | null;
  date: Date;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  committeeName: string;
  url: string | null;
}

interface CaptureDetailRow {
  captureId: string;
  hearingId: string;
  storageStatus: string;
  domainStatus: string | null;
  scheduledStart: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  capturedSeconds: number;
  transcriptGapSeconds: number;
  reconnectCount: number;
  failureCode: string | null;
  failureDetail: string | null;
  resolutionState: string | null;
  resolutionReasonCode: string | null;
  resolutionCapturePolicy: string | null;
  resolutionProvider: string | null;
  resolutionReference: string | null;
  terminalReasonCode: string | null;
  lastOutcomeAt: Date | null;
}

interface ParticipationScheduleRow {
  scheduledByUser: boolean;
  scheduledByRuleId: string | null;
  notifyOnStart: boolean;
  notifyOnMention: boolean;
  clientIds: string[] | null;
  watchlistId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ParticipationFollowRow {
  notifyOnStart: boolean;
  notifyOnUpdates: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface TranscriptSegmentRow {
  id: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
  speakerLabel: string | null;
  resolvedSpeakerName: string | null;
  speakerConfidence: number | null;
  transcriptionConfidence: number | null;
  isFinal: boolean;
  hasGapBefore: boolean;
  revision: number;
}

interface ListRow {
  id: string;
  congress: number | null;
  chamber: string;
  committeeName: string;
  committeeSystemCode: string | null;
  subcommitteeSystemCode: string | null;
  title: string;
  eventType: string | null;
  eventStatus: string;
  visibility: string;
  date: Date;
  startsAt: Date | null;
  time: string | null;
  timezone: string;
  location: string | null;
  officialPageUrl: string | null;
  streamAvailability: string;
  coverageStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  captureScheduledStart: Date | null;
  captureActualStart: Date | null;
  captureActualEnd: Date | null;
  capturedSeconds: number | null;
  transcriptGapSeconds: number | null;
  reconnectCount: number | null;
  failureCode: string | null;
  terminalReasonCode: string | null;
  resolutionReasonCode: string | null;
  scheduledByUser?: boolean | null;
  scheduledByRuleId?: string | null;
}

export interface Phase7Participation {
  scheduled: boolean;
  scheduledByUser: boolean;
  scheduledByRule: boolean;
  scheduledByRuleId: string | null;
  followed: boolean;
  notifyOnStart: boolean;
  notifyOnMention: boolean;
  notifyOnUpdates: boolean;
  clientIds: string[];
  watchlistId: string | null;
  updatedAt: string | null;
}

export interface Phase7CaptureDetail {
  id: string;
  status: string;
  storageStatus: string;
  scheduledStart: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  capturedSeconds: number;
  transcriptGapSeconds: number;
  reconnectCount: number;
  failureCode: string | null;
  failureDetail: string | null;
  resolutionState: string | null;
  resolutionReasonCode: string | null;
  resolutionCapturePolicy: string | null;
  resolutionProvider: string | null;
  resolutionReference: string | null;
  terminalReasonCode: string | null;
  lastOutcomeAt: string | null;
}

export type BrowserJoinPlan =
  | {
      mode: 'ATTACH_CANONICAL';
      hearingId: string;
      captureId: string;
      captureStatus: string;
      reasonCode: 'CANONICAL_CAPTURE_ACTIVE' | 'CANONICAL_TRANSCRIPT_AVAILABLE';
    }
  | {
      mode: 'BROWSER_CAPTURE';
      hearingId: string;
      title: string;
      sourceType: string;
      audioSource: 'browser_mic';
      recordingPolicy: 'transcript_only';
      sourceUrl: string;
      sourceKind: 'official_player_page' | 'official_listing_page';
      sourceProvider: string | null;
      /** True when the chosen source is a listing page and must be resolved to a playable stream at session creation/reopen. */
      requiresStreamResolution: boolean;
      committeeId: string | null;
      reasonCode: string;
      /** Present when a canonical server capture exists; browser entry stays independent of it. */
      canonicalCaptureId?: string;
      canonicalCaptureStatus?: string;
    }
  | {
      mode: 'BLOCKED';
      hearingId: string;
      reasonCode: string;
      message: string;
    };

@Injectable()
export class LiveHearingsPhase7Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hearings: LiveHearingsService,
    private readonly committees: CommitteeDirectoryService,
  ) {}

  async room(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    const event = await this.hearings.event(ctx, hearingId);
    if (!event) throw new NotFoundException(`hearing ${hearingId} not found`);

    const committeeCode = event.subcommitteeSystemCode ?? event.committeeSystemCode;
    const [participation, capture, updates, members, browser] = await Promise.all([
      this.participation(ctx, hearingId),
      this.captureDetail(hearingId),
      this.hearings.updates(ctx, hearingId, 150),
      committeeCode
        ? this.committees.members(committeeCode)
        : Promise.resolve({
            rows: [],
            total: 0,
            chair: null,
            rankingMember: null,
            asOf: new Date().toISOString(),
          }),
      this.browserJoin(ctx, hearingId),
    ]);

    return {
      event,
      participation,
      capture,
      browser,
      witnesses: event.witnesses,
      documents: event.documents ?? [],
      members: members.rows,
      chair: members.chair,
      rankingMember: members.rankingMember,
      updates,
      transcriptDisclaimer:
        'Machine-generated transcript. Verify consequential quotations against the official recording or transcript.',
      asOf: new Date().toISOString(),
    };
  }

  async transcript(
    hearingId: string,
    input: { cursor?: string; limit?: number },
  ): Promise<{
    hearingId: string;
    capture: Phase7CaptureDetail | null;
    items: Array<Record<string, unknown>>;
    total: number;
    nextCursor: string | null;
    /** Resume from the live tail even when no further page exists yet. */
    resumeCursor: string | null;
    hasMore: boolean;
  }> {
    const hearing = await this.requireHearing(hearingId);
    if (hearing.visibility !== 'public') {
      throw new ForbiddenException(
        'Canonical public transcript is unavailable for a non-public proceeding.',
      );
    }
    const capture = await this.captureDetail(hearingId);
    if (!capture) {
      return {
        hearingId,
        capture: null,
        items: [],
        total: 0,
        nextCursor: null,
        resumeCursor: null,
        hasMore: false,
      };
    }

    const decoded = decodeTranscriptCursor(input.cursor);
    const limit = clamp(input.limit ?? 250, 1, TRANSCRIPT_MAX_PAGE_SIZE);
    const rows = await this.prisma.$queryRawUnsafe<TranscriptSegmentRow[]>(
      `SELECT s.id,
              s.sequence,
              s.start_ms AS "startMs",
              s.end_ms AS "endMs",
              s.text,
              s.speaker_label AS "speakerLabel",
              sp.display_name AS "resolvedSpeakerName",
              s.speaker_confidence AS "speakerConfidence",
              s.transcription_confidence AS "transcriptionConfidence",
              s.is_final AS "isFinal",
              s.has_gap_before AS "hasGapBefore",
              s.revision
       FROM public_hearing_transcript_segment s
       LEFT JOIN public_hearing_speaker sp
         ON sp.capture_id = s.capture_id AND sp.speaker_label = s.speaker_label
       WHERE s.capture_id=$1
         AND (
           $2::int IS NULL OR
           s.sequence > $2 OR
           (s.sequence = $2 AND s.id > $3)
         )
       ORDER BY s.sequence ASC, s.id ASC
       LIMIT $4`,
      capture.id,
      decoded?.sequence ?? null,
      decoded?.id ?? '',
      limit + 1,
    );
    const countRows = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM public_hearing_transcript_segment
       WHERE capture_id=$1`,
      capture.id,
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);

    return {
      hearingId,
      capture,
      items: page.map((row) => ({
        id: row.id,
        sequence: row.sequence,
        startMs: row.startMs,
        endMs: row.endMs,
        text: row.text,
        speakerLabel: row.speakerLabel,
        // A bare diarization index is not a name; older rails stored real labels.
        speakerName:
          row.resolvedSpeakerName ??
          (row.speakerLabel && !/^\d+$/.test(row.speakerLabel.trim()) ? row.speakerLabel : null),
        confidence: row.transcriptionConfidence ?? row.speakerConfidence,
        transcriptionConfidence: row.transcriptionConfidence,
        speakerConfidence: row.speakerConfidence,
        isFinal: row.isFinal,
        hasGapBefore: row.hasGapBefore,
        gapBefore: row.hasGapBefore,
        revision: row.revision,
      })),
      total: countRows[0]?.count ?? 0,
      nextCursor: hasMore && last ? encodeTranscriptCursor(last.sequence, last.id) : null,
      resumeCursor: last
        ? encodeTranscriptCursor(last.sequence, last.id)
        : decoded
          ? encodeTranscriptCursor(decoded.sequence, decoded.id)
          : null,
      hasMore,
    };
  }

  async participation(ctx: TenantContext, hearingId: string): Promise<Phase7Participation> {
    const { schedule, follow } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [scheduleRows, followRows] = await Promise.all([
        tx.$queryRawUnsafe<ParticipationScheduleRow[]>(
          `SELECT scheduled_by_user AS "scheduledByUser",
                  scheduled_by_rule_id AS "scheduledByRuleId",
                  notify_on_start AS "notifyOnStart",
                  notify_on_mention AS "notifyOnMention",
                  client_ids AS "clientIds",
                  watchlist_id AS "watchlistId",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
           FROM hearing_subscription
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3
           LIMIT 1`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
        ),
        tx.$queryRawUnsafe<ParticipationFollowRow[]>(
          `SELECT notify_on_start AS "notifyOnStart",
                  notify_on_updates AS "notifyOnUpdates",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
           FROM hearing_follow
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3
           LIMIT 1`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
        ),
      ]);
      return { schedule: scheduleRows[0] ?? null, follow: followRows[0] ?? null };
    });

    const scheduledByRule = Boolean(schedule?.scheduledByRuleId);
    const updatedAt = [schedule?.updatedAt, follow?.updatedAt]
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => right.getTime() - left.getTime())[0];
    return {
      scheduled: Boolean(schedule?.scheduledByUser || scheduledByRule),
      scheduledByUser: Boolean(schedule?.scheduledByUser),
      scheduledByRule,
      scheduledByRuleId: schedule?.scheduledByRuleId ?? null,
      followed: Boolean(follow),
      notifyOnStart: Boolean(schedule?.notifyOnStart || follow?.notifyOnStart),
      notifyOnMention: Boolean(schedule?.notifyOnMention),
      notifyOnUpdates: Boolean(follow?.notifyOnUpdates),
      clientIds: schedule?.clientIds ?? [],
      watchlistId: schedule?.watchlistId ?? null,
      updatedAt: updatedAt?.toISOString() ?? null,
    };
  }

  async schedule(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    const hearing = await this.requireHearing(hearingId);
    const candidates = await this.prisma.hearingStreamCandidate.findMany({
      where: { hearingId },
      orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
      select: { capturePolicy: true, resolutionState: true },
    });
    const statePermission = await stateCapturePolicy(this.prisma, ctx, hearing);
    const assessment = statePermission?.policy ?? assessSchedulePolicy(hearing, candidates);
    if (!assessment.allowed) {
      throw new ConflictException({
        code: assessment.reasonCode,
        message: assessment.message,
        browserFallbackAvailable:
          statePermission?.browserAllowed ??
          Boolean(hearing.url && hearing.visibility === 'public'),
      });
    }

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO hearing_subscription
           (tenant_id, user_id, hearing_id, notify_on_start, notify_on_mention,
            scheduled_by_user, scheduled_by_rule_id, client_ids, watchlist_id,
            attendance_mode, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, true, false, true, NULL, ARRAY[]::text[], NULL, 'automatic', now(), now())
         ON CONFLICT (tenant_id, user_id, hearing_id)
         DO UPDATE SET scheduled_by_user=true,
                       attendance_mode='automatic',
                       notify_on_start=true,
                       updated_at=now()`,
        ctx.tenantId,
        ctx.userId,
        hearingId,
      ),
    );

    const captureId = await this.ensureCanonicalCapture(hearing);
    const preflight = await this.enqueuePreflight(hearingId);
    return {
      hearingId,
      captureId,
      participation: await this.participation(ctx, hearingId),
      assessment,
      preflight,
      oneCanonicalCapture: true,
    };
  }

  async cancelSchedule(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    await this.requireHearing(hearingId);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ scheduledByRuleId: string | null }>>(
        `SELECT scheduled_by_rule_id AS "scheduledByRuleId"
         FROM hearing_subscription
         WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3
         LIMIT 1`,
        ctx.tenantId,
        ctx.userId,
        hearingId,
      );
      if (!rows[0]) return;
      if (rows[0].scheduledByRuleId) {
        await tx.$executeRawUnsafe(
          `UPDATE hearing_subscription
           SET scheduled_by_user=false, updated_at=now()
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
        );
      } else {
        await tx.$executeRawUnsafe(
          `DELETE FROM hearing_subscription
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3`,
          ctx.tenantId,
          ctx.userId,
          hearingId,
        );
      }
    });

    return {
      hearingId,
      participation: await this.participation(ctx, hearingId),
      canonicalCapturePreserved: true,
      otherTenantDemandUntouched: true,
    };
  }

  async follow(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    await this.requireHearing(hearingId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO hearing_follow
           (tenant_id, user_id, hearing_id, notify_on_start, notify_on_updates, created_at, updated_at)
         VALUES ($1::uuid, $2, $3, true, true, now(), now())
         ON CONFLICT (tenant_id, user_id, hearing_id)
         DO UPDATE SET notify_on_start=true,
                       notify_on_updates=true,
                       updated_at=now()`,
        ctx.tenantId,
        ctx.userId,
        hearingId,
      ),
    );
    return { hearingId, participation: await this.participation(ctx, hearingId) };
  }

  async unfollow(ctx: TenantContext, hearingId: string): Promise<Record<string, unknown>> {
    await this.requireHearing(hearingId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `DELETE FROM hearing_follow
         WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id=$3`,
        ctx.tenantId,
        ctx.userId,
        hearingId,
      ),
    );
    return { hearingId, participation: await this.participation(ctx, hearingId) };
  }

  async browserJoin(ctx: TenantContext, hearingId: string): Promise<BrowserJoinPlan> {
    const hearing = await this.requireHearing(hearingId);
    const permission = await stateCapturePolicy(this.prisma, ctx, hearing);
    const [capture, candidates] = await Promise.all([
      this.captureDetail(hearingId),
      this.prisma.hearingStreamCandidate.findMany({
        where: { hearingId },
        orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }],
        select: {
          provider: true,
          officialPageUrl: true,
          mediaUrl: true,
          capturePolicy: true,
        },
      }),
    ]);
    const plan = browserJoinPlan(hearing, capture, candidates);
    if (plan.mode === 'BROWSER_CAPTURE' && permission && !permission.browserAllowed) {
      return {
        mode: 'BLOCKED',
        hearingId,
        reasonCode: permission.policy.reasonCode,
        message: permission.policy.message,
      };
    }
    return plan;
  }

  async recordings(
    ctx: TenantContext,
    input: { page?: number; pageSize?: number },
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = clamp(input.pageSize ?? 50, 1, LIST_MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<ListRow[]>(
        `SELECT h.id,
                h.congress,
                h.chamber,
                h.committee_name AS "committeeName",
                h.committee_system_code AS "committeeSystemCode",
                h.subcommittee_system_code AS "subcommitteeSystemCode",
                h.title,
                h.type AS "eventType",
                h.event_status AS "eventStatus",
                h.visibility,
                h.date,
                h.starts_at AS "startsAt",
                h.time,
                h.timezone,
                h.location,
                h.url AS "officialPageUrl",
                h.stream_availability AS "streamAvailability",
                h.coverage_status AS "coverageStatus",
                c.id AS "captureId",
                c.domain_status AS "captureStatus",
                c.scheduled_start AS "captureScheduledStart",
                c.actual_start AS "captureActualStart",
                c.actual_end AS "captureActualEnd",
                c.captured_seconds AS "capturedSeconds",
                c.transcript_gap_seconds AS "transcriptGapSeconds",
                c.reconnect_count AS "reconnectCount",
                c.failure_code AS "failureCode",
                c.terminal_reason_code AS "terminalReasonCode",
                c.resolution_reason_code AS "resolutionReasonCode",
                s.scheduled_by_user AS "scheduledByUser",
                s.scheduled_by_rule_id AS "scheduledByRuleId"
         FROM hearing_subscription s
         JOIN federal_committee_hearing h ON h.id=s.hearing_id
         LEFT JOIN public_hearing_capture c ON c.hearing_id=h.id
         WHERE s.tenant_id=$1::uuid
           AND s.user_id=$2
           AND h.event_status IN ('scheduled','postponed','in_progress')
         ORDER BY h.starts_at ASC NULLS LAST, h.date ASC, h.id ASC
         LIMIT $3 OFFSET $4`,
        ctx.tenantId,
        ctx.userId,
        pageSize,
        offset,
      );
      const counts = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM hearing_subscription s
         JOIN federal_committee_hearing h ON h.id=s.hearing_id
         WHERE s.tenant_id=$1::uuid
           AND s.user_id=$2
           AND h.event_status IN ('scheduled','postponed','in_progress')`,
        ctx.tenantId,
        ctx.userId,
      );
      return { rows, total: counts[0]?.count ?? 0 };
    });

    return {
      rows: result.rows.map(mapListRow),
      total: result.total,
      page,
      pageSize,
    };
  }

  /**
   * Durable all-lifecycle SERVER capture attendance for exactly this
   * tenant+user. Source of truth is the durable `hearing_subscription` demand
   * row using the SAME predicate the recorder worker uses
   * (`attendance_mode='automatic'` AND user-or-rule demand), so a scheduled
   * row appears immediately (capture may still be null) and stays visible
   * through started/processing/completed/failed. No event_status filter, no
   * synthetic rows, no browser-only/notify-only rows, no cross-tenant leakage.
   * Reads the canonical `committee_hearing` table (federal + state), not the
   * legacy federal-only view. Cancellation removes the demand row, so the
   * listing never resurrects canceled/no-demand entries.
   */
  async serverSessions(
    ctx: TenantContext,
    input: { page?: number; pageSize?: number },
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = clamp(input.pageSize ?? 50, 1, LIST_MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    const result = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.$queryRawUnsafe<ListRow[]>(
        `SELECT h.id,
                h.congress,
                h.chamber,
                h.committee_name AS "committeeName",
                h.committee_system_code AS "committeeSystemCode",
                h.subcommittee_system_code AS "subcommitteeSystemCode",
                h.title,
                h.type AS "eventType",
                h.event_status AS "eventStatus",
                h.visibility,
                h.date,
                h.starts_at AS "startsAt",
                h.time,
                h.timezone,
                h.location,
                h.url AS "officialPageUrl",
                h.stream_availability AS "streamAvailability",
                h.coverage_status AS "coverageStatus",
                c.id AS "captureId",
                c.domain_status AS "captureStatus",
                c.scheduled_start AS "captureScheduledStart",
                c.actual_start AS "captureActualStart",
                c.actual_end AS "captureActualEnd",
                c.captured_seconds AS "capturedSeconds",
                c.transcript_gap_seconds AS "transcriptGapSeconds",
                c.reconnect_count AS "reconnectCount",
                c.failure_code AS "failureCode",
                c.terminal_reason_code AS "terminalReasonCode",
                c.resolution_reason_code AS "resolutionReasonCode",
                s.scheduled_by_user AS "scheduledByUser",
                s.scheduled_by_rule_id AS "scheduledByRuleId"
         FROM hearing_subscription s
         JOIN committee_hearing h ON h.id=s.hearing_id
         LEFT JOIN public_hearing_capture c ON c.hearing_id=h.id
         WHERE s.tenant_id=$1::uuid
           AND s.user_id=$2
           AND s.attendance_mode='automatic'
           AND (s.scheduled_by_user=true OR s.scheduled_by_rule_id IS NOT NULL)
         ORDER BY COALESCE(h.starts_at, h.date::timestamp) DESC, h.id ASC
         LIMIT $3 OFFSET $4`,
        ctx.tenantId,
        ctx.userId,
        pageSize,
        offset,
      );
      const counts = await tx.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT COUNT(*)::int AS count
         FROM hearing_subscription s
         JOIN committee_hearing h ON h.id=s.hearing_id
         WHERE s.tenant_id=$1::uuid
           AND s.user_id=$2
           AND s.attendance_mode='automatic'
           AND (s.scheduled_by_user=true OR s.scheduled_by_rule_id IS NOT NULL)`,
        ctx.tenantId,
        ctx.userId,
      );
      return { rows, total: counts[0]?.count ?? 0 };
    });

    return {
      rows: result.rows.map(mapListRow),
      total: result.total,
      page,
      pageSize,
    };
  }

  async archive(
    ctx: TenantContext,
    input: { page?: number; pageSize?: number; q?: string },
  ): Promise<Record<string, unknown>> {
    const page = Math.max(1, input.page ?? 1);
    const pageSize = clamp(input.pageSize ?? 50, 1, LIST_MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;
    const q = input.q?.trim() || null;

    const rows = await this.prisma.$queryRawUnsafe<ListRow[]>(
      `SELECT h.id,
              h.congress,
              h.chamber,
              h.committee_name AS "committeeName",
              h.committee_system_code AS "committeeSystemCode",
              h.subcommittee_system_code AS "subcommitteeSystemCode",
              h.title,
              h.type AS "eventType",
              h.event_status AS "eventStatus",
              h.visibility,
              h.date,
              h.starts_at AS "startsAt",
              h.time,
              h.timezone,
              h.location,
              h.url AS "officialPageUrl",
              h.stream_availability AS "streamAvailability",
              h.coverage_status AS "coverageStatus",
              c.id AS "captureId",
              c.domain_status AS "captureStatus",
              c.scheduled_start AS "captureScheduledStart",
              c.actual_start AS "captureActualStart",
              c.actual_end AS "captureActualEnd",
              c.captured_seconds AS "capturedSeconds",
              c.transcript_gap_seconds AS "transcriptGapSeconds",
              c.reconnect_count AS "reconnectCount",
              c.failure_code AS "failureCode",
              c.terminal_reason_code AS "terminalReasonCode",
              c.resolution_reason_code AS "resolutionReasonCode"
       FROM federal_committee_hearing h
       LEFT JOIN public_hearing_capture c ON c.hearing_id=h.id
       WHERE h.visibility='public'
         AND (
           h.event_status='completed' OR
           c.domain_status IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED')
         )
         AND ($1::text IS NULL OR h.title ILIKE '%' || $1 || '%' OR h.committee_name ILIKE '%' || $1 || '%')
       ORDER BY COALESCE(c.actual_end, h.starts_at, h.date::timestamp) DESC, h.id DESC
       LIMIT $2 OFFSET $3`,
      q,
      pageSize,
      offset,
    );
    const counts = await this.prisma.$queryRawUnsafe<Array<{ count: number }>>(
      `SELECT COUNT(*)::int AS count
       FROM federal_committee_hearing h
       LEFT JOIN public_hearing_capture c ON c.hearing_id=h.id
       WHERE h.visibility='public'
         AND (
           h.event_status='completed' OR
           c.domain_status IN ('COMPLETE','COMPLETE_WITH_GAPS','FAILED','CANCELED','BLOCKED')
         )
         AND ($1::text IS NULL OR h.title ILIKE '%' || $1 || '%' OR h.committee_name ILIKE '%' || $1 || '%')`,
      q,
    );
    const participation = await this.participationByHearingIds(
      ctx,
      rows.map((row) => row.id),
    );

    return {
      rows: rows.map((row) => ({
        ...mapListRow(row),
        participation: participation.get(row.id) ?? null,
      })),
      total: counts[0]?.count ?? 0,
      page,
      pageSize,
    };
  }

  private async requireHearing(hearingId: string): Promise<CanonicalHearingRow> {
    const row = await this.prisma.committeeHearing.findUnique({
      where: { id: hearingId },
      select: {
        id: true,
        geographicJurisdiction: true,
        title: true,
        type: true,
        eventStatus: true,
        visibility: true,
        startsAt: true,
        date: true,
        committeeSystemCode: true,
        subcommitteeSystemCode: true,
        committeeName: true,
        url: true,
      },
    });
    if (!row) throw new NotFoundException(`hearing ${hearingId} not found`);
    return row;
  }

  private async captureDetail(hearingId: string): Promise<Phase7CaptureDetail | null> {
    const rows = await this.prisma.$queryRawUnsafe<CaptureDetailRow[]>(
      `SELECT id AS "captureId",
              hearing_id AS "hearingId",
              status AS "storageStatus",
              domain_status AS "domainStatus",
              scheduled_start AS "scheduledStart",
              actual_start AS "actualStart",
              actual_end AS "actualEnd",
              captured_seconds AS "capturedSeconds",
              transcript_gap_seconds AS "transcriptGapSeconds",
              reconnect_count AS "reconnectCount",
              failure_code AS "failureCode",
              failure_detail AS "failureDetail",
              resolution_state AS "resolutionState",
              resolution_reason_code AS "resolutionReasonCode",
              resolution_capture_policy AS "resolutionCapturePolicy",
              resolution_provider AS "resolutionProvider",
              resolution_reference AS "resolutionReference",
              terminal_reason_code AS "terminalReasonCode",
              last_outcome_at AS "lastOutcomeAt"
       FROM public_hearing_capture
       WHERE hearing_id=$1
       LIMIT 1`,
      hearingId,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.captureId,
      status: row.domainStatus ?? legacyCaptureStatus(row.storageStatus),
      storageStatus: row.storageStatus,
      scheduledStart: row.scheduledStart?.toISOString() ?? null,
      actualStart: row.actualStart?.toISOString() ?? null,
      actualEnd: row.actualEnd?.toISOString() ?? null,
      capturedSeconds: row.capturedSeconds ?? 0,
      transcriptGapSeconds: row.transcriptGapSeconds ?? 0,
      reconnectCount: row.reconnectCount ?? 0,
      failureCode: row.failureCode,
      failureDetail: row.failureDetail,
      resolutionState: row.resolutionState,
      resolutionReasonCode: row.resolutionReasonCode,
      resolutionCapturePolicy: row.resolutionCapturePolicy,
      resolutionProvider: row.resolutionProvider,
      // resolution_reference is a safe page/reference URL; the Phase 6 writer
      // explicitly refuses to persist the resolved media URL here.
      resolutionReference: row.resolutionReference,
      terminalReasonCode: row.terminalReasonCode,
      lastOutcomeAt: row.lastOutcomeAt?.toISOString() ?? null,
    };
  }

  private async ensureCanonicalCapture(hearing: CanonicalHearingRow): Promise<string> {
    const inserted = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO public_hearing_capture
         (id, hearing_id, status, domain_status, scheduled_start, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, 'scheduled', 'SCHEDULED', $2, now(), now())
       ON CONFLICT (hearing_id) DO NOTHING
       RETURNING id`,
      hearing.id,
      hearing.startsAt,
    );
    if (inserted[0]?.id) return inserted[0].id;
    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM public_hearing_capture WHERE hearing_id=$1 LIMIT 1`,
      hearing.id,
    );
    if (!existing[0]?.id) throw new Error(`canonical capture missing after ensure: ${hearing.id}`);
    return existing[0].id;
  }

  private async enqueuePreflight(hearingId: string): Promise<Record<string, unknown>> {
    const dedupeKey = `hearing-stream-preflight:v1:${hearingId.toLowerCase()}`;
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `INSERT INTO public_hearing_capture_job
         (job_type, dedupe_key, hearing_id, capture_id, status, due_at, payload, created_at, updated_at)
       VALUES ('preflight', $1, $2, NULL, 'pending', now(), '{}'::jsonb, now(), now())
       ON CONFLICT (dedupe_key) DO UPDATE SET
         due_at=LEAST(public_hearing_capture_job.due_at, EXCLUDED.due_at),
         status=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 'pending'
           ELSE public_hearing_capture_job.status
         END,
         attempts=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN 0
           ELSE public_hearing_capture_job.attempts
         END,
         lease_owner=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_owner
         END,
         lease_expires_at=CASE
           WHEN public_hearing_capture_job.status IN ('completed','failed') THEN NULL
           ELSE public_hearing_capture_job.lease_expires_at
         END,
         completed_at=NULL,
         last_error=NULL,
         updated_at=now()
       WHERE public_hearing_capture_job.status <> 'leased'
       RETURNING id, status`,
      dedupeKey,
      hearingId,
    );
    if (rows[0]) return { jobId: rows[0].id, status: rows[0].status, queued: true };
    const existing = await this.prisma.$queryRawUnsafe<Array<{ id: string; status: string }>>(
      `SELECT id, status FROM public_hearing_capture_job WHERE dedupe_key=$1 LIMIT 1`,
      dedupeKey,
    );
    return {
      jobId: existing[0]?.id ?? null,
      status: existing[0]?.status ?? 'unknown',
      queued: false,
      alreadyLeased: existing[0]?.status === 'leased',
    };
  }

  private async participationByHearingIds(
    ctx: TenantContext,
    hearingIds: string[],
  ): Promise<Map<string, Phase7Participation>> {
    if (!hearingIds.length) return new Map();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [schedules, follows] = await Promise.all([
        tx.$queryRawUnsafe<Array<ParticipationScheduleRow & { hearingId: string }>>(
          `SELECT hearing_id AS "hearingId",
                  scheduled_by_user AS "scheduledByUser",
                  scheduled_by_rule_id AS "scheduledByRuleId",
                  notify_on_start AS "notifyOnStart",
                  notify_on_mention AS "notifyOnMention",
                  client_ids AS "clientIds",
                  watchlist_id AS "watchlistId",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
           FROM hearing_subscription
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id = ANY($3::text[])`,
          ctx.tenantId,
          ctx.userId,
          hearingIds,
        ),
        tx.$queryRawUnsafe<Array<ParticipationFollowRow & { hearingId: string }>>(
          `SELECT hearing_id AS "hearingId",
                  notify_on_start AS "notifyOnStart",
                  notify_on_updates AS "notifyOnUpdates",
                  created_at AS "createdAt",
                  updated_at AS "updatedAt"
           FROM hearing_follow
           WHERE tenant_id=$1::uuid AND user_id=$2 AND hearing_id = ANY($3::text[])`,
          ctx.tenantId,
          ctx.userId,
          hearingIds,
        ),
      ]);
      const scheduleById = new Map(schedules.map((row) => [row.hearingId, row]));
      const followById = new Map(follows.map((row) => [row.hearingId, row]));
      const output = new Map<string, Phase7Participation>();
      for (const hearingId of hearingIds) {
        const schedule = scheduleById.get(hearingId);
        const follow = followById.get(hearingId);
        const scheduledByRule = Boolean(schedule?.scheduledByRuleId);
        output.set(hearingId, {
          scheduled: Boolean(schedule?.scheduledByUser || scheduledByRule),
          scheduledByUser: Boolean(schedule?.scheduledByUser),
          scheduledByRule,
          scheduledByRuleId: schedule?.scheduledByRuleId ?? null,
          followed: Boolean(follow),
          notifyOnStart: Boolean(schedule?.notifyOnStart || follow?.notifyOnStart),
          notifyOnMention: Boolean(schedule?.notifyOnMention),
          notifyOnUpdates: Boolean(follow?.notifyOnUpdates),
          clientIds: schedule?.clientIds ?? [],
          watchlistId: schedule?.watchlistId ?? null,
          updatedAt:
            [schedule?.updatedAt, follow?.updatedAt]
              .filter((value): value is Date => value instanceof Date)
              .sort((left, right) => right.getTime() - left.getTime())[0]
              ?.toISOString() ?? null,
        });
      }
      return output;
    });
  }
}

/** One capture-policy decision for request guards and internal scheduling callers. */
export const assessSchedulePolicy = assessStrictSchedulePolicy;

export function browserJoinPlan(
  hearing: CanonicalHearingRow,
  capture: Phase7CaptureDetail | null,
  candidates: BrowserSourceCandidate[] = [],
): BrowserJoinPlan {
  if (hearing.visibility !== 'public') {
    return {
      mode: 'BLOCKED',
      hearingId: hearing.id,
      reasonCode: 'NON_PUBLIC_PROCEEDING',
      message: 'Browser-assisted capture is available only for public proceedings.',
    };
  }
  if (hearing.eventStatus === 'canceled') {
    return {
      mode: 'BLOCKED',
      hearingId: hearing.id,
      reasonCode: 'EVENT_CANCELED',
      message: 'This proceeding has been canceled.',
    };
  }

  // An EXPLICIT browser join is independent of the server recorder: an active
  // or complete canonical capture never refuses it. The capture id/status are
  // carried on the plan so the UI can show "Capiro is capturing" alongside the
  // user's own private browser context.
  const source = selectBrowserSource({
    hearingUrl: hearing.url,
    candidates,
  });
  if (!source) {
    return {
      mode: 'BLOCKED',
      hearingId: hearing.id,
      reasonCode: 'OFFICIAL_PAGE_UNAVAILABLE',
      message: 'No official public event page has been reconciled yet.',
    };
  }

  return {
    mode: 'BROWSER_CAPTURE',
    hearingId: hearing.id,
    title: hearing.title.slice(0, 300),
    sourceType: (hearing.type ?? 'hearing').toLowerCase().includes('markup') ? 'markup' : 'hearing',
    audioSource: 'browser_mic',
    recordingPolicy: 'transcript_only',
    sourceUrl: source.sourceUrl,
    sourceKind: source.sourceKind,
    sourceProvider: source.sourceProvider,
    requiresStreamResolution: source.sourceKind === 'official_listing_page',
    committeeId: hearing.subcommitteeSystemCode ?? hearing.committeeSystemCode,
    reasonCode:
      capture?.terminalReasonCode ??
      capture?.resolutionReasonCode ??
      'BROWSER_ASSISTED_FALLBACK_AVAILABLE',
    ...(capture ? { canonicalCaptureId: capture.id, canonicalCaptureStatus: capture.status } : {}),
  };
}

export function encodeTranscriptCursor(sequence: number, id: string): string {
  return Buffer.from(JSON.stringify({ sequence, id }), 'utf8').toString('base64url');
}

export function decodeTranscriptCursor(cursor?: string): { sequence: number; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      sequence?: unknown;
      id?: unknown;
    };
    if (
      !Number.isInteger(parsed.sequence) ||
      (parsed.sequence as number) < 0 ||
      typeof parsed.id !== 'string'
    ) {
      return null;
    }
    return { sequence: parsed.sequence as number, id: parsed.id };
  } catch {
    return null;
  }
}

function mapListRow(row: ListRow): Record<string, unknown> {
  return {
    id: row.id,
    congress: row.congress,
    chamber: row.chamber,
    committeeName: row.committeeName,
    committeeSystemCode: row.committeeSystemCode,
    subcommitteeSystemCode: row.subcommitteeSystemCode,
    title: row.title,
    eventType: row.eventType,
    eventStatus: row.eventStatus,
    visibility: row.visibility,
    date: row.date.toISOString().slice(0, 10),
    startsAt: row.startsAt?.toISOString() ?? null,
    time: row.time,
    timezone: row.timezone,
    location: row.location,
    officialPageUrl: strictOfficialSourceUrl(row.officialPageUrl),
    streamAvailability: row.streamAvailability,
    coverageStatus: row.coverageStatus,
    capture: row.captureId
      ? {
          id: row.captureId,
          status: row.captureStatus ?? 'UNKNOWN',
          scheduledStart: row.captureScheduledStart?.toISOString() ?? null,
          actualStart: row.captureActualStart?.toISOString() ?? null,
          actualEnd: row.captureActualEnd?.toISOString() ?? null,
          capturedSeconds: row.capturedSeconds ?? 0,
          transcriptGapSeconds: row.transcriptGapSeconds ?? 0,
          reconnectCount: row.reconnectCount ?? 0,
          failureCode: row.failureCode,
          terminalReasonCode: row.terminalReasonCode,
          resolutionReasonCode: row.resolutionReasonCode,
        }
      : null,
    // Honest "no capture yet" state: durable demand exists but the canonical
    // capture row has not been acquired/created. Distinct from a real capture
    // status so the UI never fabricates a recording that does not exist.
    capturePending: !row.captureId,
    scheduleSource:
      row.scheduledByUser || row.scheduledByRuleId
        ? {
            byUser: Boolean(row.scheduledByUser),
            byRule: Boolean(row.scheduledByRuleId),
            ruleId: row.scheduledByRuleId ?? null,
          }
        : null,
  };
}

function legacyCaptureStatus(status: string): string {
  switch (status) {
    case 'scheduled':
      return 'SCHEDULED';
    case 'leased':
      return 'READY';
    case 'capturing':
      return 'CAPTURING';
    case 'ended':
      return 'COMPLETE';
    case 'failed':
      return 'FAILED';
    case 'no_stream':
      return 'BLOCKED';
    default:
      return 'PREPARING';
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
