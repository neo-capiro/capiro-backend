import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Phase9RuntimeHeartbeat } from '../phase9-runtime-heartbeat.js';
import { RecordingStorageService } from './recording-storage.service.js';
import { RecordingAssemblyWorker } from './recording-assembly.worker.js';
import { HearingAnalysisService } from './hearing-analysis.service.js';
import { HearingCryptoService } from '../hearing-crypto.service.js';
import { SegmentCommitService } from '../segment-commit.service.js';
import { OrchestratorClient } from '../orchestrator.client.js';
import { HearingAiCredentialResolver } from '../hearing-ai-credential-resolver.client.js';
import { PublicHearingAudioStore } from '../capture/public-hearing-audio.store.js';
import { TranscriptionRecoveryWorker } from './transcription-recovery.worker.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !/^--limit=[1-9][0-9]?$/.test(arg)) || args.length > 1)
    throw new Error('Usage: hearing-media [--limit=1..20]');
  if (process.env.HEARING_AUDIO_MAINTENANCE_ENABLED !== 'true')
    throw new Error('Hearing media maintenance is disabled');
  const limit = Math.min(20, Number(args[0]?.split('=')[1] ?? 2));
  const prisma = new PrismaService(),
    storage = new RecordingStorageService(new ConfigService());
  const worker = new RecordingAssemblyWorker(prisma, storage);
  const config = new ConfigService(),
    crypto = new HearingCryptoService(config);
  const analysis = new HearingAnalysisService(
    prisma,
    crypto,
    new SegmentCommitService(prisma, crypto),
    new OrchestratorClient(config, new HearingAiCredentialResolver(config)),
  );
  const heartbeat = new Phase9RuntimeHeartbeat(prisma, {
    jobKey: 'hearing-media-worker',
    workerId: `hearing-media:${hostname()}:${process.pid}`,
  });
  try {
    await prisma.$connect();
    await heartbeat.begin();
    const purged = await worker.purgeExpired(),
      recovered = await worker.recoverAbandoned();
    const publicAudio = await new PublicHearingAudioStore(prisma, storage).maintain();
    let assembled = 0;
    for (; assembled < limit; assembled++) {
      const rows = await prisma.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT (enabled AND schedule_enabled) AS enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-media-worker'`;
      if (!rows[0]?.enabled || !(await worker.runOne())) break;
      await heartbeat.beat({ assembled: assembled + 1 });
    }
    let analyzed = 0;
    let retranscribed = 0;
    if (process.env.HEARING_TRANSCRIPTION_RECOVERY_ENABLED === 'true') {
      const recovery = new TranscriptionRecoveryWorker(prisma, storage, crypto);
      await recovery.seed();
      for (; retranscribed < limit; retranscribed++) {
        const rows = await prisma.$queryRaw<
          Array<{ enabled: boolean }>
        >`SELECT (enabled AND schedule_enabled) AS enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-media-worker'`;
        if (!rows[0]?.enabled || !(await recovery.runOne())) break;
        await heartbeat.beat({ assembled, retranscribed: retranscribed + 1 });
      }
    }
    for (; analyzed < 100; analyzed++) {
      const rows = await prisma.$queryRaw<Array<{ enabled: boolean }>>`
        SELECT (enabled AND schedule_enabled) AS enabled FROM legiwatch_runtime_heartbeat WHERE job_key='hearing-media-worker'`;
      if (!rows[0]?.enabled || !(await analysis.runOne())) break;
      await heartbeat.beat({ assembled, analyzed: analyzed + 1 });
    }
    await heartbeat.succeed({ purged, recovered, assembled, analyzed, retranscribed, publicAudio });
    console.log(
      JSON.stringify({ event: 'hearing_media_maintenance', purged, recovered, assembled }),
    );
  } catch (error) {
    await heartbeat.fail(new Error('Hearing media maintenance failed')).catch(() => undefined);
    throw error;
  } finally {
    heartbeat.stopTimer();
    await prisma.$disconnect();
  }
}
void main().catch(() => {
  console.error('Hearing media maintenance failed; inspect recording job status.');
  process.exitCode = 1;
});
