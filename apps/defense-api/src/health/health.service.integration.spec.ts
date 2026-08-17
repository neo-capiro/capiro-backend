/**
 * Database-backed acceptance tests for /readyz (Phase 8 Session 2, mandatory
 * correction 2). Skipped unless REHEARSAL_DATABASE_URL and REHEARSAL_SERVE_URL
 * are set: scripts/verify-phase8-session2-db.mjs sets both up (a real
 * migrated database plus a capiro_defense_serve-safe login) before this suite
 * runs, so `pnpm test` alone still runs with no database and no regression.
 *
 * REHEARSAL_DATABASE_URL: the disposable database's superuser/admin
 * connection. It also stands in as a deliberately "invalid role" connection
 * for scenario 4, since a superuser is never a member of capiro_defense_serve.
 * REHEARSAL_SERVE_URL: a login that IS a safe capiro_defense_serve member,
 * created by the rehearsal script with the same grants production would use.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
// defense-api generates its own Prisma client to a custom output path
// (prisma/schema.prisma: output = "../generated/prisma-client") rather than
// the default node_modules/.prisma/client location the bare '@prisma/client'
// package resolves to, so this suite must import the generated client the
// same way prisma.service.ts does.
import { PrismaClient } from '../../generated/prisma-client/index.js';
import { HealthService } from './health.service.ts';

const ADMIN_URL = process.env.REHEARSAL_DATABASE_URL;
const SERVE_URL = process.env.REHEARSAL_SERVE_URL;
const RUN = Boolean(ADMIN_URL && SERVE_URL);

function fakeConfig(cutoverMode: 'dark' | 'strict') {
  return {
    get: (key: string) => (key === 'DEFENSE_CUTOVER_MODE' ? cutoverMode : undefined),
  } as unknown as import('@nestjs/config').ConfigService;
}

function clientFor(url: string) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function withConnectionLimit(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('connection_limit', '5');
  return parsed.toString();
}

test('database-backed /readyz acceptance', { skip: !RUN }, async (t) => {
  const admin = clientFor(ADMIN_URL as string);
  const serve = clientFor(SERVE_URL as string);
  const environment = `phase8-session2-test-${randomUUID().slice(0, 8)}`;

  const priorDatabaseUrl = process.env.DATABASE_URL;
  const priorClerkKey = process.env.CLERK_SECRET_KEY;
  process.env.DATABASE_URL = withConnectionLimit(SERVE_URL as string);
  process.env.CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY ?? 'test-secret';
  process.env.PE_SNAPSHOT_ENVIRONMENT = environment;

  t.after(async () => {
    // No cleanup DELETEs: defense_budget_canonical_snapshot and
    // defense_budget_active_snapshot are immutable by design (Phase 7
    // triggers refuse DELETE unconditionally — "canonical snapshots are
    // never deleted" / "the active-snapshot pointer is moved, never
    // deleted"). The randomized `environment` value keeps repeat runs from
    // colliding, and this rehearsal database is disposable end to end.
    await admin.$disconnect();
    await serve.$disconnect();
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    if (priorClerkKey === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = priorClerkKey;
    delete process.env.PE_SNAPSHOT_ENVIRONMENT;
  });

  await t.test('dark mode + healthy infra + no active pointer -> 200, unavailable', async () => {
    const service = new HealthService(serve as never, fakeConfig('dark'));
    const result = await service.readiness();
    assert.equal(result.httpStatus, 200);
    assert.equal(result.domainAvailability, 'unavailable');
  });

  await t.test('strict mode + no active pointer -> 503', async () => {
    const service = new HealthService(serve as never, fakeConfig('strict'));
    const result = await service.readiness();
    assert.equal(result.httpStatus, 503);
  });

  await t.test('valid active pointer -> 200', async () => {
    // A snapshot only counts as "active" once it has actually been activated
    // through the real Phase 7 chain: enforce_active_snapshot_preconditions
    // requires the activation_id to name a real, matching
    // defense_budget_promotion_activation row, which itself cascades through
    // a run, an authorization, a plan, and an eligibility record. This
    // mirrors apps/api/scripts/pe-budget-phase7-migration-rehearsal.sh's own
    // fixture-building rather than inventing a shortcut around the triggers.
    const snapshotId = randomUUID();
    const activationId = randomUUID();
    const runId = randomUUID();
    const suffix = randomUUID().slice(0, 8);
    const planId = `p8s2-plan-${suffix}`;
    const authId = `p8s2-auth-${suffix}`;
    const runKey = `p8s2-run-${suffix}`;
    const activationKey = `p8s2-act-${suffix}`;
    const eligibilityId = `p8s2-elig-${suffix}`;

    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_canonical_snapshot
         (id, snapshot_key, domain, environment, cycle_id, fiscal_year, status,
          snapshot_hash, mapping_registry_hash)
       VALUES ($1::uuid, $2, 'defense_budget', $3, 'p8s2-cycle', 2026, 'READY',
               repeat('a', 64), repeat('b', 64))`,
      snapshotId,
      `key-${snapshotId}`,
      environment,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_eligibility
         (eligibility_id, eligibility_hash, cycle_id, mapping_registry_version,
          mapping_registry_hash, scope, scope_hash, open_conflict_count,
          unsupported_item_count, document, generated_at)
       VALUES ($1, repeat('c', 64), 'p8s2-cycle', '1.0.0', repeat('b', 64),
               '{}'::jsonb, repeat('c', 64), 0, 0, '{}'::jsonb, now())`,
      eligibilityId,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_plan
         (plan_id, plan_hash, eligibility_hash, mapping_registry_version,
          mapping_registry_hash, cycle_id, fiscal_year, scope, scope_hash, mode,
          proposed_snapshot_id, item_count, blocked_count, plan_document)
       VALUES ($1, repeat('d', 64), repeat('c', 64), '1.0.0', repeat('b', 64),
               'p8s2-cycle', 2026, '{}'::jsonb, repeat('c', 64),
               'baseline_hydration', $2::uuid, 0, 0, '{}'::jsonb)`,
      planId,
      snapshotId,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_authorization
         (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
          authorizer_actor_id, authorizer_role, reason, issued_at, expires_at,
          segregation, authorization_hash)
       VALUES ($1, $2, repeat('d', 64), repeat('c', 64), repeat('c', 64),
               'p8s2-actor', 'capiro_admin', 'p8s2 rehearsal', now(),
               now() + interval '1 hour', '{}'::jsonb, repeat('e', 64))`,
      authId,
      planId,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_run
         (id, run_key, plan_id, plan_hash, authorization_id, snapshot_id, executor_identity)
       VALUES ($1::uuid, $2, $3, repeat('d', 64), $4, $5::uuid, 'p8s2-rehearsal')`,
      runId,
      runKey,
      planId,
      authId,
      snapshotId,
    );
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_promotion_activation
         (id, activation_key, run_id, domain, environment, previous_snapshot_id,
          new_snapshot_id, authorization_id, activated_by)
       VALUES ($1::uuid, $2, $3::uuid, 'defense_budget', $4, NULL, $5::uuid, $6, 'p8s2-rehearsal')`,
      activationId,
      activationKey,
      runId,
      environment,
      snapshotId,
      authId,
    );
    // Precondition trigger allows READY or ACTIVE at the moment the pointer
    // moves; flip to ACTIVE afterward, same order as the Phase 7 rehearsal.
    await admin.$executeRawUnsafe(
      `INSERT INTO defense_budget_active_snapshot
         (id, domain, environment, snapshot_id, activation_id)
       VALUES (gen_random_uuid(), 'defense_budget', $1, $2::uuid, $3::uuid)`,
      environment,
      snapshotId,
      activationId,
    );
    await admin.$executeRawUnsafe(
      `UPDATE defense_budget_canonical_snapshot SET status = 'ACTIVE', activated_at = now()
         WHERE id = $1::uuid`,
      snapshotId,
    );

    const service = new HealthService(serve as never, fakeConfig('strict'));
    const result = await service.readiness();
    assert.equal(result.httpStatus, 200);
    assert.equal(result.domainAvailability, 'available');
    assert.equal(result.activeSnapshotId, snapshotId);
  });

  await t.test('invalid role (superuser, not a serve member) -> 503 even with a valid pointer', async () => {
    const service = new HealthService(admin as never, fakeConfig('dark'));
    const result = await service.readiness();
    assert.equal(result.httpStatus, 503);
    assert.ok(result.reasons.includes('database_role_unauthorized'));
  });

  await t.test('bad configuration (missing CLERK_SECRET_KEY) -> 503', async () => {
    const prior = process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_SECRET_KEY;
    try {
      const service = new HealthService(serve as never, fakeConfig('dark'));
      const result = await service.readiness();
      assert.equal(result.httpStatus, 503);
      assert.ok(result.reasons.includes('config_invalid'));
    } finally {
      if (prior !== undefined) process.env.CLERK_SECRET_KEY = prior;
    }
  });

  await t.test('a failed query -> 503', async () => {
    const badAuth = new URL(SERVE_URL as string);
    badAuth.password = 'definitely-the-wrong-password';
    const broken = clientFor(badAuth.toString());
    const service = new HealthService(broken as never, fakeConfig('dark'));
    const result = await service.readiness();
    assert.equal(result.httpStatus, 503);
    assert.ok(result.reasons.includes('database_unreachable'));
    await broken.$disconnect().catch(() => {});
  });
});
