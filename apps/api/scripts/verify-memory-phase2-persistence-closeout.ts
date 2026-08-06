import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { assertMemoryPhase2PersistenceContract } from './lib/memory-phase2-persistence-contract.js';

const PHASE1 = '20260818010000_memory_phase2_review_workflow_foundation';
const PHASE2 = '20260818020000_memory_phase2_revision_lineage';
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..');
const prismaRoot = join(apiRoot, 'prisma');
const migrationRoot = join(prismaRoot, 'migrations');

interface FixtureIds {
  tenantId: string;
  proposerId: string;
  reviewerId: string;
  otherUserId: string;
  predecessorId: string;
}

async function main(): Promise<void> {
  runStaticContract();
  run('pnpm', ['exec', 'prisma', 'validate', '--schema', 'prisma/schema.prisma']);
  run('pnpm', ['exec', 'prisma', 'generate', '--schema', 'prisma/schema.prisma']);

  const cleanUrl = requireDisposableUrl('MEMORY_PHASE2_CLEAN_DATABASE_URL');
  const upgradeUrl = requireDisposableUrl('MEMORY_PHASE2_UPGRADE_DATABASE_URL');
  if (cleanUrl === upgradeUrl) throw new Error('Clean and upgrade database URLs must differ.');

  await assertEmptyDatabase(cleanUrl, 'clean');
  await assertEmptyDatabase(upgradeUrl, 'upgrade');

  runMigrateDeploy(cleanUrl, join(prismaRoot, 'schema.prisma'));
  await runDatabaseAcceptance(cleanUrl, fixtureIds('clean'));

  const temporaryPrismaRoot = buildPrePhaseMigrationTree();
  try {
    const temporarySchema = join(temporaryPrismaRoot, 'schema.prisma');
    runMigrateDeploy(upgradeUrl, temporarySchema);
    const upgradeFixture = fixtureIds('upgrade');
    await seedCandidate(upgradeUrl, upgradeFixture);

    copyMigration(PHASE1, temporaryPrismaRoot);
    runMigrateDeploy(upgradeUrl, temporarySchema);
    await markChangesRequested(upgradeUrl, upgradeFixture);

    copyMigration(PHASE2, temporaryPrismaRoot);
    runMigrateDeploy(upgradeUrl, temporarySchema);
    await runDatabaseAcceptance(upgradeUrl, upgradeFixture, { alreadySeeded: true });
  } finally {
    rmSync(dirname(temporaryPrismaRoot), { recursive: true, force: true });
  }

  process.stdout.write('MEMORY_PHASE2_PERSISTENCE_CLOSEOUT_COMPLETE\n');
}

function runStaticContract(): void {
  const read = (relativePath: string) => readFileSync(join(apiRoot, relativePath), 'utf8');
  assertMemoryPhase2PersistenceContract({
    prismaSchema: read('prisma/schema.prisma'),
    workflowMigration: read(`prisma/migrations/${PHASE1}/migration.sql`),
    revisionMigration: read(`prisma/migrations/${PHASE2}/migration.sql`),
    revisionService: read('src/memory/memory-review-revision.service.ts'),
  });
}

function buildPrePhaseMigrationTree(): string {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'capiro-memory-phase2-'));
  const targetPrisma = join(temporaryRoot, 'prisma');
  const targetMigrations = join(targetPrisma, 'migrations');
  mkdirSync(targetMigrations, { recursive: true });
  cpSync(join(prismaRoot, 'schema.prisma'), join(targetPrisma, 'schema.prisma'));
  const lock = join(migrationRoot, 'migration_lock.toml');
  if (existsSync(lock)) cpSync(lock, join(targetMigrations, 'migration_lock.toml'));

  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === PHASE1 || entry.name === PHASE2) continue;
    cpSync(join(migrationRoot, entry.name), join(targetMigrations, entry.name), {
      recursive: true,
    });
  }
  return targetPrisma;
}

function copyMigration(name: string, targetPrismaRoot: string): void {
  cpSync(join(migrationRoot, name), join(targetPrismaRoot, 'migrations', name), {
    recursive: true,
  });
}

function runMigrateDeploy(databaseUrl: string, schemaPath: string): void {
  run('pnpm', ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    DATABASE_URL: databaseUrl,
  });
}

