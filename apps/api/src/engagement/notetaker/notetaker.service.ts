import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext, TenantRole } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { notetakerEnabled } from '../../common/tenant-flags.js';
import { EngagementService, ownMeetingWhere } from '../engagement.service.js';
import {
  MEETING_BOT_PROVIDER,
  type MeetingBotProvider,
  type NormalizedBotEvent,
  type RecordingPolicy,
} from './meeting-bot.provider.js';

/** Bot display name in the participant list (part of the consent disclosure; Recall max 100). */
const DEFAULT_BOT_NAME = 'Meri Notetaker (recording)';

/** Columns returned to the UI (never the raw consent/metadata blobs). */
const SESSION_SELECT = {
  id: true,
  meetingId: true,
  clientId: true,
  provider: true,
  platform: true,
  status: true,
  recordingPolicy: true,
  externalBotId: true,
  debriefId: true,
  error: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Forward-only rank of the happy-path lifecycle. Webhooks are at-least-once and
 * can be redelivered out of order, so a coarse status_change may arrive AFTER the
 * pipeline advanced (e.g. a redelivered `call_ended` after `done`). Status writes
 * driven by provider status codes only ever move FORWARD through this ladder —
 * never backwards — so a stale redelivery can't clobber `drafting`/`done` (which
 * would break both the UI and the drafting idempotency claim).
 */
const STATUS_RANK: Record<string, number> = {
  requested: 0,
  joining: 1,
  in_call: 2,
  recording: 3,
  processing: 4,
  drafting: 5,
  done: 6,
};

/** Statuses in which the bot is (or may still be) in the call and can be removed. */
const REMOVABLE_STATUSES = ['requested', 'joining', 'in_call', 'recording'];

export interface DispatchNotetakerInput {
  /** The meeting join URL (Zoom/Meet/Teams) the bot should join. */
  meetingUrl: string;
  /** Strict-consent affirmation — must be true or dispatch is refused. */
  authorizedToRecord: boolean;
  /** Required true when an all-party-consent state is involved. */
  allPartiesWillBeNotified?: boolean;
  /** All-party-consent states flagged by the UI for this meeting. */
  allPartyStates?: string[];
  recordingPolicy?: RecordingPolicy;
  /** ISO8601 join-later time; omit to join now. */
  joinAt?: string;
}

/**
 * Meeting Notetaker orchestration — docs/plans/meeting-notetaker-bot-plan.md (Phase 1).
 *
 * `dispatch()`/`remove()` are user-initiated (controller routes). `handleBotEvent()`
 * is the async half, driven by the /webhooks/recall receiver — it starts async
 * transcription when the recording is ready, then pulls the transcript, files it as
 * a meeting attachment (the erasure-wired store), and saves a debrief through the
 * EXISTING createMeetingDebrief path so the result is byte-identical to a
 * hand-written debrief (E2E-encrypted, authored by the requesting user).
 *
 * Webhooks are at-least-once: every pipeline step claims its work with an atomic
 * conditional update (updateMany) so duplicate deliveries can't double-transcribe
 * or double-create debriefs.
 *
 * Registered in EngagementModule (not NotetakerModule) so it can inject
 * EngagementService; NotetakerModule (imported by EngagementModule) supplies the
 * MEETING_BOT_PROVIDER token.
 */
@Injectable()
export class NotetakerService {
  private readonly logger = new Logger(NotetakerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MEETING_BOT_PROVIDER) private readonly bot: MeetingBotProvider,
    private readonly engagement: EngagementService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** Send a meeting bot to a meeting the caller owns. Strict-consent gated. */
  async dispatch(ctx: TenantContext, meetingId: string, input: DispatchNotetakerInput) {
    const tenant = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenant.findFirst({
        where: { id: ctx.tenantId },
        select: { settings: true, name: true },
      }),
    );
    // Env kill-switch AND per-tenant flag (default OFF) — belt-and-suspenders.
    if (!notetakerEnabled(tenant?.settings)) {
      throw new ForbiddenException('Meeting notetaker is not enabled for this tenant');
    }

