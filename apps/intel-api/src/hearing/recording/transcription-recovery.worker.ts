import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma-client/index.js';
import { HearingCryptoService } from '../hearing-crypto.service.js';
import {
  isFloridaStatePublisherUrl,
  STATE_CAPTURE_LINK_ONLY,
} from '../state-capture-policy.js';
import { RecordingStorageService } from './recording-storage.service.js';
import { pcmWave } from '../capture/public-hearing-audio.store.js';
import {
  recoveryWindowWords,
  uncoveredSegments,
  type RecoveryWord,
} from './transcription-recovery-domain.js';

const runFile = promisify(execFile),
  CHUNK_MS = 240000,
  LOOKAHEAD_MS = 2000,
  LEASE_MS = 180000;
interface Job {
  id: string;
  kind: 'browser' | 'public';
  epoch_id: string;
  cursor_ms: bigint;
  attempts: number;
}
interface Source {
  kind: 'browser' | 'public';
  epochId: string;
  tenantId?: string;
  sessionId?: string;
  actor?: string;
  recordingId?: string;
  captureId?: string;
  hearingId: string | null;
  sourceUrl: string;
  permissionId?: string;
  artifactKey?: string;
  artifactHash?: string;
  startMs: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
}
export type RecoveryTranscriber = (pcm: Buffer, signal: AbortSignal) => Promise<RecoveryWord[]>;

/** Saved audio is the repair source. Each committed chunk advances a fenced
 * cursor, so process loss only repeats one bounded provider request. */
