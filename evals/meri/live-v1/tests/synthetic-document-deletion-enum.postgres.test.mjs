import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { it } from 'node:test';
import { clientDocumentPhysicalId } from '../fixture-provisioning/canonical-owner-adapter.mjs';
import {
  ownedIdentity,
  FIXTURE_NAMESPACE,
  AUTHORIZED_TENANTS,
} from '../fixture-provisioning/contract.mjs';
import { FIXTURE_VERSION } from '../fixture.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'canonical synthetic document cleanup guard uses actual Prisma parameters against TenantRole enum',
  { skip: !configPath, timeout: 45_000 },
  async (t) => {
    assert.ok(isAbsolute(configPath));
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 55433);
    assert.equal(cfg.scope, 'owned local disposable test cluster; no AWS connection');
    assert.ok(isAbsolute(cfg.dataDirectory));
    const { Client } = require('pg');
    const admin = new Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      connectionTimeoutMillis: 3000,
    });
    try {
      await admin.connect();
    } catch {
      throw new Error('Owned loopback connection failed');
    }
    const schema = `meri_document_enum_${randomUUID().replaceAll('-', '')}`;
    const prior = process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
    let db;
    try {
      const actual = (
        await admin.query(
          "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
          [cfg.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, cfg.host);
      assert.equal(actual.port, 55433);
      assert.equal(actual.directory.replaceAll('\\', '/'), cfg.dataDirectory.replaceAll('\\', '/'));
      require('ts-node').register({
        project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
        transpileOnly: true,
        experimentalResolver: true,
      });
      const { guardSyntheticDocumentDeletionInTx } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/engagement/synthetic-document-deletion.helpers.ts',
            import.meta.url,
          ),
        ),
      );
      const { Prisma, PrismaClient } = require('@prisma/client');
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(`CREATE TYPE "TenantRole" AS ENUM ('standard_user','user_admin','super_admin');
        CREATE TABLE tenants(id uuid PRIMARY KEY,slug text);
        CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,status text,role "TenantRole");
        CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,memory_wall boolean);
        CREATE TABLE client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);`);
      const uuids = new Set([
        'id',
        'tenantId',
        'clientId',
        'meetingId',
        'mailMessageId',
        'uploadedByUserId',
        'approvedByUserId',
        'sharedByUserId',
        'supersededByAttachmentId',
      ]);
      const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'EngagementAttachment');
      const columns = model.fields
        .filter((f) => f.kind !== 'object')
        .map((f) => {
          const name = f.dbName ?? f.name;
          assert.match(name, /^[a-z_][a-z0-9_]*$/);
          const type = f.isList
            ? 'text[]'
            : uuids.has(f.name)
              ? 'uuid'
              : {
                  String: 'text',
                  Int: 'integer',
                  DateTime: 'timestamptz',
                  Json: 'jsonb',
                  Boolean: 'boolean',
                }[f.type];
          assert.ok(type, f.name);
          let def = '';
          if (f.hasDefaultValue) {
            if (f.isList) def = " DEFAULT '{}'::text[]";
            else if (typeof f.default === 'object')
              def =
                f.default.name === 'now'
                  ? ' DEFAULT now()'
                  : f.default.name.startsWith('uuid')
                    ? ' DEFAULT gen_random_uuid()'
                    : '';
            else if (typeof f.default === 'number' || typeof f.default === 'boolean')
              def = ` DEFAULT ${f.default}`;
            else
              def = ` DEFAULT '${String(f.default).replaceAll("'", "''")}'${f.type === 'Json' ? '::jsonb' : ''}`;
          }
          return `"${name}" ${type}${f.isId ? ' PRIMARY KEY' : ''}${def}`;
        });
      await admin.query(`CREATE TABLE engagement_attachments(${columns.join(',')})`);
      const ctx = {
        tenantId: AUTHORIZED_TENANTS.T1.id,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        userId: randomUUID(),
        role: 'standard_user',
      };
      const clientId = randomUUID(),
        run = randomUUID(),
        logicalId = 'ENUM-CLEANUP-1',
        bytes = Buffer.from('Synthetic enum cleanup fixture\n');
      const contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const idempotencyKey = `${FIXTURE_NAMESPACE}:${run}:${logicalId}`;
      const id = clientDocumentPhysicalId({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        idempotencyKey,
        contentType: 'text/plain',
        byteSha256: contentSha256,
      });
      const marker = ownedIdentity(
        logicalId,
        ctx.tenantId,
        'engagement_attachment',
        FIXTURE_VERSION,
        run,
      );
      await admin.query('INSERT INTO tenants VALUES($1,$2)', [ctx.tenantId, ctx.tenantSlug]);
      await admin.query("INSERT INTO tenant_memberships VALUES($1,$2,'active','standard_user')", [
        ctx.tenantId,
        ctx.userId,
      ]);
      await admin.query('INSERT INTO clients VALUES($1,$2,false)', [clientId, ctx.tenantId]);
      const url = new URL(`postgresql://${cfg.host}:${cfg.port}/${cfg.database}`);
      url.username = cfg.user;
      url.password = cfg.password;
      url.searchParams.set('schema', schema);
      db = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
      const tx = (work) =>
        db.$transaction(async (client) => {
          await client.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
          return work(client);
        });
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
      const bucket = 'owned-enum-test-bucket';
      await tx((client) =>
        client.engagementAttachment.create({
          data: {
            id,
            tenantId: ctx.tenantId,
            clientId,
            uploadedByUserId: ctx.userId,
            fileName: 'synthetic-enum.txt',
            contentType: 'text/plain',
            byteSize: bytes.length,
            bucket,
            s3Key: `tenants/${ctx.tenantId}/engagement/${id}/document`,
            source: 'meri_synthetic_fixture',
            sourceEntityType: 'meri_synthetic_fixture',
            sourceEntityId: marker.markerSha256,
            sourceVersion: 1,
            sourceContentHash: contentSha256,
            calculatedSha256: contentSha256,
            viewerMode: 'all',
            viewerUserIds: [],
            lifecycleStatus: 'ready',
            scanStatus: 'clean',
            extractionMetadata: {},
          },
        }),
      );
      const expectedRowVersion = (
        await admin.query('SELECT xmin::text AS version FROM engagement_attachments WHERE id=$1', [
          id,
        ])
      ).rows[0].version;
      const guard = {
        expectedRowVersion,
        expectedBucket: bucket,
        fixtureVersion: FIXTURE_VERSION,
        fixtureInstanceId: run,
        logicalId,
        clientId,
        fileName: 'synthetic-enum.txt',
        contentType: 'text/plain',
        byteSize: bytes.length,
        contentSha256,
        sourceVersion: 1,
      };
      await t.test('old enum = Prisma text expression reproduces P2010/42883', async () => {
        await assert.rejects(
          tx(
            (client) =>
              client.$queryRaw`SELECT user_id FROM tenant_memberships WHERE role=${ctx.role}`,
          ),
          (error) => error?.code === 'P2010' && error?.meta?.code === '42883',
        );
      });
      await t.test(
        'current helper inspects and claims the exact owned document through the real enum query',
        async () => {
          const inspected = await tx((client) =>
            guardSyntheticDocumentDeletionInTx(client, ctx, id, guard, bucket, 'inspect'),
          );
          assert.equal(inspected.state, 'present');
          assert.equal(inspected.rowVersion, expectedRowVersion);
          const claimed = await tx((client) =>
            guardSyntheticDocumentDeletionInTx(client, ctx, id, guard, bucket, 'claim'),
          );
          const saved = await tx((client) =>
            client.engagementAttachment.findUnique({ where: { id } }),
          );
          assert.equal(saved.lifecycleStatus, 'delete_pending');
          assert.equal(saved.extractionMetadata.syntheticFixtureDeleteIntent, claimed.intent);
          const finish = await tx((client) =>
            guardSyntheticDocumentDeletionInTx(client, ctx, id, guard, bucket, 'finish'),
          );
          assert.equal(finish.state, 'pending');
          assert.equal(finish.intent, claimed.intent);
        },
      );
      await t.test(
        'cast does not elevate role or bypass current namespace/client wall',
        async () => {
          await assert.rejects(
            tx((client) =>
              guardSyntheticDocumentDeletionInTx(
                client,
                { ...ctx, role: 'user_admin' },
                id,
                guard,
                bucket,
                'inspect',
              ),
            ),
            /guard does not match/,
          );
          await admin.query('UPDATE clients SET memory_wall=true WHERE id=$1', [clientId]);
          await assert.rejects(
            tx((client) =>
              guardSyntheticDocumentDeletionInTx(client, ctx, id, guard, bucket, 'inspect'),
            ),
            /guard does not match/,
          );
          await admin.query('UPDATE clients SET memory_wall=false WHERE id=$1', [clientId]);
          process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'wrong';
          await assert.rejects(
            tx((client) =>
              guardSyntheticDocumentDeletionInTx(client, ctx, id, guard, bucket, 'inspect'),
            ),
            /guard does not match/,
          );
          process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
        },
      );
    } finally {
      await db?.$disconnect();
      assert.match(schema, /^meri_document_enum_[a-f0-9]{32}$/);
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      if (prior === undefined) delete process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE;
      else process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = prior;
    }
  },
);
