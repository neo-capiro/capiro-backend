import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { before, after, describe, it } from 'node:test';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import {
  createClientDocumentOwnerPort,
  CanonicalOwnerAdapter,
} from '../fixture-provisioning/canonical-owner-adapter.mjs';
import { createClientDocumentOwnerReader } from '../fixture-provisioning/client-document-owner-reader.mjs';
import { createClientDocumentDeletionPort } from '../fixture-provisioning/client-document-deletion-owner.mjs';
import {
  planFixture,
  applyFixture,
  planOwnedReset,
  applyOwnedReset,
} from '../fixture-provisioning/provisioner.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  receiptWithHash,
  APPLY_CONFIRMATION,
  RESET_CONFIRMATION,
} from '../fixture-provisioning/contract.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const { Pool } = require('pg');
const { Prisma } = require('@prisma/client');
const { PrismaService } = require('./dist/prisma/prisma.service.js');
const { EngagementService } = require('./dist/engagement/engagement.service.js');
const {
  ClientDocumentWriterService,
} = require('./dist/client-documents/client-document-writer.service.js');
const { AttachmentContentService } = require('./dist/engagement/attachment-content.service.js');
const { ClientKbService } = require('./dist/embeddings/client-kb.service.js');
const {
  EngagementRuntimePolicyService,
} = require('./dist/engagement/runtime/engagement-runtime-policy.service.js');
const { clientMemoryAllowed } = require('./dist/memory/memory-wall.helpers.js');
const configPath = process.env.MERI_FIXTURE_POSTGRES_CONFIG;
const TENANT = AUTHORIZED_TENANTS.T1.id,
  USER = '44444444-4444-4444-8444-444444444444',
  CLIENT = '11111111-1111-4111-8111-111111111111';

