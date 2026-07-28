import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { PrismaService } from '../src/prisma/prisma.service.js';

/**
 * Phase 6 §4 — DB-backed tenant-crossing probes for the two tables this
 * prototype rollout added: `sp_strategy_chat_message` (Phase 2) and
 * `sp_watch_dismissal` (Phase 3).
 *
 * Same self-skip contract as tenant-isolation.int-spec.ts: `describe.skip`
 * whenever DATABASE_URL is unset, which is exactly the ci-pr condition. It runs
 * in the DB-backed path (local `docker compose up -d postgres` + migrate, or
 * the deploy migrate + canary), and there it is the real proof — the two tables
 * carry RLS policies AND, more importantly for today, are reached through
 * PrismaService.withTenant, whose query hook injects `where.tenantId`. That
 * injection is the enforcement while capiro_app still bypasses RLS.
 *
 * The service-layer half of these probes (a cross-tenant accept/dismiss by id)
 * runs everywhere, in watch-review.service.spec.ts's "tenant-crossing probes"
 * block; this file covers what only a real database can show.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const suite = hasDb ? describe : describe.skip;

const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';
const CLIENT_A = '00000000-0000-0000-0000-0000000000c1';
const CLIENT_B = '00000000-0000-0000-0000-0000000000c2';

suite('Watch dismissal + chat tenant isolation (integration)', () => {
  let prisma: PrismaService;
  let strategyA: string;
  let strategyB: string;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.onModuleInit();
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
      const a = await tx.spStrategy.create({
        data: {
          tenantId: TENANT_A,
          clientId: CLIENT_A,
          title: 'Tenant A strategy',
          type: 'appropriations',
          ownerUserId: 'user_a',
          createdByUserId: 'user_a',
        },
      });
      const b = await tx.spStrategy.create({
        data: {
          tenantId: TENANT_B,
          clientId: CLIENT_B,
          title: 'Tenant B strategy',
          type: 'appropriations',
          ownerUserId: 'user_b',
          createdByUserId: 'user_b',
        },
      });
      strategyA = a.id;
      strategyB = b.id;
      await tx.spStrategyChatMessage.createMany({
        data: [
          { tenantId: TENANT_A, strategyId: a.id, role: 'meri', kind: 'message', body: 'A-only line' },
          { tenantId: TENANT_B, strategyId: b.id, role: 'meri', kind: 'message', body: 'B-only line' },
        ],
      });
      await tx.spWatchDismissal.createMany({
        data: [
          { tenantId: TENANT_A, strategyId: a.id, watchKey: 'shared-key', dismissedByUserId: 'user_a' },
          { tenantId: TENANT_B, strategyId: b.id, watchKey: 'shared-key', dismissedByUserId: 'user_b' },
        ],
      });
    });
  });

  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.spStrategy.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
      await tx.spWatchDismissal.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
      await tx.spActivityLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    });
    await prisma.onModuleDestroy();
  });

  it('chat messages are only visible to their own tenant', async () => {
    const rows = await prisma.withTenant(TENANT_A, (tx) => tx.spStrategyChatMessage.findMany());
    expect(rows.every((r) => r.tenantId === TENANT_A)).toBe(true);
    expect(rows.some((r) => r.body === 'A-only line')).toBe(true);
    expect(rows.some((r) => r.body === 'B-only line')).toBe(false);
  });

  it('an attacker-supplied cross-tenant filter on chat is overridden, not honoured', async () => {
    const rows = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategyChatMessage.findMany({ where: { tenantId: TENANT_B, strategyId: strategyB } }),
    );
    expect(rows).toEqual([]);
  });

  it('a chat update cannot reach another tenant’s message', async () => {
    const updated = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategyChatMessage.updateMany({ where: {}, data: { state: 'dismissed' } }),
    );
    expect(updated.count).toBe(1);
    const bIntact = await prisma.withTenant(TENANT_B, (tx) => tx.spStrategyChatMessage.findMany());
    expect(bIntact.every((r) => r.state === 'active')).toBe(true);
    await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategyChatMessage.updateMany({ where: {}, data: { state: 'active' } }),
    );
  });

  it('the SAME watch key dismissed in two tenants stays two independent rows', async () => {
    const aRows = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spWatchDismissal.findMany({ where: { watchKey: 'shared-key' } }),
    );
    const bRows = await prisma.withTenant(TENANT_B, (tx) =>
      tx.spWatchDismissal.findMany({ where: { watchKey: 'shared-key' } }),
    );
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0]!.strategyId).toBe(strategyA);
    expect(bRows[0]!.strategyId).toBe(strategyB);
    // Scenario G: suppressing a finding for one tenant must never suppress it
    // for another.
    expect(aRows[0]!.id).not.toBe(bRows[0]!.id);
  });

  it('a dismissal delete cannot reach another tenant’s suppression', async () => {
    const deleted = await prisma.withTenant(TENANT_A, (tx) =>
      tx.spWatchDismissal.deleteMany({ where: { watchKey: 'shared-key' } }),
    );
    expect(deleted.count).toBe(1);
    const bStillThere = await prisma.withTenant(TENANT_B, (tx) =>
      tx.spWatchDismissal.findMany({ where: { watchKey: 'shared-key' } }),
    );
    expect(bStillThere).toHaveLength(1);
    await prisma.withSystem((tx) =>
      tx.spWatchDismissal.create({
        data: { tenantId: TENANT_A, strategyId: strategyA, watchKey: 'shared-key', dismissedByUserId: 'user_a' },
      }),
    );
  });

  it('the chat table’s idempotency key is scoped per tenant', async () => {
    const clientMessageId = '22222222-2222-4222-8222-222222222222';
    await prisma.withTenant(TENANT_A, (tx) =>
      tx.spStrategyChatMessage.create({
        data: {
          tenantId: TENANT_A,
          strategyId: strategyA,
          role: 'user',
          kind: 'message',
          body: 'retryable',
          clientMessageId,
        },
      }),
    );
    // The same client-minted id under a DIFFERENT tenant is a different row —
    // the unique index is (tenant_id, client_message_id).
    await expect(
      prisma.withTenant(TENANT_B, (tx) =>
        tx.spStrategyChatMessage.create({
          data: {
            tenantId: TENANT_B,
            strategyId: strategyB,
            role: 'user',
            kind: 'message',
            body: 'retryable',
            clientMessageId,
          },
        }),
      ),
    ).resolves.toBeTruthy();
    // ...but a second insert of the same id in the SAME tenant is rejected.
    await expect(
      prisma.withTenant(TENANT_A, (tx) =>
        tx.spStrategyChatMessage.create({
          data: {
            tenantId: TENANT_A,
            strategyId: strategyA,
            role: 'user',
            kind: 'message',
            body: 'retryable again',
            clientMessageId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
