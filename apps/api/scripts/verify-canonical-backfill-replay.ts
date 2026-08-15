/**
 * Verify one data-bearing tenant canonical-identity backfill cohort is
 * idempotent when replayed with the exact same source/cursor/limit.
 *
 * This command is intentionally manual and bounded. It never schedules work.
 * Run only against disposable or explicitly designated development databases.
 *
 * Example:
 *   pnpm --filter @capiro/api exec tsx scripts/verify-canonical-backfill-replay.ts \
 *     --tenant <uuid> --source client --limit 10
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { parseArgs } from 'node:util';
import {
  evaluateCanonicalBackfillReplay,
  type CanonicalBackfillReplaySnapshot,
} from '../src/knowledge/entities/canonical-backfill-replay-evaluator.js';
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

interface EntityIdRow {
  id: string;
}
interface AliasRow {
  entity_id: string;
  tenant_id: string | null;
  identity_scope: string;
  normalized_alias: string;
  source_type: string;
  source_id: string | null;
  status: string;
}
interface IdentifierRow {
  entity_id: string;
  tenant_id: string | null;
  identity_scope: string;
  identifier_type: string;
  normalized_value: string;
  source_type: string;
  source_id: string | null;
  status: string;
}
interface ResolutionRow {
  idempotency_key: string;
  selected_entity_id: string | null;
}

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
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error('limit must be an integer between 1 and 100');
  }
  return parsed;
}

function normalizeSource(value: string | undefined): CanonicalBackfillSource {
  const normalized = value?.trim().toLocaleLowerCase('en-US').replace(/-/g, '_');
  if (!normalized || !SOURCES.has(normalized as CanonicalBackfillSource)) {
    throw new Error(`source must be one of: ${[...SOURCES].join(', ')}`);
  }
  return normalized as CanonicalBackfillSource;
}

async function snapshot(
  prisma: PrismaClient,
  tenantId: string,
  cursor: string | null,
): Promise<CanonicalBackfillReplaySnapshot> {
  const [entities, aliases, identifiers, resolutions] = await Promise.all([
    prisma.$queryRaw<EntityIdRow[]>`
      SELECT id
      FROM canonical_entities
      WHERE status = 'active'
        AND (identity_scope = 'global_public' OR tenant_id = ${tenantId}::uuid)
      ORDER BY id
    `,
    prisma.$queryRaw<AliasRow[]>`
      SELECT entity_id, tenant_id, identity_scope, normalized_alias,
             source_type, source_id, status
      FROM entity_aliases
      WHERE identity_scope = 'global_public' OR tenant_id = ${tenantId}::uuid
      ORDER BY entity_id, identity_scope, normalized_alias, source_type, source_id
    `,
    prisma.$queryRaw<IdentifierRow[]>`
      SELECT entity_id, tenant_id, identity_scope, identifier_type,
             normalized_value, source_type, source_id, status
      FROM entity_identifiers
      WHERE identity_scope = 'global_public' OR tenant_id = ${tenantId}::uuid
      ORDER BY entity_id, identity_scope, identifier_type, normalized_value,
               source_type, source_id
    `,
    prisma.$queryRaw<ResolutionRow[]>`
      SELECT idempotency_key, selected_entity_id
      FROM entity_resolutions
      WHERE tenant_id = ${tenantId}::uuid
      ORDER BY idempotency_key
    `,
  ]);

  return {
    entityIds: entities.map((row) => row.id),
    aliasKeys: aliases.map(
      (row) =>
        `${row.entity_id}|${row.tenant_id ?? 'global'}|${row.identity_scope}|${row.normalized_alias}|${row.source_type}|${row.source_id ?? ''}|${row.status}`,
    ),
    identifierKeys: identifiers.map(
      (row) =>
        `${row.entity_id}|${row.tenant_id ?? 'global'}|${row.identity_scope}|${row.identifier_type}|${row.normalized_value}|${row.source_type}|${row.source_id ?? ''}|${row.status}`,
    ),
    resolutions: resolutions.map((row) => ({
      key: row.idempotency_key,
      selectedEntityId: row.selected_entity_id,
    })),
    cursor,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      source: { type: 'string' },
      after: { type: 'string' },
      limit: { type: 'string' },
      actor: { type: 'string' },
    },
  });

  const tenantId = stringArg(values.tenant)?.trim();
  if (!tenantId) throw new Error('--tenant is required');
  const source = normalizeSource(stringArg(values.source));
  const afterId = stringArg(values.after)?.trim() || null;
  const limit = positiveInteger(stringArg(values.limit), 10);
  const actorUserId = stringArg(values.actor)?.trim() || null;

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

  const options = {
    source,
    afterId,
    limit,
    dryRun: false,
    actorUserId,
  } as const;

  try {
    const first = await backfill.runPage(tenantId, options);
    if (first.failures.length > 0) {
      throw new Error(`first replay pass failed for ${first.failures.length} row(s)`);
    }
    if (first.scanned === 0) {
      throw new Error(
        'bounded replay requires a data-bearing cohort; this source/cursor returned zero rows',
      );
    }
    const firstSnapshot = await snapshot(prisma, tenantId, first.nextCursor);

    const second = await backfill.runPage(tenantId, options);
    if (second.failures.length > 0) {
      throw new Error(`second replay pass failed for ${second.failures.length} row(s)`);
    }
    if (second.scanned !== first.scanned) {
      throw new Error(
        `replay scanned ${second.scanned} rows after first pass scanned ${first.scanned}`,
      );
    }
    const secondSnapshot = await snapshot(prisma, tenantId, second.nextCursor);
    const report = evaluateCanonicalBackfillReplay(firstSnapshot, secondSnapshot);

    console.log(
      JSON.stringify({
        event: 'canonical_entity_backfill.replay_verification',
        tenantId,
        source,
        afterId,
        limit,
        first: {
          scanned: first.scanned,
          counts: first.counts,
          nextCursor: first.nextCursor,
          complete: first.complete,
        },
        second: {
          scanned: second.scanned,
          counts: second.counts,
          nextCursor: second.nextCursor,
          complete: second.complete,
        },
        report,
      }),
    );

    if (!report.pass) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'canonical_entity_backfill.replay_verification_crashed',
      error: error instanceof Error ? error.message : 'unknown error',
    }),
  );
  process.exit(1);
});
