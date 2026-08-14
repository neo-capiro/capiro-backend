/**
 * Drain durable mailbox KnowledgeEvent work.
 *
 * This is an out-of-band worker. EventBridge / ECS starts a short-lived task;
 * concurrent invocations are safe because claims use FOR UPDATE SKIP LOCKED.
 * The queue payload is only job IDs and revision identifiers — the worker
 * reloads the tenant-scoped mail_messages row from Postgres.
 *
 * Usage:
 *   drain-mailbox-knowledge [batch-size]
 *
 * Exits non-zero when any claimed job failed so EventBridge/ECS and CloudWatch
 * surface the run instead of treating a partial drain as healthy.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { KnowledgeEventRepository } from '../src/knowledge/events/knowledge-event.repository.js';
import { KnowledgeEventService } from '../src/knowledge/events/knowledge-event.service.js';
import { MailboxKnowledgeConsumer } from '../src/knowledge/mailbox/mailbox-knowledge.consumer.js';
import { MailboxKnowledgeFlagsService } from '../src/knowledge/mailbox/mailbox-knowledge-flags.service.js';
import { MailboxKnowledgeRepository } from '../src/knowledge/mailbox/mailbox-knowledge.repository.js';
import { MailboxNormalizerService } from '../src/knowledge/mailbox/mailbox-normalizer.service.js';
import { MailboxRelevanceService } from '../src/knowledge/mailbox/mailbox-relevance.service.js';
import { MailboxThreadService } from '../src/knowledge/mailbox/mailbox-thread.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

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

async function main(): Promise<void> {
  const limit = positiveInteger(process.argv[2], 10, 'batch size');
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
    const summary = await consumer.drainOnce();
    console.log(JSON.stringify({ event: 'mailbox_knowledge_worker.drain', ...summary }));
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : 'WorkerError';
  console.error(JSON.stringify({ event: 'mailbox_knowledge_worker.crashed', error_code: errorName }));
  process.exit(1);
});
