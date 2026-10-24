import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClientPeopleService } from '../../src/clients/client-people.service.js';
import {
  fixture,
  id,
  tenant,
  actor,
  client,
  ctx,
  foreign,
  outsider,
  release,
  settled,
} from './fixture.js';

let h: Awaited<ReturnType<typeof fixture>>;
let service: ClientPeopleService;
const indexed = jest.fn();
const input = {
  requestId: id(800),
  name: 'Synthetic contact',
  title: 'Director',
  email: 'synthetic@example.test',
  notes: 'Original',
};
const migration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024070000_client_person_create_receipts/migration.sql',
    ),
    'utf8',
  );
const create = (value = input) => service.createPerson(ctx, client, value);
const read = () => service.readCreation(ctx, client, input.requestId);
const counts = async () =>
  (
    await h.sql(
      'SELECT (SELECT count(*)::int FROM client_people) AS people,(SELECT count(*)::int FROM client_person_create_receipts) AS receipts',
    )
  ).rows[0];
beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`
      CREATE TYPE tenant_status AS ENUM ('active','suspended','pending');
      ALTER TABLE tenants ADD status tenant_status NOT NULL DEFAULT 'active';
      CREATE TABLE client_people (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,name text NOT NULL,title text,email text,
        phone text,role text,last_contact timestamptz,notes text,created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),hierarchy_level varchar(24),reports_to_person_id uuid,
        placement_source varchar(16) NOT NULL DEFAULT 'auto_title',placement_confidence decimal(4,3),review_required boolean NOT NULL DEFAULT false
      );
      ALTER TABLE client_people ENABLE ROW LEVEL SECURITY;
      ALTER TABLE client_people FORCE ROW LEVEL SECURITY;
      CREATE POLICY people_tenant ON client_people USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON client_people TO capiro_app;
    `);
    await h.sql(migration());
    await h.sql(migration());
    service = new ClientPeopleService(h.prisma, {
      indexPersonFireAndForget: indexed,
      purgeFireAndForget: jest.fn(),
    } as never);
  } catch (error) {
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
  indexed.mockClear();
});
afterAll(async () => {
  await h?.close();
});

it('commits one contact for concurrent retries and recovers a discarded response by exact request', async () => {
  const [first, second] = await Promise.all([create(), create()]);
  expect(second).toEqual(first);
  expect(await read()).toEqual(first);
  expect(first).toMatchObject({
    schemaVersion: 1,
    status: 'completed',
    tenantId: tenant,
    actorUserId: actor,
    clientId: client,
    requestId: input.requestId,
    available: true,
  });
  expect(await counts()).toEqual({ people: 1, receipts: 1 });
  expect(indexed).toHaveBeenCalledTimes(1);
});
it('refuses changed payload with the same key but permits separate contacts with equal names', async () => {
  const first = await create();
  await expect(create({ ...input, notes: 'Different' })).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(first);
  const distinct = await create({ ...input, requestId: id(801) });
  expect(distinct.personId).not.toBe(first.personId);
  expect(await counts()).toEqual({ people: 2, receipts: 2 });
});
it('preserves the consumed result through later edits and actual contact deletion', async () => {
  const first = await create();
  await service.updatePerson(ctx, client, first.personId, { name: 'Edited by a colleague' });
  expect(await create()).toEqual(first);
  expect((await h.sql('SELECT name FROM client_people')).rows[0].name).toBe(
    'Edited by a colleague',
  );
  await service.deletePerson(ctx, client, first.personId);
  expect(await read()).toEqual({ ...first, available: false });
  expect(await create()).toEqual({ ...first, available: false });
  expect(await counts()).toEqual({ people: 0, receipts: 1 });
});
it('rolls the contact back if receipt insertion fails and permits the original retry', async () => {
  await h.sql(`CREATE FUNCTION fail_contact_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON client_person_create_receipts FOR EACH ROW EXECUTE FUNCTION fail_contact_receipt()`);
  try {
    await expect(create()).rejects.toThrow();
    expect(await counts()).toEqual({ people: 0, receipts: 0 });
    expect(indexed).not.toHaveBeenCalled();
  } finally {
    await h.sql(
      'DROP TRIGGER synthetic_failure ON client_person_create_receipts; DROP FUNCTION fail_contact_receipt()',
    );
  }
  expect(await create()).toMatchObject({ requestId: input.requestId, available: true });
});
it('does not expose a receipt to a foreign tenant, another actor or another client', async () => {
  await create();
  await h.sql('INSERT INTO clients(id,tenant_id) VALUES($1,$2)', [id(802), tenant]);
  await expect(
    service.readCreation({ ...ctx, tenantId: foreign }, client, input.requestId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(
    service.readCreation(
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      client,
      input.requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(service.readCreation(ctx, id(802), input.requestId)).rejects.toMatchObject({
    status: 404,
  });
  await expect(service.readCreation(ctx, client, id(899))).rejects.toMatchObject({ status: 404 });
  expect(await counts()).toEqual({ people: 1, receipts: 1 });
});
it('rechecks current walls and revoked membership for lookup and replay', async () => {
  await create();
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await expect(create()).rejects.toMatchObject({ status: 404 });
  await h.sql('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)', [
    tenant,
    client,
    actor,
  ]);
  expect(await read()).toMatchObject({ available: true });
  await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  await expect(read()).rejects.toMatchObject({ status: 403 });
  await expect(create()).rejects.toMatchObject({ status: 403 });
});
it('observes revocation that commits while admission waits for the canonical client lock', async () => {
  const blocker = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]);
  const pending = settled(create());
  try {
    await h.waitForLock('account_owner_version');
    await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  } finally {
    await release(blocker);
  }
  expect((await pending).error).toMatchObject({ status: 403 });
  expect(await counts()).toEqual({ people: 0, receipts: 0 });
});
it('keeps receipt identity immutable, enforces tenant RLS, and reapplies migration without losing consumption', async () => {
  const first = await create();
  await expect(
    h.prisma.withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM client_person_create_receipts`),
  ).rejects.toThrow();
  await expect(
    h.sql("UPDATE client_person_create_receipts SET payload_digest=repeat('a',64)"),
  ).rejects.toThrow();
  expect(
    await h.prisma.withTenant(
      foreign,
      (tx) => tx.$queryRaw`SELECT * FROM client_person_create_receipts`,
    ),
  ).toEqual([]);
  await h.sql(migration());
  expect(await read()).toEqual(first);
});
