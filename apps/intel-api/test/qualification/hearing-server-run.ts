/** Owned fixture qualification; local disposable DB, existing S3, real FFmpeg and Deepgram.
 * The source resolver is replaced only for this owned local WAV. This does not
 * qualify provider permission, production egress, ECS scheduling or client delivery.
 */
import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RecordingStorageService } from '../../src/hearing/recording/recording-storage.service.js';
import { PublicHearingAudioStore } from '../../src/hearing/capture/public-hearing-audio.store.js';
import { PublicHearingCaptureStore } from '../../src/hearing/capture/public-hearing-capture.store.js';
import { PublicHearingTranscriptStore } from '../../src/hearing/capture/public-hearing-transcript.store.js';
import { PublicHearingCaptureAttemptStore } from '../../src/hearing/capture/public-hearing-capture-attempt.store.js';
import { PublicCapturePersistentQueueAdapter } from '../../src/hearing/capture/public-capture-persistent-queue.adapter.js';
import { PublicCaptureWorkerCoordinator } from '../../src/hearing/capture/public-capture.orchestrator.js';
import { assertPublicCaptureRuntimeEnabled } from '../../src/hearing/capture/public-capture-runtime-control.js';
import {
  FfmpegDeepgramCaptureRuntime,
  NodeFfmpegProcessFactory,
} from '../../src/hearing/capture/ffmpeg-deepgram-capture.runtime.js';

