import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { LiveHearingSourceType } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateSessionDto,
  LiveHearingAudioSourceDto,
  LiveHearingSourceTypeDto,
  RecordingPolicyDto,
} from './dto/session.dto.js';

const CAPTURE_LEASE_STALE_MS = Number.parseInt(
  process.env.HEARING_CAPTURE_LEASE_STALE_MS ?? '90000',
  10,
);

const PUBLIC_SOURCE_TYPES = [
  LiveHearingSourceType.hearing,
  LiveHearingSourceType.markup,
] as const;

export interface HearingCaptureClaim {
  startedAt: Date;
}

/**
 * Live Hearing session lifecycle + tenant/user scoping. EVERY method filters by
 * tenantId (the TenantGuard-resolved scope).
 *
 * CONSENT (P8, spec D11) — conditional on source type:
 *  - PUBLIC congressional proceedings (`hearing` / `markup`): consent is NOT
 *    required. `consent_status=not_required`; any attestation sent is ignored.
 *  - PRIVATE sessions (`meeting` / `webinar` / `agency_session`): the operator
 *    MUST attest they're authorized to capture the session. Enforced SERVER-SIDE
 *    here — a private create WITHOUT a non-empty `consentAttestation` is rejected
 *    (400). When present, the session is created `confirmed` and the FULL
 *    attestation is PERSISTED (consentAttestation + attestedBy + attestedAt) as a
 *    durable, queryable compliance artifact (only a truncated copy is logged);
 *    capture proceeds.
 *
 * Public congressional hearings and markups are team-visible inside the tenant.
 * Private meetings, webinars and agency sessions are creator-private: a same-
 * tenant user who guesses a session id receives the same 404 as a missing row.
 *
 * The browser capture lease uses the existing session row rather than an in-
 * memory map. `status in (paused, live) + updated_at` is the distributed lease;
 * `started_at` is its ownership token. A new capture first claims `paused` while
 * Deepgram and the browser recorder are prepared, then becomes `live` on the
 * first audio frame.
 */
@Injectable()
export class HearingSessionService {
  private readonly logger = new Logger(HearingSessionService.name);

  /** Source types that require a consent attestation before capture. */
  private static readonly PRIVATE_SOURCE_TYPES: ReadonlySet<string> = new Set([
    LiveHearingSourceTypeDto.meeting,
    LiveHearingSourceTypeDto.webinar,
    LiveHearingSourceTypeDto.agency_session,
  ]);

  /** True when a source type is a PRIVATE session needing a consent attestation. */
  static requiresConsent(sourceType: string): boolean {
    return HearingSessionService.PRIVATE_SOURCE_TYPES.has(sourceType);
  }