    if (!input.authorizedToRecord) {
      throw new BadRequestException('Recording authorization is required to send the notetaker');
    }
    if (input.allPartyStates?.length && !input.allPartiesWillBeNotified) {
      throw new BadRequestException(
        'All-party consent must be affirmed when an all-party-consent state is involved',
      );
    }
    const meetingUrl = validateMeetingUrl(input.meetingUrl);
    // Reject non-meeting URLs BEFORE creating a session or calling the vendor.
    // The prime real-world offender: Outlook-synced meetings carry a calendar
    // webLink (outlook.office365.com/...), which the UI used to prefill — Recall
    // then 400s with "meeting_url is malformed, or for an unsupported platform"
    // AFTER a session row exists. Fail fast with an actionable message instead.
    const platform = detectPlatform(meetingUrl);
    if (!platform) {
      throw new BadRequestException(
        "That link doesn't look like a meeting join URL — paste the Zoom, Microsoft Teams, Google Meet, Webex, GoTo, or Slack link from the calendar invite",
      );
    }

    const recordingPolicy: RecordingPolicy = input.recordingPolicy ?? 'transcript_only';
    // Only the policies the pipeline actually honors are accepted (the DTO
    // enforces this too; re-checked here for non-HTTP callers). The pipeline
    // always delete_media's vendor recordings after pulling the transcript, so
    // accepting 'audio_and_transcript' would silently downgrade a
    // consent-critical choice.
    if (recordingPolicy !== 'transcript_only' && recordingPolicy !== 'no_storage') {
      throw new BadRequestException(
        `Recording policy "${recordingPolicy}" is not available — audio retention is not implemented`,
      );
    }

