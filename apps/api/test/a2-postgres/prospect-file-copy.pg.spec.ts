import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fixture, id, tenant, actor, client, ctx, foreign, release, settled } from './fixture.js';
import {
  copyProspectFile,
  readProspectFileCopy,
  type ProspectFileCopyOwner,
} from '../../src/engagement/attachments/prospect-file-copy.js';
import { AttachmentContentService } from '../../src/engagement/attachment-content.service.js';

let h: Awaited<ReturnType<typeof fixture>>, owner: ProspectFileCopyOwner;
const prospect = id(1500),
  sourceId = id(1501),
  requestId = id(1502),
  timestamp = '2026-10-25T00:00:00.000Z';
const bytes = Buffer.from('Synthetic reviewed prospect upload'),
  checksum = createHash('sha256').update(bytes).digest('hex');
const command = {
  schemaVersion: 1,
  requestId,
  prospectId: prospect,
  clientId: client,
  sourceId,
  expectedProspectUpdatedAt: timestamp,
  expectedRevision: 0,
  checksumSha256: checksum,
  contentLength: bytes.length,
  folder: 'Reviewed',
};
const objects = new Map<string, Record<string, unknown>>();
let storageCalls = 0,
  losePut = false,
  afterPut: (() => Promise<void>) | undefined;
const migration = (name: string) =>
  readFileSync(resolve(__dirname, '../../prisma/migrations', name, 'migration.sql'), 'utf8');
const save = (raw: unknown = command) => copyProspectFile(owner, ctx, raw);
const read = () => readProspectFileCopy(owner, ctx, requestId);
const counts = async () =>
  (
    await h.sql(`SELECT
  (SELECT count(*)::int FROM prospect_attachment_copies) AS receipts,
  (SELECT count(*)::int FROM engagement_attachments WHERE source_entity_type='prospect_upload_copy') AS copies`)
  ).rows[0];