  /**
   * Whether a session's transcript must be encrypted REGARDLESS of what any
   * classifier later says about it. Deciding this from the session's own
   * structure — private source type, or an explicit client/matter/issue/bill/PE/
   * agency link — is what stops sensitive text from sitting in plaintext for the
   * seconds (or forever, on model failure) before an AI relevance score arrives.
   */
  static isSensitiveSession(session: {
    sourceType: string;
    clientId?: string | null;
    matterId?: string | null;
    issueIds?: string[] | null;
    billIds?: string[] | null;
    programElementIds?: string[] | null;
    agencyIds?: string[] | null;
  }): boolean {
    return (
      HearingSessionService.requiresConsent(session.sourceType) ||
      Boolean(session.clientId || session.matterId) ||
      Boolean(session.issueIds?.length) ||
      Boolean(session.billIds?.length) ||
      Boolean(session.programElementIds?.length) ||
      Boolean(session.agencyIds?.length)
    );
  }

  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, userId: string, dto: CreateSessionDto) {
    const isPrivate = HearingSessionService.requiresConsent(dto.sourceType);
    const attestation = dto.consentAttestation?.trim();

    if (isPrivate && !attestation) {
      throw new BadRequestException(
        'Consent attestation required for a private session (meeting/webinar/agency_session)',
      );
    }

    // Server-side enforcement (D11): a PRIVATE session requires an attestation.
    // Public → not_required; private (with attestation) → confirmed up front.
    const consentStatus = isPrivate ? 'confirmed' : 'not_required';
    if (isPrivate) {
      // Log truncated only — the FULL attestation is persisted below (durable,
      // queryable compliance artifact), so we don't emit the full text to logs.
      this.logger.log(
        `consent attested at create session-type=${dto.sourceType} tenant=${tenantId} ` +
          `user=${userId} attestation="${attestation!.slice(0, 80)}"`,
      );
    }

    // The active browser workflow never stores raw audio. A stale client may
    // still submit the old `audio_and_transcript` enum; persist the truthful
    // effective policy instead of promising retention that does not exist.
    const recordingPolicy =
      dto.recordingPolicy === RecordingPolicyDto.no_storage
        ? RecordingPolicyDto.no_storage
        : RecordingPolicyDto.transcript_only;
    if (dto.recordingPolicy === RecordingPolicyDto.audio_and_transcript) {
      this.logger.warn(
        `audio retention requested but unavailable; normalized to transcript_only ` +
          `tenant=${tenantId} user=${userId}`,
      );
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.create({
        data: {
          tenantId,
          createdBy: userId,
          title: dto.title,
          sourceType: dto.sourceType,
          // Browser-tab audio is the only active capture implementation. Older
          // clients may still send stream_url/upload/bridge enum values; normalize
          // them instead of persisting metadata the room cannot honor.
          audioSource: LiveHearingAudioSourceDto.browser_mic,
          sourceUrl: dto.sourceUrl?.trim() || null,
          recordingPolicy,
          consentStatus,
          // Persist the full attestation + who/when for PRIVATE sessions (P8/D11
          // compliance record). Public proceedings store nothing here.
          consentAttestation: isPrivate ? attestation! : null,
          attestedBy: isPrivate ? userId : null,
          attestedAt: isPrivate ? new Date() : null,
          clientId: dto.clientId ?? null,
          matterId: dto.matterId ?? null,
          hearingId: dto.hearingId ?? null,
          committeeId: dto.committeeId ?? null,
          issueIds: dto.issueIds ?? [],
          billIds: dto.billIds ?? [],
          programElementIds: dto.programElementIds ?? [],
          agencyIds: dto.agencyIds ?? [],
        },
      }),
    );
  }

  /** Internal tenant-only read after a caller has already been authorized. */
  async getOwned(tenantId: string, sessionId: string) {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({ where: { id: sessionId, tenantId } }),
    );
    if (!session) throw new NotFoundException('Live hearing session not found');
    return session;
  }

  /**
   * User-facing read: public proceedings are firm-visible; private sessions are
   * visible only to their creator. A denied row is deliberately non-enumerating.
   */
  async getAccessible(tenantId: string, sessionId: string, userId: string) {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({
        where: {
          id: sessionId,
          tenantId,
          OR: [
            { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
            { createdBy: userId },
          ],
        },
      }),
    );
    if (!session) throw new NotFoundException('Live hearing session not found');
    return session;
  }

  /** Legacy bounded array response retained for existing callers. */
  async list(tenantId: string, userId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findMany({
        where: {
          tenantId,
          OR: [
            { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
            { createdBy: userId },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  /**
   * Paginated My Sessions history. The old list endpoint silently stopped at
   * 100 rows, so a mature workspace could no longer reach older transcripts.
   * This uses the exact same public-vs-private visibility predicate as list()
   * and returns a truthful total plus an offset cursor for the web's Load More.
   */
  async listPage(
    tenantId: string,
    userId: string,
    opts?: { offset?: number; limit?: number },
  ) {
    const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
    const limit = Math.min(Math.max(Math.floor(opts?.limit ?? 50), 1), 100);
    const where = {
      tenantId,
      OR: [
        { sourceType: { in: [...PUBLIC_SOURCE_TYPES] } },
        { createdBy: userId },
      ],
    };
    const [items, total] = await this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.liveHearingSession.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: offset,
          take: limit,
        }),
        tx.liveHearingSession.count({ where }),
      ]),
    );
    const nextOffset = offset + items.length;
    return {
      items,
      total,
      nextOffset: nextOffset < total ? nextOffset : null,
      hasMore: nextOffset < total,
    };
  }

  /** Confirm consent (needs_review -> confirmed). Persists the attestation. */
  async confirmConsent(
    tenantId: string,
    sessionId: string,
    userId: string,
    attestation: string,
  ) {
    const session = await this.getAccessible(tenantId, sessionId, userId);
    if (session.consentStatus === 'not_required') return session;
    const normalized = attestation.trim();
    if (!normalized) throw new BadRequestException('Consent attestation is required');
    // Log truncated only; persist the full attestation as the durable record.
    this.logger.log(
      `consent confirmed session=${sessionId} tenant=${tenantId} user=${userId} ` +
        `attestation="${normalized.slice(0, 80)}"`,
    );
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.update({
        where: { id: sessionId },
        data: {
          consentStatus: 'confirmed',
          consentAttestation: normalized,
          attestedBy: userId,
          attestedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Guard: capture may start only when consent is satisfied. Throws 403 if the
   * session still needs review, 404 if this user cannot see it. Returns the
   * session when allowed. `userId` is omitted only for internal re-reads by a
   * caller that has ALREADY proven the user's access.
   */
  async assertCaptureAllowed(tenantId: string, sessionId: string, userId?: string) {
    const session = userId
      ? await this.getAccessible(tenantId, sessionId, userId)
      : await this.getOwned(tenantId, sessionId);
    if (session.consentStatus === 'needs_review') {
      throw new ForbiddenException(
        'Consent required before recording (consent_status=needs_review)',
      );
    }
    return session;
  }

  /**
   * Atomically claim one active browser capture across every intel-api replica.
   * The `paused` state is an active lease that has not received audio yet.
   */
  async claimCapture(tenantId: string, sessionId: string): Promise<HearingCaptureClaim | null> {
    await this.assertCaptureAllowed(tenantId, sessionId);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ started_at: Date }>>`
        UPDATE intel_live_hearing_session
        SET status = 'paused',
            started_at = now(),
            ended_at = NULL,
            updated_at = now()
        WHERE id = ${sessionId}
          AND tenant_id = ${tenantId}
          AND (
            status NOT IN ('live', 'paused')
            OR updated_at < now() - (${CAPTURE_LEASE_STALE_MS} * interval '1 millisecond')
          )
        RETURNING started_at
      `,
    );
    const row = rows[0];
    return row ? { startedAt: row.started_at } : null;
  }

  /** Promote the owned preparation lease to live on the first audio frame. */
  async activateCapture(
    tenantId: string,
    sessionId: string,
    claimStartedAt: Date,
  ): Promise<boolean> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        UPDATE intel_live_hearing_session
        SET status = 'live', updated_at = now()
        WHERE id = ${sessionId}
          AND tenant_id = ${tenantId}
          AND status = 'paused'
          AND started_at = ${claimStartedAt}
        RETURNING id
      `,
    );
    return rows.length === 1;
  }

  /** Renew only the claim that owns this exact started_at token. */
  async heartbeatCapture(
    tenantId: string,
    sessionId: string,
    claimStartedAt: Date,
  ): Promise<boolean> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        UPDATE intel_live_hearing_session
        SET updated_at = now()
        WHERE id = ${sessionId}
          AND tenant_id = ${tenantId}
          AND status IN ('paused', 'live')
          AND started_at = ${claimStartedAt}
        RETURNING id
      `,
    );
    return rows.length === 1;
  }

  /**
   * Release only the caller's own claim. A stale socket cannot end a replacement
   * capture because its started_at token no longer matches.
   */
  async releaseCapture(
    tenantId: string,
    sessionId: string,
    claimStartedAt: Date,
    outcome: 'ended' | 'failed',
  ): Promise<boolean> {
    const rows =
      outcome === 'failed'
        ? await this.prisma.withTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<{ id: string }>>`
              UPDATE intel_live_hearing_session
              SET status = 'failed', ended_at = now(), updated_at = now()
              WHERE id = ${sessionId}
                AND tenant_id = ${tenantId}
                AND started_at = ${claimStartedAt}
              RETURNING id
            `,
          )
        : await this.prisma.withTenant(tenantId, (tx) =>
            tx.$queryRaw<Array<{ id: string }>>`
              UPDATE intel_live_hearing_session
              SET status = 'ended', ended_at = now(), updated_at = now()
              WHERE id = ${sessionId}
                AND tenant_id = ${tenantId}
                AND started_at = ${claimStartedAt}
              RETURNING id
            `,
          );
    return rows.length === 1;
  }

  /** Compatibility helper retained for non-live lifecycle callers. */
  async markStatus(
    tenantId: string,
    sessionId: string,
    status: string,
    patch?: { startedAt?: Date; endedAt?: Date },
  ) {
    await this.getOwned(tenantId, sessionId);
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.update({
        where: { id: sessionId },
        data: {
          status: status as never,
          ...(patch?.startedAt ? { startedAt: patch.startedAt } : {}),
          ...(patch?.endedAt ? { endedAt: patch.endedAt } : {}),
        },
      }),
    );
  }
}