    // 1) Create the session row (tenant-scoped) BEFORE dispatch so its id can be
    //    stamped into the bot metadata that every webhook echoes back. The meeting
    //    lookup enforces the SAME ownership predicate as the debrief pipeline
    //    (generateMeetingDebriefDraft/createMeetingDebrief) — otherwise a dispatch
    //    for a visible-but-not-owned meeting would record the whole meeting and
    //    only fail at debrief time.
    const created = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true, clientId: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      const active = await tx.meetingBotSession.findFirst({
        where: { meetingId, tenantId: ctx.tenantId, status: { in: REMOVABLE_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new BadRequestException('A notetaker is already assigned to this meeting');
      }
      return tx.meetingBotSession.create({
        data: {
          tenantId: ctx.tenantId,
          meetingId,
          clientId: meeting.clientId,
          requestedByUserId: ctx.userId,
          provider: 'recall',
          region: this.recallRegion(),
          platform,
          joinUrl: meetingUrl,
          status: 'requested',
          recordingPolicy,
          consent: {
            mode: 'strict',
            affirmedByUserId: ctx.userId,
            affirmedAt: new Date().toISOString(),
            allPartyStatesFlagged: input.allPartyStates ?? [],
            allPartiesWillBeNotified: input.allPartiesWillBeNotified ?? false,
            disclosurePosted: true,
          },
        },
        select: { id: true },
      });
    });

    // 2) Dispatch the bot (external HTTP — never inside a DB transaction).
    let externalBotId: string;
    try {
      const result = await this.bot.dispatchBot({
        meetingUrl,
        botName: DEFAULT_BOT_NAME,
        metadata: {
          tenantId: ctx.tenantId,
          meetingBotSessionId: created.id,
          meetingId,
          requestedByUserId: ctx.userId,
        },
        recordingPolicy,
        joinAt: input.joinAt,
        disclosureMessage: this.disclosureMessage(tenant?.name ?? null),
      });
      externalBotId = result.externalBotId;
    } catch (err) {
      await this.failSession(ctx.tenantId, created.id, (err as Error).message);
      throw err;
    }

    // 3) Record the bot id + advance status. If THIS write fails we would have a
    //    live bot recording a meeting with no externalBotId on file — untrackable
    //    by the kill switch, the bot.done fallback, and delete_media. That is a
    //    consent violation, not just an inconsistency, so compensate by pulling
    //    the bot back out of the call before surfacing the error.
    try {
      return await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.meetingBotSession.update({
          where: { id: created.id },
          data: { status: 'joining', externalBotId, startedAt: new Date() },
          select: SESSION_SELECT,
        }),
      );
    } catch (err) {
      this.logger.error(
        `failed to record bot id for session ${created.id} — removing bot ${externalBotId} from the call: ${(err as Error).message}`,
      );
      try {
        await this.bot.leaveCall(externalBotId);
      } catch (leaveErr) {
        this.logger.error(
          `leave_call compensation failed (bot ${externalBotId}): ${(leaveErr as Error).message}`,
        );
      }
      try {
        await this.failSession(ctx.tenantId, created.id, (err as Error).message);
      } catch {
        // DB still down — the session stays 'requested'; the error below surfaces it.
      }
      throw err;
    }
  }

  /**
   * Latest bot session for a meeting — powers the status chip. Enforces the same
   * per-user meeting-visibility predicate as every other meeting-scoped endpoint
   * (getMeeting/dispatch/remove): a tenant member must not be able to probe bot
   * sessions on meetings they can't see.
   */
  async getSessionForMeeting(ctx: TenantContext, meetingId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      return tx.meetingBotSession.findFirst({
        where: { meetingId, tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        select: SESSION_SELECT,
      });
    });
  }

  /**
   * Kill switch (§5 consent control): remove the bot from the call. Deliberately
   * NOT gated on the feature flag — removal must always work, even if the flag
   * was flipped off while a bot is mid-call. Recording captured up to the removal
   * still flows through the normal pipeline (disclosed while it ran); the user
   * can delete the resulting debrief/transcript like any other.
   */
  async remove(ctx: TenantContext, meetingId: string) {
    const session = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      return tx.meetingBotSession.findFirst({
        where: { meetingId, tenantId: ctx.tenantId },
        orderBy: { createdAt: 'desc' },
        select: { id: true, externalBotId: true, status: true },
      });
    });
    if (!session || !REMOVABLE_STATUSES.includes(session.status)) {
      throw new BadRequestException('No active notetaker to remove for this meeting');
    }
    if (!session.externalBotId) {
      // Dispatch is still in flight (bot id not recorded yet). Marking the
      // session 'removed' now would be a false-safe: the bot may still land in
      // the call with nobody tracking it. Make the caller retry in a moment.
      throw new BadRequestException(
        'The notetaker is still being dispatched — try again in a moment',
      );
    }
    await this.bot.leaveCall(session.externalBotId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingBotSession.updateMany({
        where: { id: session.id, tenantId: ctx.tenantId, status: { in: REMOVABLE_STATUSES } },
        data: { status: 'removed' },
      }),
    );
    return this.getSessionForMeeting(ctx, meetingId);
  }

  /**
   * Entry point for the /webhooks/recall receiver: verify the signature (throws on
   * a bad/missing signature so the controller returns 4xx), then process the event
   * OUT OF BAND. Recall expects a fast 2xx and retries on non-2xx/timeout, so we do
   * not await the (potentially slow) transcript→debrief pipeline here.
   */
  receiveWebhook(headers: Record<string, string | undefined>, rawBody: Buffer | string): void {
    const event = this.bot.verifyAndParseWebhook(headers, rawBody);
    void this.handleBotEvent(event).catch((err) =>
      this.logger.error(
        `notetaker webhook processing failed (event=${event.event}): ${(err as Error).message}`,
      ),
    );
  }

  /**
   * Process a VERIFIED Recall webhook event (called by the /webhooks/recall
   * receiver). All external calls run outside DB transactions.
   *
   * Handles BOTH documented async choreographies: the `recording.done` webhook
   * carrying the recording id, AND the `bot.done` status change (fallback: look
   * the recording id up via Retrieve Bot) — whichever arrives, transcription
   * starts exactly once (atomic claim on `recordingId`).
   */
  async handleBotEvent(event: NormalizedBotEvent): Promise<void> {
    const located = await this.locateSession(event);
    if (!located) return;
    const { tenantId, sessionId } = located;

    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.meetingBotSession.findFirst({
        where: { id: sessionId, tenantId },
        select: {
          id: true,
          meetingId: true,
          clientId: true,
          requestedByUserId: true,
          externalBotId: true,
          recordingId: true,
          transcriptId: true,
          debriefId: true,
          recordingPolicy: true,
        },
      }),
    );
    if (!session) {
      this.logger.warn(`Recall webhook for unknown session ${sessionId} (tenant ${tenantId})`);
      return;
    }

    if (event.kind === 'status_change') {
      // Reflect coarse bot lifecycle for the UI (forward-only; see STATUS_RANK).
      const mapped = mapRecallStatus(event.statusCode);
      if (mapped) await this.advanceStatus(tenantId, sessionId, mapped);

      // `bot.done` = bot finished AND the recording is available. If we haven't
      // seen a recording.done webhook (or it carried no id), look the recording
      // up directly so the pipeline can't stall on a missing/undelivered event.
      if (event.statusCode === 'done' && !session.recordingId && !session.transcriptId) {
        let recordingId: string | null = null;
        try {
          recordingId = session.externalBotId
            ? await this.bot.getRecordingId(session.externalBotId)
            : null;
        } catch (err) {
          // We already ACKed the webhook (204), so Recall will NOT redeliver
          // bot.done — a silent return here would wedge the session at
          // 'processing' forever. Mark it failed instead; if a recording.done
          // webhook still arrives later, startTranscription's claim (which
          // doesn't filter on status) recovers the session from 'failed'.
          this.logger.warn(
            `getRecordingId failed (session ${sessionId}): ${(err as Error).message}`,
          );
          await this.failSession(tenantId, sessionId, (err as Error).message);
          return;
        }
        if (!recordingId) {
          // Bot finished without any recording — it never got to record (e.g.
          // stuck in the waiting room until the call ended).
          await this.failSession(tenantId, sessionId, 'Bot finished without a recording');
          return;
        }
        await this.startTranscription(tenantId, sessionId, recordingId);
      }
      return;
    }

    // Recording ready → start async transcription on OUR Deepgram (exactly once).
    if (event.kind === 'recording_ready' && event.recordingId) {
      await this.startTranscription(tenantId, sessionId, event.recordingId);
      return;
    }

    // Provider-side recording/transcription failure → surface it (never clobbers done).
    if (event.kind === 'pipeline_failed') {
      await this.failSession(tenantId, sessionId, `Provider pipeline failed (${event.event})`);
      return;
    }

    // Transcript done → pull it, store it, generate + save the debrief, delete media.
    if (event.kind === 'transcript_done' && event.transcriptId) {
      await this.finishTranscript(tenantId, session, event.transcriptId);
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Resolve (tenantId, sessionId) for an inbound event. Primary: the metadata we
   * stamped at dispatch (echoed back on every webhook). Fallback: some event
   * families may omit bot metadata — resolve by the indexed externalBotId via a
   * single system-scoped point read (the webhook has no tenant context yet; this
   * is the same posture as the Clerk webhook receiver).
   */
  private async locateSession(
    event: NormalizedBotEvent,
  ): Promise<{ tenantId: string; sessionId: string } | null> {
    const tenantId = asString(event.metadata.tenantId);
    const sessionId = asString(event.metadata.meetingBotSessionId);
    if (tenantId && sessionId) return { tenantId, sessionId };

    if (event.botId) {
      const row = await this.prisma.withSystem((tx) =>
        tx.meetingBotSession.findFirst({
          where: { externalBotId: event.botId! },
          select: { id: true, tenantId: true },
        }),
      );
      if (row) return { tenantId: row.tenantId, sessionId: row.id };
    }
    this.logger.warn(
      `Recall webhook could not be matched to a session (event=${event.event}, bot=${event.botId ?? 'n/a'})`,
    );
    return null;
  }

  /**
   * Start async transcription exactly once: atomically claim the session's
   * `recordingId` slot; the loser of a duplicate-delivery race no-ops. On a
   * createAsyncTranscript failure the claim is released (recordingId reset) so a
   * later redelivery / bot.done fallback can retry.
   */
  private async startTranscription(
    tenantId: string,
    sessionId: string,
    recordingId: string,
  ): Promise<void> {
    const claimed = await this.prisma.withTenant(tenantId, (tx) =>
      tx.meetingBotSession.updateMany({
        where: {
          id: sessionId,
          tenantId,
          recordingId: null,
          transcriptId: null,
          debriefId: null,
        },
        data: { recordingId, status: 'processing' },
      }),
    );
    if (claimed.count === 0) return;

    try {
      const { transcriptId } = await this.bot.createAsyncTranscript(recordingId);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meetingBotSession.update({ where: { id: sessionId }, data: { transcriptId } }),
      );
    } catch (err) {
      this.logger.warn(
        `createAsyncTranscript failed (session ${sessionId}): ${(err as Error).message}`,
      );
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.meetingBotSession.updateMany({
          where: { id: sessionId, tenantId, transcriptId: null },
          data: {
            recordingId: null,
            status: 'failed',
            error: (err as Error).message.slice(0, 500),
          },
        }),
      );
    }
  }

  private async finishTranscript(
    tenantId: string,
    session: {
      id: string;
      meetingId: string;
      clientId: string | null;
      requestedByUserId: string | null;
      externalBotId: string | null;
      recordingPolicy: string;
    },
    transcriptId: string,
  ): Promise<void> {
    // Atomic idempotency claim: webhooks are at-least-once, and a duplicate
    // transcript.done must not double-create debriefs. `drafting` marks the
    // pipeline in flight; failures release the claim by setting `failed`.
    const claimed = await this.prisma.withTenant(tenantId, (tx) =>
      tx.meetingBotSession.updateMany({
        where: {
          id: session.id,
          tenantId,
          debriefId: null,
          status: { notIn: ['drafting', 'done'] },
        },
        data: { status: 'drafting', transcriptId },
      }),
    );
    if (claimed.count === 0) return;

    let plainText: string;
    try {
      const transcript = await this.bot.getTranscript(transcriptId);
      plainText = transcript.plainText.trim();
    } catch (err) {
      this.logger.warn(`getTranscript failed (session ${session.id}): ${(err as Error).message}`);
      await this.failSession(tenantId, session.id, (err as Error).message);
      return;
    }
    if (!plainText) {
      await this.failSession(tenantId, session.id, 'Transcript was empty');
      return;
    }

    // The debrief is authored by the requesting user, so hydrate their context.
    const ctx = await this.hydrateContext(tenantId, session.requestedByUserId);
    if (!ctx) {
      await this.failSession(tenantId, session.id, 'Requesting user unavailable');
      return;
    }

    // Persist the transcript itself as a meeting attachment (plan §5: transcripts
    // at rest live in OUR S3 and MUST be erasure-wired — the EngagementAttachment
    // row is exactly that wiring: deleteAttachment removes object + row + KB
    // chunks). Skipped entirely under `no_storage` (the debrief is the only
    // artifact kept). Best-effort: a storage hiccup must not cost the user their
    // debrief.
    let transcriptS3Key: string | null = null;
    if (session.recordingPolicy !== 'no_storage') {
      try {
        const stored = await this.engagement.createAttachmentFromBuffer(ctx, {
          clientId: session.clientId,
          meetingId: session.meetingId,
          fileName: `meeting-transcript-${new Date().toISOString().slice(0, 10)}.txt`,
          contentType: 'text/plain',
          buffer: Buffer.from(plainText, 'utf8'),
          source: 'notetaker',
        });
        transcriptS3Key = stored.s3Key;
      } catch (err) {
        this.logger.warn(
          `transcript attachment store failed (session ${session.id}): ${(err as Error).message}`,
        );
      }
    }

    try {
      const draft = await this.engagement.generateMeetingDebriefDraft(ctx, session.meetingId, {
        method: 'upload',
        sourceText: plainText,
      });
      const debrief = await this.engagement.createMeetingDebrief(ctx, session.meetingId, {
        body: formatDebriefBody(draft),
      });
      await this.prisma.withTenant(tenantId, async (tx) => {
        await tx.meetingBotSession.update({
          where: { id: session.id },
          data: {
            transcriptId,
            transcriptS3Key,
            debriefId: debrief.id,
            status: 'done',
            endedAt: new Date(),
          },
        });
        if (transcriptS3Key) {
          await tx.meeting.updateMany({
            where: { id: session.meetingId, tenantId },
            data: { transcriptS3Key },
          });
        }
      });
    } catch (err) {
      this.logger.warn(`debrief save failed (session ${session.id}): ${(err as Error).message}`);
      await this.failSession(tenantId, session.id, (err as Error).message);
      return;
    }

    // Retention hygiene: delete the recording media from Recall now the
    // transcript is safely stored on our side. Best-effort — don't fail the save.
    if (session.externalBotId) {
      try {
        await this.bot.deleteMedia(session.externalBotId);
      } catch (err) {
        this.logger.warn(`delete_media failed (session ${session.id}): ${(err as Error).message}`);
      }
    }
  }

  /** Build a full TenantContext for the (session-less) webhook actor, like the middleware does. */
  private async hydrateContext(
    tenantId: string,
    userId: string | null,
  ): Promise<TenantContext | null> {
    if (!userId) return null;
    return this.prisma.withSystem(async (tx) => {
      const [user, tenant, membership] = await Promise.all([
        tx.user.findUnique({ where: { id: userId }, select: { id: true, clerkUserId: true } }),
        tx.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } }),
        tx.tenantMembership.findFirst({ where: { tenantId, userId }, select: { role: true } }),
      ]);
      // Fail closed: only author a bot debrief for a user who is still a member of
      // the tenant (missing membership => they lost access => refuse, rather than
      // defaulting a role). Stays within-tenant regardless, but this is the safer
      // posture and guards any future caller passing a mismatched (tenantId, userId).
      if (!user || !tenant || !membership) return null;
      return {
        tenantId,
        tenantSlug: tenant.slug,
        userId: user.id,
        clerkUserId: user.clerkUserId,
        role: membership.role as TenantRole,
      };
    });
  }

  /** Region label parsed from the Recall base URL (e.g. us-west-2.recall.ai → us-west-2). */
  private recallRegion(): string {
    const base = this.config.get('RECALL_API_BASE_URL', { infer: true });
    return /https?:\/\/([a-z0-9-]+)\.recall\.ai/i.exec(base)?.[1] ?? 'us-west-2';
  }

  /** In-meeting consent disclosure (mirrors consent-copy §2). */
  private disclosureMessage(firmName: string | null): string {
    const who = firmName ? `${firmName} is using ` : '';
    return (
      `${who}Meri Notetaker to transcribe this meeting for a private debrief. ` +
      'The transcript is stored securely and access-controlled; no audio is retained. ' +
      "If you'd prefer we not record, let the host know and they can remove this notetaker."
    );
  }

  /**
   * Forward-only lifecycle write for provider status codes: only updates when the
   * current status ranks LOWER than the incoming one, so an out-of-order or
   * redelivered status_change can never regress `drafting`/`done` (or resurrect a
   * `failed`/`removed`/`denied_consent` session).
   */
  private async advanceStatus(tenantId: string, sessionId: string, status: string): Promise<void> {
    const rank = STATUS_RANK[status];
    if (rank === undefined) {
      // Non-ladder statuses (failed / denied_consent) go through their own guards.
      if (status === 'failed') {
        await this.failSession(tenantId, sessionId, 'Bot reported a fatal error');
      } else if (status === 'denied_consent') {
        await this.prisma.withTenant(tenantId, (tx) =>
          tx.meetingBotSession.updateMany({
            where: { id: sessionId, tenantId, status: { notIn: ['done', 'failed'] } },
            data: { status: 'denied_consent' },
          }),
        );
      }
      return;
    }
    const lower = Object.entries(STATUS_RANK)
      .filter(([, r]) => r < rank)
      .map(([s]) => s);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.meetingBotSession.updateMany({
        where: { id: sessionId, tenantId, status: { in: lower } },
        data: { status },
      }),
    );
  }

  /** Mark a session failed with an error message — never clobbers a delivered (`done`) session. */
  private async failSession(tenantId: string, sessionId: string, error: string): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.meetingBotSession.updateMany({
        where: { id: sessionId, tenantId, status: { not: 'done' } },
        data: { status: 'failed', error: error.slice(0, 500) },
      }),
    );
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Validate + normalize the join URL: must parse as an absolute http(s) URL, so we
 * never hand the bot vendor a garbage string (or a non-web scheme). Exported for
 * unit tests.
 */
