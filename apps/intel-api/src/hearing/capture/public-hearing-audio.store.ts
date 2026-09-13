import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { RecordingStorageService } from '../recording/recording-storage.service.js';
import { retryableRecordingFailure } from '../recording/recording-domain.js';
import { approvedPublicCapture, publicAudioEnabled } from './public-capture-permission.js';

export interface PublicAudioAttempt {
  id: string;
  captureId: string;
  hearingId: string;
  sourceUrl: string;
  ownerId: string;
  fencingToken: number;
  sampleRate: number;
  channels: number;
  startMs: number;
  sequence: number;
  pcmBytes: number;
}
export interface PublicAudioSinkPort {
  begin(input: {
    captureId: string;
    hearingId: string;
    lease: { ownerId: string; fencingToken: number };
    timelineOffsetMs: number;
    sampleRate: number;
    channels: number;
  }): Promise<PublicAudioAttempt | undefined>;
  append(attempt: PublicAudioAttempt, pcm: Buffer, cancellation?: AbortSignal): Promise<void>;
  markTranscriptPartial?(attempt: PublicAudioAttempt): Promise<void>;
  seal(
    attempt: PublicAudioAttempt,
    complete: boolean,
    transcriptFailed: boolean,
    reason?: string,
  ): Promise<void>;
}
/** Five-second independently playable WAV parts avoid an unbounded final remux. */
export function pcmWave(pcm: Buffer, sampleRate: number, channels: number) {
  if (!pcm.length || pcm.length % (channels * 2)) throw Error('Whole PCM samples required');
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export class PublicHearingAudioStore implements PublicAudioSinkPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStorageService,
  ) {}
  private async owned(
    tx: Prisma.TransactionClient,
    attempt: Pick<PublicAudioAttempt, 'captureId' | 'ownerId' | 'fencingToken' | 'hearingId'>,
  ) {
    if (!publicAudioEnabled()) throw new ForbiddenException('PUBLIC_AUDIO_DISABLED');
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM public_hearing_capture
      WHERE id=${attempt.captureId} AND hearing_id=${attempt.hearingId} AND worker_lease_owner=${attempt.ownerId}
        AND fencing_token=${attempt.fencingToken} AND lease_expires_at>clock_timestamp() FOR UPDATE`;
    if (!rows.length) throw new ForbiddenException('PUBLIC_AUDIO_LEASE_LOST');
    const permissions = await approvedPublicCapture(this.prisma, attempt.hearingId, tx);
    if (!permissions.length)
      throw new ForbiddenException('PUBLIC_AUDIO_PERMISSION_OR_DEMAND_WITHDRAWN');
    return permissions;
  }
  async begin(
    input: Parameters<PublicAudioSinkPort['begin']>[0],
  ): Promise<PublicAudioAttempt | undefined> {
    if (
      !publicAudioEnabled() ||
      !(await approvedPublicCapture(this.prisma, input.hearingId)).length
    )
      return undefined;
    this.storage.assertReady();
    const attempt: PublicAudioAttempt = {
      id: randomUUID(),
      captureId: input.captureId,
      hearingId: input.hearingId,
      sourceUrl: '',
      ...input.lease,
      sampleRate: input.sampleRate,
      channels: input.channels,
      startMs: input.timelineOffsetMs,
      sequence: 0,
      pcmBytes: 0,
    };
    await this.prisma.withSystem(async (tx) => {
      const grants = await this.owned(tx, attempt);
      attempt.sourceUrl = grants[0]!.sourceUrl;
      const capture = await tx.$queryRaw<
        Array<{ actual_start: Date | null }>
      >`UPDATE public_hearing_capture SET actual_start=COALESCE(actual_start,clock_timestamp()) WHERE id=${attempt.captureId} RETURNING actual_start`;
      const wall = capture[0]?.actual_start
        ? Date.now() - capture[0].actual_start.getTime()
        : attempt.startMs;
      if (wall - attempt.startMs > 2000) attempt.startMs = wall;
      const expiresAt = new Date(
        Math.min(
          ...grants.map((g) =>
            Math.min(g.expiresAt.getTime(), Date.now() + g.retentionDays * 86400000),
          ),
        ),
      );
      await tx.$executeRaw`INSERT INTO intel_public_hearing_audio_epoch(id,capture_id,hearing_id,source_url,owner_id,fencing_token,start_ms,durable_end_ms,sample_rate,channels,expires_at)
        VALUES(${attempt.id},${attempt.captureId}::uuid,${attempt.hearingId},${attempt.sourceUrl},${attempt.ownerId},${attempt.fencingToken},${attempt.startMs},${attempt.startMs},${attempt.sampleRate},${attempt.channels},${expiresAt})`;
    });
    return attempt;
  }
  async append(attempt: PublicAudioAttempt, pcm: Buffer, cancellation?: AbortSignal) {
    if (pcm.length > 960000) throw Error('Public audio part exceeds bounded size');
    cancellation?.throwIfAborted();
    const wave = pcmWave(pcm, attempt.sampleRate, attempt.channels),
      hash = createHash('sha256').update(wave).digest('hex');
    const key = `hearing-audio/public/${attempt.captureId}/${attempt.id}/${String(attempt.sequence).padStart(8, '0')}.wav`;
    for (let retry = 0; ; retry++) {
      cancellation?.throwIfAborted();
      // Keep only this bounded PCM part while FFmpeg stdout is paused. Each
      // retry rechecks current demand/permission and preserves the same bytes.
      await this.prisma.withSystem((tx) => this.owned(tx, attempt));
      try {
        await this.storage.put(key, wave, wave.length, hash, 'audio/wav', cancellation);
        break;
      } catch (error) {
        if (cancellation?.aborted || retry >= 7 || !retryableRecordingFailure(error)) throw error;
        await delay(Math.min(4000, 1000 * 2 ** retry), undefined, { signal: cancellation });
      }
    }
    const bytesPerMs = (attempt.sampleRate * attempt.channels * 2) / 1000;
    const start = attempt.startMs + Math.floor(attempt.pcmBytes / bytesPerMs),
      end = attempt.startMs + Math.floor((attempt.pcmBytes + pcm.length) / bytesPerMs);
    await this.prisma.withSystem(async (tx) => {
      await this.owned(tx, attempt);
      const epoch = await tx.$queryRaw<
        Array<{ durable_sequence: number }>
      >`SELECT durable_sequence FROM intel_public_hearing_audio_epoch WHERE id=${attempt.id} AND state='recording' AND expires_at>clock_timestamp() FOR UPDATE`;
      if (epoch[0]?.durable_sequence !== attempt.sequence - 1)
        throw Error('Public audio checkpoint changed or expired');
      await tx.$executeRaw`INSERT INTO intel_public_hearing_audio_part(id,epoch_id,sequence,start_ms,end_ms,bytes,sha256,object_key)
        VALUES(${randomUUID()},${attempt.id},${attempt.sequence},${start},${end},${wave.length},${hash},${key})`;
      await tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch SET durable_sequence=${attempt.sequence},durable_end_ms=${end},durable_bytes=durable_bytes+${wave.length} WHERE id=${attempt.id}`;
      await tx.$executeRaw`UPDATE public_hearing_capture SET captured_ms=GREATEST(captured_ms,${end}),captured_seconds=GREATEST(captured_seconds,${Math.floor(end / 1000)}) WHERE id=${attempt.captureId}`;
    });
    attempt.sequence++;
    attempt.pcmBytes += pcm.length;
  }
  async markTranscriptPartial(attempt: PublicAudioAttempt) {
    await this.prisma.withSystem(
      (tx) => tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch SET transcript_state='partial'
      WHERE id=${attempt.id} AND owner_id=${attempt.ownerId} AND fencing_token=${attempt.fencingToken} AND state='recording'`,
    );
  }
  async seal(
    attempt: PublicAudioAttempt,
    complete: boolean,
    transcriptFailed: boolean,
    reason?: string,
  ) {
    // Closing this attempt never rewrites a replacement capture's ownership.
    await this.prisma.withSystem(
      (tx) => tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch
      SET state=${complete ? 'ready' : 'partial'},transcript_state=${transcriptFailed ? 'partial' : 'finalized'},reason=${reason?.slice(0, 120) ?? null}
      WHERE id=${attempt.id} AND owner_id=${attempt.ownerId} AND fencing_token=${attempt.fencingToken} AND state='recording'`,
    );
    if (complete)
      await this.prisma.withSystem(
        (tx) => tx.$executeRaw`UPDATE public_hearing_capture SET actual_end=clock_timestamp()
      WHERE id=${attempt.captureId} AND worker_lease_owner=${attempt.ownerId} AND fencing_token=${attempt.fencingToken} AND lease_expires_at>clock_timestamp()`,
      );
  }

  async maintain() {
    const recovered = await this.prisma.withSystem(
      (tx) => tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch e
      SET state='partial',transcript_state='partial',reason='worker_disappeared' WHERE state='recording'
      AND NOT EXISTS(SELECT 1 FROM public_hearing_capture c WHERE c.id=e.capture_id::text AND c.worker_lease_owner=e.owner_id
        AND c.fencing_token=e.fencing_token AND c.lease_expires_at>clock_timestamp())`,
    );
    const expired = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{ id: string; capture_id: string }>
      >`SELECT id,capture_id::text FROM intel_public_hearing_audio_epoch
      WHERE state<>'expired' AND expires_at<now()-interval '2 minutes' ORDER BY expires_at LIMIT 20`,
    );
    for (const epoch of expired) {
      await this.storage.purgeEpoch('public', epoch.capture_id, epoch.id);
      await this.prisma.withSystem(
        (tx) =>
          tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch SET state='expired' WHERE id=${epoch.id} AND expires_at<now()`,
      );
    }
    return { recovered, purged: expired.length };
  }
}