async function main() {
  if (
    process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
    !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
  )
    throw Error('Local disposable database required');
  const minutes = Number(process.env.PHASE4_QUALIFICATION_MINUTES ?? '3');
  const stopMode = process.env.PHASE4_QUALIFICATION_STOP ?? 'none';
  if (
    !['none', 'permission', 'demand', 'tenant', 'runtime', 'canceled'].includes(stopMode) ||
    (stopMode !== 'none' && minutes >= 240)
  )
    throw Error('Invalid active-stop qualification');
  if (
    minutes < 3 ||
    minutes > 260 ||
    !process.env.PHASE4_QUALIFICATION_OUTPUT ||
    !process.env.PHASE4_OWNED_SPEECH ||
    !process.env.DEEPGRAM_API_KEY
  )
    throw Error('Explicit qualification environment required');
  const out = resolve(process.env.PHASE4_QUALIFICATION_OUTPUT);
  mkdirSync(out, { recursive: true });
  const log = (event: string, data: unknown = {}) =>
    appendFileSync(
      join(out, 'events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), event, data }, (_, value) =>
        typeof value === 'bigint' ? Number(value) : value,
      ) + '\n',
    );
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } }),
    storage = new RecordingStorageService(new ConfigService());
  const store = new PublicHearingCaptureStore(p),
    audio = new PublicHearingAudioStore(p, storage),
    transcript = new PublicHearingTranscriptStore(p);
  const hearingId = 'owned-server-' + randomUUID(),
    sourceUrl = 'https://owned.example/' + hearingId,
    tenants = [randomUUID(), randomUUID()];
  const started = Date.now(),
    deadline = started + minutes * 60000;
  await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,starts_at,event_status,visibility,geographic_jurisdiction,legislative_session,url,type)
    VALUES(${hearingId},'Owned synthetic committee','Senate','Owned server audio qualification',${new Date()},${new Date()},'in_progress','public','FL','2099',${sourceUrl},'hearing')`;
  for (const tenantId of tenants) {
    const userId = randomUUID(),
      actor = 'owned-server-' + randomUUID();
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'owned-server-' + tenantId},'Owned server test')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${userId}::uuid,${actor},${actor + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${userId}::uuid,'standard_user','active')`;
    await p.$executeRaw`INSERT INTO hearing_subscription(id,tenant_id,user_id,hearing_id,attendance_mode,scheduled_by_user,consent_acknowledged_at) VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${userId},${hearingId},'automatic',true,now())`;
    await p.featureFlag.create({
      data: { tenantId, feature: 'legiwatch_hearing_recording_v1', enabled: true },
    });
    await p.hearingMediaPermission.create({
      data: {
        tenantId,
        hearingId,
        sourceUrl,
        mode: 'server',
        operations: ['capture', 'transcription', 'retention', 'analysis'],
        evidence:
          'Owned synthesized speech for isolated local qualification. The FL jurisdiction is synthetic adapter data, not a Florida broadcast authorization.',
        reviewedBy: actor,
        retentionDays: 1,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  }
  const capture = await store.ensureCapture({
    hearingId,
    idempotencyKey: hearingId,
    scheduledStart: new Date(),
    now: new Date(),
  });
  const duplicate = await store.ensureCapture({
    hearingId,
    idempotencyKey: hearingId,
    scheduledStart: new Date(),
    now: new Date(),
  });
  if (
    capture.id !== duplicate.id ||
    (await store.getDemand(hearingId)).activeSubscriptionCount !== 2
  )
    throw Error('Two-tenant global capture identity failed');
  const factory = new NodeFfmpegProcessFactory();
  let child: ReturnType<typeof factory.spawn> | undefined,
    attemptNumber = 0;
  let stopCommittedAt: number | undefined, processClosedAt: number | undefined;
  const long = minutes >= 240,
    recessStart = long ? 45 * 60 : 30,
    recessEnd = recessStart + (long ? 16 * 60 : 15);
  const runtime = new FfmpegDeepgramCaptureRuntime(process.env.DEEPGRAM_API_KEY, transcript, {
    audioSink: audio,
    processFactory: {
      spawn: (command) => {
        child = factory.spawn(command);
        attemptNumber++;
        log('ffmpeg_started', { attempt: attemptNumber });
        child.once('close', () => {
          processClosedAt = Date.now();
          log('ffmpeg_closed', {
            attempt: attemptNumber,
            stopLagMs: stopCommittedAt ? processClosedAt - stopCommittedAt : null,
          });
        });
        return child;
      },
    },
    buildCommand: async () => {
      const elapsed = (Date.now() - started) / 1000,
        remaining = Math.max(1, (deadline - Date.now()) / 1000),
        from = Math.max(0, recessStart - elapsed),
        to = recessEnd - elapsed;
      const filter =
        to > 0 ? ['-af', `volume=if(between(t\\,${from}\\,${to})\\,0\\,1):eval=frame`] : [];
      return {
        executable: 'ffmpeg',
        args: [
          '-nostdin',
          '-hide_banner',
          '-loglevel',
          'warning',
          '-re',
          '-stream_loop',
          '-1',
          '-i',
          process.env.PHASE4_OWNED_SPEECH!,
          ...filter,
          '-t',
          String(remaining),
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-acodec',
          'pcm_s16le',
          '-f',
          's16le',
          'pipe:1',
        ],
        output: { encoding: 'linear16', sampleRate: 16000, channels: 1, bytesPerSample: 2 },
      };
    },
  });
  const runtimeBefore =
    stopMode === 'runtime'
      ? (
          await p.$queryRaw<
            Array<{ enabled: boolean; schedule_enabled: boolean }>
          >`SELECT enabled,schedule_enabled FROM legiwatch_runtime_heartbeat WHERE job_key='capture-worker'`
        )[0]
      : undefined;
  if (stopMode === 'runtime')
    await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=true,schedule_enabled=true WHERE job_key='capture-worker'`;
  const coordinator = new PublicCaptureWorkerCoordinator(
    store,
    {
      resolve: async () => ({
        status: 'resolved',
        media: { url: sourceUrl, kind: 'mp3', provider: 'owned-fixture' },
        reviewedSourcePermission: true,
      }),
    },
    runtime,
    {
      attempts: new PublicHearingCaptureAttemptStore(p),
      retryQueue: new PublicCapturePersistentQueueAdapter(p),
      maxAttempts: 3,
      ...(stopMode === 'runtime'
        ? { assertRuntimeAllowed: () => assertPublicCaptureRuntimeEnabled(p) }
        : {}),
    },
  );
  const sourceFiles = [
    'src/hearing/capture/ffmpeg-deepgram-capture.runtime.ts',
    'src/hearing/capture/public-hearing-audio.store.ts',
    'src/hearing/capture/public-capture-permission.ts',
    'src/hearing/capture/public-hearing-capture.store.ts',
    'src/hearing/capture/public-capture.orchestrator.ts',
    'src/hearing/capture/server-deepgram-stream.manager.ts',
    'src/hearing/recording/recording-storage.service.ts',
  ];
  const metadata = {
    startedAt: new Date(started).toISOString(),
    requestedMinutes: minutes,
    stopMode,
    hearingId,
    captureId: capture.id,
    tenants,
    source: 'owned local synthesized speech',
    sourceResolver: 'owned local-file fixture only; production guarded resolver not qualified',
    database: 'disposable PostgreSQL',
    providers: 'real FFmpeg, Deepgram, existing private S3',
    sourceHashes: Object.fromEntries(
      sourceFiles.map((path) => [
        path,
        createHash('sha256')
          .update(readFileSync(resolve(path)))
          .digest('hex'),
      ]),
    ),
  };
  writeFileSync(join(out, 'run.json'), JSON.stringify(metadata, null, 2));
  log('started', metadata);
  const fault = setTimeout(
    () => {
      if (stopMode === 'none') {
        log('controlled_source_process_failure', { attempt: attemptNumber });
        child?.kill('SIGKILL');
        return;
      }
      void (async () => {
        if (stopMode === 'permission')
          await p.hearingMediaPermission.updateMany({
            where: { hearingId },
            data: { revokedAt: new Date() },
          });
        if (stopMode === 'tenant')
          await p.featureFlag.updateMany({
            where: { tenantId: { in: tenants }, feature: 'legiwatch_hearing_recording_v1' },
            data: { enabled: false },
          });
        if (stopMode === 'demand')
          await p.$executeRaw`DELETE FROM hearing_subscription WHERE hearing_id=${hearingId} AND tenant_id::text=ANY(${tenants}::text[])`;
        if (stopMode === 'runtime')
          await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=false,schedule_enabled=false WHERE job_key='capture-worker'`;
        if (stopMode === 'canceled')
          await p.$executeRaw`UPDATE public_hearing_capture SET domain_status='CANCELED',version=version+1 WHERE id=${capture.id}`;
        stopCommittedAt = Date.now();
        log('active_stop_committed', { stopMode });
      })().catch((error) => log('active_stop_failed', { name: (error as Error).name }));
    },
    (stopMode !== 'none' ? 15 : long ? 90 * 60 : 75) * 1000,
  );
  let sampling = false;
  const samples = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void p
      .withSystem(async (tx) => {
        const epochs =
          await tx.$queryRaw`SELECT id,state,durable_sequence,durable_end_ms,durable_bytes FROM intel_public_hearing_audio_epoch WHERE capture_id=${capture.id}::uuid ORDER BY created_at`;
        log('sample', {
          elapsedMs: Date.now() - started,
          heap: process.memoryUsage().heapUsed,
          epochs,
        });
      })
      .catch(() => log('sample_unavailable'))
      .finally(() => {
        sampling = false;
      });
  }, 10000);
  try {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await coordinator.run({
        hearingId,
        captureId: capture.id,
        workerId: 'owned-qualification-' + randomUUID(),
      });
      log('attempt_result', result);
      if (stopMode !== 'none') break;
      if (result.action !== 'RECOVERING') break;
      await new Promise((r) => setTimeout(r, Math.max(0, result.dueAt.getTime() - Date.now())));
    }
    if (stopMode !== 'none') {
      if (
        !stopCommittedAt ||
        !processClosedAt ||
        processClosedAt - stopCommittedAt > 30000 ||
        result?.action === 'COMPLETE'
      )
        throw Error('Active source withdrawal did not stop the actual process within 30 seconds');
      const proof = {
        ...metadata,
        finishedAt: new Date().toISOString(),
        stopCommittedAt: new Date(stopCommittedAt).toISOString(),
        processClosedAt: new Date(processClosedAt).toISOString(),
        stopLagMs: processClosedAt - stopCommittedAt,
        result,
        qualification: 'Measured active stop; not a four-hour or deployment qualification',
      };
      writeFileSync(join(out, 'result.json'), JSON.stringify(proof, null, 2));
      log('active_stop_verified', proof);
      return;
    }
    if (result?.action !== 'COMPLETE') throw Error('Server capture did not complete');
    if (!result.gaps.some((g) => g.reason === 'WORKER_RESTART' && g.endMs > g.startMs))
      throw Error('Process recovery must preserve its uncaptured wall-clock gap');
    const epochs = await p.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            state: string;
            durable_bytes: bigint;
            start_ms: bigint;
            durable_end_ms: bigint;
          }>
        >`SELECT * FROM intel_public_hearing_audio_epoch WHERE capture_id=${capture.id}::uuid ORDER BY created_at`,
    );
    const capturedMediaMs = epochs.reduce(
      (sum, epoch) => sum + Number(epoch.durable_end_ms) - Number(epoch.start_ms),
      0,
    );
    if (long && capturedMediaMs < 240 * 60000)
      throw Error('At least four hours of saved media is required; elapsed gaps do not count');
    if (epochs.length < 2 || epochs.some((e) => e.durable_bytes <= 0))
      throw Error('Capture recovery did not produce saved audio attempts');
    for (const epoch of epochs) {
      const parts = await p.withSystem(
        (tx) =>
          tx.$queryRaw<
            Array<{ object_key: string; sha256: string; start_ms: bigint; end_ms: bigint }>
          >`SELECT object_key,sha256,start_ms,end_ms FROM intel_public_hearing_audio_part WHERE epoch_id=${epoch.id} ORDER BY sequence`,
      );
      for (const index of new Set([0, Math.floor(parts.length / 2), parts.length - 1])) {
        const part = parts[index]!;
        const chunks: Buffer[] = [];
        for await (const chunk of await storage.read(part.object_key))
          chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        if (createHash('sha256').update(bytes).digest('hex') !== part.sha256)
          throw Error('Saved audio integrity mismatch');
        const path = join(out, `verified-${epoch.id}-${index}.wav`);
        writeFileSync(path, bytes);
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], {
          windowsHide: true,
        });
        log('saved_audio_decode_verified', {
          epochId: epoch.id,
          part: index,
          startMs: Number(part.start_ms),
          endMs: Number(part.end_ms),
        });
      }
    }
    const finals = await p.$queryRaw<
      Array<{ count: number }>
    >`SELECT count(*)::int AS count FROM public_hearing_transcript_segment WHERE capture_id=${capture.id} AND is_final`;
    if (!finals[0]?.count) throw Error('Known speech did not produce persisted final transcripts');
    const finished = {
      ...metadata,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      capturedMediaMs,
      result,
      epochs,
      finals: finals[0].count,
      qualification: long
        ? 'Actual elapsed server pipeline run; fixture resolver and deployment limits apply'
        : 'Short server smoke test; not four-hour qualification',
    };
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify(
        finished,
        (_, value) => (typeof value === 'bigint' ? Number(value) : value),
        2,
      ),
    );
    log('completed', { elapsedMs: Date.now() - started });
  } catch (error) {
    log('failed', { message: (error as Error).message });
    throw error;
  } finally {
    clearTimeout(fault);
    clearInterval(samples);
    child?.kill('SIGKILL');
    if (runtimeBefore)
      await p.$executeRaw`UPDATE legiwatch_runtime_heartbeat SET enabled=${runtimeBefore.enabled},schedule_enabled=${runtimeBefore.schedule_enabled} WHERE job_key='capture-worker'`;
    await p.$disconnect();
  }
}
void main().catch((error) => {
  console.error('Server qualification failed: ' + (error as Error).message);
  process.exitCode = 1;
});
