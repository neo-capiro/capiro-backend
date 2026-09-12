import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  FeatureFlagService,
  HEARING_RECORDING_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { RecordingStorageService } from './recording-storage.service.js';
import { permissionAllowsRecording } from './recording-domain.js';

@Injectable()
export class RecordingPermissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly storage: RecordingStorageService,
  ) {}

  async find(tenantId: string, source: { sourceUrl?: string | null; hearingId?: string | null }) {
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
  ) {
    const grant = await this.find(tenantId, source);
    if (!grant)
      throw new ForbiddenException(
        'Audio retention requires enabled storage and current source-specific permission',
      );
    return grant;
  }
}