function run(command: string, args: string[], env: Record<string, string> = {}): void {
  const executable = process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command;
  const result = spawnSync(executable, args, {
    cwd: apiRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}).\n${result.stdout}\n${result.stderr}`,
    );
  }
  process.stdout.write(result.stdout);
}

function requireDisposableUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  const localHost = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  const databaseName = basename(parsed.pathname).toLowerCase();
  if (!localHost || !databaseName.includes('memory_phase2')) {
    throw new Error(`${name} must target a disposable local database named with memory_phase2.`);
  }
  return value;
}

async function assertEmptyDatabase(databaseUrl: string, label: string): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ table_count: number }>>(
      `SELECT count(*)::int AS table_count
       FROM pg_catalog.pg_tables
       WHERE schemaname = 'public'
         AND tablename <> '_prisma_migrations'`,
    );
    if ((rows[0]?.table_count ?? 0) !== 0) {
      throw new Error(`${label} database is not empty; refusing a destructive closeout run.`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function runDatabaseAcceptance(
  databaseUrl: string,
  ids: FixtureIds,
  options: { alreadySeeded?: boolean } = {},
): Promise<void> {
  if (!options.alreadySeeded) {
    await seedCandidate(databaseUrl, ids);
    await markChangesRequested(databaseUrl, ids);
  }

  await assertContextGuards(databaseUrl, ids);
  const memoryCountsBefore = await activeMemoryCounts(databaseUrl, ids.tenantId);
  const winner = await createConcurrentSuccessor(databaseUrl, ids);
  await assertLineage(databaseUrl, ids, winner);
  await assertCompatibilityDecisionGuard(databaseUrl, ids, winner);
  const memoryCountsAfter = await activeMemoryCounts(databaseUrl, ids.tenantId);
  if (
    memoryCountsAfter.memory_items !== memoryCountsBefore.memory_items ||
    memoryCountsAfter.clio_memory !== memoryCountsBefore.clio_memory
  ) {
    throw new Error('Revision closeout mutated active memory tables.');
  }
}

async function seedCandidate(databaseUrl: string, ids: FixtureIds): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO tenants (id, slug, name, status)
         VALUES ($1::uuid, $2, $3, 'active'::tenant_status)`,
        ids.tenantId,
        `memory-phase2-${ids.tenantId.slice(0, 8)}`,
        'Memory Phase 2 Test Tenant',
      );
      for (const [userId, clerkId, email] of [
        [ids.proposerId, `clerk-${ids.proposerId}`, `proposer-${ids.proposerId}@example.test`],
        [ids.reviewerId, `clerk-${ids.reviewerId}`, `reviewer-${ids.reviewerId}@example.test`],
        [ids.otherUserId, `clerk-${ids.otherUserId}`, `other-${ids.otherUserId}@example.test`],
      ]) {
        await tx.$executeRawUnsafe(
          `INSERT INTO users (id, clerk_user_id, email)
           VALUES ($1::uuid, $2, $3::citext)`,
          userId,
          clerkId,
          email,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO tenant_memberships (tenant_id, user_id, role, status, joined_at)
           VALUES ($1::uuid, $2::uuid, 'user_admin'::tenant_role,
                   'active'::membership_status, now())`,
          ids.tenantId,
          userId,
        );
      }
      await setContext(tx, ids.tenantId, ids.proposerId);
      await tx.$executeRawUnsafe(
        `INSERT INTO memory_candidate (
           id, tenant_id, proposed_by, source_kind, scope,
           payload_jsonb, provenance_jsonb, status
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'settings_sections', 'firm',
           $4::jsonb, $5::jsonb, 'pending'
         )`,
        ids.predecessorId,
        ids.tenantId,
        ids.proposerId,
        JSON.stringify({
          key: 'settings-file:firm-soul:firm',
          value: '[{"key":"mission","body":"Original"}]',
          source: 'settings_memory_editor',
          scope: 'firm',
          canonicalItem: {
            type: 'firm-soul',
            slug: 'firm',
            title: 'Firm Soul',
            sections: [
              { key: 'mission', heading: 'Mission', owner: 'human', body: 'Original' },
            ],
          },
        }),
        JSON.stringify({ tool: 'memory_phase2_closeout' }),
      );
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function markChangesRequested(databaseUrl: string, ids: FixtureIds): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.reviewerId);
      const updated = await tx.$executeRawUnsafe(
        `UPDATE review_request
         SET assigned_to = $1::uuid,
             status = 'changes_needed',
             reason = 'Add the underlying source.',
             decided_by = $1::uuid,
             decided_at = now()
         WHERE tenant_id = $2::uuid
           AND surface = 'memory'
           AND subject_type = 'memory_candidate'
           AND subject_id = $3`,
        ids.reviewerId,
        ids.tenantId,
        ids.predecessorId,
      );
      if (updated !== 1) throw new Error('Expected one changes-requested workflow row.');
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function assertContextGuards(databaseUrl: string, ids: FixtureIds): Promise<void> {
  const cases = [
    {
      name: 'cross-tenant',
      tenantContext: randomUUID(),
      actorContext: ids.proposerId,
      bypass: false,
      code: 'MEMORY_REVISION_TENANT_CONTEXT_REQUIRED',
    },
    {
      name: 'wrong-actor',
      tenantContext: ids.tenantId,
      actorContext: ids.otherUserId,
      bypass: false,
      code: 'MEMORY_REVISION_ACTOR_CONTEXT_REQUIRED',
    },
    {
      name: 'system-bypass',
      tenantContext: ids.tenantId,
      actorContext: ids.proposerId,
      bypass: true,
      code: 'MEMORY_REVISION_SYSTEM_BYPASS_DENIED',
    },
  ];

  for (const testCase of cases) {
    const prisma = client(databaseUrl);
    try {
      let message = '';
      try {
        await prisma.$transaction(async (tx) => {
          await setContext(tx, testCase.tenantContext, testCase.actorContext);
          if (testCase.bypass) {
            await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
          }
          await callRevision(tx, ids, randomUUID());
        });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (!message.includes(testCase.code)) {
        throw new Error(`${testCase.name} guard did not fail with ${testCase.code}.`);
      }
    } finally {
      await prisma.$disconnect();
    }
  }
}

async function createConcurrentSuccessor(databaseUrl: string, ids: FixtureIds): Promise<string> {
  const successors = [randomUUID(), randomUUID()];
  const attempts = successors.map(async (successorId) => {
    const prisma = client(databaseUrl);
    try {
      return await prisma.$transaction(
        async (tx) => {
          await setContext(tx, ids.tenantId, ids.proposerId);
          await callRevision(tx, ids, successorId);
          return successorId;
        },
        { timeout: 20_000 },
      );
    } finally {
      await prisma.$disconnect();
    }
  });
  const results = await Promise.allSettled(attempts);
  const winners = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  if (winners.length !== 1) {
    throw new Error(`Expected exactly one concurrent successor; received ${winners.length}.`);
  }
  return winners[0]!;
}

async function callRevision(
  tx: { $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> },
  ids: FixtureIds,
  successorId: string,
): Promise<void> {
  await tx.$queryRawUnsafe(
    `SELECT candidate_id::text
     FROM create_memory_candidate_revision(
       $1::uuid, $2::uuid, $3::uuid, $4::uuid,
       $5::jsonb, $6::jsonb, $7
     )`,
    ids.tenantId,
    ids.predecessorId,
    ids.proposerId,
    successorId,
    JSON.stringify({
      key: 'settings-file:firm-soul:firm',
      value: '[{"key":"mission","body":"Revised"}]',
      source: 'settings_memory_editor',
      scope: 'firm',
      canonicalItem: {
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        sections: [
          { key: 'mission', heading: 'Mission', owner: 'human', body: 'Revised' },
        ],
      },
    }),
    JSON.stringify({ tool: 'memory_phase2_closeout', revision: true }),
    'a'.repeat(64),
  );
}

async function assertLineage(
  databaseUrl: string,
  ids: FixtureIds,
  successorId: string,
): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        predecessor_status: string;
        predecessor_successor: string | null;
        successor_root: string | null;
        successor_predecessor: string | null;
        successor_revision: number;
        successor_count: number;
        review_status: string;
        review_decided_by: string | null;
      }>
    >(
      `SELECT predecessor.status AS predecessor_status,
              predecessor.superseded_by_id::text AS predecessor_successor,
              successor.revision_root_id::text AS successor_root,
              successor.predecessor_candidate_id::text AS successor_predecessor,
              successor.revision_number AS successor_revision,
              (SELECT count(*)::int FROM memory_candidate
               WHERE tenant_id = $1::uuid
                 AND predecessor_candidate_id = $2::uuid) AS successor_count,
              review.status AS review_status,
              review.decided_by::text AS review_decided_by
       FROM memory_candidate predecessor
       JOIN memory_candidate successor ON successor.id = $3::uuid
       JOIN review_request review
         ON review.tenant_id = predecessor.tenant_id
        AND review.surface = 'memory'
        AND review.subject_type = 'memory_candidate'
        AND review.subject_id = predecessor.id::text
       WHERE predecessor.tenant_id = $1::uuid
         AND predecessor.id = $2::uuid`,
      ids.tenantId,
      ids.predecessorId,
      successorId,
    );
    const row = rows[0];
    if (
      !row ||
      row.predecessor_status !== 'superseded' ||
      row.predecessor_successor !== successorId ||
      row.successor_root !== ids.predecessorId ||
      row.successor_predecessor !== ids.predecessorId ||
      row.successor_revision !== 2 ||
      row.successor_count !== 1 ||
      row.review_status !== 'superseded' ||
      row.review_decided_by !== ids.reviewerId
    ) {
      throw new Error(`Revision lineage assertion failed: ${JSON.stringify(row)}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function assertCompatibilityDecisionGuard(
  databaseUrl: string,
  ids: FixtureIds,
  successorId: string,
): Promise<void> {
  const prisma = client(databaseUrl);
  try {
    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.reviewerId);
      const updated = await tx.$executeRawUnsafe(
        `UPDATE review_request
         SET assigned_to = $1::uuid
         WHERE tenant_id = $2::uuid
           AND surface = 'memory'
           AND subject_type = 'memory_candidate'
           AND subject_id = $3
           AND status = 'pending'`,
        ids.reviewerId,
        ids.tenantId,
        successorId,
      );
      if (updated !== 1) throw new Error('Expected one successor workflow assignment.');
    });

    let wrongReviewerDenied = false;
    try {
      await prisma.$transaction(async (tx) => {
        await setContext(tx, ids.tenantId, ids.otherUserId);
        await tx.$executeRawUnsafe(
          `UPDATE memory_candidate
           SET status = 'approved', decided_by = $1::uuid, decided_at = now()
           WHERE tenant_id = $2::uuid AND id = $3::uuid`,
          ids.otherUserId,
          ids.tenantId,
          successorId,
        );
      });
    } catch (error) {
      wrongReviewerDenied = String(error).includes('MEMORY_REVIEW_ASSIGNED_REVIEWER_REQUIRED');
    }
    if (!wrongReviewerDenied) throw new Error('Compatibility decision route bypassed assignment.');

    await prisma.$transaction(async (tx) => {
      await setContext(tx, ids.tenantId, ids.reviewerId);
      const updated = await tx.$executeRawUnsafe(
        `UPDATE memory_candidate
         SET status = 'approved', decided_by = $1::uuid, decided_at = now()
         WHERE tenant_id = $2::uuid AND id = $3::uuid`,
        ids.reviewerId,
        ids.tenantId,
        successorId,
      );
      if (updated !== 1) throw new Error('Assigned reviewer could not complete compatibility decision.');
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function activeMemoryCounts(
  databaseUrl: string,
  tenantId: string,
): Promise<{ memory_items: number; clio_memory: number }> {
  const prisma = client(databaseUrl);
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ memory_items: number; clio_memory: number }>
    >(
      `SELECT
         (SELECT count(*)::int FROM memory_items WHERE tenant_id = $1::uuid) AS memory_items,
         (SELECT count(*)::int FROM clio_memory WHERE tenant_id = $1::uuid) AS clio_memory`,
      tenantId,
    );
    return rows[0] ?? { memory_items: -1, clio_memory: -1 };
  } finally {
    await prisma.$disconnect();
  }
}

async function setContext(
  tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
  tenantId: string,
  userId: string,
): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', $1, true)`, tenantId);
  await tx.$executeRawUnsafe(`SELECT set_config('app.current_user', $1, true)`, userId);
  await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'off', true)`);
}

function fixtureIds(label: string): FixtureIds {
  const prefix = label === 'clean' ? '1' : '2';
  return {
    tenantId: `${prefix}1111111-1111-4111-8111-111111111111`,
    proposerId: `${prefix}2222222-2222-4222-8222-222222222222`,
    reviewerId: `${prefix}3333333-3333-4333-8333-333333333333`,
    otherUserId: `${prefix}4444444-4444-4444-8444-444444444444`,
    predecessorId: `${prefix}5555555-5555-4555-8555-555555555555`,
  };
}

function client(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } } });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
