/**
 * Narrow real-HTTP replica for the C-11 process-level profile-lease spec.
 *
 * Each invocation boots its own Nest HTTP server, Prisma pool and production
 * MeriHermesProfileLeaseService. It deliberately installs no signal handler:
 * SIGKILL leaves the database lease behind exactly as an abruptly dead API
 * replica would.
 *
 * Protocol on stdout: READY <replicaName> <port> | FAILED <reason>
 */
import 'reflect-metadata';
import { Body, Controller, HttpCode, Inject, Module, Post, Res } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { meriHermesSharedDbGovernor } from './meri-hermes-db-governor.js';
import {
  MeriHermesProfileLeaseService,
  MeriHermesStaleProfileWriterError,
} from './meri-hermes-profile-lease.service.js';

interface LeaseBody {
  scopeId: string;
  tenantId: string;
  ttlMs?: number;
}

interface WriteBody extends LeaseBody {
  runId: string;
  fence: number;
  key: string;
}

const [replicaName, processRunId] = process.argv.slice(2);

@Controller('lease')
class ProfileLeaseFixtureController {
  constructor(
    @Inject(MeriHermesProfileLeaseService) private readonly profiles: MeriHermesProfileLeaseService,
  ) {}

  @Post('acquire')
  @HttpCode(201)
  async acquire(@Body() body: LeaseBody, @Res() response: Response): Promise<void> {
    let lease;
    try {
      lease = await this.profiles.acquire({
        scopeId: body.scopeId,
        tenantId: body.tenantId,
        runId: processRunId!,
        ttlMs: body.ttlMs,
      });
    } catch (error) {
      response.status(500).json({ code: 'fixture_acquire_failed', detail: String(error) });
      return;
    }
    if (lease) {
      response.status(201).json({ acquired: true, runId: processRunId, fence: lease.fence });
      return;
    }
    const holder = await this.profiles.holder(body.tenantId, body.scopeId);
    response.status(409).json({
      acquired: false,
      runId: processRunId,
      code: 'profile_write_busy',
      holderRunId: holder?.holderRunId ?? null,
      currentFence: holder?.fence ?? null,
    });
  }

  @Post('write')
  @HttpCode(201)
  async write(@Body() body: WriteBody, @Res() response: Response): Promise<void> {
    try {
      const state = await this.profiles.writeSharedProfileState({
        scopeId: body.scopeId,
        tenantId: body.tenantId,
        runId: body.runId,
        fence: body.fence,
        mutate: (current) => ({ ...current, [body.key]: true }),
      });
      response.status(201).json({ state });
    } catch (error) {
      if (!(error instanceof MeriHermesStaleProfileWriterError)) throw error;
      response.status(409).json({
        code: error.code,
        currentHolderRunId: error.currentHolder?.holderRunId ?? null,
        currentFence: error.currentHolder?.fence ?? null,
      });
    }
  }
}

@Module({
  imports: [PrismaModule],
  controllers: [ProfileLeaseFixtureController],
  providers: [
    {
      provide: MeriHermesProfileLeaseService,
      useFactory: (prisma: PrismaService) =>
        new MeriHermesProfileLeaseService(prisma, meriHermesSharedDbGovernor()),
      inject: [PrismaService],
    },
  ],
})
class ProfileLeaseFixtureModule {}

async function main(): Promise<void> {
  if (!replicaName || !processRunId) throw new Error('missing replicaName or runId');
  const app = await NestFactory.create(ProfileLeaseFixtureModule, { logger: ['error'] });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as { port: number };
  // Same orphan safety net as the existing consumer-process fixture.
  setTimeout(() => void app.close().finally(() => process.exit(0)), 120_000);
  process.stdout.write(`READY ${replicaName} ${address.port}\n`);
}

void main().catch((error: unknown) => {
  process.stdout.write(`FAILED ${String(error).replace(/\s+/g, ' ').slice(0, 500)}\n`);
  process.exit(1);
});
