#!/usr/bin/env node
/**
 * Pass --resume for a durable, checkpointed run instead of one manual page:
 * this reads the persisted cursor for this global source from
 * canonical_entity_backfill_checkpoints, loops pages until the source is
 * exhausted or a row fails, and is safe to invoke again after a crash — it
 * resumes from the last committed page rather than restarting.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-canonical-public-references.ts \
 *     --source federal_contractors --execute --resume
 */
import { parseArgs } from 'node:util';
import { CanonicalEntityRegistrationService } from '../src/knowledge/entities/canonical-entity-registration.service.js';
import { CanonicalEntityRegistrationRepository } from '../src/knowledge/entities/canonical-entity-registration.repository.js';
import { CanonicalEntityBackfillCheckpointRepository } from '../src/knowledge/entities/canonical-entity-backfill-checkpoint.repository.js';
import { CanonicalPublicReferenceBackfillRepository } from '../src/knowledge/entities/canonical-public-reference-backfill.repository.js';
import { CanonicalPublicReferenceBackfillService } from '../src/knowledge/entities/canonical-public-reference-backfill.service.js';
import {
  CANONICAL_PUBLIC_REFERENCE_SOURCES,
  type CanonicalPublicReferenceSource,
} from '../src/knowledge/entities/canonical-public-reference-backfill.types.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const { values } = parseArgs({
  options: {
    source: { type: 'string' },
    after: { type: 'string' },
    limit: { type: 'string' },
    execute: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    'max-pages': { type: 'string' },
  },
});

function parseSource(value: string | undefined): CanonicalPublicReferenceSource {
  if (!value || !CANONICAL_PUBLIC_REFERENCE_SOURCES.includes(value as CanonicalPublicReferenceSource)) {
    throw new Error(`--source is required and must be one of: ${CANONICAL_PUBLIC_REFERENCE_SOURCES.join(', ')}`);
  }
  return value as CanonicalPublicReferenceSource;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }
  return parsed;
}

function parseMaxPages(value: string | undefined): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('--max-pages must be a positive integer');
  }
  return parsed;
}

async function main(): Promise<void> {
  const source = parseSource(values.source);
  // AppModule validates web-only Clerk secrets. A database backfill CLI must not
  // require those unrelated application credentials just to read source rows.
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    const registration = new CanonicalEntityRegistrationService(
      new CanonicalEntityRegistrationRepository(prisma),
    );
    const service = new CanonicalPublicReferenceBackfillService(
      new CanonicalPublicReferenceBackfillRepository(prisma),
      registration,
      new CanonicalEntityBackfillCheckpointRepository(prisma),
    );
    const execute = values.execute === true && values['dry-run'] !== true;

    if (values.resume === true) {
      const { pages, checkpoint } = await service.runToCompletion({
        source,
        limit: parseLimit(values.limit),
        execute,
        maxPages: parseMaxPages(values['max-pages']),
      });
      console.log(
        JSON.stringify({
          event: 'canonical_public_reference_backfill.resume',
          pagesRun: pages.length,
          checkpoint,
        }),
      );
      if (checkpoint.status === 'failed' || pages.some((page) => page.failures.length > 0)) {
        process.exitCode = 1;
      }
      return;
    }

    const result = await service.run({
      source,
      cursor: values.after ?? null,
      limit: parseLimit(values.limit),
      execute,
    });

    console.log(JSON.stringify({ event: 'canonical_public_reference_backfill', ...result }));
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    event: 'canonical_public_reference_backfill.crashed',
    error: message.replace(/[\r\n\t]+/g, ' ').slice(0, 500),
  }));
  process.exit(1);
});
