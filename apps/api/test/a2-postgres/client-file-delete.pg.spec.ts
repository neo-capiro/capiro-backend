import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
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
import {
  deleteClientFile,
  readClientFileDelete,
  type ClientFileDeleteOwner,
} from '../../src/engagement/attachments/client-file-delete.js';
import { ClientKbService } from '../../src/embeddings/client-kb.service.js';

let h: Awaited<ReturnType<typeof fixture>>, owner: ClientFileDeleteOwner, s3: S3Client;
const attachmentId = id(1600),
  requestId = id(1601),
  etag = '"synthetic-reviewed-object"';
const command = { schemaVersion: 1, requestId, clientId: client, expectedRevision: 0 };
const calls: string[] = [];
let objectEtag: string | null,
  loseDelete = false,
  failDelete = false,
  beforeDelete: (() => Promise<void>) | undefined,
  afterDelete: (() => Promise<void>) | undefined;
const migration = () =>
  readFileSync(
    resolve(
      __dirname,
      '../../prisma/migrations/20281024140000_client_file_deletions/migration.sql',
    ),
    'utf8',
  );
const save = (raw: unknown = command) => deleteClientFile(owner, ctx, attachmentId, raw);
const read = () => readClientFileDelete(owner, ctx, requestId);
const source = async () =>
  (
    await h.sql(
      'SELECT lifecycle_status,metadata_revision,shared_at,shared_by_user_id FROM engagement_attachments WHERE id=$1',
      [attachmentId],
    )
  ).rows[0];
const counts = async () =>
  (
    await h.sql(
      `SELECT
  (SELECT count(*)::int FROM client_file_deletions) AS receipts,
  (SELECT count(*)::int FROM engagement_attachments WHERE id=$1) AS files,
  (SELECT count(*)::int FROM context_embeddings WHERE tenant_id=$2 AND source_type='client_doc_chunk'
    AND (source_id=$1::uuid::text OR source_id LIKE $1::uuid::text||':%')) AS chunks,
  (SELECT count(*)::int FROM audit_logs WHERE action='client.file.deleted') AS audits`,
      [attachmentId, tenant],
    )
  ).rows[0];
const response = (statusCode: number, headers: Record<string, string> = {}, body = '') => ({
  statusCode,
  headers,
  body: Buffer.from(body),
});

