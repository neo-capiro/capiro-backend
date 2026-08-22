import { NestFactory } from '@nestjs/core';
import { hostname } from 'node:os';
import { AppModule } from '../../app.module.js';
import {
  LEGIWATCH_PHASE9_API_JOBS,
  LegiWatchPhase9JobsService,
  type LegiWatchPhase9ApiJob,
} from './legiwatch-phase9-jobs.service.js';

async function main(): Promise<void> {
  const job = process.argv[2] as LegiWatchPhase9ApiJob | undefined;
  if (!job || !LEGIWATCH_PHASE9_API_JOBS.includes(job)) {
    throw new Error(
      `Usage: node run-legiwatch-phase9-job.js <${LEGIWATCH_PHASE9_API_JOBS.join('|')}> [--manual]`,
    );
  }
  const manual = process.argv.includes('--manual');
  const limitArg = argumentValue('--limit');
  const limit = limitArg ? Number.parseInt(limitArg, 10) : undefined;
  const workerId =
    process.env.LEGIWATCH_WORKER_ID ??
    `phase9-api:${hostname()}:${process.pid}:${job}`;
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const service = app.get(LegiWatchPhase9JobsService);
    const result = await service.run({
      job,
      workerId,
      manual,
      limit: Number.isFinite(limit) && (limit ?? 0) > 0 ? limit : undefined,
    });
    console.log(JSON.stringify({ job, workerId, manual, result }));
  } finally {
    await app.close();
  }
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
