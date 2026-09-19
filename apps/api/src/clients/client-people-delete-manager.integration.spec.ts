import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { ClientPeopleService } from './client-people.service.js';

/**
 * Native DB regression for manager deletion (core-open-defects item 1).
 * deletePerson on a MANAGER previously failed with P2011: the composite
 * self-FK client_people_reports_to_fk is ON DELETE SET NULL over
 * (reports_to_person_id, tenant_id, client_id), and Postgres SET NULL on a
 * composite FK nulls every column in the set — including NOT NULL
 * tenant_id. The service now clears only the manager reference first.
 *
 * Runs against the REAL migrated table (foreign keys must actually fire —
 * a mock proves nothing about constraint behavior). Creates its own
 * tenant/client/manager/child with fresh random ids; cleans up afterward.
 */
const databaseUrl = process.env.PEOPLE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase('deletePerson manager detach — native FK behavior', () => {
  let db: PrismaClient;
  const tenantId = randomUUID();
  const clientId = randomUUID();
  const managerId = randomUUID();
  const childId = randomUUID();
  const ctx = { tenantId, userId: randomUUID() } as never;

  beforeAll(async () => {
    db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    await db.$executeRawUnsafe(
      `INSERT INTO tenants (id, name, slug) VALUES ($1::uuid, 'people-delete tenant', $2) ON CONFLICT (id) DO NOTHING`,
      tenantId,
      `people-delete-${tenantId.slice(0, 8)}`,
    );
    await db.$executeRawUnsafe(
      `INSERT INTO clients (id, tenant_id, name, status) VALUES ($1::uuid, $2::uuid, 'people-delete client', 'active')`,
      clientId,
      tenantId,
    );
    for (const [id, name, manager] of [
      [managerId, 'Manager Person', null],
      [childId, 'Child Person', managerId],
    ] as const) {
      await db.$executeRawUnsafe(
        `INSERT INTO client_people (id, tenant_id, client_id, name, reports_to_person_id, placement_source, review_required, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, 'manual', false, now())`,
        id,
        tenantId,
        clientId,
        name,
        manager,
      );
    }
  }, 60_000);

  afterAll(async () => {
    await db.$executeRawUnsafe(`DELETE FROM client_people WHERE tenant_id = $1::uuid`, tenantId);
    await db.$executeRawUnsafe(`DELETE FROM clients WHERE id = $1::uuid`, clientId);
    await db.$executeRawUnsafe(`DELETE FROM tenants WHERE id = $1::uuid`, tenantId);
    await db.$disconnect();
  }, 60_000);

  test('deleting a manager detaches the child: child survives with tenant/client intact and reports_to NULL', async () => {
    const service = Object.create(ClientPeopleService.prototype) as ClientPeopleService;
    (service as unknown as { prisma: unknown }).prisma = {
      withTenant: (_t: string, run: (tx: never) => Promise<unknown>) =>
        db.$transaction(async (tx) => run(tx as never)),
    };
    (service as unknown as { clientKb: unknown }).clientKb = {
      purgeFireAndForget: () => undefined,
      indexPersonFireAndForget: () => undefined,
    };

    await service.deletePerson(ctx, clientId, managerId);

    const child = await db.$queryRawUnsafe<
      Array<{ id: string; tenantId: string; clientId: string; reportsToPersonId: string | null }>
    >(
      `SELECT id, tenant_id AS "tenantId", client_id AS "clientId", reports_to_person_id AS "reportsToPersonId"
         FROM client_people WHERE id = $1::uuid`,
      childId,
    );
    expect(child).toHaveLength(1);
    expect(child[0]!.tenantId).toBe(tenantId);
    expect(child[0]!.clientId).toBe(clientId);
    expect(child[0]!.reportsToPersonId).toBeNull();

    const managerGone = await db.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM client_people WHERE id = $1::uuid`,
      managerId,
    );
    expect(managerGone).toHaveLength(0);
  }, 60_000);
});