beforeAll(async () => {
  h = await fixture('files');
  try {
    // Scalar columns returned by the actual Prisma attachment delete, plus the
    // exact raw-SQL index subset. The fixture already installs the real revision trigger.
    await h.sql(`ALTER TABLE engagement_attachments
      ADD COLUMN meeting_id uuid,ADD COLUMN mail_message_id uuid,
      ADD COLUMN content_type text NOT NULL DEFAULT 'text/plain',ADD COLUMN byte_size integer,
      ADD COLUMN bucket text NOT NULL DEFAULT 'synthetic-bucket',
      ADD COLUMN s3_key text NOT NULL DEFAULT 'synthetic-unrelated',ADD COLUMN checksum_sha256 text,
      ADD COLUMN source text NOT NULL DEFAULT 'manual',
      ADD COLUMN lifecycle_status varchar(32) NOT NULL DEFAULT 'ready',
      ADD COLUMN verified_content_type text,ADD COLUMN calculated_sha256 text,
      ADD COLUMN scan_provider text,ADD COLUMN scan_status text,ADD COLUMN scan_result_at timestamptz,
      ADD COLUMN extraction_status text,ADD COLUMN extraction_metadata_jsonb jsonb NOT NULL DEFAULT '{}',
      ADD COLUMN source_version integer,ADD COLUMN source_content_hash text,ADD COLUMN indexed_at timestamptz,
      ADD COLUMN approved_at timestamptz,ADD COLUMN approved_by_user_id uuid,
      ADD COLUMN shared_at timestamptz,ADD COLUMN shared_by_user_id uuid,ADD COLUMN superseded_by_attachment_id uuid;
      CREATE TABLE context_embeddings(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,source_type text NOT NULL,source_id text NOT NULL);
      CREATE TABLE audit_logs(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        actor_user_id uuid,actor_role text,action text NOT NULL,entity_type text,entity_id text,
        before_jsonb jsonb,after_jsonb jsonb,ip text,user_agent text,request_id text,occurred_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE context_embeddings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE context_embeddings FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON context_embeddings USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
      ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON audit_logs USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON context_embeddings,audit_logs TO capiro_app;`);
    await h.sql(migration());
    await h.sql(migration());
    // Actual SDK serialization; synthetic transport and credentials cannot reach a provider.
    s3 = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://s3.synthetic.invalid',
      forcePathStyle: true,
      credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
      maxAttempts: 1,
      requestHandler: {
        handle: async (request: {
          method: string;
          path: string;
          headers: Record<string, string>;
        }) => {
          expect(request.path).toBe('/synthetic-bucket/reviewed%20file.txt');
          calls.push(request.method);
          if (request.method === 'HEAD')
            return {
              response:
                objectEtag === null
                  ? response(404, { 'x-amzn-errortype': 'NotFound' })
                  : response(200, { etag: objectEtag }),
            };
          if (request.method !== 'DELETE') throw Error('Unexpected storage operation');
          expect(request.headers['if-match']).toBe(etag);
          await beforeDelete?.();
          if (failDelete) throw Error('Synthetic storage unavailable');
          if (objectEtag !== null && request.headers['if-match'] !== objectEtag)
            return {
              response: response(412, {}, '<Error><Code>PreconditionFailed</Code></Error>'),
            };
          objectEtag = null;
          await afterDelete?.();
          if (loseDelete) throw Error('Synthetic lost DELETE acknowledgement');
          return { response: response(204) };
        },
        destroy: () => {},
      },
    });
    owner = {
      prisma: h.prisma,
      s3,
      bucket: 'synthetic-bucket',
      parents: async (_tx, _ctx, row) => {
        // These fixtures are client uploads without meeting/mail parents.
        expect(row.meetingId).toBeNull();
        expect(row.mailMessageId).toBeNull();
      },
      purgeChunks: (tx, tenantId, selectedId) =>
        ClientKbService.prototype.purgeAttachmentChunks(tx, tenantId, selectedId),
    };
  } catch (error) {
    s3?.destroy();
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
  calls.length = 0;
  objectEtag = etag;
  loseDelete = false;
  failDelete = false;
  beforeDelete = undefined;
  afterDelete = undefined;
  await h.sql(
    `INSERT INTO engagement_attachments(id,tenant_id,client_id,uploaded_by_user_id,
    file_name,s3_key,shared_at,shared_by_user_id) VALUES($1,$2,$3,$4,'Reviewed.txt','reviewed file.txt',now(),$4)`,
    [attachmentId, tenant, client, actor],
  );
  await h.sql(
    `INSERT INTO context_embeddings(tenant_id,source_type,source_id) VALUES
    ($1,'client_doc_chunk',$3),($1,'client_doc_chunk',$3||':0'),($1,'client_doc_chunk',$3||':1'),
    ($1,'client_profile',$3),($1,'client_doc_chunk','unrelated:0'),($2,'client_doc_chunk',$3||':0')`,
    [tenant, foreign, attachmentId],
  );
});
afterAll(async () => {
  s3?.destroy();
  await h?.close();
});

it('concurrent exact requests retain one receipt and audit; completed replay makes no storage calls', async () => {
  const [a, b] = await Promise.all([settled(save()), settled(save())]);
  expect(a.error).toBeUndefined();
  expect(b.error).toBeUndefined();
  expect(a.value).toEqual(b.value);
  expect(a.value).toMatchObject({
    status: 'completed',
    result: {
      attachmentId,
      objectAbsent: true,
      indexedChunksAbsent: true,
    },
  });
  expect(await counts()).toEqual({ receipts: 1, files: 0, chunks: 0, audits: 1 });
  expect(objectEtag).toBeNull();
  expect(
    (
      await h.sql(
        'SELECT tenant_id,source_type,source_id FROM context_embeddings ORDER BY tenant_id,source_type,source_id',
      )
    ).rows,
  ).toEqual([
    { tenant_id: tenant, source_type: 'client_doc_chunk', source_id: 'unrelated:0' },
    { tenant_id: tenant, source_type: 'client_profile', source_id: attachmentId },
    { tenant_id: foreign, source_type: 'client_doc_chunk', source_id: `${attachmentId}:0` },
  ]);
  const callsBeforeReplay = [...calls];
  expect(await save()).toEqual(a.value);
  expect(await read()).toEqual(a.value);
  expect(calls).toEqual(callsBeforeReplay);
});

