import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateSessionDto, LiveHearingSourceTypeDto } from './dto/session.dto.js';

/**
 * Live Hearing session lifecycle + tenant/user scoping.
 *
 * EVERY method filters by tenantId (the TenantGuard-resolved scope).
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

  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, userId: string, dto: CreateSessionDto) {
    const isPrivate = HearingSessionService.requiresConsent(dto.sourceType);
    const attestation = dto.consentAttestation?.trim();

    // Server-side enforcement (D11): a PRIVATE session requires an attestation.
    if (isPrivate && !attestation) {
      throw new BadRequestException(
        'Consent attestation required for a private session (meeting/webinar/agency_session)',
      );
    }

    // Public → not_required; private (with attestation) → confirmed up front.
    const consentStatus = isPrivate ? 'confirmed' : 'not_required';
    if (isPrivate) {
      // Log truncated only — the FULL attestation is persisted below (durable,
      // queryable compliance artifact), so we don't emit the full text to logs.
      this.logger.log(
        `consent attested at create session-type=${dto.sourceType} tenant=${tenantId} user=${userId} attestation="${attestation!.slice(0, 80)}"`,
      );
    }

    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.create({
        data: {
          tenantId,
          createdBy: userId,
          title: dto.title,
          sourceType: dto.sourceType,
          audioSource: dto.audioSource,
          sourceUrl: dto.sourceUrl?.trim() || null,
          recordingPolicy: dto.recordingPolicy ?? 'transcript_only',
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

  /** Tenant-scoped fetch; throws 404 if not found in this tenant. */
  async getOwned(tenantId: string, sessionId: string) {
    const session = await this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findFirst({
        where: { id: sessionId, tenantId },
      }),
    );
    if (!session) throw new NotFoundException('Live hearing session not found');
    return session;
  }

  async list(tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  }

  /** Confirm consent (needs_review -> confirmed). Persists the attestation. */
  async confirmConsent(tenantId: string, sessionId: string, userId: string, attestation: string) {
    const session = await this.getOwned(tenantId, sessionId);
    if (session.consentStatus === 'not_required') return session;
    // Log truncated only; persist the full attestation as the durable record.
    this.logger.log(
      `consent confirmed session=${sessionId} tenant=${tenantId} user=${userId} attestation="${attestation.slice(0, 80)}"`,
    );
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.liveHearingSession.update({
        where: { id: sessionId },
        data: {
          consentStatus: 'confirmed',
          consentAttestation: attestation,
          attestedBy: userId,
          attestedAt: new Date(),
        },
      }),
    );
  }

  /**
   * Guard: capture may start only when consent is satisfied. Throws 403 if the
   * session still needs review. Returns the session when allowed.
   */
  async assertCaptureAllowed(tenantId: string, sessionId: string) {
    const session = await this.getOwned(tenantId, sessionId);
    if (session.consentStatus === 'needs_review') {
      throw new ForbiddenException(
        'Consent required before recording (consent_status=needs_review)',
      );
    }
    return session;
  }

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
