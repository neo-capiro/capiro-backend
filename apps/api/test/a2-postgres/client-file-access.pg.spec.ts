import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  commitFileAccess,
  getFileAccessReceipt,
} from '../../src/clients/client-file-access-command.js';
import {
  fixture,
  id,
  tenant,
  actor,
  client,
  ctx,
  foreign,
  outsider,
  first,
  second,
  release,
  settled,
} from './fixture.js';

let h: Awaited<ReturnType<typeof fixture>>;
const input = {
  schemaVersion: 1,
  requestId: id(950),
  clientId: client,
  operation: 'folder-access',
  folder: null,
  files: [
    { id: first, expectedRevision: 0 },
    { id: second, expectedRevision: 0 },
  ],
  viewerMode: 'restricted',
  viewerUserIds: [outsider],
};
const migration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024100000_portfolio_file_access/migration.sql',
    ),
    'utf8',
  );
const save = (raw: unknown = input) => commitFileAccess(h.prisma, ctx, client, raw);
const read = () => getFileAccessReceipt(h.prisma, ctx, client, input.requestId);
const counts = async () =>
  (
    await h.sql(`SELECT
  (SELECT count(*)::int FROM client_file_access_receipts) AS receipts,
  (SELECT count(*)::int FROM audit_logs) AS audits,
  (SELECT sum(metadata_revision)::int FROM engagement_attachments) AS revisions`)
  ).rows[0];

beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`ALTER TABLE engagement_attachments ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'ready';
      CREATE TABLE audit_logs (id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_user_id uuid,actor_role text,action text NOT NULL,entity_type text,entity_id text,
        before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,request_id text,occurred_at timestamptz DEFAULT now());
      ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON audit_logs USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON audit_logs TO capiro_app;`);
    await h.sql(migration());
    await h.sql(migration());
  } catch (error) {
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

it('serializes same-request retries and retains history after ACL self-removal and file deletion', async () => {
  const [a, b] = await Promise.all([save(), save()]);
  expect(a).toEqual(b);
  expect(a).toMatchObject({
    status: 'completed',
    result: {
      files: [first, second].map((fileId) => ({ id: fileId, previousRevision: 0, revision: 1 })),
    },
  });
  expect(await counts()).toEqual({ receipts: 1, audits: 1, revisions: 2 });
  expect(await read()).toEqual(a);
  await h.sql('DELETE FROM engagement_attachments');
  expect(await save()).toEqual(a);
  expect(await read()).toEqual(a);
  expect((await counts()).receipts).toBe(1);
});

it('changes only the reviewed files, preserves no-op revisions, and binds conflicting retries', async () => {
  await h.sql('INSERT INTO engagement_attachments(id,tenant_id,client_id) VALUES($1,$2,$3)', [
    id(951),
    tenant,
    client,
  ]);
  const result = await save({ ...input, viewerMode: 'all', viewerUserIds: [] });
  expect(result.result?.files.every((file) => file.revision === 0)).toBe(true);
  await expect(save()).rejects.toMatchObject({ status: 409 });
  expect(
    (
      await h.sql('SELECT metadata_revision,viewer_mode FROM engagement_attachments WHERE id=$1', [
        id(951),
      ])
    ).rows[0],
  ).toEqual({ metadata_revision: 0, viewer_mode: 'all' });
  expect(await read()).toEqual(result);
});

it('stale reviewed revisions consume an immutable no-write refusal', async () => {
  await h.sql("UPDATE engagement_attachments SET folder='Changed' WHERE id=$1", [second]);
  const result = await save();
  expect(result).toMatchObject({
    status: 'refused',
    result: null,
    refusal: { code: 'FILE_ACCESS_REFUSED' },
  });
  expect(await counts()).toEqual({ receipts: 1, audits: 0, revisions: 1 });
  expect(await save()).toEqual(result);
  expect(await read()).toEqual(result);
});

it.each(['audit_logs', 'client_file_access_receipts'])(
  'rolls back every file when %s insertion fails',
  async (table) => {
    await h.sql(`CREATE FUNCTION synthetic_access_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER synthetic_failure BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_access_fail()`);
    try {
      await expect(save()).rejects.toThrow();
      expect(await counts()).toEqual({ receipts: 0, audits: 0, revisions: 0 });
      await expect(read()).rejects.toMatchObject({ status: 404 });
    } finally {
      await h.sql(
        `DROP TRIGGER synthetic_failure ON ${table}; DROP FUNCTION synthetic_access_fail()`,
      );
    }
    expect(await save()).toMatchObject({ status: 'completed' });
  },
);

it.each(['member', 'role', 'wall'])(
  'rechecks %s changed while waiting for the client lock',
  async (change) => {
    const blocker = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]);
    const pending = settled(save());
    try {
      await h.waitForLock('account_owner_version');
      if (change === 'member')
        await blocker.query("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [
          actor,
        ]);
      if (change === 'role')
        await blocker.query(
          "UPDATE tenant_memberships SET role='client_portal_user' WHERE user_id=$1",
          [actor],
        );
      if (change === 'wall')
        await blocker.query('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
    } finally {
      await release(blocker);
    }
    expect((await pending).error).toMatchObject({ status: change === 'wall' ? 404 : 403 });
    expect(await counts()).toEqual({ receipts: 0, audits: 0, revisions: 0 });
  },
);

