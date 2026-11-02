import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  FeatureFlagService,
  HEARING_RECORDING_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { RecordingStorageService } from './recording-storage.service.js';
import { permissionAllowsRecording } from './recording-domain.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';

@Injectable()
export class RecordingPermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly storage: RecordingStorageService,
  ) {}

  async canEnablePublic(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
    if (!this.storage.enabled) return false;
    const rows = await tx.$queryRaw<Array<{ eligible: boolean }>>`
      SELECT public.public_hearing_browser_recording_eligible(${sessionId}) AS eligible`;
    return rows[0]?.eligible === true;
  }

  async enablePublic(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
    this.storage.assertReady();
    try {
      await tx.$queryRaw`SELECT public.enable_public_hearing_browser_recording(${sessionId})`;
    } catch (error) {
      if ((error as { meta?: { code?: string } }).meta?.code === '42501')
        throw new ForbiddenException('Public browser recording is unavailable for this source');
      throw error;
    }
  }

  async canEnableVideo(tx: Prisma.TransactionClient, sessionId: string): Promise<boolean> {
    if (!(await this.canEnablePublic(tx, sessionId))) return false;
    const rows = await tx.$queryRaw<Array<{ available: boolean }>>`SELECT
      to_regprocedure('public.enable_public_hearing_browser_video_recording(text)') IS NOT NULL AS available`;
    return rows[0]?.available === true;
  }

  async enableVideo(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
    this.storage.assertReady();
    if (!(await this.canEnableVideo(tx, sessionId)))
      throw new ForbiddenException('Video permission is unavailable for this source');
    await tx.$queryRaw`SELECT public.enable_public_hearing_browser_video_recording(${sessionId})`;
  }

  async find(
    tenantId: string,
    source: { sourceUrl?: string | null; hearingId?: string | null },
    video = false,
  ) {
    if (
      !this.storage.enabled ||
      !(await this.flags.isEnabled(HEARING_RECORDING_FEATURE, tenantId)) ||
      !source.sourceUrl
    )
      return null;
    const now = new Date();
    const grants = await this.prisma.withTenant(tenantId, (tx) =>
      tx.hearingMediaPermission.findMany({
        where: {
          tenantId,
          sourceUrl: source.sourceUrl!,
          hearingId: source.hearingId ?? null,
          mode: 'browser',
          revokedAt: null,
          expiresAt: { gt: now },
          ...(video ? { operations: { has: 'video_retention' } } : {}),
        },
        orderBy: { reviewedAt: 'desc' },
        take: 20,
      }),
    );
    return (
      grants.find((grant) =>
        permissionAllowsRecording(
          grant,
          { sourceUrl: source.sourceUrl ?? null, hearingId: source.hearingId ?? null },
          now,
        ),
      ) ?? null
    );
  }

  async require(
    tenantId: string,
    source: { sourceUrl?: string | null; hearingId?: string | null },
    video = false,
  ) {
    const grant = await this.find(tenantId, source, video);
    if (!grant)
      throw new ForbiddenException(
        'Audio retention requires enabled storage and current source-specific permission',
      );
    return grant;
  }
}
