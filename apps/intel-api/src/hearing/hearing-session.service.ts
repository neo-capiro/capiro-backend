import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateSessionDto } from './dto/session.dto.js';

/**
 * Live Hearing session lifecycle + tenant/user scoping.
 *
 * EVERY method filters by tenantId (the TenantGuard-resolved scope). Public
 * congressional hearing/markup default to consent_status=not_required; all
 * other source types default to needs_review and BLOCK capture until confirmed.
 */
@Injectable()
export class HearingSessionService {
  private readonly logger = new Logger(HearingSessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, userId: string, dto: CreateSessionDto) {
    const consentStatus =
      dto.sourceType === 'hearing' || dto.sourceType === 'markup' ? 'not_required' : 'needs_review';

    return this.prisma.liveHearingSession.create({
      data: {
        tenantId,
        createdBy: userId,
        title: dto.title,
        sourceType: dto.sourceType,
        audioSource: dto.audioSource,
        sourceUrl: dto.sourceUrl?.trim() || null,
        recordingPolicy: dto.recordingPolicy ?? 'transcript_only',
        consentStatus,
        clientId: dto.clientId ?? null,
        matterId: dto.matterId ?? null,
        hearingId: dto.hearingId ?? null,
        committeeId: dto.committeeId ?? null,
        issueIds: dto.issueIds ?? [],
        billIds: dto.billIds ?? [],
        programElementIds: dto.programElementIds ?? [],
        agencyIds: dto.agencyIds ?? [],
      },
    });
  }

  /** Tenant-scoped fetch; throws 404 if not found in this tenant. */
  async getOwned(tenantId: string, sessionId: string) {
    const session = await this.prisma.liveHearingSession.findFirst({
      where: { id: sessionId, tenantId },
    });
    if (!session) throw new NotFoundException('Live hearing session not found');
    return session;
  }

  async list(tenantId: string) {
    return this.prisma.liveHearingSession.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** Confirm consent (needs_review -> confirmed). Records the attestation. */
  async confirmConsent(tenantId: string, sessionId: string, userId: string, attestation: string) {
    const session = await this.getOwned(tenantId, sessionId);
    if (session.consentStatus === 'not_required') return session;
    this.logger.log(
      `consent confirmed session=${sessionId} tenant=${tenantId} user=${userId} attestation="${attestation.slice(0, 80)}"`,
    );
    return this.prisma.liveHearingSession.update({
      where: { id: sessionId },
      data: { consentStatus: 'confirmed' },
    });
  }

  /**
   * Guard: capture may start only when consent is satisfied. Throws 403 if the
   * session still needs review. Returns the session when allowed.
   */
  async assertCaptureAllowed(tenantId: string, sessionId: string) {
    const session = await this.getOwned(tenantId, sessionId);
    if (session.consentStatus === 'needs_review') {
      throw new ForbiddenException('Consent required before recording (consent_status=needs_review)');
    }
    return session;
  }

  async markStatus(tenantId: string, sessionId: string, status: string, patch?: { startedAt?: Date; endedAt?: Date }) {
    await this.getOwned(tenantId, sessionId);
    return this.prisma.liveHearingSession.update({
      where: { id: sessionId },
      data: {
        status: status as never,
        ...(patch?.startedAt ? { startedAt: patch.startedAt } : {}),
        ...(patch?.endedAt ? { endedAt: patch.endedAt } : {}),
      },
    });
  }
}
