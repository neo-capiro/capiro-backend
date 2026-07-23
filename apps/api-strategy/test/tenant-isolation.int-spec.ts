import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * DB-backed tenant-isolation + append-only integration tests.
 *
 * Requires a Postgres with the sp_* migration applied (DATABASE_URL set). It is
 * kept OUT of the PR pipeline by the runtime self-skip below: `describe.skip`
 * fires whenever DATABASE_URL is unset, which is exactly the ci-pr condition
 * (ci-pr runs `pnpm --filter @capiro/api-strategy test` with no DB). It runs in
 * the DB-backed path (local `docker compose up -d postgres` + migrate, or the
 * deploy migrate + canary). NOTE: the guard is the DATABASE_URL check, not a
 * jest path filter — jest.config testMatch DOES include *.int-spec.ts, so if a
 * DATABASE_URL is ever present in the PR runner this suite would execute; that
 * is intentional (it would then run against a migrated DB).
 *
 * What this proves is the REAL isolation guarantee: PrismaService.withTenant
 * injects `where.tenantId` (application-layer), which holds regardless of RLS
 * (the local superuser bypasses RLS, and in prod capiro_app bypasses it too —
 * the injection is the enforcement). Plus the sp_activity_log append-only
 * trigger, which fires for every role including superuser.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';
const CLIENT_A = '00000000-0000-0000-0000-0000000000c1';
const CLIENT_B = '00000000-0000-0000-0000-0000000000c2';

suite('tenant isolation + append-only (integration)', () => {
  // Constructed in beforeAll (NOT at collection time): Prisma's constructor
  // throws without DATABASE_URL, and describe.skip still runs the callback to
  // collect tests — so a top-level `new PrismaService()` would crash the file
  // load in a DB-less PR run. beforeAll only runs for the non-skipped suite.
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    // Clean any prior test rows, then seed one strategy per tenant.
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
      await tx.spStrategy.createMany({
        data: [
          {
            tenantId: TENANT_A,
            clientId: CLIENT_A,
            title: 'Tenant A strategy',
            type: 'appropriations',
            ownerUserId: 'user_a',
            createdByUserId: 'user_a',
          },
          {
            tenantId: TENANT_B,
            clientId: CLIENT_B,
            title: 'Tenant B strategy',
            type: 'authorization',
            ownerUserId: 'user_b',
            createdByUserId: 'user_b',
          },
        ],
      });
    });
  });

  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
      await tx.spActivityLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    });
    await prisma.onModuleDestroy();
  });

  it('withTenant only sees its own tenant rows', async () => {
    const aRows = await prisma.withTenant(TENANT_A, (tx) => tx.spStrategy.findMany());
    expect(aRows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(aRows.some((r) => r.title === 'Tenant A strategy')).toBe(true);
    expect(aRows.some((r) => r.tenantId === TENANT_B)).toBe(false);
  });

  it('withTenant OVERRIDES an attacker-supplied cross-tenant where filter', async () => {
    // Even if calling code passes the other tenant's id, the hook forces the
    // scope tenant — so this returns tenant A's rows, never tenant B's.
    const rows = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategy.findMany({ where: { tenantId: TENANT_B } }),
    );
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
  });

  it('withTenant update/delete cannot reach another tenant', async () => {
    const updated = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategy.updateMany({ data: { title: 'hijacked' }, where: {} }),
    );
    // Only tenant A's single row is affected.
    expect(updated.count).toBe(1);
    const bStillIntact = await prisma.withTenant(TENANT_B, (tx) =>
      tx.spStrategy.findMany({ where: { title: 'Tenant B strategy' } }),
    );
    expect(bStillIntact).toHaveLength(1);
    // restore
    await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategy.updateMany({ data: { title: 'Tenant A strategy' }, where: {} }),
    );
  });

  it('withSystem sees across tenants (no injection)', async () => {
    const all = await prisma.withSystem((tx) =>
      tx.spStrategy.findMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } }),
    );
    const tenants = new Set(all.map((r) => r.tenantId));
    expect(tenants.has(TENANT_A)).toBe(true);
    expect(tenants.has(TENANT_B)).toBe(true);
  });

  it('global sp_reference_entry is readable regardless of tenant scope', async () => {
    // Should not throw and should be tenant-agnostic (the model has no tenantId
    // field, so the hook never touches it).
    const underTenant = await prisma.withTenant(TENANT_A, (tx) => tx.spReferenceEntry.count());
    const underSystem = await prisma.withSystem((tx) => tx.spReferenceEntry.count());
    expect(underTenant).toBe(underSystem);
  });

  it('sp_activity_log is append-only: UPDATE and DELETE are rejected', async () => {
    const row = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spActivityLog.create({
        data: {
          tenantId: TENANT_A,
          actorUserId: 'user_a',
          authorKind: 'person',
          action: 'strategy.created',
          entityType: 'strategy',
          entityId: 'test-entity',
        },
      }),
    );

    await expect(
      prisma.withTenant(TENANT_A, (tx) =>
        tx.spActivityLog.update({ where: { id: row.id }, data: { action: 'tampered' } }),
      ),
    ).rejects.toThrow();

    await expect(
      prisma.withTenant(TENANT_A, (tx) =>
        tx.spActivityLog.delete({ where: { id: row.id } }),
      ),
    ).rejects.toThrow();

    // The sanctioned escape hatch: app.allow_audit_purge = 'on' (GDPR purge).
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.allow_audit_purge', 'on', true)`;
      await tx.spActivityLog.deleteMany({ where: { id: row.id } });
    });
    const gone = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spActivityLog.findUnique({ where: { id: row.id } }),
    );
    expect(gone).toBeNull();
  });
});
