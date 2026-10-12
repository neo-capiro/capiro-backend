/**
 * Executable proof that CanonicalSourceBackfillService.runToCompletion
 * genuinely resumes a crashed backfill from its persisted checkpoint rather
 * than silently restarting from scratch or skipping rows.
 *
 * Against a real PostgreSQL database (DATABASE_URL):
 *   1. Seeds two tenants with an identical N-row `clients` corpus each.
 *   2. Runs tenant CLEAN's backfill to completion in one uninterrupted call.
 *   3. Runs tenant RESUMED's backfill bounded to one page (the "crash"), then
 *      constructs a brand-new service instance (a fresh process would do the
 *      same) and calls runToCompletion again with no page bound (the
 *      "restart") — sharing only the persisted checkpoint row, never told the
 *      prior in-memory cursor.
 *   4. Asserts: the resumed run's second call only scans the REMAINING rows
 *      (proving it did not restart from scratch — a from-scratch regression
 *      would double-count them here even though the identity layer's own
 *      idempotency would still prevent duplicate canonical entities); the
 *      final checkpoint accounts for every seeded row exactly once (proving
 *      nothing was skipped); and tenant RESUMED's final canonical
 *      entities/aliases/identifiers are identical in count and in the exact
 *      set of identifiers to tenant CLEAN's uninterrupted run.
 *
 * This script exits nonzero and prints which assertion failed if the crash
 * simulation ever begins from scratch or skips data.
 *
 * Usage:
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:55440/capiro \
 *     pnpm --filter @capiro/api exec tsx scripts/verify-canonical-backfill-checkpoint-resume.ts --verify
 */
/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import type { PrismaService } from '../src/prisma/prisma.service.js';

const TENANT_CLEAN = 'cccccccc-1111-4111-8111-111111111111';
const TENANT_RESUMED = 'dddddddd-2222-4222-8222-222222222222';
const CLIENT_COUNT = 7;
const PAGE_LIMIT = 2;
const CLIENT_NAME_PREFIX = 'Checkpoint Resume Client';

class AssertionFailure extends Error {}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new AssertionFailure(message);
}

