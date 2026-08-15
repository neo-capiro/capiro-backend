/**
 * Run one resumable Universal Entity Resolution backfill page.
 *
 * Safety/order:
 *   1. confirmed_client_mapping
 *   2. client
 *   3. client_person
 *   4. engagement_contact
 *
 * Process confirmed public-source mappings first so an exact public identity
 * exists before ordinary CRM rows fall back to tenant-private registration.
 * Every invocation is bounded and keyset-paginated. Pass the returned
 * nextCursor back as --after. --dry-run uses resolver.preview and writes
 * nothing, including no EntityResolution history.
 *
 * Usage:
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-canonical-entities.ts \
 *     --tenant <uuid> --source confirmed_client_mapping --dry-run
 *
 *   pnpm --filter @capiro/api exec tsx scripts/backfill-canonical-entities.ts \
 *     --tenant <uuid> --source client --limit 100 --after <uuid>
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { parseArgs } from 'node:util';
import { CanonicalEntityRegistrationRepository } from '../src/knowledge/entities/canonical-entity-registration.repository.js';
import { CanonicalEntityRegistrationService } from '../src/knowledge/entities/canonical-entity-registration.service.js';
import { CanonicalEntityRepository } from '../src/knowledge/entities/canonical-entity.repository.js';
import { CanonicalSourceAdapterService } from '../src/knowledge/entities/canonical-source-adapter.service.js';
import { CanonicalSourceBackfillRepository } from '../src/knowledge/entities/canonical-source-backfill.repository.js';
import { CanonicalSourceBackfillService } from '../src/knowledge/entities/canonical-source-backfill.service.js';
import type { CanonicalBackfillSource } from '../src/knowledge/entities/canonical-source-backfill.types.js';
import { UniversalEntityResolutionService } from '../src/knowledge/entities/universal-entity-resolution.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

const SOURCES = new Set<CanonicalBackfillSource>([
  'confirmed_client_mapping',
  'client',
  'client_person',
  'engagement_contact',
]);

function prismaServiceFromClient(prisma: PrismaClient): PrismaService {
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

function stringArg(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error('limit must be an integer between 1 and 500');
  }
  return parsed;
}

function normalizeSource(value: string | undefined): CanonicalBackfillSource {
  const normalized = value?.trim().toLocaleLowerCase('en-US').replace(/-/g, '_');
  if (!normalized || !SOURCES.has(normalized as CanonicalBackfillSource)) {
    throw new Error(
      `source must be one of: ${[...SOURCES].join(', ')}`,
    );
  }
  return normalized as CanonicalBackfillSource;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      source: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      actor: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const tenantId = stringArg(values.tenant)?.trim();
  if (!tenantId) throw new Error('--tenant is required');

  const prisma = new PrismaClient();
  const prismaLike = prismaServiceFromClient(prisma);
  const entityRepository = new CanonicalEntityRepository(prismaLike);
  const resolver = new UniversalEntityResolutionService(entityRepository);
  const registration = new CanonicalEntityRegistrationService(
    new CanonicalEntityRegistrationRepository(prismaLike),
  );
  const adapter = new CanonicalSourceAdapterService(resolver, registration);
  const backfill = new CanonicalSourceBackfillService(
    new CanonicalSourceBackfillRepository(prismaLike),
    adapter,
  );

  try {
    const result = await backfill.runPage(tenantId, {
      source: normalizeSource(stringArg(values.source)),
      afterId: stringArg(values.after)?.trim() || null,
      limit: positiveInteger(stringArg(values.limit), 100),
      dryRun: values['dry-run'] === true,
      actorUserId: stringArg(values.actor)?.trim() || null,
    });
    console.log(
      JSON.stringify({ event: 'canonical_entity_backfill.page', ...result }),
    );
    if (result.failures.length > 0) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  const errorCode = error instanceof Error ? error.name : 'CanonicalEntityBackfillError';
  console.error(
    JSON.stringify({ event: 'canonical_entity_backfill.crashed', error_code: errorCode }),
  );
  process.exit(1);
});