export class TranscriptionRecoveryWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: RecordingStorageService,
    private readonly crypto: HearingCryptoService,
    private readonly transcribe: RecoveryTranscriber = transcribeSavedPcm,
  ) {}

  async seed(epochId?: string) {
    await this.prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO intel_hearing_transcription_recovery(kind,epoch_id)
        SELECT 'browser',e.id
        FROM intel_hearing_recording_epoch e
        JOIN intel_hearing_recording r ON r.id=e.recording_id AND r.tenant_id=e.tenant_id
        JOIN intel_live_hearing_session s ON s.id=r.session_id AND s.tenant_id=r.tenant_id
        WHERE e.state='ready' AND e.transcript_state='partial' AND e.artifact_key IS NOT NULL AND r.expires_at>now()
          AND (s.hearing_id IS NULL OR EXISTS(
            SELECT 1 FROM federal_committee_hearing f WHERE f.id=s.hearing_id
          ))
          AND (${epochId ?? null}::text IS NULL OR e.id=${epochId ?? null}) ON CONFLICT(kind,epoch_id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO intel_hearing_transcription_recovery(kind,epoch_id)
        SELECT 'public',e.id
        FROM intel_public_hearing_audio_epoch e
        JOIN federal_committee_hearing f ON f.id=e.hearing_id
        WHERE e.state IN ('ready','partial') AND e.transcript_state='partial'
          AND e.durable_bytes>0 AND e.expires_at>now() AND (${epochId ?? null}::text IS NULL OR e.id=${epochId ?? null})
        ON CONFLICT(kind,epoch_id) DO NOTHING`;
    });
  }

  private async source(job: Job): Promise<Source> {
    if (job.kind === 'browser') {
      const epoch = await this.prisma.withSystem((tx) =>
        tx.hearingRecordingEpoch.findFirst({
          where: {
            id: job.epoch_id,
            state: 'ready',
            recording: {
              expiresAt: { gt: new Date() },
              session: { recordingPolicy: 'audio_and_transcript' },
            },
          },
          include: { recording: { include: { session: true } } },
        }),
      );
      if (!epoch?.artifactKey || !epoch.artifactHash || !epoch.decodedDurationMs)
        throw Error('saved_media_unavailable');
      const session = epoch.recording.session;
      return {
        kind: 'browser',
        epochId: epoch.id,
        tenantId: epoch.tenantId,
        recordingId: epoch.recordingId,
        sessionId: session.id,
        actor: session.createdBy,
        hearingId: session.hearingId,
        sourceUrl: session.sourceUrl ?? '',
        permissionId: epoch.recording.permissionId,
        artifactKey: epoch.artifactKey,
        artifactHash: epoch.artifactHash,
        startMs: epoch.startMs,
        durationMs: epoch.decodedDurationMs,
        sampleRate: 16000,
        channels: 1,
      };
    }
    const rows = await this.prisma.withSystem(
      (tx) => tx.$queryRaw<
        Array<{
          id: string;
          capture_id: string;
          hearing_id: string;
          source_url: string;
          start_ms: bigint;
          durable_end_ms: bigint;
          sample_rate: number;
          channels: number;
        }>
      >`SELECT * FROM intel_public_hearing_audio_epoch
      WHERE id=${job.epoch_id} AND state IN ('ready','partial') AND expires_at>now()`,
    );
    const row = rows[0];
    if (!row) throw Error('saved_media_unavailable');
    return {
      kind: 'public',
      epochId: row.id,
      captureId: row.capture_id,
      hearingId: row.hearing_id,
      sourceUrl: row.source_url,
      startMs: Number(row.start_ms),
      durationMs: Number(row.durable_end_ms - row.start_ms),
      sampleRate: row.sample_rate,
      channels: row.channels,
    };
  }

  private async assertFederalRecoverySource(
    tx: Prisma.TransactionClient,
    source: Source,
  ): Promise<void> {
    // A legacy/substituted federal id must not make a known Florida publisher
    // source recoverable. New sessions are blocked at admission; this closes the
    // same boundary for already-saved audio and historical recovery jobs.
    if (isFloridaStatePublisherUrl(source.sourceUrl)) {
      throw Error(STATE_CAPTURE_LINK_ONLY);
    }
    if (!source.hearingId) {
      if (source.kind === 'public') throw Error(STATE_CAPTURE_LINK_ONLY);
      return;
    }
    const federal = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM federal_committee_hearing
      WHERE id=${source.hearingId}
      LIMIT 1
      FOR SHARE`;
    if (!federal.length) throw Error(STATE_CAPTURE_LINK_ONLY);
  }

  private async authorize(tx: Prisma.TransactionClient, source: Source) {
    await this.assertFederalRecoverySource(tx, source);
    if (process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED !== 'true' || !this.storage.enabled)
      throw Error('recovery_disabled');
    if (source.kind === 'public' && process.env.HEARING_PUBLIC_AUDIO_STORAGE_ENABLED !== 'true')
      throw Error('public_audio_disabled');
    // Completed captures need current source permission, rather than new capture
    // demand. Revocation and inactive membership still stop every repair chunk.
    const grants = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT p.id FROM intel_hearing_media_permission p
      JOIN intel_feature_flag f ON f.tenant_id=p.tenant_id AND f.feature='legiwatch_hearing_recording_v1' AND f.enabled
      WHERE p.source_url=${source.sourceUrl} AND p.hearing_id IS NOT DISTINCT FROM ${source.hearingId}
        AND p.mode=${source.kind === 'browser' ? 'browser' : 'server'} AND p.revoked_at IS NULL AND p.expires_at>clock_timestamp()
        AND p.operations @> ARRAY['transcription','retention']::text[]
        AND (${source.permissionId ?? null}::text IS NULL OR p.id=${source.permissionId ?? null})
        AND EXISTS(SELECT 1 FROM users u JOIN tenant_memberships tm ON tm.user_id=u.id
          WHERE u.clerk_user_id=${source.actor ?? null} OR u.clerk_user_id=p.reviewed_by
          GROUP BY u.id,u.clerk_user_id HAVING bool_or(tm.tenant_id::text=p.tenant_id AND tm.status::text='active')
            AND (${source.actor ?? null}::text IS NULL OR u.clerk_user_id=${source.actor ?? null}))
      LIMIT 1 FOR SHARE OF p,f`;
    if (!grants.length) throw Error('source_transcription_permission_unavailable');
    if (source.kind === 'browser') {
      const rows =
        await tx.$queryRaw`SELECT s.id FROM intel_live_hearing_session s JOIN intel_hearing_recording r ON r.session_id=s.id AND r.tenant_id=s.tenant_id
        WHERE s.id=${source.sessionId!} AND s.tenant_id=${source.tenantId!} AND s.recording_policy='audio_and_transcript'
          AND r.id=${source.recordingId!} AND r.expires_at>clock_timestamp() FOR SHARE OF s,r`;
      if (!(rows as unknown[]).length) throw Error('saved_media_unavailable');
    } else {
      const rows =
        await tx.$queryRaw`SELECT id FROM intel_public_hearing_audio_epoch WHERE id=${source.epochId} AND expires_at>clock_timestamp() AND state IN ('ready','partial') FOR SHARE`;
      if (!(rows as unknown[]).length) throw Error('saved_media_unavailable');
    }
  }

  async runOne(epochId?: string) {
    if (process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED !== 'true') return false;
    const token = randomUUID();
    const job = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Job[]>`SELECT j.* FROM intel_hearing_transcription_recovery j
        WHERE (${epochId ?? null}::text IS NULL OR j.epoch_id=${epochId ?? null}) AND (j.next_attempt IS NULL OR j.next_attempt<=now())
          AND (j.state='pending' OR (j.state='processing' AND j.lease_until<now()))
          AND (
            (j.kind='browser' AND EXISTS(
              SELECT 1
              FROM intel_hearing_recording_epoch e
              JOIN intel_hearing_recording r ON r.id=e.recording_id AND r.tenant_id=e.tenant_id
              JOIN intel_live_hearing_session s ON s.id=r.session_id AND s.tenant_id=r.tenant_id
              WHERE e.id=j.epoch_id AND (
                s.hearing_id IS NULL OR EXISTS(
                  SELECT 1 FROM federal_committee_hearing f WHERE f.id=s.hearing_id
                )
              )
            ))
            OR
            (j.kind='public' AND EXISTS(
              SELECT 1
              FROM intel_public_hearing_audio_epoch e
              JOIN federal_committee_hearing f ON f.id=e.hearing_id
              WHERE e.id=j.epoch_id
            ))
          )
        ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`;
      const row = rows[0];
      if (!row) return null;
      await tx.$executeRaw`UPDATE intel_hearing_transcription_recovery SET state='processing',token=${token}::uuid,
        lease_until=${new Date(Date.now() + LEASE_MS)},attempts=attempts+1,updated_at=now() WHERE id=${row.id}::uuid`;
      return row;
    });
    if (!job) return false;
    const cancel = new AbortController();
    let heartbeat: ReturnType<typeof setInterval> | undefined,
      renewing = false;
    try {
      const source = await this.source(job);
      await this.prisma.withSystem((tx) => this.authorize(tx, source));
      heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void this.prisma
          .withSystem(async (tx) => {
            await this.authorize(tx, source);
            const changed =
              await tx.$executeRaw`UPDATE intel_hearing_transcription_recovery SET lease_until=${new Date(Date.now() + LEASE_MS)}
            WHERE id=${job.id}::uuid AND token=${token}::uuid AND state='processing' AND lease_until>clock_timestamp()`;
            if (!changed) throw Error('recovery_lease_lost');
          })
          .catch(() => cancel.abort())
          .finally(() => {
            renewing = false;
          });
      }, 20000);
      const cursor = Number(job.cursor_ms),
        duration = Math.min(CHUNK_MS, source.durationMs - cursor),
        readDuration = Math.min(duration + LOOKAHEAD_MS, source.durationMs - cursor);
      if (duration <= 0) throw Error('invalid_recovery_cursor');
      // A word crossing a four-minute boundary needs its recorded ending.
      // At 16 kHz mono, 242 seconds stays below the existing 8 MiB PCM bound.
      const pcm = await this.readPcm(source, cursor, readDuration, cancel.signal);
      const words = recoveryWindowWords(await this.transcribe(pcm, cancel.signal), duration);
      cancel.signal.throwIfAborted();
      const next = Math.min(source.durationMs, cursor + duration),
        done = next >= source.durationMs;
      await this.prisma.withSystem(async (tx) => {
        const owned =
          await tx.$queryRaw`SELECT id FROM intel_hearing_transcription_recovery WHERE id=${job.id}::uuid
          AND token=${token}::uuid AND state='processing' AND lease_until>clock_timestamp() FOR UPDATE`;
        if (!(owned as unknown[]).length) throw Error('recovery_lease_lost');
        await this.authorize(tx, source);
        const begin = source.startMs + cursor,
          end = begin + readDuration;
        let covered: Array<{ startMs: number; endMs: number }>;
        if (source.kind === 'browser')
          covered = await tx.transcriptSegment.findMany({
            where: {
              tenantId: source.tenantId!,
              sessionId: source.sessionId!,
              isFinal: true,
              startMs: { lt: end },
              endMs: { gt: begin },
            },
            select: { startMs: true, endMs: true },
          });
        else {
          // Serialize sequence allocation with live finals without adopting or
          // releasing the current capture worker's lease.
          await tx.$queryRaw`SELECT id FROM public_hearing_capture WHERE id=${source.captureId!} FOR UPDATE`;
          covered =
            await tx.$queryRaw`SELECT start_ms AS "startMs",end_ms AS "endMs" FROM public_hearing_transcript_segment
            WHERE capture_id=${source.captureId!} AND is_final AND start_ms<${end} AND end_ms>${begin}`;
        }
        const segments = uncoveredSegments(words, begin, readDuration, covered);
        for (const segment of segments) {
          if (source.kind === 'browser')
            await tx.transcriptSegment.create({
              data: {
                tenantId: source.tenantId!,
                sessionId: source.sessionId!,
                startMs: segment.startMs,
                endMs: segment.endMs,
                speakerLabel: segment.speakerLabel,
                isFinal: true,
                confidence: segment.confidence,
                source: 'deepgram_recovery',
                issueTags: [],
                textPlain: null,
                ...this.crypto.encrypt(segment.text),
                analysisState: 'pending',
                analysisActor: source.actor!,
              },
            });
          else
            await tx.$executeRaw`INSERT INTO public_hearing_transcript_segment
            (id,capture_id,sequence,start_ms,end_ms,text,speaker_label,transcription_confidence,is_final,has_gap_before)
            VALUES(gen_random_uuid(),${source.captureId!},(SELECT COALESCE(MAX(sequence),0)+1 FROM public_hearing_transcript_segment WHERE capture_id=${source.captureId!}),
              ${segment.startMs},${segment.endMs},${segment.text},${segment.speakerLabel ?? null},${segment.confidence ?? null},true,true)
            ON CONFLICT(capture_id,start_ms,end_ms) DO NOTHING`;
        }
        await tx.$executeRaw`UPDATE intel_hearing_transcription_recovery SET cursor_ms=${next},state=${done ? 'ready' : 'pending'},
          token=NULL,lease_until=NULL,next_attempt=NULL,attempts=0,recovered_segments=recovered_segments+${segments.length},last_error=NULL,updated_at=now()
          WHERE id=${job.id}::uuid AND token=${token}::uuid`;
        if (source.kind === 'browser') {
          await tx.hearingRecordingEpoch.updateMany({
            where: { id: source.epochId, tenantId: source.tenantId! },
            data: {
              transcriptRecoveryState: done ? 'ready' : 'processing',
              ...(done ? { transcriptState: 'finalized' } : {}),
            },
          });
          const partial = await tx.hearingRecordingEpoch.count({
            where: {
              tenantId: source.tenantId!,
              recordingId: source.recordingId!,
              transcriptState: 'partial',
            },
          });
          const streaming = await tx.hearingRecordingEpoch.count({
            where: {
              tenantId: source.tenantId!,
              recordingId: source.recordingId!,
              transcriptState: 'streaming',
            },
          });
          await tx.hearingRecording.updateMany({
            where: { tenantId: source.tenantId!, id: source.recordingId! },
            data: {
              transcriptState: partial ? 'partial' : streaming ? 'streaming' : 'finalized',
              ...(segments.length ? { analysisState: 'pending' } : {}),
            },
          });
        } else if (done)
          await tx.$executeRaw`UPDATE intel_public_hearing_audio_epoch SET transcript_state='finalized' WHERE id=${source.epochId}`;
      });
    } catch (error) {
      const failed = job.attempts >= 4;
      const diagnostic = error as {
        message?: string;
        name?: string;
        code?: string;
        meta?: { code?: string };
      };
      const reason =
        diagnostic.message === STATE_CAPTURE_LINK_ONLY
          ? STATE_CAPTURE_LINK_ONLY
          : /^(recovery_|saved_media_|source_transcription_|public_audio_|unsupported_recovery_|invalid_recovery_)[a-z0-9_]+$/.test(
                diagnostic.message ?? '',
              )
            ? diagnostic.message!
            : /^P\d{4}$/.test(diagnostic.code ?? '')
            ? `${diagnostic.code}:${diagnostic.meta?.code ?? 'unknown'}`
            : diagnostic.name === 'AbortError'
              ? 'recovery_cancelled'
              : 'recovery_incomplete';
      await this.prisma.withSystem(async (tx) => {
        const changed =
          await tx.$executeRaw`UPDATE intel_hearing_transcription_recovery SET state=${failed ? 'failed' : 'pending'},token=NULL,lease_until=NULL,
          next_attempt=${new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts))},last_error=${reason},updated_at=now()
          WHERE id=${job.id}::uuid AND token=${token}::uuid AND state='processing'`;
        if (changed && failed && job.kind === 'browser')
          await tx.hearingRecordingEpoch.updateMany({
            where: { id: job.epoch_id },
            data: { transcriptRecoveryState: 'failed' },
          });
      });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      cancel.abort();
    }
    return true;
  }

  private async readPcm(
    source: Source,
    cursor: number,
    duration: number,
    signal: AbortSignal,
  ): Promise<Buffer> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(90000)]);
    signal.throwIfAborted();
    if (source.kind === 'public') {
      const parts = await this.prisma.withSystem(
        (tx) => tx.$queryRaw<
          Array<{
            object_key: string;
            sha256: string;
            bytes: number;
            start_ms: bigint;
            end_ms: bigint;
          }>
        >`
        SELECT * FROM intel_public_hearing_audio_part WHERE epoch_id=${source.epochId}
          AND end_ms>${source.startMs + cursor} AND start_ms<${source.startMs + cursor + duration} ORDER BY sequence LIMIT 50`,
      );
      const pieces: Buffer[] = [];
      let expected = source.startMs + cursor;
      for (const part of parts) {
        const wave = await this.readBounded(part.object_key, 1048576, signal);
        if (
          wave.length !== part.bytes ||
          createHash('sha256').update(wave).digest('hex') !== part.sha256 ||
          Number(part.start_ms) !== expected
        )
          throw Error('saved_media_integrity_failed');
        const startSample =
          Math.max(
            0,
            Math.round(
              ((source.startMs + cursor - Number(part.start_ms)) * source.sampleRate) / 1000,
            ),
          ) *
          source.channels *
          2;
        const endSample = Math.min(
          wave.length - 44,
          Math.round(
            ((source.startMs + cursor + duration - Number(part.start_ms)) * source.sampleRate) /
              1000,
          ) *
            source.channels *
            2,
        );
        pieces.push(wave.subarray(44 + startSample, 44 + endSample));
        expected = Number(part.end_ms);
      }
      if (expected < source.startMs + cursor + duration) throw Error('saved_media_part_missing');
      const pcm = Buffer.concat(pieces);
      if (source.sampleRate !== 16000 || source.channels !== 1)
        throw Error('unsupported_recovery_pcm_format');
      return pcm;
    }
    const directory = await mkdtemp(join(tmpdir(), 'legiwatch-recovery-'));
    try {
      const input = join(directory, 'saved.webm'),
        file = await open(input, 'wx'),
        hash = createHash('sha256');
      let count = 0;
      const stream = await this.storage.read(source.artifactKey!);
      const abort = () => stream.destroy(new Error('recovery_cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted();
          const buffer = Buffer.from(chunk);
          count += buffer.length;
          if (count > 1024 ** 3) throw Error('saved_media_too_large');
          hash.update(buffer);
          let offset = 0;
          while (offset < buffer.length) {
            const written = await file.write(buffer, offset, buffer.length - offset);
            if (!written.bytesWritten) throw Error('recovery_disk_stalled');
            offset += written.bytesWritten;
          }
        }
      } finally {
        signal.removeEventListener('abort', abort);
        stream.destroy();
        await file.close();
      }
      if (hash.digest('hex') !== source.artifactHash) throw Error('saved_media_integrity_failed');
      const result = await runFile(
        'ffmpeg',
        [
          '-nostdin',
          '-v',
          'error',
          '-xerror',
          '-ss',
          String(cursor / 1000),
          '-i',
          input,
          '-t',
          String(duration / 1000),
          '-map',
          '0:a:0',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-f',
          's16le',
          'pipe:1',
        ],
        {
          encoding: 'buffer',
          maxBuffer: 8 * 1024 * 1024,
          timeout: 90000,
          windowsHide: true,
          signal,
        },
      );
      if (!result.stdout.length) throw Error('saved_media_empty');
      return result.stdout;
    } finally {
      if (
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
        basename(directory).startsWith('legiwatch-recovery-')
      )
        await rm(directory, { recursive: true, force: true });
    }
  }

  private async readBounded(key: string, max: number, signal: AbortSignal) {
    const stream = await this.storage.read(key),
      buffers: Buffer[] = [];
    let size = 0;
    const abort = () => stream.destroy(new Error('recovery_cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      for await (const chunk of stream) {
        signal.throwIfAborted();
        const buffer = Buffer.from(chunk);
        size += buffer.length;
        if (size > max) throw Error('saved_media_too_large');
        buffers.push(buffer);
      }
      return Buffer.concat(buffers);
    } finally {
      signal.removeEventListener('abort', abort);
      stream.destroy();
    }
  }
}

async function transcribeSavedPcm(pcm: Buffer, cancellation: AbortSignal): Promise<RecoveryWord[]> {
  if (!process.env.DEEPGRAM_API_KEY || !pcm.length || pcm.length > 8 * 1024 * 1024)
    throw Error('recovery_provider_unavailable');
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(120000)]);
  const response = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&diarize=true',
    {
      method: 'POST',
      headers: {
        Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY,
        'Content-Type': 'audio/wav',
      },
      body: new Uint8Array(pcmWave(pcm, 16000, 1)),
      signal,
      redirect: 'error',
    },
  );
  if (!response.ok) throw Error('recovery_provider_http_' + response.status);
  const reader = response.body?.getReader();
  if (!reader) throw Error('recovery_provider_empty');
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      count += item.value.length;
      if (count > 2 * 1024 * 1024) throw Error('recovery_provider_response_too_large');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    results?: { channels?: Array<{ alternatives?: Array<{ words?: RecoveryWord[] }> }> };
  };
  const words = parsed.results?.channels?.[0]?.alternatives?.[0]?.words;
  if (!Array.isArray(words)) throw Error('recovery_provider_invalid');
  return words;
}