it('lost DELETE acknowledgement remains pending; exact retry observes absence without another DELETE', async () => {
  loseDelete = true;
  await expect(save()).rejects.toThrow('lost DELETE acknowledgement');
  expect(await counts()).toEqual({ receipts: 1, files: 1, chunks: 0, audits: 0 });
  expect(await read()).toMatchObject({ status: 'pending', completedAt: null, result: null });
  expect(await source()).toEqual({
    lifecycle_status: 'delete_pending',
    metadata_revision: 1,
    shared_at: null,
    shared_by_user_id: null,
  });
  expect(objectEtag).toBeNull();
  loseDelete = false;
  expect((await save()).status).toBe('completed');
  expect(calls.filter((method) => method === 'DELETE')).toHaveLength(1);
  expect(await counts()).toEqual({ receipts: 1, files: 0, chunks: 0, audits: 1 });
});

it('conditional ETag conflict preserves the replacement and retained pending identity', async () => {
  beforeDelete = async () => {
    objectEtag = '"synthetic-replacement"';
  };
  await expect(save()).rejects.toThrow();
  expect(objectEtag).toBe('"synthetic-replacement"');
  expect(await read()).toMatchObject({ status: 'pending', result: null });
  expect(
    (await h.sql('SELECT object_jsonb FROM client_file_deletions')).rows[0].object_jsonb,
  ).toEqual({ bucket: 'synthetic-bucket', key: 'reviewed file.txt', etag });
  await expect(save()).rejects.toMatchObject({ status: 409 });
  expect(calls.filter((method) => method === 'DELETE')).toHaveLength(1);
  expect(await counts()).toEqual({ receipts: 1, files: 1, chunks: 0, audits: 0 });
});

it.each(['INSERT', 'UPDATE'] as const)(
  'deferred receipt %s COMMIT failure preserves atomic database state and an honest pending outcome',
  async (operation) => {
    const before = await source();
    await h.sql(`CREATE FUNCTION synthetic_delete_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic deferred deletion failure'; END $$;
      CREATE CONSTRAINT TRIGGER synthetic_delete_failure AFTER ${operation} ON client_file_deletions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_delete_fail()`);
    if (operation === 'UPDATE')
      beforeDelete = async () => {
        // A late chunk must roll back with the final row delete, audit, and receipt.
        await h.sql(
          "INSERT INTO context_embeddings(tenant_id,source_type,source_id) VALUES($1,'client_doc_chunk',$2)",
          [tenant, `${attachmentId}:late`],
        );
      };
    try {
      await expect(save()).rejects.toThrow();
      if (operation === 'INSERT') {
        expect(await counts()).toEqual({ receipts: 0, files: 1, chunks: 3, audits: 0 });
        expect(await source()).toEqual(before);
        expect(calls).toEqual(['HEAD']);
        expect(objectEtag).toBe(etag);
        await expect(read()).rejects.toMatchObject({ status: 404 });
      } else {
        expect(await counts()).toEqual({ receipts: 1, files: 1, chunks: 1, audits: 0 });
        expect(await source()).toMatchObject({
          lifecycle_status: 'delete_pending',
          metadata_revision: 1,
        });
        expect((await read()).status).toBe('pending');
        expect(objectEtag).toBeNull();
      }
    } finally {
      await h.sql(
        'DROP TRIGGER synthetic_delete_failure ON client_file_deletions; DROP FUNCTION synthetic_delete_fail()',
      );
    }
    beforeDelete = undefined;
    expect((await save()).status).toBe('completed');
    expect(calls.filter((method) => method === 'DELETE')).toHaveLength(1);
    expect(await counts()).toEqual({ receipts: 1, files: 0, chunks: 0, audits: 1 });
  },
);

