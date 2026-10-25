import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  commitContactTransfer,
  readContactTransfer,
} from '../../src/business-development/prospect-contacts/prospect-contact-transfer-command.js';
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
const prospect = id(1200),
  sources = [id(1201), id(1202), id(1203)],
  target = id(1204);
const timestamp = '2026-10-25T00:00:00.000Z';
const input = {
  schemaVersion: 1,
  requestId: id(1205),
  prospectId: prospect,
  clientId: client,
  expectedProspectUpdatedAt: timestamp,
  items: [
    { sourceId: sources[0], expectedVersion: 1, action: 'create', createRequestId: id(1206) },
    {
      sourceId: sources[1],
      expectedVersion: 1,
      action: 'link',
      personId: target,
      expectedUpdatedAt: timestamp,
    },
    { sourceId: sources[2], expectedVersion: 1, action: 'skip' },
  ],
};
const migration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024110000_portfolio_contact_transfer/migration.sql',
    ),
    'utf8',
  );
const save = (raw: unknown = input) => commitContactTransfer(h.prisma, ctx, prospect, raw);
const read = () => readContactTransfer(h.prisma, ctx, prospect, input.requestId);
const counts = async () =>
  (
    await h.sql(`SELECT
  (SELECT count(*)::int FROM prospect_contact_transfer_receipts) AS receipts,
  (SELECT count(*)::int FROM client_person_create_receipts) AS creates,
  (SELECT count(*)::int FROM client_people) AS people,
  (SELECT count(*)::int FROM audit_logs) AS audits,
  (SELECT sum(version)::int FROM business_development_prospect_contacts) AS source_versions`)
  ).rows[0];

beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
      ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"businessDevelopment.enabled":true}}';
      CREATE TABLE business_development_prospects (
        id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        linked_client_id uuid REFERENCES clients(id),converted_at timestamptz,updated_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'active',dismissed_at timestamptz,UNIQUE(tenant_id,id));
      CREATE TABLE client_people (
        id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        name text NOT NULL,title text,email citext,phone text,role text,last_contact timestamptz,notes text,
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL,
        hierarchy_level varchar(24),reports_to_person_id uuid REFERENCES client_people(id) ON DELETE SET NULL,
        placement_source varchar(16) NOT NULL DEFAULT 'auto_title',placement_confidence decimal(4,3),review_required boolean NOT NULL DEFAULT false);
      CREATE TABLE audit_logs (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_user_id uuid,actor_role text,action text NOT NULL,entity_type text,entity_id text,
        before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,request_id text,occurred_at timestamptz DEFAULT now());
      DO $$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['business_development_prospects','client_people','audit_logs'] LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
          EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
          EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id())',t);
          EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO capiro_app',t);
        END LOOP;
      END $$;`);
    // Apply the deployed forward Contacts prerequisite, not an out-of-ledger proposal.
    await h.sql(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20281024120000_portfolio_prospect_contacts/migration.sql',
        ),
        'utf8',
      ),
    );
    await h.sql(
      readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20281024070000_client_person_create_receipts/migration.sql',
        ),
        'utf8',
      ),
    );
    await h.sql(migration());
    await h.sql(migration());
  } catch (error) {
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
  await h.sql(
    `INSERT INTO business_development_prospects(id,tenant_id,linked_client_id,converted_at,updated_at) VALUES($1,$2,$3,$4,$4)`,
    [prospect, tenant, client, timestamp],
  );
  for (const [index, source] of sources.entries())
    await h.sql(
      `INSERT INTO business_development_prospect_contacts(id,tenant_id,prospect_id,request_id,create_hash,name,title,notes,created_by_user_id,updated_by_user_id)
      VALUES($1,$2,$3,$1,repeat('0',64),$4,'CEO','Reviewed',$5,$5)`,
      [source, tenant, prospect, `Synthetic ${index}`, actor],
    );
  await h.sql(
    `INSERT INTO client_people(id,tenant_id,client_id,name,title,notes,updated_at) VALUES($1,$2,$3,'Synthetic 1','CEO','Reviewed',$4)`,
    [target, tenant, client, timestamp],
  );
});
afterAll(async () => {
  await h?.close();
});

it('concurrent identical requests commit once through actual ClientPeople and retain exact create/link/skip', async () => {
  const [a, b] = await Promise.all([save(), save()]);
  expect(a.receipt).toEqual(b.receipt);
  expect(a.createdIds.length + b.createdIds.length).toBe(1);
  expect(a.receipt).toMatchObject({
    status: 'completed',
    result: {
      items: [
        { sourceId: sources[0], sourceVersion: 1, action: 'create', personId: expect.any(String) },
        { sourceId: sources[1], sourceVersion: 1, action: 'link', personId: target },
        { sourceId: sources[2], sourceVersion: 1, action: 'skip', personId: null },
      ],
    },
  });
  expect(await counts()).toEqual({
    receipts: 1,
    creates: 1,
    people: 2,
    audits: 1,
    source_versions: 3,
  });
  expect(
    (
      await h.sql(
        `SELECT hierarchy_level,placement_source,review_required FROM client_people WHERE id<>$1`,
        [target],
      )
    ).rows,
  ).toEqual([
    { hierarchy_level: 'executive', placement_source: 'auto_title', review_required: false },
  ]);
  expect(await read()).toEqual(a.receipt);
});
it('historical outcomes survive later contact edits/deletion and reject altered retries', async () => {
  const result = await save();
  await h.sql('DELETE FROM client_people');
  await h.sql('DELETE FROM business_development_prospect_contacts');
  expect(await read()).toEqual(result.receipt);
  expect((await save()).receipt).toEqual(result.receipt);
  await expect(
    save({ ...input, items: [{ sourceId: sources[0], expectedVersion: 2, action: 'skip' }] }),
  ).rejects.toMatchObject({ status: 409 });
});
it('stale link after the first create rolls back all creates and stores an immutable refusal', async () => {
  await h.sql(`UPDATE client_people SET notes='Changed',updated_at=now() WHERE id=$1`, [target]);
  const result = await save();
  expect(result.receipt).toMatchObject({ status: 'refused', result: null });
  expect(await counts()).toEqual({
    receipts: 1,
    creates: 0,
    people: 1,
    audits: 0,
    source_versions: 3,
  });
  expect(await save()).toEqual(result);
  expect(await read()).toEqual(result.receipt);
});
it.each(['audit_logs', 'prospect_contact_transfer_receipts'])(
  'rolls back all ClientPeople writes when %s insert fails',
  async (table) => {
    await h.sql(`CREATE FUNCTION synthetic_transfer_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_transfer_failure()`);
    try {
      await expect(save()).rejects.toThrow();
      expect(await counts()).toEqual({
        receipts: 0,
        creates: 0,
        people: 1,
        audits: 0,
        source_versions: 3,
      });
      await expect(read()).rejects.toMatchObject({ status: 404 });
    } finally {
      await h.sql(
        `DROP TRIGGER synthetic_failure ON ${table}; DROP FUNCTION synthetic_transfer_failure()`,
      );
    }
    expect((await save()).receipt.status).toBe('completed');
  },
);
it.each(['member', 'role', 'wall'])(
  'rejects current %s revocation committed during the actual client lock wait',
  async (change) => {
    const blocker = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]),
      pending = settled(save());
    try {
      await h.waitForLock('account_owner_version');
      if (change === 'member')
        await blocker.query(`UPDATE tenant_memberships SET status='removed' WHERE user_id=$1`, [
          actor,
        ]);
      if (change === 'role')
        await blocker.query(
          `UPDATE tenant_memberships SET role='client_portal_user' WHERE user_id=$1`,
          [actor],
        );
      if (change === 'wall')
        await blocker.query('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
    } finally {
      await release(blocker);
    }
    expect((await pending).error).toMatchObject({ status: change === 'wall' ? 404 : 403 });
    expect(await counts()).toEqual({
      receipts: 0,
      creates: 0,
      people: 1,
      audits: 0,
      source_versions: 3,
    });
  },
);
it('a target edit creating an exact match during the row-lock wait refuses create', async () => {
  const blocker = await h.lock('SELECT id FROM client_people WHERE id=$1 FOR UPDATE', [target]),
    pending = settled(save());
  try {
    await h.waitForLock('FROM client_people');
    await blocker.query(
      `UPDATE client_people SET name='Synthetic 0',updated_at=now() WHERE id=$1`,
      [target],
    );
  } finally {
    await release(blocker);
  }
  expect((await pending).value?.receipt.status).toBe('refused');
  expect(await counts()).toEqual({
    receipts: 1,
    creates: 0,
    people: 1,
    audits: 0,
    source_versions: 3,
  });
});
it('source version change during the actual contact lock wait refuses every action', async () => {
  const blocker = await h.lock(
      'SELECT id FROM business_development_prospect_contacts WHERE id=$1 FOR UPDATE',
      [sources[2]],
    ),
    pending = settled(save());
  try {
    await h.waitForLock('FROM business_development_prospect_contacts');
    await blocker.query('UPDATE business_development_prospect_contacts SET version=2 WHERE id=$1', [
      sources[2],
    ]);
  } finally {
    await release(blocker);
  }
  expect((await pending).value?.receipt.status).toBe('refused');
  expect(await counts()).toEqual({
    receipts: 1,
    creates: 0,
    people: 1,
    audits: 0,
    source_versions: 4,
  });
});
it('a new transfer cannot adopt an old per-item create request after its target was deleted', async () => {
  await save();
  await h.sql('DELETE FROM client_people WHERE id<>$1', [target]);
  expect((await save({ ...input, requestId: id(1220) })).receipt.status).toBe('refused');
  expect(await counts()).toEqual({
    receipts: 2,
    creates: 1,
    people: 1,
    audits: 1,
    source_versions: 3,
  });
});
it('current feature, actor, tenant, prospect and client wall gates remain binding on historical lookups', async () => {
  await save();
  await expect(
    readContactTransfer(
      h.prisma,
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      prospect,
      input.requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    readContactTransfer(h.prisma, { ...ctx, tenantId: foreign }, prospect, input.requestId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(readContactTransfer(h.prisma, ctx, id(1221), input.requestId)).rejects.toMatchObject(
    { status: 404 },
  );
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await h.sql('UPDATE clients SET memory_wall=false WHERE id=$1', [client]);
  await h.sql(`UPDATE tenants SET settings_jsonb='{}' WHERE id=$1`, [tenant]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
});
it('unconverted or differently linked prospects cannot carry over to a selected client', async () => {
  await h.sql('UPDATE business_development_prospects SET converted_at=NULL');
  await expect(save()).rejects.toMatchObject({ status: 404 });
  expect((await counts()).receipts).toBe(0);
});
it('enforces immutable results, null-safe shapes, app grants, RLS and repeat migration', async () => {
  const result = await save();
  for (const statement of [
    'UPDATE prospect_contact_transfer_receipts SET result_jsonb=NULL',
    'DELETE FROM prospect_contact_transfer_receipts',
    'TRUNCATE prospect_contact_transfer_receipts',
  ])
    await expect(
      h.prisma.withTenant(tenant, (tx) => tx.$executeRawUnsafe(statement)),
    ).rejects.toThrow();
  await expect(
    h.sql("UPDATE prospect_contact_transfer_receipts SET payload_digest=repeat('0',64)"),
  ).rejects.toThrow('immutable');
  expect(
    await h.prisma.withTenant(
      foreign,
      (tx) => tx.$queryRaw`SELECT * FROM prospect_contact_transfer_receipts`,
    ),
  ).toEqual([]);
  await expect(
    h.prisma.withTenant(
      foreign,
      (tx) => tx.$executeRaw`INSERT INTO prospect_contact_transfer_receipts
    (tenant_id,actor_user_id,request_id,prospect_id,client_id,payload_digest,status)
    VALUES (${tenant}::uuid,${actor}::uuid,${id(1230)}::uuid,${prospect}::uuid,${client}::uuid,${'0'.repeat(64)},'refused')`,
    ),
  ).rejects.toThrow();
  for (const value of [null, '{}', '{"items":null}', '{"items":[]}'])
    await expect(
      h.sql(
        `INSERT INTO prospect_contact_transfer_receipts(tenant_id,actor_user_id,request_id,prospect_id,client_id,payload_digest,status,result_jsonb)
      VALUES($1,$2,$3,$4,$5,repeat('0',64),'completed',$6::jsonb)`,
        [tenant, actor, id(1231), prospect, client, value],
      ),
    ).rejects.toThrow();
  await h.sql(migration());
  expect(await read()).toEqual(result.receipt);
});
