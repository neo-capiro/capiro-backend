#!/usr/bin/env node
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from '../src/app.module.js';
import { CanonicalEntityRegistrationService } from '../src/knowledge/entities/canonical-entity-registration.service.js';
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
  },
});

function parseSource(value: string | undefined): CanonicalPublicReferenceSource {
  if (
    !value ||
    !CANONICAL_PUBLIC_REFERENCE_SOURCES.includes(
      value as CanonicalPublicReferenceSource,
    )
  ) {
    throw new Error(
      `--source is required and must be one of: ${CANONICAL_PUBLIC_REFERENCE_SOURCES.join(', ')}`,
    );
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

async function main(): Promise<void> {
  const source = parseSource(values.source);
  const logger = new Logger('backfill-canonical-public-references');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(PrismaService);
    const registration = app.get(CanonicalEntityRegistrationService);
    const repository = new CanonicalPublicReferenceBackfillRepository(prisma);
    const service = new CanonicalPublicReferenceBackfillService(
      repository,
      registration,
    );

    const result = await service.run({
      source,
      cursor: values.after ?? null,
      limit: parseLimit(values.limit),
      execute: values.execute === true,
    });

    logger.log(JSON.stringify({ event: 'canonical_public_reference_backfill', ...result }));
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    JSON.stringify({
      event: 'canonical_public_reference_backfill.crashed',
      error: message.replace(/[\r\n\t]+/g, ' ').slice(0, 500),
    }),
  );
  process.exit(1);
});