export function validateMeetingUrl(rawUrl: string | undefined): string {
  const meetingUrl = rawUrl?.trim();
  if (!meetingUrl) {
    throw new BadRequestException('A meeting join URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(meetingUrl);
  } catch {
    throw new BadRequestException('The meeting join URL is not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new BadRequestException('The meeting join URL must be an http(s) link');
  }
  return meetingUrl;
}

/**
 * Best-effort platform label from the join URL. Doubles as the dispatch gate:
 * null ⇒ dispatch refuses before any session/vendor call. Its ONLY job is to
 * catch obvious non-meeting URLs (calendar webLinks, arbitrary pages) early —
 * Recall itself is the real authority on joinability, and the provider layer
 * translates a Recall create-bot rejection into a friendly error. So err toward
 * recognizing anything platform-shaped: covers Recall's full supported set
 * (Zoom incl. ZoomGov, Google Meet, Teams incl. US-Gov GCC/GCC-High/DoD, Webex,
 * GoTo, Slack Huddles). Agency-hosted meetings (zoomgov.com, *.teams.microsoft.us)
 * are routine for this federal-lobbying customer base.
 *
 * MUST stay in lockstep with the web mirrors isSupportedJoinUrl()/JOIN_URL_PATTERN
 * (apps/web/src/pages/engagement/EngagementPage.tsx) — a drift where one accepts a
 * URL the other rejects surfaces as a confusing "not a join link" dead-end.
 */
export function detectPlatform(meetingUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(meetingUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === 'zoom.us' ||
    host.endsWith('.zoom.us') ||
    host === 'zoomgov.com' ||
    host.endsWith('.zoomgov.com')
  ) {
    return 'zoom';
  }
  if (host === 'meet.google.com') return 'meet';
  // Commercial (teams.microsoft.com / teams.live.com) AND US-Government tenants,
  // which live on *.teams.microsoft.us (gov. = GCC-High, dod. = DoD).
  if (
    host === 'teams.microsoft.com' ||
    host === 'teams.live.com' ||
    host === 'teams.microsoft.us' ||
    host.endsWith('.teams.microsoft.us')
  ) {
    return 'teams';
  }
  if (host === 'webex.com' || host.endsWith('.webex.com')) return 'webex';
  if (
    host === 'goto.com' ||
    host.endsWith('.goto.com') ||
    host === 'gotomeeting.com' ||
    host.endsWith('.gotomeeting.com') ||
    host === 'gotomeet.me'
  ) {
    return 'goto';
  }
  // Slack Huddles only — app.slack.com also serves ordinary Slack, so require the
  // /huddle/ path so a message permalink isn't mistaken for a joinable meeting.
  if (host === 'app.slack.com' && url.pathname.includes('/huddle/')) return 'slack';
  return null;
}

/**
 * Map a Recall bot status code to our coarse lifecycle. Returns null for codes we
 * don't surface. Recall reserves the right to add codes, so this is intentionally
 * a partial map, not an exhaustive enum. Exported for unit tests.
 */
export function mapRecallStatus(code: string | null): string | null {
  switch (code) {
    case 'joining_call':
    case 'in_waiting_room':
      return 'joining';
    case 'in_call_not_recording':
      return 'in_call';
    case 'in_call_recording':
      return 'recording';
    case 'recording_permission_denied':
      return 'denied_consent';
    case 'call_ended':
    case 'done':
      return 'processing';
    case 'fatal':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Assemble the stored debrief body from a generated draft. MUST stay byte-identical
 * to the frontend's formatDebriefBody (apps/web/src/pages/engagement/EngagementPage.tsx)
 * so the existing parseDebriefBody round-trips a bot-authored debrief the same as a
 * hand-written one. Exported for unit tests.
 */
export function formatDebriefBody(draft: {
  recap: string;
  actionItems: string[];
  notes: string;
}): string {
  return [
    'Recap',
    draft.recap.trim() || 'No recap saved.',
    '',
    'Action Items',
    ...(draft.actionItems.length
      ? draft.actionItems.map((item) => `- ${item}`)
      : ['No action items saved.']),
    '',
    'Notes',
    draft.notes.trim() || 'No notes saved.',
  ].join('\n');
}