it('rejects an inactive selected viewer after its membership lock wait', async () => {
  const blocker = await h.lock(
    'SELECT user_id FROM tenant_memberships WHERE user_id=$1 FOR UPDATE',
    [outsider],
  );
  const pending = settled(save());
  try {
    await h.waitForLock('ORDER BY user_id');
    await blocker.query("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [
      outsider,
    ]);
  } finally {
    await release(blocker);
  }
  expect((await pending).value).toMatchObject({ status: 'refused' });
  expect(await counts()).toEqual({ receipts: 1, audits: 0, revisions: 0 });
});

it('receipt reads enforce current actor, tenant, client and wall', async () => {
  await save();
  await expect(
    getFileAccessReceipt(
      h.prisma,
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      client,
      input.requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(
    getFileAccessReceipt(h.prisma, { ...ctx, tenantId: foreign }, client, input.requestId),
  ).rejects.toMatchObject({ status: 403 });
  await expect(getFileAccessReceipt(h.prisma, ctx, id(952), input.requestId)).rejects.toMatchObject(
    { status: 404 },
  );
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(read()).rejects.toMatchObject({ status: 404 });
  await h.sql('UPDATE clients SET memory_wall=false WHERE id=$1', [client]);
  await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  await expect(read()).rejects.toMatchObject({ status: 403 });
});

it('keeps immutable RLS-protected outcomes and rejects null-shaped completed results', async () => {
  const result = await save();
  for (const action of [
    'UPDATE client_file_access_receipts SET result_jsonb=NULL',
    'DELETE FROM client_file_access_receipts',
    'TRUNCATE client_file_access_receipts',
  ])
    await expect(
      h.prisma.withTenant(tenant, (tx) => tx.$executeRawUnsafe(action)),
    ).rejects.toThrow();
  await expect(
    h.sql("UPDATE client_file_access_receipts SET payload_digest=repeat('0',64)"),
  ).rejects.toThrow('immutable');
  expect(
    await h.prisma.withTenant(
      foreign,
      (tx) => tx.$queryRaw`SELECT * FROM client_file_access_receipts`,
    ),
  ).toEqual([]);
  await expect(
    h.prisma.withTenant(
      foreign,
      (tx) => tx.$executeRaw`
    INSERT INTO client_file_access_receipts(tenant_id,actor_user_id,request_id,client_id,payload_digest,operation,status)
    VALUES (${tenant}::uuid,${actor}::uuid,${id(953)}::uuid,${client}::uuid,${'0'.repeat(64)},'file-access','refused')`,
    ),
  ).rejects.toThrow();
  for (const value of [null, '{}', '{"files":null}', '{"files":[]}'])
    await expect(
      h.sql(
        `INSERT INTO client_file_access_receipts(tenant_id,actor_user_id,request_id,client_id,payload_digest,operation,status,result_jsonb)
      VALUES($1,$2,$3,$4,repeat('0',64),'file-access','completed',$5::jsonb)`,
        [tenant, actor, id(954), client, value],
      ),
    ).rejects.toThrow();
  await h.sql(migration());
  expect(await read()).toEqual(result);
});
