import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it, mock } from 'node:test';
import { clientDocumentPhysicalId } from '../fixture-provisioning/canonical-owner-adapter.mjs';
import { ownedIdentity } from '../fixture-provisioning/contract.mjs';
import { FIXTURE_VERSION } from '../fixture.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'case46 actual PG authority/CAS/lock/rollback; canonical storage is a bounded test port, not live S3',
  { skip: !configPath, timeout: 60_000 },
  async (t) => {
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
      'DATABASE_URL', 'CLIO_CLIENT_KB_ENABLED', 'ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED',
      'CAPIRO_SERVICE_NAME', 'ENGAGEMENT_PROCESS_MODE', 'ENGAGEMENT_EXTERNAL_ACTIONS',
      'ENGAGEMENT_BACKGROUND_OWNER', 'ENGAGEMENT_CALLBACKS_ENABLED', 'ENGAGEMENT_RECALL_WEBHOOK_ENABLED',
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
      const {
        assertCase46ProposalAuthorityInTx,
        assertCase46ArtifactEffectInTx,
        case46ProposalMarker,
      } = source('meri-case46-action-authority');
      const { case46BudgetTestFixture } = source('meri-case46-provider-budget.spec-helper');
      const { case46BudgetHash } = source('meri-case46-provider-budget');
      const { assertCase46NewTurnInTx, case46TurnReceiptInTx } = source('meri-case46-turn-owner');
      const { readCase46CaptureAdmission, readCase46CaptureMessage } = source('meri-case46-capture-readback');
      const { MERI_CASE46: f } = core;
      const { p, q, b } = case46BudgetTestFixture();
      const ctx = {
        tenantId: f.tenantId,
        tenantSlug: f.tenantSlug,
        userId: f.actorUserId,
        clerkUserId: 'user_case46_local_only',
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
        CREATE TABLE clio_messages(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,conversation_id uuid,client_id uuid,role text,body text,metadata_jsonb jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
        CREATE TABLE meri_action_proposals(id uuid,tenant_id uuid,user_id uuid,conversation_id uuid,
          tool text,input_jsonb jsonb,preview_jsonb jsonb,surface text,status text,approved_at timestamptz,approved_by uuid,expires_at timestamptz,
          actor_user_id uuid,result_summary_jsonb jsonb,executed_at timestamptz,attempt_count int DEFAULT 0);
        CREATE TABLE clio_artifacts(id uuid,tenant_id uuid,conversation_id uuid,user_id uuid,client_id uuid,kind text,body_text text,metadata_jsonb jsonb DEFAULT '{}');
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
      const readbackInput = async () => ({ prisma, deps, ctx, conversationId: p.conversationId,
        conversationMetadata: await saved() });
      const admission = async () => readCase46CaptureAdmission(await readbackInput());
      assert.equal((await admission()).phase, 'READY');
      assert.equal(await readCase46CaptureAdmission({ ...await readbackInput(), ctx: { ...ctx, userId: randomUUID() } }), null);
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
      await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
        assertCase46NewTurnInTx(tx, deps, ctx, { ...policy, turnId: null }),
      );
      await t.test(
        'actual guarded turn insertion serializes two PostgreSQL backends and rejects the loser',
        async () => {
          let releaseTurn, turnLocked;
          const turnReady = new Promise((resolve) => {
            turnLocked = resolve;
          });
          const turnContinue = new Promise((resolve) => {
            releaseTurn = resolve;
          });
          let firstTurnPid;
          const firstTurn = prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            await assertCase46NewTurnInTx(tx, deps, ctx, { ...policy, turnId: null });
            firstTurnPid = latestPid;
            turnLocked();
            await turnContinue;
            await tx.$executeRaw`INSERT INTO clio_messages(id,tenant_id,user_id,conversation_id,client_id,role,body)
            VALUES(${p.turnId}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${p.conversationId}::uuid,${f.clientId}::uuid,'user',${f.prompt})`;
          });
          pending.push(firstTurn);
          try {
            await turnReady;
            const secondTurn = prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
              assertCase46NewTurnInTx(tx, deps, ctx, { ...policy, turnId: null }),
            );
            pending.push(secondTurn);
            const denied = assert.rejects(secondTurn, /turn_already_started/);
            let waiting = false;
            for (let i = 0; i < 100 && !waiting; i++) {
              await delay(10);
              if (latestPid !== firstTurnPid)
                waiting =
                  (
                    await admin.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND granted=false', [
                      latestPid,
                    ])
                  ).rowCount > 0;
            }
            assert.equal(
              waiting,
              true,
              'second actual backend waits on the current authority conversation lock',
            );
            releaseTurn();
            await firstTurn;
            await denied;
            assert.equal(
              (await admin.query('SELECT count(*)::int AS n FROM clio_messages')).rows[0].n,
              1,
            );
          } finally {
            releaseTurn();
          }
        },
      );
      await call({ kind: 'admit' });
      await assert.rejects(
        prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          assertCase46NewTurnInTx(tx, deps, ctx, { ...policy, turnId: null }),
        ),
        /turn_already_started/,
      );
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
      await assert.rejects(
        prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
          case46TurnReceiptInTx(tx, deps, ctx, policy),
        ),
        /settled_usage_required/,
      );
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
      assert.equal(
        (
          await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
            case46TurnReceiptInTx(tx, deps, ctx, policy),
          )
        ).costMicros,
        20,
      );
      await t.test(
        'actual PG current readback joins saved usage, canonical approval, exact owned bytes and one effect',
        async () => {
          const assistantId = randomUUID(), proposalId = randomUUID(), artifactId = randomUUID();
          const operationId = randomUUID(), duplicateId = randomUUID();
          const usage = await prisma.withTenantUser(ctx.tenantId, ctx.userId, tx =>
            case46TurnReceiptInTx(tx, deps, ctx, policy));
          const body = 'The export proposal is ready for your approval.';
          const message = { id: assistantId, role: 'assistant', body,
            metadata: { governedArtifactCaptureReceipt: usage } };
          const input = { title: f.title, format: 'txt', text: f.text,
            clientId: f.clientId, conversationId: p.conversationId };
          const creation = { version: 1, kind: 'meri_text_artifact_creation', operationId,
            actionProposalId: proposalId, tenantId: ctx.tenantId, userId: ctx.userId,
            clientId: f.clientId, conversationId: p.conversationId, filename: f.filename,
            mimeType: 'text/plain', sha256: f.sha256, byteLength: 28 };
          const artifactMetadata = { docFormat: 'txt', filename: f.filename, mimeType: 'text/plain',
            documentBytesBase64: Buffer.from(f.text).toString('base64'), documentSha256: f.sha256,
            documentByteLength: 28, documentByteFormat: 'txt',
            documentByteAuthority: 'persisted_at_creation_v1', textCreation: creation };
          const result = { ok: true, artifactId, operationId, sha256: f.sha256,
            byteLength: 28, filename: f.filename };
          const readMessage = async (value = message) => readCase46CaptureMessage({ ...await readbackInput(), message: value });
          try {
            assert.equal((await admission()).phase, 'TURN_STARTED');
            await admin.query(`INSERT INTO meri_action_proposals(id,tenant_id,user_id,actor_user_id,conversation_id,
              tool,input_jsonb,preview_jsonb,surface,status,expires_at) VALUES($1,$2,$3,$3,$4,'create_word',$5,$6,'chat','proposed',now()+interval '10 minutes')`,
              [proposalId,ctx.tenantId,ctx.userId,p.conversationId,input,{ governedArtifactCapture: case46ProposalMarker(policy) }]);
            await admin.query(`INSERT INTO clio_messages(id,tenant_id,user_id,conversation_id,client_id,role,body,metadata_jsonb)
              VALUES($1,$2,$3,$4,$5,'assistant',$6,$7)`, [assistantId,ctx.tenantId,ctx.userId,p.conversationId,f.clientId,body,message.metadata]);
            const waiting = await admission();
            assert.equal(waiting.phase, 'AWAITING_APPROVAL');
            assert.deepEqual(waiting.counts, { userTurns: 1, assistantTurns: 1, proposals: 1, artifactEffects: 0 });
            assert.equal(waiting.providerUsage.costMicros, 20);
            assert.equal((await readMessage()).assistant.id, assistantId);
            assert.equal(JSON.stringify(waiting).includes('sealedPolicy'), false);
            assert.equal(JSON.stringify(waiting).includes('case46-owned-test-key-only'), false);
            await assert.rejects(readMessage({ ...message, body: 'changed served body' }), /served_message_changed/);
            await assert.rejects(readMessage({ ...message, metadata: { governedArtifactCaptureReceipt: { changed: true } } }), /served_message_changed/);
            await admin.query('UPDATE clio_messages SET metadata_jsonb=$1 WHERE id=$2',
              [{ governedArtifactCaptureReceipt: { ...usage, costMicros: 0 } },assistantId]);
            await assert.rejects(admission(), /saved_usage_changed/);
            await admin.query('UPDATE clio_messages SET metadata_jsonb=$1 WHERE id=$2', [message.metadata,assistantId]);
            await admin.query(`UPDATE meri_action_proposals SET status='succeeded',approved_by=$1,
              approved_at=now()-interval '1 second',executed_at=now(),attempt_count=2,result_summary_jsonb=$2 WHERE id=$3`,
              [ctx.userId,result,proposalId]);
            await admin.query(`INSERT INTO clio_artifacts(id,tenant_id,conversation_id,user_id,client_id,kind,body_text,metadata_jsonb)
              VALUES($1,$2,$3,$4,$5,'text_document',$6,$7)`, [artifactId,ctx.tenantId,p.conversationId,ctx.userId,f.clientId,f.text,artifactMetadata]);
            const complete = await readMessage();
            assert.equal(complete.phase, 'ARTIFACT_CREATED');
            assert.equal(complete.effect.artifactId, artifactId);
            assert.equal(complete.effect.operationId, operationId);
            assert.equal(complete.effect.currentAction.artifactEffectCount, 1);
            // Two attempts may still produce exactly one effect. Do not deny an
            // otherwise valid artifact after a pre-write transient failure.
            assert.equal(complete.effect.currentAction.attemptCount, 2);
            await admin.query('UPDATE meri_action_proposals SET approved_by=$1 WHERE id=$2', [randomUUID(),proposalId]);
            await assert.rejects(admission(), /current_approval_missing/);
            await admin.query('UPDATE meri_action_proposals SET approved_by=$1,approved_at=executed_at+interval \'1 second\' WHERE id=$2', [ctx.userId,proposalId]);
            await assert.rejects(admission(), /current_approval_missing/);
            await admin.query('UPDATE meri_action_proposals SET approved_at=executed_at-interval \'1 second\',attempt_count=0 WHERE id=$1', [proposalId]);
            await assert.rejects(admission(), /current_approval_missing/);
            await admin.query('UPDATE meri_action_proposals SET attempt_count=2,result_summary_jsonb=$1 WHERE id=$2', [{...result,operationId:randomUUID()},proposalId]);
            await assert.rejects(admission(), /matching completed action proposal/);
            await admin.query('UPDATE meri_action_proposals SET result_summary_jsonb=$1 WHERE id=$2', [result,proposalId]);
            await admin.query('UPDATE clio_artifacts SET body_text=$1 WHERE id=$2', ['changed stored bytes',artifactId]);
            await assert.rejects(admission(), /stored_effect_bytes_changed/);
            await admin.query('UPDATE clio_artifacts SET body_text=$1,client_id=$2 WHERE id=$3', [f.text,randomUUID(),artifactId]);
            await assert.rejects(admission(), /scope_or_count_changed/);
            await admin.query('UPDATE clio_artifacts SET client_id=$1 WHERE id=$2', [f.clientId,artifactId]);
            await admin.query(`INSERT INTO clio_artifacts SELECT $1,tenant_id,conversation_id,user_id,client_id,kind,body_text,metadata_jsonb
              FROM clio_artifacts WHERE id=$2`, [duplicateId,artifactId]);
            await assert.rejects(admission(), /scope_or_count_changed/);
            await admin.query('DELETE FROM clio_artifacts WHERE id=$1', [duplicateId]);
            bytesChanged = true;
            await assert.rejects(admission(), /current_source_bytes_changed/);
            bytesChanged = false;
            assert.equal((await admission()).phase, 'ARTIFACT_CREATED');
          } finally {
            bytesChanged = false;
            await admin.query('DELETE FROM clio_artifacts WHERE id=ANY($1::uuid[])', [[artifactId,duplicateId]]);
            await admin.query('DELETE FROM meri_action_proposals WHERE id=$1', [proposalId]);
            await admin.query('DELETE FROM clio_messages WHERE id=$1', [assistantId]);
          }
        },
      );
      await t.test(
        'actual PG proposal and effect locks refuse duplicates, missing approval, stale source and changed bytes',
        async () => {
          const request = {
            tool: 'create_word',
            surface: 'chat',
            conversationId: p.conversationId,
            input: {
              title: f.title,
              format: 'txt',
              text: f.text,
              clientId: f.clientId,
              conversationId: p.conversationId,
            },
          };
          const proposalId = randomUUID(),
            marker = { governedArtifactCapture: case46ProposalMarker(policy) };
          const guard = (tx, admission = { phase: 'create', policy }) =>
            assertCase46ProposalAuthorityInTx(tx, deps, ctx, request, admission);
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
              guard(tx, { phase: 'create', policy: null }),
            ),
            /transport_missing/,
          );
          let unlocked, locked;
          const ready = new Promise((resolve) => {
            locked = resolve;
          });
          const releaseLock = new Promise((resolve) => {
            unlocked = resolve;
          });
          let proposalPid;
          const createFirst = prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            await guard(tx);
            proposalPid = (await tx.$queryRaw`SELECT pg_backend_pid() AS pid`)[0].pid;
            locked();
            await releaseLock;
            await tx.$executeRaw`INSERT INTO meri_action_proposals(id,tenant_id,user_id,conversation_id,tool,input_jsonb,preview_jsonb,surface,status,expires_at)
            VALUES(${proposalId}::uuid,${ctx.tenantId}::uuid,${ctx.userId}::uuid,${p.conversationId}::uuid,'create_word',${JSON.stringify(request.input)}::jsonb,${JSON.stringify(marker)}::jsonb,'chat','proposed',now()+interval '10 minutes')`;
          });
          pending.push(createFirst);
          await ready;
          const createSecond = prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => guard(tx));
          pending.push(createSecond);
          const duplicate = assert.rejects(createSecond, /proposal_count_changed/);
          let proposalBlocked = false;
          try {
            for (let i = 0; i < 100 && !proposalBlocked; i++) {
              await delay(10);
              if (latestPid !== proposalPid)
                proposalBlocked =
                  (
                    await admin.query('SELECT 1 FROM pg_locks WHERE pid=$1 AND granted=false', [
                      latestPid,
                    ])
                  ).rowCount > 0;
            }
            assert.equal(
              proposalBlocked,
              true,
              'second proposal is blocked on the owned conversation row',
            );
          } finally {
            unlocked();
          }
          await createFirst;
          await duplicate;
          const approval = { phase: 'approve', proposalId, preview: marker };
          await prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => guard(tx, approval));
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
              guard(tx, { ...approval, preview: {} }),
            ),
            /capability_invalid|marker_changed/,
          );
          const artifact = {
            conversationId: p.conversationId,
            clientId: f.clientId,
            title: f.title,
            kind: 'text_document',
            bodyText: f.text,
            metadata: {
              tool: 'create_word',
              docFormat: 'txt',
              filename: f.filename,
              mimeType: 'text/plain',
              documentBytesBase64: Buffer.from(f.text).toString('base64'),
              documentSha256: f.sha256,
              documentByteLength: 28,
              documentByteFormat: 'txt',
              documentByteAuthority: 'persisted_at_creation_v1',
              textCreation: {
                version: 1,
                kind: 'meri_text_artifact_creation',
                operationId: randomUUID(),
                actionProposalId: proposalId,
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                clientId: f.clientId,
                conversationId: p.conversationId,
                filename: f.filename,
                mimeType: 'text/plain',
                sha256: f.sha256,
                byteLength: 28,
              },
            },
          };
          const effect = (tx, value = artifact) =>
            assertCase46ArtifactEffectInTx(tx, deps, ctx, value);
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => effect(tx)),
            /approved_effect_owner_missing/,
          );
          await admin.query(
            "UPDATE meri_action_proposals SET status='executing',approved_by=$1,approved_at=now() WHERE id=$2",
            [ctx.userId, proposalId],
          );
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
              effect(tx, { ...artifact, bodyText: 'changed' }),
            ),
            /effect_bytes_or_identity_changed/,
          );
          bytesChanged = true;
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => effect(tx)),
            /current_source_bytes_changed/,
          );
          bytesChanged = false;
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
              await effect(tx);
              await tx.$executeRaw`INSERT INTO clio_artifacts(id,tenant_id,conversation_id) VALUES(${randomUUID()}::uuid,${ctx.tenantId}::uuid,${p.conversationId}::uuid)`;
              throw new Error('effect transaction rollback');
            }),
            /effect transaction rollback/,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM clio_artifacts')).rows[0].n,
            0,
          );
          await prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
            await effect(tx);
            await tx.$executeRaw`INSERT INTO clio_artifacts(id,tenant_id,conversation_id) VALUES(${randomUUID()}::uuid,${ctx.tenantId}::uuid,${p.conversationId}::uuid)`;
          });
          await assert.rejects(
            prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) => effect(tx)),
            /effect_already_present/,
          );
          assert.equal(
            (await admin.query('SELECT count(*)::int AS n FROM clio_artifacts')).rows[0].n,
            1,
          );
        },
      );
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
      await t.test(
        'setup plan drift refuses effects and concurrent one-shot execution retains exactly one durable failed claim',
        async () => {
          const { planCase46Setup, executeCase46Setup } = source('meri-case46-setup-owner');
          const recipe = {
            version: 1,
            caseId: '46',
            fixtureNamespace: f.namespace,
            captureRunId: randomUUID(),
            ctx,
            rateEvidence: {
              version: 1,
              caseId: '46',
              expiresAt: q.rateEvidenceExpiresAt,
              priceKind: q.priceKind,
              maxAttempts: q.maxAttempts,
              maxTokens: q.maxTokens,
              maxCostMicros: q.maxCostMicros,
              rates: q.rates,
            },
          };
          const journals = [];
          let sourceCalls = 0,
            entered,
            leave;
          const started = new Promise((resolve) => {
            entered = resolve;
          });
          const stop = new Promise((resolve) => {
            leave = resolve;
          });
          const runtime = {
            deps,
            async createSource() {
              sourceCalls++;
              entered();
              await stop;
              throw new Error('bounded injected source failure');
            },
            async createConversation() {
              assert.fail('source failure cannot create a conversation');
            },
          };
          const plan = await planCase46Setup(runtime, recipe);
          await admin.query(
            `UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,preserved}', '"other-case-owned"'::jsonb) WHERE id=$1`,
            [ctx.tenantId],
          );
          await assert.rejects(
            executeCase46Setup(runtime, recipe, plan.planSha256, (e) => journals.push(e)),
            /reconciliation_required/,
          );
          assert.equal(sourceCalls, 0);
          assert.equal(
            (
              await admin.query(
                `SELECT settings_jsonb#>'{meriFoundationFixture,case46ExecutionSetup}' AS claim FROM tenants WHERE id=$1`,
                [ctx.tenantId],
              )
            ).rows[0].claim,
            null,
          );
          const fresh = await planCase46Setup(runtime, recipe);
          const first = executeCase46Setup(runtime, recipe, fresh.planSha256, (e) =>
            journals.push(e),
          );
          const firstFailure = assert.rejects(first, /reconciliation_required/);
          await started;
          try {
            await assert.rejects(
              executeCase46Setup(runtime, recipe, fresh.planSha256, (e) => journals.push(e)),
              /reconciliation_required/,
            );
            assert.equal(sourceCalls, 1);
          } finally {
            leave();
          }
          await firstFailure;
          const fixture = (
            await admin.query(
              `SELECT settings_jsonb->'meriFoundationFixture' AS fixture FROM tenants WHERE id=$1`,
              [ctx.tenantId],
            )
          ).rows[0].fixture;
          assert.equal(fixture.preserved, 'other-case-owned');
          assert.equal(fixture.case46ExecutionSetup.status, 'STARTED');
          assert.equal(fixture.case46ExecutionSetup.recipeSha256, case46BudgetHash(recipe));
          assert.equal(
            journals.filter((e) => e.stage === 'CLAIM' && e.phase === 'VERIFIED').length,
            1,
          );
          assert.equal(
            journals.filter(
              (e) => e.stage === 'INPUT_SOURCE' && e.phase === 'RECONCILIATION_REQUIRED',
            ).length,
            1,
          );
          await assert.rejects(
            planCase46Setup(runtime, recipe),
            /existing_claim_requires_reconciliation/,
          );
        },
      );
      await t.test('actual PrismaService plus canonical document/conversation factory composes complete setup; S3 is a test port only', async () => {
        // Separate owned test fixture; never a production recovery/reset API.
        await admin.query(`UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture}',(settings_jsonb->'meriFoundationFixture')-'case46ExecutionSetup') WHERE id=$1`, [ctx.tenantId]);
        await admin.query(`ALTER TABLE clients ADD COLUMN status text DEFAULT 'active';
          ALTER TABLE engagement_attachments ADD COLUMN checksum_sha256 text, ADD COLUMN folder varchar(120),
            ADD COLUMN indexed_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now(),
            ADD COLUMN verified_content_type text, ADD COLUMN scan_provider text, ADD COLUMN scan_result_at timestamptz,
            ADD COLUMN extraction_status text, ADD COLUMN extraction_metadata_jsonb jsonb DEFAULT '{}';
          ALTER TABLE engagement_attachments ALTER COLUMN viewer_mode SET DEFAULT 'all', ALTER COLUMN viewer_user_ids SET DEFAULT '{}';
          ALTER TABLE clio_conversations ADD COLUMN workspace_id uuid, ADD COLUMN workspace_key text DEFAULT 'workspace',
            ADD COLUMN nanoclaw_platform_id text, ADD COLUMN nanoclaw_agent_group_id text,
            ADD COLUMN summary text, ADD COLUMN summary_up_to_message_id uuid, ADD COLUMN summary_tokens integer,
            ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN updated_at timestamptz DEFAULT now();
          ALTER TABLE clio_conversations ALTER COLUMN status SET DEFAULT 'active';
          CREATE TYPE "TenantRole" AS ENUM ('standard_user','user_admin','firm_admin');
          ALTER TABLE tenant_memberships ALTER COLUMN role TYPE "TenantRole" USING role::"TenantRole";`);
        Object.assign(process.env, { DATABASE_URL: url.href, CLIO_CLIENT_KB_ENABLED: 'false',
          ENGAGEMENT_ATTACHMENT_SCAN_REQUIRED: 'false', CAPIRO_SERVICE_NAME: 'api',
          ENGAGEMENT_PROCESS_MODE: 'active', ENGAGEMENT_EXTERNAL_ACTIONS: 'enabled',
          ENGAGEMENT_BACKGROUND_OWNER: 'api', ENGAGEMENT_CALLBACKS_ENABLED: 'true', ENGAGEMENT_RECALL_WEBHOOK_ENABLED: 'true' });
        const { S3Client } = require('@aws-sdk/client-s3');
        const objects = new Map(); let puts = 0, gets = 0;
        const send = mock.method(S3Client.prototype, 'send', async command => {
          const { Bucket, Key, Body } = command.input;
          assert.equal(Bucket, process.env.ASSETS_BUCKET);
          if (command.constructor.name === 'PutObjectCommand') {
            puts++; assert.equal(objects.has(Key), false); assert.equal(Buffer.from(Body).toString('utf8'), f.text);
            objects.set(Key, Buffer.from(Body)); return {};
          }
          assert.equal(command.constructor.name, 'GetObjectCommand'); gets++;
          assert.ok(objects.has(Key)); return { Body: { transformToByteArray: async () => Buffer.from(objects.get(Key)) } };
        });
        let runtime;
        try {
          const { createCase46SetupDependencies } = source('meri-case46-setup-dependencies');
          const { planCase46Setup, executeCase46Setup } = source('meri-case46-setup-owner');
          runtime = await createCase46SetupDependencies();
          const recipe = { version: 1, caseId: '46', fixtureNamespace: f.namespace, captureRunId: randomUUID(), ctx,
            rateEvidence: { version: 1, caseId: '46', expiresAt: q.rateEvidenceExpiresAt,
              priceKind: q.priceKind, maxAttempts: q.maxAttempts, maxTokens: q.maxTokens,
              maxCostMicros: q.maxCostMicros, rates: q.rates } };
          const plan = await planCase46Setup(runtime, recipe); const journal = [];
          const receipt = await executeCase46Setup(runtime, recipe, plan.planSha256, e => journal.push(e));
          assert.equal(puts, 1); assert.ok(gets >= 2);
          assert.equal(receipt.chatTurns, 0); assert.equal(receipt.outputArtifacts, 0);
          assert.equal(receipt.source.id, case46SourceIdentity(recipe.captureRunId).physicalId);
          assert.equal(journal.at(-1).stage, 'COMPLETE'); assert.equal(journal.at(-1).phase, 'VERIFIED');
          const saved = (await admin.query('SELECT metadata_jsonb AS metadata FROM clio_conversations WHERE id=$1', [receipt.conversationId])).rows[0];
          const bound = readSealedCase46Binding(saved.metadata, ctx, receipt.conversationId);
          assert.equal(bound.policy.turnId, null); assert.equal(bound.policy.source.physicalId, receipt.source.id);
          assert.equal(bound.qualification.rateEvidenceSha256, case46BudgetHash(recipe.rateEvidence));
          const empty = (await admin.query(`SELECT
            (SELECT count(*)::int FROM clio_messages WHERE conversation_id=$1) AS messages,
            (SELECT count(*)::int FROM meri_action_proposals WHERE conversation_id=$1) AS proposals,
            (SELECT count(*)::int FROM clio_artifacts WHERE conversation_id=$1) AS artifacts`, [receipt.conversationId])).rows[0];
          assert.deepEqual(empty, { messages: 0, proposals: 0, artifacts: 0 });
          assert.equal((await admin.query(`SELECT settings_jsonb#>>'{meriFoundationFixture,case46ExecutionSetup,status}' AS status FROM tenants WHERE id=$1`, [ctx.tenantId])).rows[0].status, 'COMPLETE');
          await assert.rejects(executeCase46Setup(runtime, recipe, plan.planSha256, e => journal.push(e)), /reconciliation_required/);
          assert.equal(puts, 1);
        } finally { send.mock.restore(); await runtime?.close(); }
      });
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
