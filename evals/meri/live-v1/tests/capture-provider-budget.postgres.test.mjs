import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'node:test';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'actual capture budget owner preserves authority, rollback and simultaneous spend on owned PostgreSQL',
  { skip: !configPath },
  async () => {
    let config;
    try {
      assert.ok(isAbsolute(configPath));
      config = JSON.parse(await readFile(configPath, 'utf8'));
    } catch {
      throw new Error('Explicit disposable configuration required');
    }
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
    const schema = `meri_capture_budget_${randomUUID().replaceAll('-', '')}`;
    assert.match(schema, /^meri_capture_budget_[a-f0-9]{32}$/);
    let db, release;
    const priorServiceSecret = process.env.INTERNAL_SERVICE_SECRET;
    const pending = [];
    try {
      const actual = (
        await admin.query(
          `SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory`,
          [config.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, config.host);
      assert.equal(actual.port, config.port);
      assert.equal(
        actual.directory.replaceAll('\\', '/'),
        config.dataDirectory.replaceAll('\\', '/'),
      );
      require('ts-node').register({
        project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
        transpileOnly: true,
        experimentalResolver: true,
      });
      const source = (name) =>
        require(
          fileURLToPath(new URL(`../../../../apps/api/src/meri/${name}.ts`, import.meta.url)),
        );
      const { captureProviderBudgetOwner } = source('meri-capture-provider-budget-owner');
      const {
        captureBudgetTestContext: ctx,
        captureBudgetTestPolicy,
        captureBudgetTestQualification,
        captureBudgetTestBinding,
      } = source('meri-capture-provider-budget.spec-helper');
      const policy = captureBudgetTestPolicy(),
        qualification = { ...captureBudgetTestQualification(policy), maxAttempts: 3 };
      qualification.rates.push(
        {
          kind: 'bedrock_embeddings',
          provider: 'aws-bedrock',
          model: 'test-titan',
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 0,
        },
        {
          kind: 'nvidia_rerank',
          provider: 'nvidia-nim',
          model: 'test-nvidia',
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 0,
        },
      );
      const binding = {
        caseId: policy.caseId,
        captureRunId: policy.captureRunId,
        fixtureVersion: policy.fixtureVersion,
        physicalMapSha256: policy.physicalMapSha256,
        resetReceiptId: policy.resetReceiptId,
        seedReceiptId: policy.seedReceiptId,
        fixtureNamespace: policy.fixtureNamespace,
        actorUserId: policy.actorUserId,
        clientId: policy.clientId,
        currentVerifySha256: qualification.currentVerifySha256,
      };
      const settings = {
        retain: 'tenant-setting',
        meriFoundationFixture: {
          fixtureNamespace: policy.fixtureNamespace,
          captureEvidence: binding,
          captureProviderBudget: qualification,
        },
      };
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query(`CREATE TYPE membership_status AS ENUM ('invited','active','removed');
      CREATE TABLE tenants(id uuid PRIMARY KEY,slug text,settings_jsonb jsonb);
      CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text);
      CREATE TABLE tenant_memberships(id uuid,tenant_id uuid,user_id uuid,status membership_status);
      CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,name text,memory_wall boolean);
      CREATE TABLE client_memory_access(id uuid,tenant_id uuid,client_id uuid,user_id uuid);
      CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,archived_at timestamptz,metadata_jsonb jsonb);
      CREATE TABLE clio_messages(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,conversation_id uuid,client_id uuid,role text,metadata_jsonb jsonb);`);
      await admin.query('INSERT INTO tenants VALUES($1,$2,$3)', [
        ctx.tenantId,
        ctx.tenantSlug,
        settings,
      ]);
      await admin.query('INSERT INTO users VALUES($1,$2,$3,$4,$5)', [
        ctx.userId,
        ctx.clerkUserId,
        'budget.synthetic@example.com',
        'Budget',
        'Synthetic',
      ]);
      await admin.query("INSERT INTO tenant_memberships VALUES($1,$2,$3,'active')", [
        randomUUID(),
        ctx.tenantId,
        ctx.userId,
      ]);
      await admin.query('INSERT INTO clio_conversations VALUES($1,$2,$3,NULL,NULL,$4)', [
        policy.conversationId,
        ctx.tenantId,
        ctx.userId,
        { unrelated: { keep: 7 } },
      ]);
      await admin.query("INSERT INTO clio_messages VALUES($1,$2,$3,$4,NULL,'user',$5)", [
        policy.turnId,
        ctx.tenantId,
        ctx.userId,
        policy.conversationId,
        { unrelated: { keep: 7 } },
      ]);
      const { PrismaClient } = require('@prisma/client');
      const url = new URL(`postgresql://${config.host}:${config.port}/${config.database}`);
      url.username = config.user;
      url.password = config.password;
      url.searchParams.set('schema', schema);
      db = new PrismaClient({ datasources: { db: { url: url.href } }, log: [] });
      let pause = false,
        failWrite = false,
        paused,
        firstPid,
        latestPid;
      const pausedPromise = new Promise((resolve) => {
        paused = resolve;
      });
      const resume = new Promise((resolve) => {
        release = resolve;
      });
      const prisma = {
        withTenantUser: (_tenant, _actor, work) =>
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
                      if (pause && args[0].join('').includes('SELECT metadata_jsonb AS metadata')) {
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
                      if (failWrite) throw new Error('injected rollback after write');
                      return n;
                    };
                  return target[key];
                },
              });
              return work(wrapped);
            },
            { timeout: 10000 },
          ),
      };
      prisma.withTenant = (tenant, work) => prisma.withTenantUser(tenant, ctx.userId, work);
      const call = (operation, p = policy, c = ctx) =>
        captureProviderBudgetOwner({ prisma, ctx: c, policy: p, operation });
      const saved = async () =>
        (
          await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [
            policy.conversationId,
          ])
        ).rows[0].metadata_jsonb;
      const beforeTurn = { ...policy, turnId: null };
      const admitted = await call({ kind: 'admit' }, beforeTurn);
      const { withCaptureApiProviderScope } = source('meri-capture-api-provider-scope');
      const { TitanEmbeddingProvider } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/embeddings/titan-embedding.provider.ts',
            import.meta.url,
          ),
        ),
      );
      const { NvidiaRerankingProvider } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/api/src/reranking/nvidia-reranking.provider.ts',
            import.meta.url,
          ),
        ),
      );
      let embeddings = 0,
        rankings = 0;
      const embedder = new TitanEmbeddingProvider({
        model: 'test-titan',
        dimensions: 2,
        invoker: async () => {
          embeddings++;
          return {
            body: new TextEncoder().encode(
              JSON.stringify({ embedding: [1, 0], inputTextTokenCount: 5 }),
            ),
          };
        },
      });
      const reranker = new NvidiaRerankingProvider({
        model: 'test-nvidia',
        fetchImpl: async () => {
          rankings++;
          return new Response(
            JSON.stringify({
              rankings: [
                { index: 0, logit: 1 },
                { index: 1, logit: 0 },
              ],
              usage: { prompt_tokens: 4, total_tokens: 4 },
            }),
            { status: 200 },
          );
        },
      });
      await withCaptureApiProviderScope(prisma, ctx, beforeTurn, async () => {
        await embedder.embed('synthetic source text');
        await reranker.rerank({ query: 'memory', passages: ['current', 'old'] });
      });
      assert.equal(embeddings, 1);
      assert.equal(rankings, 1);
      assert.equal((await saved()).serverCaptureProviderBudget.turnId, null);
      assert.equal((await saved()).serverCaptureProviderBudget.ledger.chargedCostMicros, 9);
      assert.equal((await saved()).unrelated.keep, 7);
      assert.equal((await call({ kind: 'admit' })).state.admissionId, admitted.state.admissionId);
      const before = await saved();
      failWrite = true;
      await assert.rejects(
        call({ kind: 'reserve', binding: captureBudgetTestBinding() }),
        /injected rollback/,
      );
      failWrite = false;
      assert.deepEqual(await saved(), before);
      process.env.INTERNAL_SERVICE_SECRET = 'local-capture-budget-test-only';
      const { MeriCaptureProviderBudgetController } = source(
        'meri-capture-provider-budget.controller',
      );
      const { captureProviderAccounting } = require(
        fileURLToPath(
          new URL(
            '../../../../apps/meriv2-orchestrator/src/meri/meriv3/meriv3-capture-provider-budget.ts',
            import.meta.url,
          ),
        ),
      );
      const controller = new MeriCaptureProviderBudgetController(prisma);
      const accounting = captureProviderAccounting({
        policy,
        apiBaseUrl: 'https://owned-test.invalid',
        serviceSecret: process.env.INTERNAL_SERVICE_SECRET,
        bearerToken: 'unit-only',
        fetchImpl: async (url, init) => {
          const request = { headers: Object.fromEntries(new Headers(init.headers)) };
          const body = JSON.parse(init.body);
          const result = String(url).endsWith('/reservations')
            ? await controller.reserve(ctx, request, body)
            : await controller.settle(ctx, request, body);
          return new Response(JSON.stringify(result), { status: 200 });
        },
      });
      pause = true;
      const first = accounting.reserve(captureBudgetTestBinding());
      pending.push(first);
      await pausedPromise;
      const second = call({
        kind: 'reserve',
        binding: { ...captureBudgetTestBinding('second'), logicalOperationId: 'second' },
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
      assert.equal(blocked, true, 'second actual session blocks on tenant row');
      release();
      const reserved = await first;
      await secondRejected;
      assert.equal(reserved.dispatchAllowed, true);
      assert.equal(
        (await call({ kind: 'reserve', binding: captureBudgetTestBinding() })).dispatchAllowed,
        false,
      );
      assert.equal((await saved()).serverCaptureProviderBudget.ledger.chargedAttempts, 3);
      await accounting.settle(
        {
          ...captureBudgetTestBinding(),
          reservationId: reserved.reservationId,
          deadlineAt: reserved.deadlineAt,
        },
        { kind: 'known', inputTokens: 10, outputTokens: 5 },
      );
      const settled = await call({ kind: 'read' });
      assert.equal(settled.state.ledger.chargedCostMicros, 29);
      const assistantMessageId = randomUUID();
      await admin.query("INSERT INTO clio_messages VALUES($1,$2,$3,$4,NULL,'assistant','{}')", [
        assistantMessageId,
        ctx.tenantId,
        ctx.userId,
        policy.conversationId,
      ]);
      const { buildApiOnlyMeriServerCaptureEvidence, persistMeriServerCaptureEvidenceReceipt } =
        source('meri-server-capture-evidence');
      const { bindCaptureProviderBudgetReceipt } = source('meri-capture-provider-budget-receipt');
      const { authorizeMeriCaptureMessageReadback } = source('meri-capture-policy-readback');
      const envelope = buildApiOnlyMeriServerCaptureEvidence({
        policy,
        userMessageId: policy.turnId,
        assistantMessageId,
        citations: [],
        usage: null,
      });
      const receipt = await bindCaptureProviderBudgetReceipt({ prisma, ctx, policy, envelope });
      assert.equal(receipt.receipt.providerBudget.status, 'SETTLED');
      assert.equal(receipt.receipt.providerBudget.chargedCostMicros, 29);
      assert.deepEqual(receipt.receipt.providerBudget.unaccountedBoundaries, []);
      await persistMeriServerCaptureEvidenceReceipt({
        prisma,
        ctx,
        policy,
        assistantMessageId,
        receipt,
      });
      const messageMetadata = (
        await admin.query('SELECT metadata_jsonb FROM clio_messages WHERE id=$1', [
          assistantMessageId,
        ])
      ).rows[0].metadata_jsonb;
      await authorizeMeriCaptureMessageReadback({
        prisma,
        ctx,
        conversationId: policy.conversationId,
        message: {
          id: assistantMessageId,
          role: 'assistant',
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          conversationId: policy.conversationId,
          clientId: null,
          metadata: messageMetadata,
        },
      });
      await assert.rejects(
        call({ kind: 'read' }, { ...policy, turnId: randomUUID() }),
        /owned_turn_missing/,
      );
      await assert.rejects(call({ kind: 'read' }, policy, { ...ctx, userId: randomUUID() }));
      await admin.query("UPDATE tenant_memberships SET status='removed'");
      await assert.rejects(call({ kind: 'read' }));
      await admin.query("UPDATE tenant_memberships SET status='active'");
      const stable = await saved();
      settings.meriFoundationFixture.captureEvidence.currentVerifySha256 = '3'.repeat(64);
      await admin.query('UPDATE tenants SET settings_jsonb=$1', [settings]);
      await assert.rejects(
        call({ kind: 'reserve', binding: captureBudgetTestBinding() }),
        /current_fixture_binding_missing/,
      );
      assert.deepEqual(await saved(), stable);
    } finally {
      if (priorServiceSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
      else process.env.INTERNAL_SERVICE_SECRET = priorServiceSecret;
      release?.();
      await Promise.allSettled(pending);
      await db?.$disconnect();
      await admin.query('SET search_path TO public');
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      assert.equal(
        (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [schema])).rowCount,
        0,
      );
      await admin.end();
    }
  },
);