it('current member revocation after provider deletion keeps the durable pending receipt', async () => {
  afterDelete = async () => {
    await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  };
  await expect(save()).rejects.toMatchObject({ status: 403 });
  expect(objectEtag).toBeNull();
  expect(await counts()).toEqual({ receipts: 1, files: 1, chunks: 0, audits: 0 });
  expect((await h.sql('SELECT status FROM client_file_deletions')).rows[0].status).toBe('pending');
  await expect(read()).rejects.toMatchObject({ status: 403 });
  await h.sql("UPDATE tenant_memberships SET status='active' WHERE user_id=$1", [actor]);
  expect((await save()).status).toBe('completed');
  expect(calls.filter((method) => method === 'DELETE')).toHaveLength(1);
});

it.each([
  [
    'member',
    'SELECT user_id FROM tenant_memberships WHERE user_id=$1 FOR UPDATE',
    actor,
    'FOR SHARE OF tm',
    "UPDATE tenant_memberships SET status='removed' WHERE user_id=$1",
    403,
  ],
  [
    'client',
    'SELECT id FROM clients WHERE id=$1 FOR UPDATE',
    client,
    'FROM clients',
    'UPDATE clients SET memory_wall=true WHERE id=$1',
    404,
  ],
  [
    'source',
    'SELECT id FROM engagement_attachments WHERE id=$1 FOR UPDATE',
    attachmentId,
    'FROM engagement_attachments',
    `UPDATE engagement_attachments SET uploaded_by_user_id='${outsider}'::uuid,
      viewer_mode='restricted',viewer_user_ids=ARRAY['${outsider}'] WHERE id=$1`,
    404,
  ],
] as const)(
  'actual %s row-lock wait observes revocation before any claim or provider call',
  async (_name, lockSql, selectedId, wait, revoke, status) => {
    const blocker = await h.lock(lockSql, [selectedId]),
      pending = settled(save());
    try {
      await h.waitForLock(wait);
      await blocker.query(revoke, [selectedId]);
    } finally {
      await release(blocker);
    }
    expect((await pending).error).toMatchObject({ status });
    expect(await counts()).toEqual({ receipts: 0, files: 1, chunks: 3, audits: 0 });
    expect(calls).toEqual([]);
  },
);

it('ordinary grants, immutable history, forced tenant RLS and repeat migration preserve completed identity', async () => {
  const result = await save();
  await h.sql(migration());
  expect(
    (
      await h.sql(
        "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='client_file_deletions'::regclass",
      )
    ).rows[0],
  ).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) => tx.$executeRaw`UPDATE client_file_deletions SET object_jsonb='{}'`,
    ),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) => tx.$executeRaw`UPDATE client_file_deletions SET status='pending',completed_at=NULL`,
    ),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM client_file_deletions`),
  ).rejects.toThrow();
  await expect(h.sql("UPDATE client_file_deletions SET source_jsonb='{}'")).rejects.toThrow(
    'immutable',
  );
  expect(
    await h.prisma.withTenant(foreign, (tx) => tx.$queryRaw`SELECT * FROM client_file_deletions`),
  ).toEqual([]);
  await expect(
    readClientFileDelete(owner, { ...ctx, tenantId: foreign }, requestId),
  ).rejects.toThrow();
  await expect(
    readClientFileDelete(
      owner,
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      requestId,
    ),
  ).rejects.toMatchObject({ status: 404 });
  await expect(save({ ...command, expectedRevision: 1 })).rejects.toMatchObject({ status: 409 });
  expect(await read()).toEqual(result);
  expect(await counts()).toEqual({ receipts: 1, files: 0, chunks: 0, audits: 1 });
});

it('same-request recovery survives authorized internal source erasure and still requires current client access', async () => {
  failDelete = true;
  await expect(save()).rejects.toThrow('storage unavailable');
  await h.prisma.withTenant(tenant, (tx) =>
    tx.engagementAttachment.delete({ where: { id: attachmentId }, select: { id: true } }),
  );
  expect((await read()).status).toBe('pending');
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  const beforeResume = [...calls];
  await expect(save()).rejects.toMatchObject({ status: 404 });
  expect(calls).toEqual(beforeResume);
  expect(objectEtag).toBe(etag);
  await h.sql('UPDATE clients SET memory_wall=false WHERE id=$1', [client]);
  failDelete = false;
  expect((await save()).status).toBe('completed');
  expect(objectEtag).toBeNull();
  expect(await counts()).toEqual({ receipts: 1, files: 0, chunks: 0, audits: 1 });
});
