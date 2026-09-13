import 'reflect-metadata';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { RecordingStorageService } from '../../src/hearing/recording/recording-storage.service.js';
import { HearingCryptoService } from '../../src/hearing/hearing-crypto.service.js';
import { TranscriptionRecoveryWorker } from '../../src/hearing/recording/transcription-recovery.worker.js';
async function main() {
  if (
    process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
    !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
  )
    throw Error('Local disposable database required');
  const epochId = process.argv[2],
    output = process.env.PHASE4_RECOVERY_OUTPUT;
  if (!epochId || !output || !process.env.DEEPGRAM_API_KEY)
    throw Error('Explicit saved epoch and qualification environment required');
  const p = new PrismaService(),
    config = new ConfigService(),
    worker = new TranscriptionRecoveryWorker(
      p,
      new RecordingStorageService(config),
      new HearingCryptoService(config),
    );
  const started = new Date();
  const sourceHashes = Object.fromEntries(
    [
      'src/hearing/recording/transcription-recovery.worker.ts',
      'src/hearing/recording/transcription-recovery-domain.ts',
    ].map((path) => [path, createHash('sha256').update(readFileSync(path)).digest('hex')]),
  );
  try {
    await worker.seed(epochId);
    for (let i = 0; i < 200; i++) {
      if (!(await worker.runOne(epochId))) break;
      const rows = await p.withSystem(
        (tx) =>
          tx.$queryRaw<
            Array<{ state: string; cursor_ms: bigint }>
          >`SELECT state,cursor_ms FROM intel_hearing_transcription_recovery WHERE epoch_id=${epochId}`,
      );
      console.log(
        JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? Number(value) : value)),
      );
      if (rows[0]?.state === 'ready') break;
    }
    const jobs = await p.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{ state: string }>
        >`SELECT kind,epoch_id,state,cursor_ms,attempts,recovered_segments,last_error FROM intel_hearing_transcription_recovery WHERE epoch_id=${epochId}`,
    );
    writeFileSync(
      resolve(output),
      JSON.stringify(
        {
          started,
          finished: new Date(),
          sourceHashes,
          source: 'owned saved audio; real Deepgram Nova-3 REST repair',
          jobs,
        },
        (_, value) => (typeof value === 'bigint' ? Number(value) : value),
        2,
      ),
    );
    if (jobs[0]?.state !== 'ready')
      throw Error('Recovery did not finish; inspect persisted job state');
  } finally {
    await p.$disconnect();
  }
}
void main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