describe(
  'canonical fixture document uploader and source-only readback',
  { skip: !configPath },
  () => {
    const schema = `meri_document_${randomUUID().replaceAll('-', '')}`;
    const prior = {
      database: process.env.DATABASE_URL,
      namespace: process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE,
    };
    let pool, prisma, service, port, reader, writer, adapter;
    const objects = new Map(),
      calls = [];
    let duringGet = null,
      duringDelete = null,
      failDelete = false;
    let headError = null,
      duringHead = null,
      loseDeleteAcknowledgment = false;
    const purges = [];
    before(async () => {
      const database = JSON.parse(await readFile(configPath, 'utf8'));
      assert.equal(database.host, '127.0.0.1');
      assert.equal(database.port, 55433);
      assert.equal(database.database, 'postgres');
      pool = new Pool(database);
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await pool.query(`CREATE TABLE "${schema}".tenants(id uuid PRIMARY KEY,slug text);
    CREATE TABLE "${schema}".tenant_memberships(tenant_id uuid,user_id uuid,status text,role text);
    CREATE TABLE "${schema}".clients(id uuid PRIMARY KEY,tenant_id uuid,memory_wall boolean DEFAULT false);
    CREATE TABLE "${schema}".client_memory_access(tenant_id uuid,client_id uuid,user_id uuid);
    CREATE TABLE "${schema}".context_embeddings(tenant_id uuid,source_type text,source_id text);`);
      // Minimal isolated owner schema, not a migration/RLS qualification. Scalar
      // columns follow generated Prisma metadata so real owner queries execute.
      const uuidFields = new Set([
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
          assert.match(name, /^[a-z_][a-z0-9_]*$/u);
          const type = f.isList
            ? 'text[]'
            : uuidFields.has(f.name)
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
      await pool.query(`CREATE TABLE "${schema}".engagement_attachments(${columns.join(',')})`);
      await pool.query(`INSERT INTO "${schema}".tenants VALUES ($1,$2)`, [
        TENANT,
        AUTHORIZED_TENANTS.T1.slug,
      ]);
      await pool.query(
        `INSERT INTO "${schema}".tenant_memberships VALUES ($1,$2,'active','standard_user')`,
        [TENANT, USER],
      );
      await pool.query(`INSERT INTO "${schema}".clients(id,tenant_id) VALUES ($1,$2)`, [
        CLIENT,
        TENANT,
      ]);
      const url = new URL(`postgresql://${database.host}:${database.port}/${database.database}`);
      url.username = database.user;
      url.password = database.password;
      url.searchParams.set('schema', schema);
      process.env.DATABASE_URL = url.href;
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
      prisma = new PrismaService();
      await prisma.$connect();
      service = Object.assign(Object.create(EngagementService.prototype), {
        prisma,
        bucket: 'owned-local-test-assets',
        attachmentContent: new AttachmentContentService(),
        scanner: {
          scanRequired: true,
          providerName: 'owned-test-scanner',
          getStatus: async () => 'clean',
        },
        logger: { error: () => {}, warn: () => {} },
        clientKb: Object.assign(Object.create(ClientKbService.prototype), {
          indexAttachmentFireAndForget: () => {},
          purgeFireAndForget: (...args) => purges.push(args),
        }),
        s3: {
          send: async (command) => {
            const kind = command.constructor.name;
            calls.push(kind);
            assert.equal(command.input.Bucket, 'owned-local-test-assets');
            if (kind === 'PutObjectCommand') {
              objects.set(command.input.Key, Buffer.from(command.input.Body));
              return {};
            }
            if (kind === 'GetObjectCommand') {
              const bytes = objects.get(command.input.Key);
              assert.ok(bytes, 'canonical object exists');
              if (duringGet) await duringGet();
              return { Body: { transformToByteArray: async () => Uint8Array.from(bytes) } };
            }
            if (kind === 'DeleteObjectCommand') {
              if (failDelete) throw new Error('owned sandbox deletion failure');
              objects.delete(command.input.Key);
              if (duringDelete) await duringDelete();
              return {};
            }
            if (kind === 'HeadObjectCommand') {
              if (headError) throw headError;
              const present = objects.has(command.input.Key);
              if (duringHead) await duringHead();
              if (present) return {};
              const error = new Error('owned object is absent');
              error.name = 'NotFound';
              error.$metadata = { httpStatusCode: 404 };
              throw error;
            }
            assert.fail(`unsandboxed operation ${kind}`);
          },
        },
      });
      const runtime = new EngagementRuntimePolicyService({
        serviceName: 'api',
        processMode: 'active',
        backgroundOwner: 'disabled',
        externalActions: 'enabled',
        callbacksEnabled: false,
        recallWebhookEnabled: false,
      });
      writer = new ClientDocumentWriterService(service, runtime);
      reader = createClientDocumentOwnerReader({
        prisma,
        engagement: service,
        actorForTenant: () => USER,
        clientMemoryAllowed,
        storageBucket: 'owned-local-test-assets',
      });
      port = createClientDocumentOwnerPort({
        documentWriter: writer,
        reader,
        actorForTenant: () => USER,
        assetRoot: new URL('../source-binaries/', import.meta.url),
        deletion: createClientDocumentDeletionPort({
          prisma,
          actorForTenant: () => USER,
          documentWriter: {
            inspectSyntheticFixtureAttachmentDeletion:
              writer.inspectSyntheticFixtureAttachmentDeletion,
            deleteSyntheticFixtureAttachment: async (...args) => {
              const result = await writer.deleteSyntheticFixtureAttachment(...args);
              if (loseDeleteAcknowledgment) {
                loseDeleteAcknowledgment = false;
                throw new Error('owned lost acknowledgement');
              }
              return result;
            },
          },
        }),
      });
      adapter = new CanonicalOwnerAdapter({ ownerPorts: { engagement_attachment: port } });
    });
    after(async () => {
      await prisma?.$disconnect();
      for (const [key, value] of [
        ['DATABASE_URL', prior.database],
        ['MERI_SYNTHETIC_FIXTURE_NAMESPACE', prior.namespace],
      ]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (pool) {
        assert.match(schema, /^meri_document_[a-f0-9]{32}$/u);
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
        console.info(`Removed owned document schema ${schema}`);
      }
    });
    async function fixture(logicalId = 'D-A-1') {
      const manifest = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: { ASTER: { tenantId: 'T1', physicalId: CLIENT } },
        actors: { PAT: { tenantId: 'T1', userId: USER } },
        uploaderActors: { T1: 'PAT' },
        availableOwners: ['engagement_attachment'],
      });
      const record = manifest.records.find((row) => row.logicalId === logicalId);
      assert.equal(record.availability.status, 'available');
      return record;
    }
    const create = (record) =>
      port.create(record, {
        tenantId: record.tenantId,
        physicalId: record.physicalId,
        expectedOwnershipMarkerSha256: record.ownership.markerSha256,
        expectedRowVersion: null,
      });
    const actor = { tenantId: TENANT, userId: USER, role: 'standard_user' };
    const objectKey = (record) => `tenants/${TENANT}/engagement/${record.physicalId}/document`;
    async function stored(record) {
      return (
        (
          await pool.query(
            `SELECT to_jsonb(a) AS row,xmin::text AS version FROM "${schema}".engagement_attachments a WHERE id=$1`,
            [record.physicalId],
          )
        ).rows[0] ?? null
      );
    }
    async function deletionGuard(record) {
      const asset = record.payload.sourceAsset;
      return {
        expectedRowVersion: (await stored(record)).version,
        expectedBucket: 'owned-local-test-assets',
        fixtureVersion: record.ownership.marker.fixtureVersion,
        fixtureInstanceId: record.ownership.marker.fixtureInstanceId,
        logicalId: record.logicalId,
        clientId: record.clientPhysicalId,
        fileName: asset.fileName,
        contentType: asset.mediaType,
        byteSize: asset.byteSize,
        contentSha256: asset.byteSha256,
        sourceVersion: Number.parseInt(String(asset.version ?? '1').replace(/\D/gu, ''), 10) || 1,
      };
    }
    const erase = (record, guard) =>
      writer.deleteSyntheticFixtureAttachment(actor, record.physicalId, guard);
    const resetGuard = (record, guard) => ({
      tenantId: TENANT,
      physicalId: record.physicalId,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
      expectedRowVersion: guard.expectedRowVersion,
      expectedStorageBucket: guard.expectedBucket ?? guard.expectedStorageBucket,
    });
    async function seededDocumentSlice() {
      const built = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: {
          ASTER: { tenantId: 'T1', physicalId: CLIENT },
          BLUEHAVEN: { tenantId: 'T1', physicalId: '22222222-2222-4222-8222-222222222222' },
          CEDAR: { tenantId: 'T2', physicalId: '33333333-3333-4333-8333-333333333333' },
        },
        actors: { PAT: { tenantId: 'T1', userId: USER } },
        uploaderActors: { T1: 'PAT' },
        availableOwners: ['engagement_attachment'],
      });
      const { contentSha256, ...body } = built;
      // Keep all frozen logical records, but qualify only these three ready
      // documents. Other lifecycle states remain explicitly unavailable.
      const manifest = receiptWithHash({
        ...body,
        records: body.records.map((record) =>
          ['D-A-1', 'DECK-A-1', 'SHEET-A-1'].includes(record.logicalId)
            ? record
            : {
                ...record,
                availability: {
                  status: 'unavailable',
                  reason: 'outside this three-document lifecycle test',
                },
              },
        ),
      });
      const plan = await planFixture({ manifest, adapter });
      const seedReceipt = await applyFixture({
        manifest,
        plan,
        adapter,
        confirmation: APPLY_CONFIRMATION,
      });
      assert.equal(
        seedReceipt.status,
        'complete',
        JSON.stringify({ status: seedReceipt.status, records: seedReceipt.records }),
      );
      assert.ok(
        seedReceipt.records.every(
          (row) =>
            row.storageProof?.kind === 'canonical-source-byte-readback-v1' &&
            row.storageProof.bucket === 'owned-local-test-assets',
        ),
      );
      assert.equal(seedReceipt.fixtureComplete, false);
      const resetPlan = await planOwnedReset({ manifest, seedReceipt, adapter });
      assert.equal(resetPlan.operations.length, 3);
      return { manifest, seedReceipt, resetPlan, adapter, confirmation: RESET_CONFIRMATION };
    }
    it('resets a real three-document owner slice and verifies current storage plus index absence', async () => {
      const input = await seededDocumentSlice();
      const result = await applyOwnedReset(input);
      assert.equal(result.status, 'complete');
      assert.equal(result.records.length, 3);
      for (const operation of input.resetPlan.operations) {
        const record = input.manifest.records.find((row) => row.logicalId === operation.logicalId);
        assert.equal(await stored(record), null);
        assert.equal(objects.has(objectKey(record)), false);
      }
      const before = calls.filter((kind) => kind === 'DeleteObjectCommand').length;
      const retry = await applyOwnedReset(input);
      assert.equal(retry.status, 'complete');
      assert.ok(retry.records.every((row) => row.outcome === 'already_absent'));
      assert.equal(calls.filter((kind) => kind === 'DeleteObjectCommand').length, before);
      const newPlan = await planOwnedReset(input);
      assert.equal(
        newPlan.operations.length,
        3,
        'already-absent records remain subject to apply-time proof',
      );
      const firstRecord = input.manifest.records.find(
        (row) => row.logicalId === newPlan.operations[0].logicalId,
      );
      objects.set(objectKey(firstRecord), Buffer.from('object reappeared after reset planning'));
      try {
        assert.equal((await applyOwnedReset({ ...input, resetPlan: newPlan })).status, 'failed');
      } finally {
        objects.delete(objectKey(firstRecord));
      }
    });
    it('reconciles a retained storage-failure intent through the original reset plan', async () => {
      const input = await seededDocumentSlice();
      failDelete = true;
      let failed;
      try {
        failed = await applyOwnedReset(input);
      } finally {
        failDelete = false;
      }
      assert.equal(failed.status, 'unknown_outcome');
      const first = input.resetPlan.operations[0];
      const record = input.manifest.records.find((row) => row.logicalId === first.logicalId);
      const proof = await adapter.inspectForReset(record, resetGuard(record, first));
      assert.equal(proof.deletionState, 'pending');
      assert.notEqual(proof.rowVersion, first.expectedRowVersion);
      assert.equal(proof.deletionOriginalRowVersion, first.expectedRowVersion);
      await assert.rejects(
        adapter.inspectForReset(record, {
          ...resetGuard(record, first),
          expectedRowVersion: proof.rowVersion,
        }),
        { status: 403 },
      );
      const retry = await applyOwnedReset(input);
      assert.equal(retry.status, 'complete');
      assert.equal(await stored(record), null);
    });
    it('reconciles a lost canonical deletion acknowledgement without repeating the effect', async () => {
      const input = await seededDocumentSlice();
      loseDeleteAcknowledgment = true;
      const first = await applyOwnedReset(input);
      assert.equal(first.status, 'unknown_outcome');
      const before = calls.filter((kind) => kind === 'DeleteObjectCommand').length;
      const retry = await applyOwnedReset(input);
      assert.equal(retry.status, 'complete');
      assert.equal(retry.records[0].outcome, 'already_absent');
      assert.equal(calls.filter((kind) => kind === 'DeleteObjectCommand').length, before + 2);
    });
    it('never accepts row absence alone when storage or indexed chunks remain', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        operation = resetGuard(record, guard);
      await erase(record, guard);
      objects.set(objectKey(record), Buffer.from('orphaned owned test bytes'));
      await assert.rejects(adapter.inspectForReset(record, operation), { status: 409 });
      objects.delete(objectKey(record));
      await pool.query(
        `INSERT INTO "${schema}".context_embeddings VALUES ($1,'client_doc_chunk',$2)`,
        [TENANT, `${record.physicalId}:0`],
      );
      await assert.rejects(adapter.inspectForReset(record, operation), { status: 409 });
      await pool.query(
        `DELETE FROM "${schema}".context_embeddings WHERE tenant_id=$1 AND source_id=$2`,
        [TENANT, `${record.physicalId}:0`],
      );
      assert.equal(await adapter.inspectForReset(record, operation), null);
    });
    it('refuses inaccessible storage and revoked authority during absence readback', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        operation = resetGuard(record, guard);
      await erase(record, guard);
      for (const [name, code] of [
        ['AccessDenied', 403],
        ['NoSuchBucket', 404],
        ['TimeoutError', 504],
      ]) {
        headError = Object.assign(new Error('owned storage fault'), {
          name,
          $metadata: { httpStatusCode: code },
        });
        try {
          await assert.rejects(adapter.inspectForReset(record, operation), { name });
        } finally {
          headError = null;
        }
      }
      service.bucket = 'changed-test-bucket';
      const count = calls.length;
      try {
        await assert.rejects(adapter.inspectForReset(record, operation), { status: 403 });
      } finally {
        service.bucket = 'owned-local-test-assets';
      }
      assert.equal(calls.length, count, 'bucket mismatch refuses before storage access');
      await assert.rejects(
        adapter.inspectForReset(record, { ...operation, expectedStorageBucket: undefined }),
        { code: 'DOCUMENT_DELETION_IDENTITY_INVALID' },
      );
      duringHead = () =>
        pool.query(`UPDATE "${schema}".tenant_memberships SET status='inactive' WHERE user_id=$1`, [
          USER,
        ]);
      try {
        await assert.rejects(adapter.inspectForReset(record, operation), { status: 403 });
      } finally {
        duringHead = null;
        await pool.query(
          `UPDATE "${schema}".tenant_memberships SET status='active' WHERE user_id=$1`,
          [USER],
        );
      }
    });
    it('rejects row recreation during storage-absence readback', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        operation = resetGuard(record, guard);
      await erase(record, guard);
      duringHead = async () => {
        duringHead = null;
        await create(record);
      };
      try {
        await assert.rejects(adapter.inspectForReset(record, operation), { status: 403 });
      } finally {
        duringHead = null;
      }
      assert.equal((await stored(record)).row.lifecycle_status, 'ready');
      assert.equal(objects.has(objectKey(record)), true);
    });
    it('deletes owned document chunks and row atomically while preserving neighboring sources', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record);
      const otherTenant = AUTHORIZED_TENANTS.T2.id;
      const staleIndexSnapshot = await prisma.withTenant(TENANT, (tx) =>
        tx.engagementAttachment.findFirst({ where: { id: record.physicalId, tenantId: TENANT } }),
      );
      await pool.query(
        `INSERT INTO "${schema}".context_embeddings VALUES ($1,'client_doc_chunk',$2),($1,'client_doc_chunk',$3),($1,'client_profile',$2),($4,'client_doc_chunk',$2),($1,'client_doc_chunk',$5)`,
        [
          TENANT,
          record.physicalId,
          `${record.physicalId}:0`,
          otherTenant,
          `${record.physicalId}-neighbor:0`,
        ],
      );
      await erase(record, guard);
      const rows = (
        await pool.query(
          `SELECT tenant_id,source_type,source_id FROM "${schema}".context_embeddings WHERE source_id LIKE $1 ORDER BY tenant_id,source_type,source_id`,
          [`${record.physicalId}%`],
        )
      ).rows;
      assert.equal(rows.length, 3, 'only exact document and its chunk prefix are purged');
      assert.equal(
        rows.some(
          (row) =>
            row.tenant_id === TENANT &&
            row.source_type === 'client_doc_chunk' &&
            [record.physicalId, `${record.physicalId}:0`].includes(row.source_id),
        ),
        false,
      );
      assert.equal(await stored(record), null);
      const mayWrite = await prisma.withTenant(TENANT, async (tx) => {
        const current = await service.clientKb.lockAttachmentSnapshot(
          tx,
          TENANT,
          staleIndexSnapshot,
        );
        if (current)
          await tx.$executeRawUnsafe(
            'INSERT INTO context_embeddings(tenant_id,source_type,source_id) VALUES ($1::uuid,$2,$3)',
            TENANT,
            'client_doc_chunk',
            `${record.physicalId}:late`,
          );
        return current;
      });
      assert.equal(
        mayWrite,
        false,
        'the actual index write guard rejects a stale job after deletion',
      );
    });
    it('retains deletion intent on transactional index-cleanup failure and reconciles an exact retry', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record);
      await pool.query(
        `INSERT INTO "${schema}".context_embeddings VALUES ($1,'client_doc_chunk',$2)`,
        [TENANT, record.physicalId],
      );
      await pool.query(`CREATE FUNCTION "${schema}".reject_fixture_purge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned purge fault'; END $$;
        CREATE TRIGGER reject_fixture_purge BEFORE DELETE ON "${schema}".context_embeddings FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_fixture_purge();`);
      try {
        await assert.rejects(erase(record, guard), /owned purge fault/);
      } finally {
        await pool.query(`DROP TRIGGER reject_fixture_purge ON "${schema}".context_embeddings`);
      }
      assert.equal(objects.has(objectKey(record)), false, 'storage deletion already happened');
      assert.equal((await stored(record)).row.lifecycle_status, 'delete_pending');
      assert.equal(
        (
          await pool.query(
            `SELECT * FROM "${schema}".context_embeddings WHERE tenant_id=$1 AND source_id=$2`,
            [TENANT, record.physicalId],
          )
        ).rowCount,
        1,
      );
      await erase(record, guard);
      assert.equal(await stored(record), null);
      assert.equal(
        (
          await pool.query(
            `SELECT * FROM "${schema}".context_embeddings WHERE tenant_id=$1 AND source_id=$2`,
            [TENANT, record.physicalId],
          )
        ).rowCount,
        0,
      );
    });
    it('deletes canonical owned bytes and row without relying on asynchronous KB cleanup', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record);
      const purgeCount = purges.length;
      await erase(record, guard);
      assert.equal(await stored(record), null);
      assert.equal(objects.has(objectKey(record)), false);
      assert.equal(await reader(record), null);
      assert.equal(purges.length, purgeCount);
    });
    it('refuses stale versions and foreign metadata without deleting bytes or changing rows', async () => {
      for (const mutation of [
        "file_name='changed'",
        "source_entity_id='foreign'",
        "s3_key='foreign/key'",
        "source_content_hash='foreign'",
        "approved_by_user_id='66666666-6666-4666-8666-666666666666'",
      ]) {
        const record = await fixture();
        await create(record);
        const guard = await deletionGuard(record);
        await pool.query(`UPDATE "${schema}".engagement_attachments SET ${mutation} WHERE id=$1`, [
          record.physicalId,
        ]);
        const before = await stored(record),
          count = calls.length;
        await assert.rejects(erase(record, guard), { status: 403 });
        assert.deepEqual(await stored(record), before);
        assert.equal(calls.length, count);
        assert.equal(objects.has(objectKey(record)), true);
      }
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        count = calls.length;
      await assert.rejects(
        erase(record, {
          ...guard,
          expectedRowVersion: String(Number(guard.expectedRowVersion) + 1),
        }),
        { status: 403 },
      );
      await assert.rejects(
        writer.deleteSyntheticFixtureAttachment(
          { ...actor, role: 'tenant_admin' },
          record.physicalId,
          guard,
        ),
        { status: 403 },
      );
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'foreign';
      try {
        await assert.rejects(erase(record, guard), { status: 403 });
      } finally {
        process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
      }
      assert.equal(calls.length, count);
    });
    it('waits for a competing row transaction and refuses its changed version before storage deletion', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        count = calls.length;
      const blocker = await pool.connect();
      let operation;
      try {
        await blocker.query('BEGIN');
        const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await blocker.query(
          `SELECT id FROM "${schema}".engagement_attachments WHERE id=$1 FOR UPDATE`,
          [record.physicalId],
        );
        operation = erase(record, guard).then(
          () => null,
          (error) => error,
        );
        let observed = false;
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const waiting = await pool.query(
            'SELECT pid FROM pg_stat_activity WHERE $1::integer=ANY(pg_blocking_pids(pid))',
            [pid],
          );
          if (waiting.rows.length > 0) {
            observed = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(observed, true, 'actual owner transaction waits for the competing row lock');
        await blocker.query(
          `UPDATE "${schema}".engagement_attachments SET file_name='competing writer' WHERE id=$1`,
          [record.physicalId],
        );
        await blocker.query('COMMIT');
        assert.equal((await operation)?.status, 403);
        assert.equal(calls.length, count);
        assert.equal((await stored(record)).row.lifecycle_status, 'ready');
        assert.equal(objects.has(objectKey(record)), true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (operation) await operation;
      }
    });
    it('retains guarded failed deletion and retries only its original intent', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record);
      failDelete = true;
      try {
        await assert.rejects(erase(record, guard), { status: 503 });
      } finally {
        failDelete = false;
      }
      const failed = await stored(record);
      assert.equal(failed.row.lifecycle_status, 'delete_failed');
      assert.match(
        failed.row.extraction_metadata_jsonb.syntheticFixtureDeleteIntent,
        /^[a-f0-9]{64}$/u,
      );
      assert.equal(objects.has(objectKey(record)), true);
      assert.deepEqual(await service.reconcileFailedAttachmentDeletes(actor), {
        retried: 0,
        deleted: 0,
        stillFailing: 0,
      });
      await assert.rejects(erase(record, { ...guard, expectedRowVersion: failed.version }), {
        status: 403,
      });
      await erase(record, guard);
      assert.equal(await stored(record), null);
      assert.equal(objects.has(objectKey(record)), false);
    });
    it('refuses missing storage and changed access before claiming deletion', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        before = await stored(record),
        count = calls.length;
      service.bucket = undefined;
      try {
        await assert.rejects(erase(record, guard), { status: 403 });
      } finally {
        service.bucket = 'owned-local-test-assets';
      }
      await pool.query(`UPDATE "${schema}".clients SET memory_wall=true WHERE id=$1`, [CLIENT]);
      try {
        await assert.rejects(erase(record, guard), { status: 403 });
      } finally {
        await pool.query(`UPDATE "${schema}".clients SET memory_wall=false WHERE id=$1`, [CLIENT]);
      }
      assert.deepEqual(await stored(record), before);
      assert.equal(calls.length, count);
    });
    it('retains a changed row when final validation fails after object deletion', async () => {
      const record = await fixture();
      await create(record);
      const guard = await deletionGuard(record),
        purgeCount = purges.length;
      duringDelete = () =>
        pool.query(
          `UPDATE "${schema}".engagement_attachments SET file_name='concurrent change' WHERE id=$1`,
          [record.physicalId],
        );
      try {
        await assert.rejects(erase(record, guard), { status: 403 });
      } finally {
        duringDelete = null;
      }
      assert.equal(objects.has(objectKey(record)), false);
      const remaining = await stored(record);
      assert.equal(remaining.row.lifecycle_status, 'delete_pending');
      assert.equal(remaining.row.file_name, 'concurrent change');
      assert.equal(purges.length, purgeCount);
    });
    it('preserves ordinary canonical deletion and failed-delete reconciliation', async () => {
      for (const source of [null, 'ordinary']) {
        const record = await fixture();
        await create(record);
        await pool.query(
          `UPDATE "${schema}".engagement_attachments SET source_entity_type=$2 WHERE id=$1`,
          [record.physicalId, source],
        );
        failDelete = true;
        try {
          await assert.rejects(writer.deleteAttachment(actor, record.physicalId), { status: 503 });
        } finally {
          failDelete = false;
        }
        assert.deepEqual(await service.reconcileFailedAttachmentDeletes(actor), {
          retried: 1,
          deleted: 1,
          stillFailing: 0,
        });
        assert.equal(await stored(record), null);
        assert.equal(objects.has(objectKey(record)), false);
      }
    });
    it('uploads immutable fixture bytes and verifies them through real canonical source-only extraction', async () => {
      for (const logicalId of ['D-A-1', 'DECK-A-1', 'SHEET-A-1']) {
        const record = await fixture(logicalId);
        assert.equal(await reader(record), null);
        await create(record);
        const proof = await reader(record);
        assert.equal(proof.physicalId, record.physicalId);
        assert.equal(proof.contentSha256, record.payload.sourceAsset.byteSha256);
        assert.equal(proof.payloadSha256, record.payloadSha256);
        assert.equal(proof.lifecycleStatus, 'ready');
        const beforeCalls = calls.length;
        await create(record);
        assert.equal(calls.length, beforeCalls, 'retry does not upload twice');
        assert.deepEqual(await reader(record), proof);
        const state = (
          await pool.query(
            `SELECT extraction_status,extraction_metadata_jsonb FROM "${schema}".engagement_attachments WHERE id=$1`,
            [record.physicalId],
          )
        ).rows[0];
        assert.equal(state.extraction_status, 'pending');
        assert.deepEqual(state.extraction_metadata_jsonb, {});
        console.info(JSON.stringify({ documentReadback: proof }));
      }
    });
    it('detects stored object tampering despite unchanged canonical hash declarations', async () => {
      const record = await fixture();
      await create(record);
      objects.set(
        `tenants/${TENANT}/engagement/${record.physicalId}/document`,
        Buffer.from('changed storage bytes'),
      );
      await assert.rejects(reader(record), { code: 'DOCUMENT_FIXTURE_BYTES_MISMATCH' });
    });
    it('refuses namespace, ownership and row metadata drift before reading object bytes', async () => {
      const record = await fixture();
      await create(record);
      const beforeCalls = calls.length;
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = 'wrong';
      try {
        await assert.rejects(reader(record), { code: 'DOCUMENT_FIXTURE_IDENTITY_INVALID' });
      } finally {
        process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = FIXTURE_NAMESPACE;
      }
      for (const mutation of [
        "source_entity_id='foreign'",
        "uploaded_by_user_id='66666666-6666-4666-8666-666666666666'",
        'source_version=9',
        "s3_key='foreign/key'",
        "bucket='foreign-bucket'",
        "viewer_mode='restricted'",
        "approved_by_user_id='66666666-6666-4666-8666-666666666666'",
        "shared_by_user_id='66666666-6666-4666-8666-666666666666'",
        "superseded_by_attachment_id='66666666-6666-4666-8666-666666666666'",
      ]) {
        const next = await fixture();
        await create(next);
        const count = calls.length;
        await pool.query(`UPDATE "${schema}".engagement_attachments SET ${mutation} WHERE id=$1`, [
          next.physicalId,
        ]);
        await assert.rejects(reader(next), { code: 'DOCUMENT_FIXTURE_ROW_MISMATCH' });
        assert.equal(calls.length, count);
      }
      assert.ok(calls.length >= beforeCalls);
    });
    it('honors canonical quarantine and never downloads quarantined bytes', async () => {
      const record = await fixture();
      await create(record);
      await pool.query(
        `UPDATE "${schema}".engagement_attachments SET lifecycle_status='quarantined',scan_status='pending' WHERE id=$1`,
        [record.physicalId],
      );
      const count = calls.length;
      await assert.rejects(reader(record));
      assert.equal(calls.length, count);
    });
    it('rechecks active membership and client walls before and after the object read', async () => {
      const record = await fixture();
      await create(record);
      const count = calls.length;
      await pool.query(`UPDATE "${schema}".clients SET memory_wall=true WHERE id=$1`, [CLIENT]);
      try {
        await assert.rejects(reader(record), { code: 'DOCUMENT_FIXTURE_CLIENT_DENIED' });
        assert.equal(calls.length, count);
      } finally {
        await pool.query(`UPDATE "${schema}".clients SET memory_wall=false WHERE id=$1`, [CLIENT]);
      }
      duringGet = () =>
        pool.query(`UPDATE "${schema}".tenant_memberships SET status='inactive' WHERE user_id=$1`, [
          USER,
        ]);
      try {
        await assert.rejects(reader(record), { code: 'DOCUMENT_FIXTURE_ACTOR_UNAVAILABLE' });
      } finally {
        duringGet = null;
        await pool.query(
          `UPDATE "${schema}".tenant_memberships SET status='active' WHERE user_id=$1`,
          [USER],
        );
      }
    });
    it('refuses row replacement during byte download', async () => {
      const record = await fixture();
      await create(record);
      duringGet = () =>
        pool.query(
          `UPDATE "${schema}".engagement_attachments SET file_name='changed' WHERE id=$1`,
          [record.physicalId],
        );
      try {
        await assert.rejects(reader(record), { code: 'DOCUMENT_FIXTURE_READ_CHANGED' });
      } finally {
        duringGet = null;
      }
    });
  },
);