beforeAll(async () => {
  h = await fixture('files');
  try {
    await h.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;
      ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb NOT NULL DEFAULT '{"clioFeatureFlags":{"businessDevelopment.enabled":true}}';
      CREATE TABLE business_development_prospects(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        linked_client_id uuid REFERENCES clients(id),converted_at timestamptz,updated_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'active',dismissed_at timestamptz,UNIQUE(tenant_id,id));
      ALTER TABLE business_development_prospects ENABLE ROW LEVEL SECURITY;
      ALTER TABLE business_development_prospects FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON business_development_prospects USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
      GRANT SELECT,INSERT,UPDATE,DELETE ON business_development_prospects TO capiro_app;
      ALTER TABLE engagement_attachments DROP COLUMN prospect_id;
      ALTER TABLE engagement_attachments ADD COLUMN meeting_id uuid,ADD COLUMN mail_message_id uuid,
        ADD COLUMN content_type text NOT NULL DEFAULT 'text/plain',ADD COLUMN byte_size integer,ADD COLUMN bucket text NOT NULL DEFAULT 'synthetic-bucket',
        ADD COLUMN s3_key text NOT NULL DEFAULT 'synthetic-source',ADD COLUMN checksum_sha256 text,ADD COLUMN source text NOT NULL DEFAULT 'manual',
        ADD COLUMN lifecycle_status varchar(32) NOT NULL DEFAULT 'legacy_ready',ADD COLUMN verified_content_type text,ADD COLUMN calculated_sha256 text,
        ADD COLUMN scan_provider text,ADD COLUMN scan_status text,ADD COLUMN scan_result_at timestamptz,ADD COLUMN extraction_status text,
        ADD COLUMN source_version integer,ADD COLUMN source_content_hash text,ADD COLUMN shared_at timestamptz,ADD COLUMN shared_by_user_id uuid,
        ADD COLUMN superseded_by_attachment_id uuid,ADD COLUMN indexed_at timestamptz,
        ADD COLUMN approved_at timestamptz,ADD COLUMN approved_by_user_id uuid,
        ADD COLUMN extraction_metadata_jsonb jsonb NOT NULL DEFAULT '{}';`);
    // Actual prerequisite protects source origin and consumed upload identities.
    await h.sql(migration('20281012030000_prospect_resource_origin'));
    await h.sql(
      'GRANT SELECT,INSERT,UPDATE,DELETE ON prospect_attachment_upload_intents TO capiro_app',
    );
    await h.sql(migration('20281024130000_portfolio_prospect_file_copy'));
    await h.sql(migration('20281024130000_portfolio_prospect_file_copy'));
    const s3 = {
      send: async (operation: any) => {
        storageCalls++;
        if (operation instanceof GetObjectCommand) {
          expect(operation.input).toEqual({ Bucket: 'synthetic-bucket', Key: 'synthetic-source' });
          return { Body: Readable.from([bytes]), ContentLength: bytes.length };
        }
        if (operation instanceof PutObjectCommand) {
          expect(operation.input.IfNoneMatch).toBe('*');
          if (objects.has(operation.input.Key!))
            throw Object.assign(Error('exists'), { name: 'PreconditionFailed' });
          objects.set(operation.input.Key!, {
            ContentLength: bytes.length,
            ContentType: operation.input.ContentType,
            ChecksumSHA256: operation.input.ChecksumSHA256,
            Metadata: operation.input.Metadata,
          });
          await afterPut?.();
          if (losePut) throw Error('Synthetic lost storage acknowledgement');
          return {};
        }
        if (operation instanceof HeadObjectCommand) return objects.get(operation.input.Key!);
        throw Error('Unexpected external operation');
      },
    };
    owner = {
      prisma: h.prisma,
      s3: s3 as never,
      bucket: 'synthetic-bucket',
      content: new AttachmentContentService(),
      scanner: { scanRequired: true, providerName: 'synthetic', getStatus: async () => 'clean' },
      allowedType: (value) => value === 'text/plain',
    };
  } catch (error) {
    await h.close();
    throw error;
  }
});
beforeEach(async () => {
  await h.reset();
  objects.clear();
  storageCalls = 0;
  losePut = false;
  afterPut = undefined;
  await h.sql(
    'INSERT INTO business_development_prospects(id,tenant_id,linked_client_id,converted_at,updated_at) VALUES($1,$2,$3,$4,$4)',
    [prospect, tenant, client, timestamp],
  );
  await h.sql(
    `INSERT INTO engagement_attachments(id,tenant_id,prospect_id,uploaded_by_user_id,file_name,content_type,byte_size,bucket,s3_key,
    calculated_sha256,lifecycle_status,scan_status,viewer_mode,viewer_user_ids)
    VALUES($1,$2,$3,$4,'Reviewed.txt','text/plain',$5,'synthetic-bucket','synthetic-source',$6,'ready','clean','restricted',ARRAY[$4::text])`,
    [sourceId, tenant, prospect, actor, bytes.length, checksum],
  );
  await h.sql(
    `INSERT INTO prospect_attachment_upload_intents(tenant_id,prospect_id,actor_user_id,request_id,file_name,content_type,content_length,checksum_sha256,bucket,s3_key,expires_at,confirmed_attachment_id)
    VALUES($1,$2,$3,$4,'Reviewed.txt','text/plain',$5,$6,'synthetic-bucket','synthetic-source',now()-interval '1 day',$7)`,
    [tenant, prospect, actor, id(1503), bytes.length, checksum, sourceId],
  );
});
afterAll(async () => {
  await h?.close();
});
it('concurrent identical requests admit one independent uploader-private copy and preserve source', async () => {
  const before = (await h.sql('SELECT * FROM engagement_attachments WHERE id=$1', [sourceId]))
    .rows[0];
  const [a, b] = await Promise.all([save(), save()]);
  expect(a).toEqual(b);
  expect(await counts()).toEqual({ receipts: 1, copies: 1 });
  expect(objects.size).toBe(1);
  expect(
    (await h.sql('SELECT * FROM engagement_attachments WHERE id=$1', [sourceId])).rows[0],
  ).toEqual(before);
  const row = (await h.sql('SELECT * FROM engagement_attachments WHERE id=$1', [a.destinationId]))
    .rows[0];
  expect(row).toMatchObject({
    prospect_id: null,
    client_id: client,
    uploaded_by_user_id: actor,
    viewer_mode: 'restricted',
    viewer_user_ids: [actor],
    shared_at: null,
    folder: 'Reviewed',
    source_entity_type: 'prospect_upload_copy',
    source_entity_id: sourceId,
    source_content_hash: checksum,
  });
});
it('storage acknowledgement loss remains pending and retries only the retained destination', async () => {
  losePut = true;
  await expect(save()).rejects.toThrow('lost storage');
  const pending = await read();
  expect(pending.status).toBe('pending');
  expect(await counts()).toEqual({ receipts: 1, copies: 0 });
  losePut = false;
  const result = await save();
  expect(result.status).toBe('completed');
  expect(result.destinationId).toBe(pending.destinationId);
  expect(objects.size).toBe(1);
});
it('completed history survives source and destination removal without resurrecting either', async () => {
  const result = await save(),
    calls = storageCalls;
  await h.sql('DELETE FROM engagement_attachments WHERE id=ANY($1::uuid[])', [
    [sourceId, result.destinationId],
  ]);
  expect(await save()).toEqual({ ...result, available: false });
  expect(await read()).toEqual({ ...result, available: false });
  expect(storageCalls).toBe(calls);
  expect(await counts()).toEqual({ receipts: 1, copies: 0 });
});
it.each(['INSERT', 'UPDATE'])(
  'deferred %s COMMIT rejection cannot report completion or lose storage attribution',
  async (operation) => {
    await h.sql(`CREATE FUNCTION synthetic_copy_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic deferred copy failure'; END $$;
    CREATE CONSTRAINT TRIGGER synthetic_copy_failure AFTER ${operation} ON prospect_attachment_copies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION synthetic_copy_fail()`);
    try {
      await expect(save()).rejects.toThrow();
      expect(await counts()).toEqual({ receipts: operation === 'INSERT' ? 0 : 1, copies: 0 });
      if (operation === 'INSERT') expect(storageCalls).toBe(0);
      else {
        expect(objects.size).toBe(1);
        expect((await read()).status).toBe('pending');
      }
    } finally {
      await h.sql(
        'DROP TRIGGER synthetic_copy_failure ON prospect_attachment_copies; DROP FUNCTION synthetic_copy_fail()',
      );
    }
    expect((await save()).status).toBe('completed');
  },
);
it('current authority revoked while storage is pending prevents final row admission', async () => {
  afterPut = async () => {
    await h.sql("UPDATE tenant_memberships SET status='removed' WHERE user_id=$1", [actor]);
  };
  await expect(save()).rejects.toThrow();
  expect(await counts()).toEqual({ receipts: 1, copies: 0 });
  expect(objects.size).toBe(1);
});
it('actual source row lock wait rechecks the reviewed metadata revision', async () => {
  const blocker = await h.lock('SELECT id FROM engagement_attachments WHERE id=$1 FOR UPDATE', [
      sourceId,
    ]),
    pending = settled(save());
  try {
    await h.waitForLock('FROM engagement_attachments');
    await blocker.query("UPDATE engagement_attachments SET file_name='Changed.txt' WHERE id=$1", [
      sourceId,
    ]);
  } finally {
    await release(blocker);
  }
  expect((await pending).error).toMatchObject({ status: 409 });
  expect(storageCalls).toBe(0);
});
it('client lock wait observes current wall revocation before recording a pending command', async () => {
  const blocker = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]),
    pending = settled(save());
  try {
    await h.waitForLock('SELECT status,memory_wall');
    await blocker.query('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  } finally {
    await release(blocker);
  }
  expect((await pending).error).toMatchObject({ status: 404 });
  expect(await counts()).toEqual({ receipts: 0, copies: 0 });
  expect(storageCalls).toBe(0);
});
it('changed manifest and wrong tenant cannot adopt completed copy history', async () => {
  await save();
  await expect(save({ ...command, folder: 'Changed' })).rejects.toMatchObject({ status: 409 });
  await expect(
    readProspectFileCopy(owner, { ...ctx, tenantId: foreign }, requestId),
  ).rejects.toThrow();
});
it('ordinary app role cannot rewrite source/destination lineage, terminal result or erase history', async () => {
  await save();
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) => tx.$executeRaw`UPDATE prospect_attachment_copies SET command_jsonb='{}'`,
    ),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(
      tenant,
      (tx) =>
        tx.$executeRaw`UPDATE prospect_attachment_copies SET status='pending',result_jsonb=NULL,completed_at=NULL`,
    ),
  ).rejects.toThrow();
  await expect(
    h.prisma.withTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM prospect_attachment_copies`),
  ).rejects.toThrow();
  await expect(h.sql("UPDATE prospect_attachment_copies SET source_jsonb='{}'")).rejects.toThrow(
    'immutable',
  );
  expect((await read()).status).toBe('completed');
});