async function seedTenantAndClients(prisma: PrismaService, tenantId: string, slug: string): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO tenants (id, slug, name, status)
    VALUES (${tenantId}::uuid, ${slug}, 'Checkpoint Resume Harness', 'active')
    ON CONFLICT (id) DO NOTHING
  `;
  for (let i = 0; i < CLIENT_COUNT; i += 1) {
    await prisma.$executeRaw`
      INSERT INTO clients (tenant_id, name)
      VALUES (${tenantId}::uuid, ${`${CLIENT_NAME_PREFIX} ${i}`})
    `;
  }
}

interface TenantState {
  entityCount: number;
  canonicalNames: string[];
  aliasCount: number;
  crmClientIds: string[];
  duplicateIdentifierGroups: number;
}

async function readTenantState(prisma: PrismaService, tenantId: string): Promise<TenantState> {
  const entities = await prisma.$queryRaw<Array<{ canonical_name: string }>>`
    SELECT canonical_name FROM canonical_entities
    WHERE tenant_id = ${tenantId}::uuid AND identity_scope = 'tenant_private'
    ORDER BY canonical_name
  `;
  const aliasCountRows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM entity_aliases WHERE tenant_id = ${tenantId}::uuid
  `;
  const crmClientIdRows = await prisma.$queryRaw<Array<{ normalized_value: string }>>`
    SELECT normalized_value FROM entity_identifiers
    WHERE tenant_id = ${tenantId}::uuid AND identifier_type = 'crm_client_id'
    ORDER BY normalized_value
  `;
  const duplicateGroups = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM (
      SELECT entity_id, identifier_type, normalized_value
      FROM entity_identifiers
      WHERE tenant_id = ${tenantId}::uuid
      GROUP BY entity_id, identifier_type, normalized_value
      HAVING count(*) > 1
    ) duplicates
  `;

  return {
    entityCount: entities.length,
    canonicalNames: entities.map((row) => row.canonical_name),
    aliasCount: Number(aliasCountRows[0]?.count ?? 0),
    crmClientIds: crmClientIdRows.map((row) => row.normalized_value),
    duplicateIdentifierGroups: Number(duplicateGroups[0]?.count ?? 0),
  };
}

async function cleanup(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`ALTER TABLE entity_resolutions DISABLE TRIGGER USER`;
  try {
    for (const tenantId of [TENANT_CLEAN, TENANT_RESUMED]) {
      await prisma.$executeRaw`DELETE FROM entity_resolutions WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`
        DELETE FROM entity_aliases WHERE entity_id IN (
          SELECT id FROM canonical_entities WHERE tenant_id = ${tenantId}::uuid
        )`;
      await prisma.$executeRaw`
        DELETE FROM entity_identifiers WHERE entity_id IN (
          SELECT id FROM canonical_entities WHERE tenant_id = ${tenantId}::uuid
        )`;
      await prisma.$executeRaw`DELETE FROM canonical_entities WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM clients WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM canonical_entity_backfill_checkpoints WHERE tenant_id = ${tenantId}::uuid`;
      await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}::uuid`;
    }
  } finally {
    await prisma.$executeRaw`ALTER TABLE entity_resolutions ENABLE TRIGGER USER`;
  }
}

async function main(): Promise<void> {
  const usage = 'Usage: tsx scripts/verify-canonical-backfill-checkpoint-resume.ts --verify';
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(usage);
    return;
  }
  if (args.length !== 1 || args[0] !== '--verify') {
    console.error(usage);
    process.exitCode = 2;
    return;
  }

  const { PrismaService } = await import('../src/prisma/prisma.service.js');
  const { CanonicalEntityRegistrationRepository } = await import('../src/knowledge/entities/canonical-entity-registration.repository.js');
  const { CanonicalEntityRegistrationService } = await import('../src/knowledge/entities/canonical-entity-registration.service.js');
  const { CanonicalEntityRepository } = await import('../src/knowledge/entities/canonical-entity.repository.js');
  const { CanonicalEntityBackfillCheckpointRepository } = await import('../src/knowledge/entities/canonical-entity-backfill-checkpoint.repository.js');
  const { CanonicalSourceAdapterService } = await import('../src/knowledge/entities/canonical-source-adapter.service.js');
  const { CanonicalSourceBackfillRepository } = await import('../src/knowledge/entities/canonical-source-backfill.repository.js');
  const { CanonicalSourceBackfillService } = await import('../src/knowledge/entities/canonical-source-backfill.service.js');
  const { UniversalEntityResolutionService } = await import('../src/knowledge/entities/universal-entity-resolution.service.js');

  function newService(prisma: PrismaService): InstanceType<typeof CanonicalSourceBackfillService> {
    const entityRepository = new CanonicalEntityRepository(prisma);
    const resolver = new UniversalEntityResolutionService(entityRepository);
    const registration = new CanonicalEntityRegistrationService(
      new CanonicalEntityRegistrationRepository(prisma),
    );
    const adapter = new CanonicalSourceAdapterService(resolver, registration);
    return new CanonicalSourceBackfillService(
      new CanonicalSourceBackfillRepository(prisma),
      adapter,
      new CanonicalEntityBackfillCheckpointRepository(prisma),
    );
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    await cleanup(prisma);
    await seedTenantAndClients(prisma, TENANT_CLEAN, 'checkpoint-resume-clean');
    await seedTenantAndClients(prisma, TENANT_RESUMED, 'checkpoint-resume-crashed');

    // --- Uninterrupted clean run ---
    const cleanResult = await newService(prisma).runToCompletion(TENANT_CLEAN, {
      source: 'client',
      limit: PAGE_LIMIT,
    });
    assert(cleanResult.checkpoint.status === 'completed', 'clean run did not reach completed status');
    assert(cleanResult.checkpoint.scanned === CLIENT_COUNT, 'clean run scanned count does not match seeded corpus');

    // --- Crash after exactly one bounded page ---
    const crashed = await newService(prisma).runToCompletion(TENANT_RESUMED, {
      source: 'client',
      limit: PAGE_LIMIT,
      maxPages: 1,
    });
    assert(crashed.checkpoint.status === 'running', 'expected the checkpoint to still be running after the simulated crash');
    assert(
      crashed.checkpoint.scanned === PAGE_LIMIT,
      `expected exactly ${PAGE_LIMIT} rows scanned before the crash, got ${crashed.checkpoint.scanned}`,
    );
    const scannedBeforeCrash = crashed.checkpoint.scanned;

    // --- "Restart": a brand-new service instance, told nothing but the DB. ---
    const resumed = await newService(prisma).runToCompletion(TENANT_RESUMED, {
      source: 'client',
      limit: PAGE_LIMIT,
    });
    const scannedDuringResume = resumed.pages.reduce((sum, page) => sum + page.scanned, 0);

    assert(resumed.checkpoint.status === 'completed', 'resumed run did not reach completed status');
    assert(
      scannedDuringResume === CLIENT_COUNT - scannedBeforeCrash,
      `resume scanned ${scannedDuringResume} rows after the crash, expected exactly ` +
        `${CLIENT_COUNT - scannedBeforeCrash} (a from-scratch restart would re-scan the whole corpus instead)`,
    );
    assert(
      resumed.checkpoint.scanned === CLIENT_COUNT,
      `final checkpoint scanned=${resumed.checkpoint.scanned}, expected exactly ${CLIENT_COUNT} (a skipped row would undercount, a restart would overcount)`,
    );
    assert(
      resumed.checkpoint.created === CLIENT_COUNT,
      `final checkpoint created=${resumed.checkpoint.created}, expected exactly ${CLIENT_COUNT}`,
    );

    // --- Compare final DB state: resumed run vs. the clean uninterrupted run ---
    const cleanState = await readTenantState(prisma, TENANT_CLEAN);
    const resumedState = await readTenantState(prisma, TENANT_RESUMED);

    assert(
      resumedState.entityCount === CLIENT_COUNT,
      `resumed tenant has ${resumedState.entityCount} canonical entities, expected exactly ${CLIENT_COUNT}`,
    );
    assert(
      resumedState.entityCount === cleanState.entityCount,
      `resumed (${resumedState.entityCount}) and clean (${cleanState.entityCount}) canonical entity counts differ`,
    );
    assert(
      JSON.stringify(resumedState.canonicalNames) === JSON.stringify(cleanState.canonicalNames),
      'resumed and clean runs produced a different set of canonical names',
    );
    assert(
      resumedState.aliasCount === cleanState.aliasCount,
      `resumed (${resumedState.aliasCount}) and clean (${cleanState.aliasCount}) alias counts differ`,
    );
    assert(resumedState.duplicateIdentifierGroups === 0, 'resumed run produced duplicate entity identifiers');
    assert(cleanState.duplicateIdentifierGroups === 0, 'clean run produced duplicate entity identifiers');
    assert(
      resumedState.crmClientIds.length === CLIENT_COUNT,
      `resumed run has ${resumedState.crmClientIds.length} distinct crm_client_id identifiers, expected exactly ${CLIENT_COUNT} (no skipped or duplicated record)`,
    );

    const report = {
      event: 'canonical_entity_backfill.checkpoint_resume_verification',
      clientCount: CLIENT_COUNT,
      pageLimit: PAGE_LIMIT,
      clean: { checkpoint: cleanResult.checkpoint, state: cleanState },
      crashedAfterRows: scannedBeforeCrash,
      resumed: { checkpoint: resumed.checkpoint, state: resumedState, pagesRunAfterResume: resumed.pages.length },
      pass: true,
    };
    console.log(JSON.stringify(report, null, 2));
    console.error('\nPASS — resume continued from the persisted checkpoint; no restart, no skipped rows, no duplicates.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      JSON.stringify({
        event: 'canonical_entity_backfill.checkpoint_resume_verification',
        pass: false,
        failure: error instanceof AssertionFailure ? message : `unexpected error: ${message}`,
      }),
    );
    process.exitCode = 1;
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      event: 'canonical_entity_backfill.checkpoint_resume_verification_crashed',
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
