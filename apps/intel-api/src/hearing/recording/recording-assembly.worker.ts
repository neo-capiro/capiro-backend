import { randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, stat, rm } from 'node:fs/promises';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RecordingStorageService } from './recording-storage.service.js';
import { CAPTURE_LEASE_STALE_MS } from '../hearing-session.service.js';

const runFile = promisify(execFile);
const MAX_ASSEMBLY_BYTES = 1024 * 1024 * 1024;
const LEASE_MS = 90_000;

/** Durable, fenced work is represented by epoch.state, not an in-memory queue. */
export class RecordingAssemblyWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStorageService,
  ) {}

  async purgeExpired(limit = 10) {
    const recordings = await this.prisma.withSystem((tx) =>
      tx.hearingRecording.findMany({
        // Reads/writes deny immediately at expiry. Allow bounded in-flight S3
        // writes and the assembly cancellation heartbeat to settle before purge.
        where: { expiresAt: { lte: new Date(Date.now() - 120_000) }, state: { not: 'expired' } },
        orderBy: { expiresAt: 'asc' },
        take: Math.min(limit, 20),
      }),
    );
    for (const recording of recordings) {
      await this.storage.purgeRecording(recording.tenantId, recording.id);
      await this.prisma.withSystem(async (tx) => {
        await tx.hearingRecordingEpoch.updateMany({
          where: { tenantId: recording.tenantId, recordingId: recording.id },
          data: {
            state: 'expired',
            artifactKey: null,
            assemblyToken: null,
            assemblyLeaseUntil: null,
          },
        });
        await tx.hearingRecording.updateMany({
          where: { tenantId: recording.tenantId, id: recording.id, expiresAt: { lte: new Date() } },
          data: { state: 'expired' },
        });
      });
    }
    return recordings.length;
  }

  async recoverAbandoned() {
    return this.prisma.withSystem(
      (tx) => tx.$executeRaw`
      UPDATE intel_hearing_recording_epoch e SET state='queued', complete=false, transcript_state='partial',
        reason='capture_interrupted', updated_at=now()
      FROM intel_hearing_recording r, intel_live_hearing_session s
      WHERE e.tenant_id=r.tenant_id AND e.recording_id=r.id AND r.tenant_id=s.tenant_id AND r.session_id=s.id
        AND e.state='recording' AND (s.started_at IS DISTINCT FROM e.capture_token
          OR s.status NOT IN ('paused','live') OR s.updated_at < now()-(${CAPTURE_LEASE_STALE_MS} * interval '1 millisecond'))`,
    );
  }

  async runOne(recordingId?: string): Promise<boolean> {
    this.storage.assertReady();
    const token = randomUUID();
    const epoch = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; tenant_id: string }>>`
        SELECT e.id,e.tenant_id FROM intel_hearing_recording_epoch e
        JOIN intel_hearing_recording r ON r.tenant_id=e.tenant_id AND r.id=e.recording_id
        WHERE r.expires_at>now() AND (${recordingId ?? null}::text IS NULL OR r.id=${recordingId ?? null})
          AND (e.state='queued' OR (e.state='assembling' AND e.assembly_lease_until<now()))
        ORDER BY e.created_at FOR UPDATE OF e SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      if (!row) return null;
      return tx.hearingRecordingEpoch.update({
        where: { id: row.id, tenantId: row.tenant_id },
        data: {
          state: 'assembling',
          assemblyToken: token,
          assemblyLeaseUntil: new Date(Date.now() + LEASE_MS),
        },
        include: { recording: true },
      });
    });
    if (!epoch) return false;
    const cancel = new AbortController();
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.prisma
        .withSystem((tx) =>
          tx.hearingRecordingEpoch.updateMany({
            where: {
              id: epoch.id,
              tenantId: epoch.tenantId,
              assemblyToken: token,
              state: 'assembling',
              assemblyLeaseUntil: { gt: new Date() },
              recording: { expiresAt: { gt: new Date() } },
            },
            data: { assemblyLeaseUntil: new Date(Date.now() + LEASE_MS) },
          }),
        )
        .then((result) => {
          if (!result.count) cancel.abort();
        })
        .catch(() => cancel.abort())
        .finally(() => {
          renewing = false;
        });
    }, 20_000);
    let directory: string | undefined;
    try {
      if (
        epoch.durableSequence < 0 ||
        epoch.durableBytes <= 0n ||
        epoch.durableBytes > BigInt(MAX_ASSEMBLY_BYTES)
      ) {
        throw new Error('Recording has no saved audio or exceeds assembly limits');
      }
      directory = await mkdtemp(join(tmpdir(), 'legiwatch-media-'));
      const input = join(directory, 'fragments.webm'),
        output = join(directory, 'playable.webm');
      const file = await open(input, 'wx');
      let cursor = -1,
        total = 0;
      try {
        for (;;) {
          cancel.signal.throwIfAborted();
          const parts = await this.prisma.withSystem((tx) =>
            tx.hearingRecordingPart.findMany({
              where: { tenantId: epoch.tenantId, epochId: epoch.id, sequence: { gt: cursor } },
              orderBy: { sequence: 'asc' },
              take: 200,
            }),
          );
          if (!parts.length) break;
          for (const part of parts) {
            if (part.sequence !== cursor + 1)
              throw new Error('Recording manifest has a missing part');
            const hash = createHash('sha256');
            let bytes = 0;
            const stream = await this.storage.read(part.objectKey);
            try {
              for await (const chunk of stream) {
                cancel.signal.throwIfAborted();
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.length;
                total += buffer.length;
                if (bytes > part.byteLength || total > MAX_ASSEMBLY_BYTES)
                  throw new Error('Recording object size conflict');
                hash.update(buffer);
                let offset = 0;
                while (offset < buffer.length) {
                  const written = await file.write(buffer, offset, buffer.length - offset);
                  if (!written.bytesWritten)
                    throw new Error('Recording assembly disk write stalled');
                  offset += written.bytesWritten;
                }
              }
            } finally {
              stream.destroy();
            }
            if (bytes !== part.byteLength || hash.digest('hex') !== part.sha256)
              throw new Error('Recording object checksum conflict');
            cursor = part.sequence;
          }
        }
      } finally {
        await file.close();
      }
      if (cursor !== epoch.durableSequence || BigInt(total) !== epoch.durableBytes)
        throw new Error('Recording checkpoint is inconsistent');
      const options = {
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        signal: cancel.signal,
      };
      await runFile(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-i',
          input,
          '-map',
          '0:a:0',
          '-vn',
          '-c:a',
          'copy',
          '-f',
          'webm',
          output,
        ],
        options,
      );
      // A successful mux is not proof that the audio decodes. Qualify every byte.
      await runFile(
        'ffmpeg',
        ['-nostdin', '-v', 'error', '-xerror', '-i', output, '-map', '0:a:0', '-f', 'null', '-'],
        options,
      );
      const probe = await runFile(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', output],
        options,
      );
      const durationMs = Math.round(Number(JSON.parse(probe.stdout).format?.duration) * 1000);
      if (
        !Number.isSafeInteger(durationMs) ||
        durationMs <= 0 ||
        durationMs > 12 * 3600_000 + 30_000
      )
        throw new Error('Invalid decoded audio duration');
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(output)) digest.update(chunk);
      const sha256 = digest.digest('hex'),
        size = (await stat(output)).size;
      const key = `hearing-audio/${epoch.tenantId}/${epoch.recordingId}/${epoch.id}/playable/${sha256}.webm`;
      const body = createReadStream(output);
      try {
        await this.storage.put(key, body, size, sha256, 'audio/webm', cancel.signal);
      } finally {
        body.destroy();
      }
      cancel.signal.throwIfAborted();
      await this.prisma.withSystem(async (tx) => {
        const saved = await tx.hearingRecordingEpoch.updateMany({
          where: {
            id: epoch.id,
            tenantId: epoch.tenantId,
            assemblyToken: token,
            state: 'assembling',
            assemblyLeaseUntil: { gt: new Date() },
            recording: { expiresAt: { gt: new Date() } },
          },
          data: {
            state: 'ready',
            artifactKey: key,
            artifactHash: sha256,
            artifactBytes: size,
            decodedDurationMs: durationMs,
            assemblyToken: null,
            assemblyLeaseUntil: null,
            ...(Math.abs(durationMs - (epoch.durableEndMs - epoch.startMs)) > 2000
              ? { complete: false, reason: 'decoded_duration_differs_from_capture_clock' }
              : {}),
          },
        });
        if (saved.count !== 1) throw new Error('Recording assembly lease lost');
        const epochs = await tx.hearingRecordingEpoch.findMany({
          where: { tenantId: epoch.tenantId, recordingId: epoch.recordingId },
        });
        const recording = await tx.hearingRecording.findFirst({
          where: { tenantId: epoch.tenantId, id: epoch.recordingId },
        });
        const state = epochs.some((e) => e.state === 'recording')
          ? 'recording'
          : epochs.some((e) => ['queued', 'assembling'].includes(e.state))
            ? 'processing'
            : epochs.every((e) => e.state === 'ready' && e.complete) && epochs.length === 1
              ? 'ready'
              : 'partial';
        await tx.hearingRecording.updateMany({
          where: { tenantId: epoch.tenantId, id: epoch.recordingId, state: { not: 'expired' } },
          data: { state, ...(recording?.finalizedAt ? {} : { finalizedAt: new Date() }) },
        });
      });
    } catch (error) {
      await this.prisma.withSystem(async (tx) => {
        const failed = await tx.hearingRecordingEpoch.updateMany({
          where: {
            id: epoch.id,
            tenantId: epoch.tenantId,
            assemblyToken: token,
            state: 'assembling',
            assemblyLeaseUntil: { gt: new Date() },
          },
          data: {
            state: 'failed',
            complete: false,
            reason: 'assembly_failed',
            assemblyToken: null,
            assemblyLeaseUntil: null,
          },
        });
        if (failed.count)
          await tx.hearingRecording.updateMany({
            where: {
              tenantId: epoch.tenantId,
              id: epoch.recordingId,
              state: 'processing',
              epochs: { none: { state: { in: ['queued', 'assembling', 'recording'] } } },
            },
            data: { state: 'partial' },
          });
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (
        directory &&
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        basename(directory).startsWith('legiwatch-media-')
      )
        await rm(directory, { recursive: true, force: true });
    }
    return true;
  }
}
