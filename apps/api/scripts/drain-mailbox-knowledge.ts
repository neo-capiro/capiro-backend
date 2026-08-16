/**
 * Drain durable mailbox KnowledgeEvent work, then the Phase 6 post-event
 * extraction outbox, then the Phase 7 episode projection outbox.
 *
 * Phase 4 remains an out-of-band deterministic worker. Phase 6 retains its
 * private-text extraction control. Phase 7 is a normal Knowledge Plane
 * projection consumer: it has operational batch/retry tuning only and is
 * not feature-flagged or tenant-allowlisted. The shared ECS verb is retained
 * so no second scheduler or deployment path is introduced.
 *
 * Usage:
 *   drain-mailbox-knowledge [batch-size]
 */
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaClient, type Prisma } from '@prisma/client';
import { KnowledgeEventRepository } from '../src/knowledge/events/knowledge-event.repository.js';
import { KnowledgeEventService } from '../src/knowledge/events/knowledge-event.service.js';
import { KnowledgeModule } from '../src/knowledge/knowledge.module.js';
import { KnowledgeEpisodeProjectionConsumer } from '../src/knowledge/episodes/knowledge-episode.consumer.js';
import { MailboxKnowledgeConsumer } from '../src/knowledge/mailbox/mailbox-knowledge.consumer.js';
import { MailboxKnowledgeExtractionConsumer } from '../src/knowledge/mailbox/mailbox-knowledge-extraction.consumer.js';
import { MailboxKnowledgeFlagsService } from '../src/knowledge/mailbox/mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from '../src/knowledge/mailbox/mailbox-knowledge.repository.js';
import { MailboxNormalizerService } from '../src/knowledge/mailbox/mailbox-normalizer.service.js';
import { MailboxRelevanceService } from '../src/knowledge/mailbox/mailbox-relevance.service.js';
import { MailboxThreadService } from '../src/knowledge/mailbox/mailbox-thread.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

function workerConfigDefaults() {
  return {
    OPENAI_MODEL: process.env.OPENAI_MODEL ?? 'gpt-4.1-mini',
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5-20251001',
    CLIO_WEB_SEARCH_PROVIDER: process.env.CLIO_WEB_SEARCH_PROVIDER ?? 'duckduckgo',
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [workerConfigDefaults],
    }),
    KnowledgeModule,
  ],
})
class MailboxKnowledgeExtractionWorkerModule {}

function positiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

function mailboxKnowledgePrismaFromClient(prisma: PrismaClient): PrismaService {
  return Object.assign(prisma, {
    withSystem: <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
    withTenant: <T>(
      tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
        return fn(tx as unknown as Prisma.TransactionClient);
      }),
  }) as unknown as PrismaService;
}

async function drainPhase4(limit: number) {
  if (process.env.MAILBOX_KNOWLEDGE_BATCH_SIZE === undefined) {
    process.env.MAILBOX_KNOWLEDGE_BATCH_SIZE = String(limit);
  }

  const prisma = new PrismaClient();
  const prismaLike = mailboxKnowledgePrismaFromClient(prisma);
  const consumer = new MailboxKnowledgeConsumer(
    new MailboxKnowledgeFlagsService(),
    new MailboxKnowledgeRepository(prismaLike),
    new MailboxNormalizerService(),
    new MailboxRelevanceService(),
    new MailboxThreadService(),
    new KnowledgeEventService(new KnowledgeEventRepository(prismaLike)),
  );

  try {
    return await consumer.drainOnce();
  } finally {
    await prisma.$disconnect();
  }
}

async function drainPhase6() {
  const flags = new MailboxKnowledgeFlagsService();
  if (!flags.extractionEnabled()) {
    return { claimed: 0, succeeded: 0, skipped: 0, failed: 0 };
  }

  const app = await NestFactory.createApplicationContext(
    MailboxKnowledgeExtractionWorkerModule,
    { logger: ['error', 'warn'] },
  );
  try {
    return await app.get(MailboxKnowledgeExtractionConsumer).drainOnce();
  } finally {
    await app.close();
  }
}

async function drainPhase7() {
  const app = await NestFactory.createApplicationContext(
    MailboxKnowledgeExtractionWorkerModule,
    { logger: ['error', 'warn'] },
  );
  try {
    return await app.get(KnowledgeEpisodeProjectionConsumer).drainOnce();
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  const limit = positiveInteger(process.argv[2], 10, 'batch size');
  const phase4 = await drainPhase4(limit);
  console.log(JSON.stringify({ event: 'mailbox_knowledge_worker.drain', ...phase4 }));

  const phase6 = await drainPhase6();
  console.log(JSON.stringify({ event: 'mailbox_knowledge_extraction_worker.drain', ...phase6 }));

  const phase7 = await drainPhase7();
  console.log(JSON.stringify({ event: 'knowledge_episode_projection_worker.drain', ...phase7 }));

  if (phase4.failed > 0 || phase6.failed > 0 || phase7.failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'WorkerError';
  console.error(JSON.stringify({ event: 'mailbox_knowledge_worker.crashed', error_code: errorName }));
  process.exit(1);
});
