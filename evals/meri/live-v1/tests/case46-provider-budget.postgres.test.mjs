import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';
import { clientDocumentPhysicalId } from '../fixture-provisioning/canonical-owner-adapter.mjs';
import { ownedIdentity } from '../fixture-provisioning/contract.mjs';
import { FIXTURE_VERSION } from '../fixture.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'case46 actual PG authority/CAS/lock/rollback; canonical storage is a bounded test port, not live S3',
  { skip: !configPath, timeout: 60_000 },
  async () => {
    assert.ok(isAbsolute(configPath));
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 55433);
    assert.equal(config.scope, 'owned local disposable test cluster; no AWS connection');
    assert.ok(isAbsolute(config.dataDirectory));
    const { Client } = require('pg');
    const admin = new Client({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectionTimeoutMillis: 3000,
    });
    try {
      await admin.connect();
    } catch {
      throw new Error('Owned loopback connection failed');
    }
    const schema = `meri_case46_${randomUUID().replaceAll('-', '')}`;
    const envKeys = [
      'INTERNAL_SERVICE_SECRET',
      'MERI_SYNTHETIC_FIXTURE_NAMESPACE',
      'ASSETS_BUCKET',
    ];
    const prior = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    let db, release;
    const pending = [];
    try {
      const actual = (
        await admin.query(
          "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
          [config.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, config.host);
      assert.equal(actual.port, 55433);
      assert.equal(
        actual.directory.replaceAll('\\', '/'),
        config.dataDirectory.replaceAll('\\', '/'),
      );
      require('ts-node').register({
        project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
        transpileOnly: true,
        experimentalResolver: true,
      });
      // Existing dependency donor is deliberately unchanged. Use this checkout's
      // built core rather than a different worktree's linked package in this process.
      const core = require(
        fileURLToPath(new URL('../../../../packages/meriv2-core/dist/index.js', import.meta.url)),
      );
      require('@capiro/meriv2-core');
      require.cache[require.resolve('@capiro/meriv2-core')].exports = core;
      const source = (name) =>
        require(
          fileURLToPath(new URL(`../../../../apps/api/src/meri/${name}.ts`, import.meta.url)),
        );
      const {
        case46SourceIdentity,
        readCase46CurrentAuthorityInTx,
        installCase46CaptureBinding,
        readSealedCase46Binding,
      } = source('meri-case46-authority');
      const { case46ProviderBudgetOwner } = source('meri-case46-provider-budget-owner');
      const { case46BudgetTestFixture } = source('meri-case46-provider-budget.spec-helper');
      const { case46BudgetHash } = source('meri-case46-provider-budget');
      const { MERI_CASE46: f } = core;
      const { p, q, b } = case46BudgetTestFixture();
      const ctx = {
        tenantId: f.tenantId,
        tenantSlug: f.tenantSlug,
        userId: f.actorUserId,
        clerkUserId: 'case46-local-only',
        role: 'standard_user',
      };
      process.env.INTERNAL_SERVICE_SECRET = 'case46-owned-test-key-only';
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE = f.namespace;
      process.env.ASSETS_BUCKET = 'owned-test-bucket';
      const identity = case46SourceIdentity(p.captureRunId);
      assert.equal(
        identity.ownershipSha256,
        ownedIdentity(
          f.sourceLogicalId,
          ctx.tenantId,
          'engagement_attachment',
          FIXTURE_VERSION,
          p.captureRunId,
        ).markerSha256,
      );
      assert.equal(
        identity.physicalId,
        clientDocumentPhysicalId({
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          clientId: f.clientId,
          idempotencyKey: identity.idempotencyKey,
          contentType: 'text/plain',
          byteSha256: f.sha256,
        }),
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(`CREATE TABLE tenants(id uuid PRIMARY KEY,slug text,settings_jsonb jsonb);
        CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text);
        CREATE TABLE tenant_memberships(tenant_id uuid,user_id uuid,status text,role text);
        CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,memory_wall boolean);
        CREATE TABLE client_memory_access(id uuid,tenant_id uuid,client_id uuid,user_id uuid);
        CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,title text,status text,archived_at timestamptz,metadata_jsonb jsonb);
        CREATE TABLE clio_messages(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,conversation_id uuid,client_id uuid,role text,body text,created_at timestamptz DEFAULT now());
        CREATE TABLE meri_action_proposals(id uuid,tenant_id uuid,conversation_id uuid);
        CREATE TABLE clio_artifacts(id uuid,tenant_id uuid,conversation_id uuid);
        CREATE TABLE engagement_attachments(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,uploaded_by_user_id uuid,meeting_id uuid,mail_message_id uuid,
          source text,source_entity_type text,source_entity_id text,source_version int,source_content_hash text,calculated_sha256 text,
          bucket text,s3_key text,file_name text,content_type text,byte_size int,lifecycle_status text,scan_status text,
          viewer_mode text,viewer_user_ids text[],approved_at timestamptz,approved_by_user_id uuid,shared_at timestamptz,shared_by_user_id uuid,superseded_by_attachment_id uuid);`);
      await admin.query('INSERT INTO tenants VALUES($1,$2,$3)', [
        ctx.tenantId,
        ctx.tenantSlug,
        { meriFoundationFixture: { fixtureNamespace: f.namespace } },
      ]);
      await admin.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
        ctx.userId,
        ctx.clerkUserId,
        'case46.synthetic@example.com',
        'Synthetic',
        'Pat',
      ]);
      await admin.query("INSERT INTO tenant_memberships VALUES($1,$2,'active','standard_user')", [
        ctx.tenantId,
        ctx.userId,
      ]);
      await admin.query('INSERT INTO clients VALUES($1,$2,true)', [f.clientId, ctx.tenantId]);
      await admin.query('INSERT INTO client_memory_access VALUES($1,$2,$3,$4)', [
        randomUUID(),
        ctx.tenantId,
        f.clientId,
        ctx.userId,
      ]);
      const original = { unrelated: { keep: 1 }, serverCaptureProviderBudget: 'untouched' };
      await admin.query("INSERT INTO clio_conversations VALUES($1,$2,$3,$4,$5,'active',NULL,$6)", [
        p.conversationId,
        ctx.tenantId,
        ctx.userId,
        f.clientId,
        `${f.namespace} case46 ${p.captureRunId}`,
        original,
      ]);
      await admin.query(
        `INSERT INTO engagement_attachments(id,tenant_id,client_id,uploaded_by_user_id,source,source_entity_type,source_entity_id,source_version,
        source_content_hash,calculated_sha256,bucket,s3_key,file_name,content_type,byte_size,lifecycle_status,scan_status,viewer_mode,viewer_user_ids)
        VALUES($1,$2,$3,$4,'meri_synthetic_fixture','meri_synthetic_fixture',$5,1,$6,$6,'owned-test-bucket',$7,$8,'text/plain',28,'ready','clean','all','{}')`,
        [
          identity.physicalId,
          ctx.tenantId,
          f.clientId,
          ctx.userId,
          identity.ownershipSha256,
          f.sha256,
          `tenants/${ctx.tenantId}/engagement/${identity.physicalId}/document`,
          f.filename,
        ],
      );
      const { PrismaClient } = require('@prisma/client');
      const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
      url.username = config.user;
      url.password = config.password;
      url.searchParams.set('schema', schema);
      db = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
      let failWrite = false,
        pause = false,
        paused,
        latestPid,
        firstPid,
        bytesChanged = false,
        sourceReads = 0;
      const pausedPromise = new Promise((resolve) => {
        paused = resolve;
      });
      const resume = new Promise((resolve) => {
        release = resolve;
      });
      const prisma = {
        withTenantUser: (_t, _u, work) =>
          db.$transaction(
            async (tx) => {
              await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
              await tx.$executeRawUnsafe("SET LOCAL lock_timeout='5s'");
              latestPid = (await tx.$queryRawUnsafe('SELECT pg_backend_pid() AS pid'))[0].pid;
              const wrapped = new Proxy(tx, {
                get(target, key) {
                  if (key === '$queryRaw')
                    return async (...args) => {
                      const result = await target.$queryRaw(...args);
                      if (
                        pause &&
                        args[0].join('').includes('SELECT metadata_jsonb AS metadata,title')
                      ) {
                        pause = false;
                        firstPid = latestPid;
                        paused();
                        await resume;
                      }
                      return result;
                    };
                  if (key === '$executeRaw')
                    return async (...args) => {
                      const n = await target.$executeRaw(...args);
                      if (failWrite) throw new Error('injected rollback');
                      return n;
                    };
                  return target[key];
                },
              });
              return work(wrapped);
            },
            { timeout: 15_000 },
          ),
      };
      const deps = {
        prisma,
        engagement: {
          async extractAttachmentText(actualCtx, id, options) {
            sourceReads++;
            assert.deepEqual(actualCtx, ctx);
            assert.equal(id, identity.physicalId);
            assert.equal(options.contextSourceOnly, true);
            assert.equal(options.clientId, f.clientId);
            assert.ok(options.signal instanceof AbortSignal);
            return {
              attachmentId: id,
              clientId: f.clientId,
              fileName: f.filename,
              contentType: 'text/plain',
              contentHash: bytesChanged ? 'e'.repeat(64) : f.sha256,
              byteSize: 28,
            };
          },
        },
      };
      const scope = { conversationId: p.conversationId, captureRunId: p.captureRunId };
      const current = await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        readCase46CurrentAuthorityInTx(tx, deps, ctx, scope),
      );
      const qualification = {
        ...q,
        currentVerifySha256: current.currentVerifySha256,
        maxAttempts: 1,
      };
      const install = () =>
        installCase46CaptureBinding(deps, {
          ctx,
          ...scope,
          expectedMetadataSha256: case46BudgetHash(original),
          qualification,
        });
      await install();
      await assert.rejects(install(), /prior_state_changed/);
      const saved = async () =>
        (
          await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [
            p.conversationId,
          ])
        ).rows[0].metadata_jsonb;
      const installed = await saved();
      assert.deepEqual(installed.unrelated, original.unrelated);
      assert.equal(installed.serverCaptureProviderBudget, 'untouched');
      const policy = {
        ...readSealedCase46Binding(installed, ctx, p.conversationId).policy,
        turnId: p.turnId,
      };
      const call = (operation, policyOverride = policy) =>
        case46ProviderBudgetOwner(deps, { ctx, policy: policyOverride, operation });
      const badSeal = structuredClone(installed);
      badSeal.governedArtifactCapture.qualification.maxCostMicros = 1;
      assert.throws(
        () => readSealedCase46Binding(badSeal, ctx, p.conversationId),
        /qualification_rebound/,
      );
      assert.throws(
        () => readSealedCase46Binding(installed, { ...ctx, role: 'user_admin' }, p.conversationId),
        /actor_denied/,
      );
      await assert.rejects(
        case46ProviderBudgetOwner(deps, {
          ctx: { ...ctx, clerkUserId: 'wrong-current-actor' },
          policy,
          operation: { kind: 'admit' },
        }),
        /current_actor_or_wall_denied/,
      );
      assert.deepEqual(await saved(), installed);
      await call({ kind: 'admit' }, { ...policy, turnId: null });
      await admin.query(
        "INSERT INTO clio_messages(id,tenant_id,user_id,conversation_id,client_id,role,body) VALUES($1,$2,$3,$4,$5,'user',$6)",
        [p.turnId, ctx.tenantId, ctx.userId, p.conversationId, f.clientId, f.prompt],
      );
      await call({ kind: 'admit' });
      const before = await saved();
      failWrite = true;
      await assert.rejects(call({ kind: 'reserve', binding: b }), /injected rollback/);
      failWrite = false;
      assert.deepEqual(await saved(), before);
      pause = true;
      const first = call({ kind: 'reserve', binding: b });
      pending.push(first);
      await pausedPromise;
      const second = call({
        kind: 'reserve',
        binding: { ...b, logicalOperationId: 'other', attemptId: 'other' },
      });
      pending.push(second);
      const secondRejected = assert.rejects(second, /attempts_exhausted/);
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        await delay(10);
        if (latestPid !== firstPid)
          blocked =
            (
              await admin.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND granted=false', [
                latestPid,
              ])
            ).rowCount > 0;
      }
      assert.equal(blocked, true, 'second PostgreSQL session blocks on actual conversation lock');
      release();
      const reserved = await first;
      await secondRejected;
      assert.equal(reserved.dispatchAllowed, true);
      assert.equal((await call({ kind: 'reserve', binding: b })).dispatchAllowed, false);
      await call({
        kind: 'settle',
        input: {
          reservationId: reserved.reservationId,
          binding: b,
          outcome: { kind: 'known', inputTokens: 10, outputTokens: 5 },
        },
      });
      assert.equal((await call({ kind: 'receipt' })).receipt.costMicros, 20);
      bytesChanged = true;
      await assert.rejects(call({ kind: 'read' }), /current_source_bytes_changed/);
      bytesChanged = false;
      await admin.query('DELETE FROM client_memory_access WHERE user_id=$1', [ctx.userId]);
      await assert.rejects(call({ kind: 'read' }), /current_actor_or_wall_denied/);
      await admin.query('INSERT INTO client_memory_access VALUES($1,$2,$3,$4)', [
        randomUUID(),
        ctx.tenantId,
        f.clientId,
        ctx.userId,
      ]);
      await admin.query('UPDATE engagement_attachments SET file_name=file_name WHERE id=$1', [
        identity.physicalId,
      ]);
      await assert.rejects(call({ kind: 'read' }), /current_binding_changed/);
      assert.ok(sourceReads >= 8);
    } finally {
      release?.();
      await Promise.allSettled(pending);
      await db?.$disconnect();
      if (/^meri_case46_[a-f0-9]{32}$/.test(schema))
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
      for (const key of envKeys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
    }
  },
);
