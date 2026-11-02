import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../../generated/prisma-client/index.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CAPTURE_LEASE_STALE_MS, HearingSessionService } from '../hearing-session.service.js';
import { RecordingPermissionService } from './recording-permission.service.js';
import { RecordingStorageService } from './recording-storage.service.js';
import {
  MAX_RECORDING_BYTES,
  VIDEO_RECORDING_MIME,
  recordingContentType,
} from './recording-media.js';
import {
  assertPartOrder,
  decodeRecordingFrame,
  permissionAllowsRecording,
} from './recording-domain.js';

export interface RecordingCapture {
  tenantId: string;
  userId: string;
  sessionId: string;
  captureToken: Date;
  recordingId: string;
  epochId: string;
  startMs: number;
}

@Injectable()
export class HearingRecordingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: HearingSessionService,
    private readonly permissions: RecordingPermissionService,
    private readonly storage: RecordingStorageService,
  ) {}

  private actor<T>(
    tenantId: string,
    userId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ) {
    return this.prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.hearing_actor', ${userId}, true)`;
      const current = await tx.$queryRaw<Array<{ id: string }>>`SELECT u.id::text AS id FROM users u
        JOIN tenant_memberships m ON m.user_id=u.id AND m.tenant_id=${tenantId}::uuid AND m.status::text='active'
        JOIN intel_feature_flag f ON f.tenant_id=${tenantId} AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
        WHERE u.clerk_user_id=${userId} FOR SHARE OF m,f`;
      if (!current.length)
        throw new NotFoundException({
          code: 'RECORDING_ACCESS_UNAVAILABLE',
          message:
            'Recording access is unavailable. A tenant administrator must check active membership and saved-audio access.',
        });
      return fn(tx);
    });
  }

  async capability(tenantId: string, sessionId: string, userId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    let canEnablePublic = false;
    let canEnableVideo = false;
    try {
      // Match the capture/manifest actor policy before offering an enable action.
      // A visible transcript alone does not grant retained-media access.
      canEnablePublic = await this.actor(tenantId, userId, (tx) =>
        this.permissions.canEnablePublic(tx, sessionId),
      );
      canEnableVideo =
        canEnablePublic &&
        (await this.actor(tenantId, userId, (tx) =>
          this.permissions.canEnableVideo(tx, sessionId),
        ));
    } catch (error) {
      if (
        error instanceof NotFoundException &&
        (error.getResponse() as { code?: string }).code === 'RECORDING_ACCESS_UNAVAILABLE'
      )
        return {
          available: false,
          recordingPolicy: session.recordingPolicy,
          retentionDays: null,
          reason:
            'Saved-audio access is unavailable. Ask a tenant administrator to check your active membership and saved-audio access.',
          code: 'RECORDING_ACCESS_UNAVAILABLE',
        };
      throw error;
    }
    const permission =
      session.recordingPolicy === 'no_storage'
        ? null
        : await this.permissions.find(tenantId, session);
    const videoPermission =
      session.recordingPolicy === 'no_storage'
        ? null
        : await this.permissions.find(tenantId, session, true);
    return {
      available: Boolean(permission) || canEnablePublic,
      recordingProtocols: [1, 2],
      videoMimeType: VIDEO_RECORDING_MIME,
      videoAvailable: Boolean(videoPermission?.operations.includes('video_retention')),
      canEnableVideo,
      maxRecordingBytes: MAX_RECORDING_BYTES,
      recordingPolicy: session.recordingPolicy,
      retentionDays: permission?.retentionDays ?? (canEnablePublic ? 30 : null),
      reason:
        permission || canEnablePublic
          ? null
          : 'Retained audio requires enabled storage and current source-specific permission',
    };
  }

  /** Explicit mutation before capture. Old sessions are never relabeled by a read. */
  async enable(tenantId: string, sessionId: string, userId: string, video = false) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    if (session.createdBy !== userId || session.recordingPolicy === 'no_storage') {
      throw new BadRequestException('Only the creator can choose retention before recording');
    }
    this.storage.assertReady();
    const permission = await this.permissions.find(tenantId, session);
    const result = await this.actor(tenantId, userId, async (tx) => {
      if (video) await this.permissions.enableVideo(tx, sessionId);
      else if (!permission) await this.permissions.enablePublic(tx, sessionId);
      return tx.liveHearingSession.updateMany({
        where: { tenantId, id: sessionId, createdBy: userId, status: 'scheduled', startedAt: null },
        data: { recordingPolicy: 'audio_and_transcript' },
      });
    });
    if (result.count !== 1)
      throw new ConflictException('Retention must be selected before the first capture');
    return { recordingPolicy: 'audio_and_transcript' };
  }

  async begin(
    tenantId: string,
    sessionId: string,
    userId: string,
    captureToken: Date,
    mimeType: string,
  ): Promise<RecordingCapture> {
    recordingContentType(mimeType);
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    // An expired live-channel binding cannot start another capture. Playback
    // remains governed by the original retained-media grant and retention.
    await this.sessions.assertCaptureSourceAllowed(tenantId, session.hearingId, session.sourceUrl);
    if (session.recordingPolicy !== 'audio_and_transcript')
      throw new BadRequestException('This session does not retain audio');
    const video = mimeType === VIDEO_RECORDING_MIME;
    const grant = await this.permissions.require(tenantId, session, video);
    if (video && !grant.operations.includes('video_retention'))
      throw new BadRequestException('Video requires an explicit video retention grant');
    const now = new Date();
    return this.actor(tenantId, userId, async (tx) => {
      await this.lockCapture(tx, { tenantId, sessionId, captureToken });
      let recording = await tx.hearingRecording.findFirst({ where: { tenantId, sessionId } });
      if (!recording)
        recording = await tx.hearingRecording.create({
          data: {
            tenantId,
            sessionId,
            permissionId: grant.id,
            permissionSnapshot: {
              id: grant.id,
              sourceUrl: grant.sourceUrl,
              hearingId: grant.hearingId,
              operations: grant.operations,
              reviewedAt: grant.reviewedAt.toISOString(),
              evidence: grant.evidence,
              retentionDays: grant.retentionDays,
            },
            originAt: now,
            expiresAt: new Date(
              Math.min(grant.expiresAt.getTime(), now.getTime() + grant.retentionDays * 86400_000),
            ),
          },
        });
      if (recording.expiresAt <= now || recording.state === 'expired')
        throw new ConflictException('Recording retention has expired');
      if (video) {
        const originalGrant = await tx.hearingMediaPermission.findFirst({
          where: { tenantId, id: recording.permissionId },
        });
        if (
          !originalGrant?.operations.includes('video_retention') ||
          !permissionAllowsRecording(originalGrant, session)
        )
          throw new ConflictException(
            'This recording has no original video permission; its identity was preserved',
          );
      }
      const previous = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId, recordingId: recording.id },
        orderBy: { startMs: 'desc' },
      });
      if (previous?.captureToken.getTime() === captureToken.getTime()) {
        if (previous.mimeType !== mimeType)
          throw new ConflictException('Recording media negotiation changed');
        return {
          tenantId,
          userId,
          sessionId,
          captureToken,
          recordingId: recording.id,
          epochId: previous.id,
          startMs: previous.startMs,
        };
      }
      // Recover abandoned attempts without claiming an acknowledged final tail.
      await tx.hearingRecordingEpoch.updateMany({
        where: { tenantId, recordingId: recording.id, state: 'recording' },
        data: {
          state: 'queued',
          complete: false,
          transcriptState: 'partial',
          reason: 'capture_interrupted',
        },
      });
      const startMs = Math.max(
        now.getTime() - recording.originAt.getTime(),
        previous?.durableEndMs ?? 0,
      );
      const epoch = await tx.hearingRecordingEpoch.create({
        data: {
          tenantId,
          recordingId: recording.id,
          captureToken,
          mimeType,
          startMs,
          durableEndMs: startMs,
        },
      });
      await tx.hearingRecording.updateMany({
        where: { tenantId, id: recording.id },
        data: { state: 'recording', finalizedAt: null, transcriptState: 'streaming' },
      });
      return {
        tenantId,
        userId,
        sessionId,
        captureToken,
        recordingId: recording.id,
        epochId: epoch.id,
        startMs,
      };
    });
  }

  private async lockCapture(
    tx: Prisma.TransactionClient,
    capture: Pick<RecordingCapture, 'tenantId' | 'sessionId' | 'captureToken'>,
  ) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM intel_live_hearing_session
      WHERE tenant_id=${capture.tenantId} AND id=${capture.sessionId}
        AND started_at=${capture.captureToken} AND status IN ('paused','live')
        AND recording_policy='audio_and_transcript'
        AND updated_at > now() - (${CAPTURE_LEASE_STALE_MS} * interval '1 millisecond')
      FOR UPDATE`;
    if (!rows.length) throw new ConflictException('Recording capture lease is no longer owned');
  }

  private async activeEpoch(tx: Prisma.TransactionClient, capture: RecordingCapture) {
    await this.lockCapture(tx, capture);
    const epoch = await tx.hearingRecordingEpoch.findFirst({
      where: { tenantId: capture.tenantId, id: capture.epochId },
      include: { recording: { include: { session: true } } },
    });
    if (
      !epoch ||
      epoch.state !== 'recording' ||
      epoch.recordingId !== capture.recordingId ||
      epoch.recording.sessionId !== capture.sessionId ||
      epoch.captureToken.getTime() !== capture.captureToken.getTime()
    )
      throw new ConflictException('Recording attempt is closed');
    const grant = await tx.hearingMediaPermission.findFirst({
      where: { tenantId: capture.tenantId, id: epoch.recording.permissionId },
    });
    if (
      epoch.recording.expiresAt <= new Date() ||
      !grant ||
      !permissionAllowsRecording(grant, epoch.recording.session) ||
      (epoch.mimeType === VIDEO_RECORDING_MIME && !grant.operations.includes('video_retention'))
    )
      throw new ConflictException('Recording permission or retention expired');
    return epoch;
  }

  /** The non-retained audio lane uses the same original grant and epoch as AV. */
  async authorizeTranscription(capture: RecordingCapture) {
    await this.actor(capture.tenantId, capture.userId, async (tx) => {
      const epoch = await this.activeEpoch(tx, capture);
      if (epoch.mimeType !== VIDEO_RECORDING_MIME)
        throw new BadRequestException('Separate transcription requires a video epoch');
    });
  }

  async append(capture: RecordingCapture, frame: Buffer) {
    const magic = frame.toString('ascii', 0, 4) === 'LWV5' ? 'LWV5' : 'LWA4';
    const part = decodeRecordingFrame(frame, magic);
    const { tenantId, userId, epochId } = capture;
    const checkpoint = await this.actor(tenantId, userId, async (tx) => {
      const epoch = await this.activeEpoch(tx, capture);
      if ((epoch.mimeType === VIDEO_RECORDING_MIME) !== (magic === 'LWV5'))
        throw new BadRequestException('Frame lane does not match recording media');
      const existing = await tx.hearingRecordingPart.findFirst({
        where: { tenantId, epochId, sequence: part.sequence },
      });
      if (
        existing &&
        (existing.sha256 !== part.sha256 ||
          existing.endMs !== part.endMs ||
          existing.byteLength !== part.bytes.length)
      ) {
        throw new ConflictException('Conflicting audio part');
      }
      if (!existing) {
        assertPartOrder(epoch, part);
        if (epoch.durableBytes + BigInt(part.bytes.length) > BigInt(MAX_RECORDING_BYTES))
          throw new BadRequestException('Recording reached its 1 GiB media limit');
      }
      return { epoch, existing };
    });
    if (checkpoint.existing)
      return {
        sequence: part.sequence,
        durableBytes: Number(checkpoint.epoch.durableBytes),
        durableEndMs: checkpoint.epoch.durableEndMs,
        duplicate: true,
      };
    if (
      part.sequence === 0 &&
      !part.bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    ) {
      throw new BadRequestException(
        'A fresh recording attempt must begin with WebM initialization',
      );
    }
    const key = `hearing-audio/${tenantId}/${capture.recordingId}/${epochId}/parts/${part.sequence}-${part.sha256}`;
    // Never hold a database transaction open during storage I/O. A failed manifest
    // commit leaves this immutable object retryable, but sends NO durable ack.
    await this.storage.put(key, part.bytes, part.bytes.length, part.sha256);
    return this.actor(tenantId, userId, async (tx) => {
      await this.lockCapture(tx, capture);
      const currentRecording = await tx.hearingRecording.findFirst({
        where: { tenantId, id: capture.recordingId },
        include: { session: true },
      });
      if (currentRecording)
        await tx.$queryRaw`SELECT id FROM intel_hearing_media_permission
        WHERE tenant_id=${tenantId} AND id=${currentRecording.permissionId} FOR SHARE`;
      const currentGrant =
        currentRecording &&
        (await tx.hearingMediaPermission.findFirst({
          where: { tenantId, id: currentRecording.permissionId },
        }));
      if (
        !currentRecording ||
        currentRecording.expiresAt <= new Date() ||
        !currentGrant ||
        !permissionAllowsRecording(currentGrant, currentRecording.session) ||
        (magic === 'LWV5' && !currentGrant.operations.includes('video_retention'))
      ) {
        throw new ConflictException('Recording permission or retention expired during save');
      }
      const epoch = await tx.hearingRecordingEpoch.findFirst({ where: { tenantId, id: epochId } });
      if (!epoch || epoch.state !== 'recording')
        throw new ConflictException('Recording attempt is closed');
      const existing = await tx.hearingRecordingPart.findFirst({
        where: { tenantId, epochId, sequence: part.sequence },
      });
      if (existing) {
        if (existing.sha256 !== part.sha256 || existing.endMs !== part.endMs)
          throw new ConflictException('Conflicting audio part');
        return {
          sequence: part.sequence,
          durableBytes: Number(epoch.durableBytes),
          durableEndMs: epoch.durableEndMs,
          duplicate: true,
        };
      }
      assertPartOrder(epoch, part);
      if (epoch.durableBytes + BigInt(part.bytes.length) > BigInt(MAX_RECORDING_BYTES))
        throw new BadRequestException('Recording reached its 1 GiB media limit');
      await tx.hearingRecordingPart.create({
        data: {
          tenantId,
          epochId,
          sequence: part.sequence,
          endMs: part.endMs,
          sha256: part.sha256,
          byteLength: part.bytes.length,
          objectKey: key,
        },
      });
      const saved = await tx.hearingRecordingEpoch.update({
        where: { id: epochId, tenantId },
        data: {
          durableSequence: part.sequence,
          durableEndMs: capture.startMs + part.endMs,
          durableBytes: { increment: part.bytes.length },
        },
      });
      return {
        sequence: part.sequence,
        durableBytes: Number(saved.durableBytes),
        durableEndMs: saved.durableEndMs,
        duplicate: false,
      };
    });
  }

  async markTranscriptPartial(capture: RecordingCapture) {
    return this.actor(capture.tenantId, capture.userId, async (tx) => {
      await this.lockCapture(tx, capture);
      const changed = await tx.hearingRecordingEpoch.updateMany({
        where: {
          tenantId: capture.tenantId,
          id: capture.epochId,
          captureToken: capture.captureToken,
          state: 'recording',
        },
        data: { transcriptState: 'partial', transcriptRecoveryState: 'pending' },
      });
      if (changed.count)
        await tx.hearingRecording.updateMany({
          where: { tenantId: capture.tenantId, id: capture.recordingId },
          data: { transcriptState: 'partial' },
        });
    });
  }

  async seal(
    capture: RecordingCapture,
    finalSequence: number | undefined,
    reason: string | undefined,
    transcriptFailed: boolean,
    analysisPending: boolean,
  ) {
    return this.actor(capture.tenantId, capture.userId, async (tx) => {
      await this.lockCapture(tx, capture);
      const epoch = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId: capture.tenantId, id: capture.epochId },
      });
      if (!epoch || epoch.state !== 'recording') return;
      const complete =
        !reason &&
        Number.isInteger(finalSequence) &&
        finalSequence === epoch.durableSequence &&
        finalSequence! >= 0;
      await tx.hearingRecordingEpoch.updateMany({
        where: { tenantId: capture.tenantId, id: capture.epochId, state: 'recording' },
        data: {
          state: 'queued',
          complete,
          expectedFinalSequence: finalSequence ?? null,
          transcriptState: transcriptFailed || !complete ? 'partial' : 'finalized',
          transcriptRecoveryState: transcriptFailed ? 'pending' : 'none',
          reason: complete ? null : (reason ?? 'unconfirmed_final_tail'),
        },
      });
      const earlierPartial = await tx.hearingRecordingEpoch.count({
        where: {
          tenantId: capture.tenantId,
          recordingId: capture.recordingId,
          transcriptState: 'partial',
        },
      });
      await tx.hearingRecording.updateMany({
        where: { tenantId: capture.tenantId, id: capture.recordingId },
        data: {
          state: 'processing',
          finalizedAt: new Date(),
          transcriptState: earlierPartial ? 'partial' : 'finalized',
          analysisState: analysisPending ? 'pending' : 'ready',
        },
      });
    });
  }

  async manifest(tenantId: string, sessionId: string, userId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    if (session.recordingPolicy !== 'audio_and_transcript')
      return { recording: null, recordingPolicy: session.recordingPolicy };
    const { row, permissionAvailable, videoPermissionAvailable } = await this.actor(
      tenantId,
      userId,
      async (tx) => {
        const row = await tx.hearingRecording.findFirst({
          where: { tenantId, sessionId },
          include: { epochs: { orderBy: { startMs: 'asc' } } },
        });
        const permission =
          row && (await this.retentionPermission(tx, tenantId, session, row.permissionId));
        return {
          row,
          permissionAvailable: Boolean(permission),
          videoPermissionAvailable: Boolean(permission?.operations.includes('video_retention')),
        };
      },
    );
    if (!row) return { recording: null, recordingPolicy: session.recordingPolicy };
    const expired = row.expiresAt <= new Date() || row.state === 'expired';
    return {
      recordingPolicy: session.recordingPolicy,
      recording: {
        id: row.id,
        state: expired ? 'expired' : row.state,
        playbackAvailability: expired
          ? 'expired'
          : permissionAvailable
            ? 'available'
            : 'permission_unavailable',
        expiresAt: row.expiresAt,
        originAt: row.originAt,
        transcriptState: row.transcriptState,
        analysisState: row.analysisState,
        epochs: row.epochs.map((epoch) => ({
          id: epoch.id,
          mimeType: recordingContentType(epoch.mimeType),
          startMs: epoch.startMs,
          durableEndMs: epoch.durableEndMs,
          transcriptState: epoch.transcriptState,
          transcriptRecoveryState: epoch.transcriptRecoveryState,
          durableSequence: epoch.durableSequence,
          durableBytes: Number(epoch.durableBytes),
          state: expired ? 'expired' : epoch.state,
          complete: epoch.complete,
          reason: epoch.reason,
          decodedDurationMs: epoch.decodedDurationMs,
          playable:
            !expired &&
            permissionAvailable &&
            (epoch.mimeType !== VIDEO_RECORDING_MIME || videoPermissionAvailable) &&
            epoch.state === 'ready' &&
            Boolean(epoch.artifactKey),
        })),
      },
    };
  }

  private retentionPermission(
    tx: Prisma.TransactionClient,
    tenantId: string,
    session: { hearingId: string | null; sourceUrl: string | null },
    permissionId: string,
  ) {
    return tx.hearingMediaPermission.findFirst({
      where: {
        tenantId,
        id: permissionId,
        mode: 'browser',
        hearingId: session.hearingId,
        sourceUrl: session.sourceUrl ?? '',
        revokedAt: null,
        expiresAt: { gt: new Date() },
        operations: { has: 'retention' },
      },
    });
  }

  async playback(tenantId: string, sessionId: string, userId: string, epochId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    const epoch = await this.actor(tenantId, userId, async (tx) => {
      const row = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId, id: epochId, recording: { tenantId, sessionId } },
        include: { recording: true },
      });
      if (!row) return null;
      const grant = await this.retentionPermission(
        tx,
        tenantId,
        session,
        row.recording.permissionId,
      );
      return grant &&
        (row.mimeType !== VIDEO_RECORDING_MIME || grant.operations.includes('video_retention'))
        ? row
        : null;
    });
    if (
      !epoch?.artifactKey ||
      epoch.state !== 'ready' ||
      epoch.recording.state === 'expired' ||
      epoch.recording.expiresAt <= new Date()
    ) {
      throw new NotFoundException('Retained audio is unavailable');
    }
    const ttl = Math.min(60, Math.floor((epoch.recording.expiresAt.getTime() - Date.now()) / 1000));
    if (ttl < 1) throw new NotFoundException('Retained audio has expired');
    return {
      url: await this.storage.playbackUrl(
        epoch.artifactKey,
        ttl,
        recordingContentType(epoch.mimeType),
      ),
      mimeType: recordingContentType(epoch.mimeType),
      expiresAt: new Date(Date.now() + ttl * 1000),
      epochId,
      startMs: epoch.startMs,
      durationMs: epoch.decodedDurationMs,
    };
  }
}
