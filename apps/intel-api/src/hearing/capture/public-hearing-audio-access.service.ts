import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { WorkspaceTenantContext } from '../../auth/tenant-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  FeatureFlagService,
  HEARING_RECORDING_FEATURE,
} from '../../feature-flags/feature-flag.service.js';
import { RecordingStorageService } from '../recording/recording-storage.service.js';
import { globalPublicAudioSource } from './global-public-audio-policy.js';

@Injectable()
export class PublicHearingAudioAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly storage: RecordingStorageService,
  ) {}
  private async sources(ctx: WorkspaceTenantContext, hearingId: string) {
    if (!(await this.flags.isEnabled(HEARING_RECORDING_FEATURE, ctx.tenantId)))
      throw new NotFoundException('Recording unavailable');
    const global = await this.prisma.withSystem((tx) =>
      globalPublicAudioSource(tx, hearingId, {
        tenantId: ctx.tenantId,
        clerkUserId: ctx.clerkUserId,
      }),
    );
    if (global) return [{ source_url: global.sourceUrl }];
    return this.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{ source_url: string }>
      >`SELECT DISTINCT p.source_url FROM intel_hearing_media_permission p
      JOIN committee_hearing h ON h.id=p.hearing_id AND h.visibility='public' AND h.url=p.source_url
      JOIN tenant_memberships tm ON tm.tenant_id::text=p.tenant_id AND tm.status::text='active'
      JOIN users u ON u.id=tm.user_id AND u.clerk_user_id=${ctx.clerkUserId}
      WHERE p.tenant_id=${ctx.tenantId} AND p.hearing_id=${hearingId} AND p.mode='server'
        AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp() AND p.operations @> ARRAY['retention']::text[]`,
    );
  }
  async manifest(ctx: WorkspaceTenantContext, hearingId: string) {
    const sources = (await this.sources(ctx, hearingId)).map((r) => r.source_url);
    if (!sources.length) throw new ForbiddenException('Source recording access unavailable');
    const epochs = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{
          id: string;
          startMs: bigint;
          durableEndMs: bigint;
          durableBytes: bigint;
          state: string;
          transcriptState: string;
          expiresAt: Date;
          reason: string | null;
        }>
      >`
      SELECT id,start_ms AS "startMs",durable_end_ms AS "durableEndMs",durable_bytes AS "durableBytes",state,transcript_state AS "transcriptState",expires_at AS "expiresAt",reason
      FROM intel_public_hearing_audio_epoch WHERE hearing_id=${hearingId} AND source_url=ANY(${sources}::text[]) ORDER BY created_at LIMIT 50`,
    );
    return {
      hearingId,
      mode: 'server',
      format: 'audio/wav',
      epochs: epochs.map((e) => ({
        ...e,
        startMs: Number(e.startMs),
        durableEndMs: Number(e.durableEndMs),
        durableBytes: Number(e.durableBytes),
        state: e.expiresAt <= new Date() ? 'expired' : e.state,
      })),
    };
  }
  async playback(
    ctx: WorkspaceTenantContext,
    hearingId: string,
    epochId: string,
    positionMs: number,
  ) {
    if (!Number.isSafeInteger(positionMs) || positionMs < 0 || positionMs > 24 * 3600000)
      throw new BadRequestException('Valid audio position required');
    const sources = (await this.sources(ctx, hearingId)).map((r) => r.source_url);
    const rows = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{
          id: string;
          object_key: string;
          start_ms: bigint;
          end_ms: bigint;
          expires_at: Date;
        }>
      >`
      SELECT p.id,p.object_key,p.start_ms,p.end_ms,e.expires_at FROM intel_public_hearing_audio_part p
      JOIN intel_public_hearing_audio_epoch e ON e.id=p.epoch_id WHERE e.id=${epochId} AND e.hearing_id=${hearingId}
        AND e.source_url=ANY(${sources}::text[]) AND e.expires_at>clock_timestamp() AND e.state<>'expired'
        AND p.start_ms<=${positionMs} AND p.end_ms>${positionMs} ORDER BY p.sequence LIMIT 1`,
    );
    const part = rows[0];
    if (!part) throw new NotFoundException('Saved audio is unavailable at this position');
    const seconds = Math.min(60, Math.floor((part.expires_at.getTime() - Date.now()) / 1000));
    if (seconds < 1) throw new NotFoundException('Saved audio expired');
    return {
      partId: part.id,
      startMs: Number(part.start_ms),
      endMs: Number(part.end_ms),
      url: await this.storage.playbackUrl(part.object_key, seconds, 'audio/wav'),
      expiresAt: new Date(Date.now() + seconds * 1000),
    };
  }
}
