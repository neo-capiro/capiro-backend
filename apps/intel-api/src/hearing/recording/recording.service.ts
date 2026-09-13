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
      if (!current.length) throw new NotFoundException('Recording access is unavailable');
      return fn(tx);
    });
  }

  async capability(tenantId: string, sessionId: string, userId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    const permission =
      session.recordingPolicy === 'no_storage'
        ? null
        : await this.permissions.find(tenantId, session);
    return {
      available: Boolean(permission),
      recordingPolicy: session.recordingPolicy,
      retentionDays: permission?.retentionDays ?? null,
      reason: permission
        ? null
        : 'Retained audio requires enabled storage and current source-specific permission',
    };
  }

  /** Explicit mutation before capture. Old sessions are never relabeled by a read. */
  async enable(tenantId: string, sessionId: string, userId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    if (session.createdBy !== userId || session.recordingPolicy === 'no_storage') {
      throw new BadRequestException('Only the creator can choose retention before recording');
    }
    await this.permissions.require(tenantId, session);
    const result = await this.actor(tenantId, userId, (tx) =>
      tx.liveHearingSession.updateMany({
        where: { tenantId, id: sessionId, createdBy: userId, status: 'scheduled', startedAt: null },
        data: { recordingPolicy: 'audio_and_transcript' },
      }),
    );
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
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    if (session.recordingPolicy !== 'audio_and_transcript')
      throw new BadRequestException('This session does not retain audio');
    const grant = await this.permissions.require(tenantId, session);
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
      const previous = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId, recordingId: recording.id },
        orderBy: { startMs: 'desc' },
      });
      if (previous?.captureToken.getTime() === captureToken.getTime()) {
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

  async append(capture: RecordingCapture, frame: Buffer) {
    const part = decodeRecordingFrame(frame);
    const { tenantId, userId, epochId } = capture;
    const checkpoint = await this.actor(tenantId, userId, async (tx) => {
      await this.lockCapture(tx, capture);
      const epoch = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId, id: epochId },
        include: { recording: { include: { session: true } } },
      });
      if (
        !epoch ||
        epoch.state !== 'recording' ||
        epoch.captureToken.getTime() !== capture.captureToken.getTime()
      ) {
        throw new ConflictException('Recording attempt is closed');
      }
      const grant = await tx.hearingMediaPermission.findFirst({
        where: { tenantId, id: epoch.recording.permissionId },
      });
      if (
        epoch.recording.expiresAt <= new Date() ||
        !grant ||
        !permissionAllowsRecording(grant, epoch.recording.session)
      ) {
        throw new ConflictException('Recording permission or retention expired');
      }
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
      if (!existing) assertPartOrder(epoch, part);
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
        !permissionAllowsRecording(currentGrant, currentRecording.session)
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
    const row = await this.actor(tenantId, userId, (tx) =>
      tx.hearingRecording.findFirst({
        where: { tenantId, sessionId },
        include: { epochs: { orderBy: { startMs: 'asc' } } },
      }),
    );
    if (!row) return { recording: null, recordingPolicy: session.recordingPolicy };
    const expired = row.expiresAt <= new Date() || row.state === 'expired';
    return {
      recordingPolicy: session.recordingPolicy,
      recording: {
        id: row.id,
        state: expired ? 'expired' : row.state,
        expiresAt: row.expiresAt,
        originAt: row.originAt,
        transcriptState: row.transcriptState,
        analysisState: row.analysisState,
        epochs: row.epochs.map((epoch) => ({
          id: epoch.id,
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
          playable: !expired && epoch.state === 'ready' && Boolean(epoch.artifactKey),
        })),
      },
    };
  }

  async playback(tenantId: string, sessionId: string, userId: string, epochId: string) {
    const session = await this.sessions.getAccessible(tenantId, sessionId, userId);
    const epoch = await this.actor(tenantId, userId, async (tx) => {
      const row = await tx.hearingRecordingEpoch.findFirst({
        where: { tenantId, id: epochId, recording: { tenantId, sessionId } },
        include: { recording: true },
      });
      if (!row) return null;
      const grant = await tx.hearingMediaPermission.findFirst({
        where: {
          tenantId,
          id: row.recording.permissionId,
          mode: 'browser',
          hearingId: session.hearingId,
          sourceUrl: session.sourceUrl ?? '',
          revokedAt: null,
          expiresAt: { gt: new Date() },
          operations: { has: 'retention' },
        },
      });
      return grant ? row : null;
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
      url: await this.storage.playbackUrl(epoch.artifactKey, ttl),
      expiresAt: new Date(Date.now() + ttl * 1000),
      epochId,
      startMs: epoch.startMs,
      durationMs: epoch.decodedDurationMs,
    };
  }
}
