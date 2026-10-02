import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { it } from 'node:test';
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const configPath = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
it(
  'budget-only real Prisma owner/enum/atomic reservation without source capture authority',
  { skip: !configPath, timeout: 60000 },
  async (t) => {
    assert.ok(isAbsolute(configPath));
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.host, '127.0.0.1');
    assert.equal(cfg.port, 55433);
    assert.equal(cfg.scope, 'owned local disposable test cluster; no AWS connection');
    const { Client } = require('pg');
    const admin = new Client({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
    });
    try {
      await admin.connect();
    } catch {
      throw new Error('Owned loopback connection failed');
    }
    const schema = 'meri_read_budget_' + randomUUID().replaceAll('-', '');
    let db;
    try {
      const actual = (
        await admin.query(
          "SELECT current_user=$1 AS owner,host(inet_server_addr()) AS address,inet_server_port() AS port,current_setting('data_directory') AS directory",
          [cfg.user],
        )
      ).rows[0];
      assert.equal(actual.owner, true);
      assert.equal(actual.address, '127.0.0.1');
      assert.equal(actual.port, 55433);
      assert.equal(actual.directory.replaceAll('\\', '/'), cfg.dataDirectory.replaceAll('\\', '/'));
      require('ts-node').register({
        project: fileURLToPath(new URL('../../../../apps/api/tsconfig.json', import.meta.url)),
        transpileOnly: true,
        experimentalResolver: true,
      });
      const core = require(
        fileURLToPath(new URL('../../../../packages/meriv2-core/dist/index.js', import.meta.url)),
      );
      require('@capiro/meriv2-core');
      require.cache[require.resolve('@capiro/meriv2-core')].exports = core;
      const source = (n) =>
        require(
          fileURLToPath(new URL('../../../../apps/api/src/meri/' + n + '.ts', import.meta.url)),
        );
      const { installSyntheticReadBudget, syntheticReadBudgetOwner } = source(
        'meri-synthetic-read-budget-owner',
      );
      const { syntheticReadBudgetHash: hash } = source('meri-synthetic-read-budget');
      const {
        issueMeriServerReadonlyCapturePolicy,
        assertMeriServerReadonlyCaptureCurrentAuthority,
        assertMeriServerReadonlyCaptureToolAllowed,
      } = source('meri-server-readonly-capture');
      const {planMeriTurn}=source('meri-context-plane.service');
      const {withCaptureApiProviderScope,assertCaptureApiRetrievalPlan}=source('meri-capture-api-provider-scope');
      const {cases}=await import('../cases.mjs');
      await admin.query(`CREATE SCHEMA "${schema}"; SET search_path TO "${schema}";
   CREATE TYPE "TenantRole" AS ENUM ('standard_user','user_admin');
   CREATE TYPE membership_status AS ENUM ('active','inactive');
   CREATE TABLE tenants(id uuid PRIMARY KEY,slug text,settings_jsonb jsonb);
   CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text);
   CREATE TABLE tenant_memberships(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,status membership_status,role "TenantRole");
   CREATE TABLE clients(id uuid PRIMARY KEY,tenant_id uuid,name text,memory_wall boolean);
   CREATE TABLE client_memory_access(id uuid PRIMARY KEY,tenant_id uuid,client_id uuid,user_id uuid);
   CREATE TABLE clio_conversations(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,archived_at timestamptz,metadata_jsonb jsonb);
   CREATE TABLE clio_messages(id uuid PRIMARY KEY,tenant_id uuid,user_id uuid,client_id uuid,conversation_id uuid,role text,body text);`);
      const ctx = {
        tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
        tenantSlug: 'meri-foundation-20260928-t1',
        userId: randomUUID(),
        clerkUserId: 'user_budget_local_only',
        role: 'standard_user',
      };
      const clientId = randomUUID(),
        conversationId = randomUUID(),
        prompt = 'Recall the approved client memory.';
      const settings = {
        meriFoundationFixture: {
          fixtureNamespace: 'meri-foundation-20260928',
          captureEvidence: { caseId: '20', captureRunId: randomUUID() },
        },
      };
      await admin.query('INSERT INTO tenants VALUES($1,$2,$3)', [
        ctx.tenantId,
        ctx.tenantSlug,
        settings,
      ]);
      await admin.query(
        "INSERT INTO users VALUES($1,$2,'synthetic@example.com','Synthetic','Pat')",
        [ctx.userId, ctx.clerkUserId],
      );
      await admin.query(
        "INSERT INTO tenant_memberships VALUES($1,$2,$3,'active','standard_user')",
        [randomUUID(), ctx.tenantId, ctx.userId],
      );
      await admin.query("INSERT INTO clients VALUES($1,$2,'Synthetic Aster',false)", [
        clientId,
        ctx.tenantId,
      ]);
      await admin.query(
        'INSERT INTO clio_conversations VALUES($1,$2,$3,$4,NULL,\'{"unrelated":true}\')',
        [conversationId, ctx.tenantId, ctx.userId, clientId],
      );
      const { PrismaClient } = require('@prisma/client');
      const url = new URL('postgresql://127.0.0.1');
      url.username = cfg.user;
      url.password = cfg.password;
      url.port = '55433';
      url.pathname = '/' + cfg.database;
      url.searchParams.set('schema', schema);
      url.searchParams.set('connection_limit', '3');
      db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
      const prisma = {
        withTenant: (_tenant, fn) => db.$transaction(fn),
        withTenantUser: (_tenant, _user, fn) => db.$transaction(fn),
      };
      const rate = {
        kind: 'openai_responses',
        provider: 'openai',
        model: 'test-only',
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 2000000,
      };
      const evidence = {
        kind: 'meri-capture-reviewed-provider-rates',
        version: 1,
        priceKind: 'qualified_text_token_upper_bound',
        observedAt: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxTokens: 1000,
        rates: [rate],
        sources: [
          {
            kind: rate.kind,
            provider: rate.provider,
            model: rate.model,
            url: 'https://example.com/unit-rate',
            unitContract: 'unit fixture only',
          },
        ],
      };
      const q = {
        version: 1,
        kind: 'synthetic_read_budget_only',
        caseId: '02',
        captureRunId: randomUUID(),
        aggregateReservationId: randomUUID(),
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        conversationId,
        clientId,
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        deadlineAt: new Date(Date.now() + 600000).toISOString(),
        rateEvidenceSha256: hash(evidence),
        rateEvidenceExpiresAt: evidence.expiresAt,
        priceKind: evidence.priceKind,
        maxAttempts: 2,
        maxTokens: 1000,
        maxCostMicros: 350,
        rates: [rate],
      };
      await t.test(
        'install is absent-key CAS and preserves unrelated/global fixture settings',
        async () => {
          await assert.rejects(() =>
            installSyntheticReadBudget({
              prisma,
              ctx: { ...ctx, clerkUserId: 'wrong' },
              qualification: q,
              rateEvidence: evidence,
            }),
          );
          await assert.rejects(() =>
            installSyntheticReadBudget({
              prisma,
              ctx,
              qualification: { ...q, clientId: randomUUID() },
              rateEvidence: evidence,
            }),
          );
          await installSyntheticReadBudget({
            prisma,
            ctx,
            qualification: q,
            rateEvidence: evidence,
          });
          await assert.rejects(() =>
            installSyntheticReadBudget({ prisma, ctx, qualification: q, rateEvidence: evidence }),
          );
          assert.deepEqual(
            (await admin.query('SELECT settings_jsonb FROM tenants')).rows[0].settings_jsonb,
            settings,
          );
        },
      );
      let policy = await issueMeriServerReadonlyCapturePolicy({ prisma, ctx, conversationId });
      await t.test('all five frozen original prompts keep the ordinary planner and fit accounted retrieval',async()=>{
        for(const row of cases.filter(c=>['01','02','03','04','05'].includes(c.id))){
          const plan=planMeriTurn({task:row.prompt,uiClientId:clientId,uiClientName:'Aster Defense',authorizedClientNames:['Aster Defense','Bluehaven Maritime']});
          assert.equal(plan.subjectScope,'client');
          await withCaptureApiProviderScope(prisma,ctx,policy,async()=>{
            assert.doesNotThrow(()=>assertCaptureApiRetrievalPlan(plan));
            assert.throws(()=>assertCaptureApiRetrievalPlan({...plan,requestedDomains:['mail']}));
          });
        }
      });
      const op = (operation) => syntheticReadBudgetOwner({ prisma, ctx, policy, operation });
      await t.test(
        'separate accounting leaves source bindings null and ordinary permissions current',
        async () => {
          assert.equal(policy.syntheticReadBudget.caseId, '02');
          for (const k of [
            'caseId',
            'captureRunId',
            'fixtureVersion',
            'seedReceiptId',
            'resetReceiptId',
            'physicalMapSha256',
          ])
            assert.equal(policy[k], null);
          assert.throws(() =>
            core.validateMeriSyntheticReadBudgetGuard({ ...policy, caseId: '02' }),
          );
          await assert.rejects(() =>
            syntheticReadBudgetOwner({
              prisma,
              ctx: { ...ctx, userId: randomUUID() },
              policy,
              operation: { kind: 'admit', prompt },
            }),
          );
          assert.throws(() => assertMeriServerReadonlyCaptureToolAllowed('send_email', policy));
          assertMeriServerReadonlyCaptureToolAllowed('search_memory', policy);
          await admin.query('UPDATE clients SET memory_wall=true');
          await assert.rejects(() =>
            assertMeriServerReadonlyCaptureCurrentAuthority({ prisma, ctx, policy }),
          );
          await admin.query('UPDATE clients SET memory_wall=false');
          const signed = core.encodeMeriCapturePolicyTransport(
            policy,
            'provider_budget',
            null,
            'unit-secret-only',
          );
          assert.throws(() =>
            core.decodeAndVerifyMeriCapturePolicyTransport(
              signed,
              { purpose: 'provider_budget', tenantId: ctx.tenantId, actorUserId: randomUUID() },
              'unit-secret-only',
            ),
          );
        },
      );
      await op({ kind: 'admit', prompt });
      await assert.rejects(() => op({ kind: 'admit', prompt }));
      const user = randomUUID();
      await admin.query("INSERT INTO clio_messages VALUES($1,$2,$3,$4,$5,'user',$6)", [
        user,
        ctx.tenantId,
        ctx.userId,
        clientId,
        conversationId,
        prompt,
      ]);
      policy = { ...policy, turnId: user };
      await op({ kind: 'admit' });
      let winning, binding;
      await t.test(
        'two real database transactions cannot overspend the same conversation',
        async () => {
          const b = (n) => ({
            logicalOperationId: 'op-' + n,
            attemptId: 'attempt-' + n,
            retryOfAttemptId: null,
            kind: 'openai_responses',
            phase: 'synthesis',
            provider: 'openai',
            model: 'test-only',
            maxInputTokens: 100,
            maxOutputTokens: 100,
          });
          const values = await Promise.allSettled([
            op({ kind: 'reserve', binding: b(1) }),
            op({ kind: 'reserve', binding: b(2) }),
          ]);
          assert.equal(values.filter((v) => v.status === 'fulfilled').length, 1);
          const i = values.findIndex((v) => v.status === 'fulfilled');
          winning = values[i].value;
          binding = b(i + 1);
          assert.equal(winning.state.ledger.chargedCostMicros, 300);
          assert.equal((await op({ kind: 'reserve', binding })).dispatchAllowed, false);
        },
      );
      await t.test(
        'settlement ignores supplied pricing, finish binds actual assistant and prevents more dispatch',
        async () => {
          await op({
            kind: 'settle',
            input: {
              reservationId: winning.reservationId,
              binding,
              outcome: {
                kind: 'known',
                inputTokens: 10,
                outputTokens: 5,
                price: { inputPerM: 0, outputPerM: 0 },
              },
            },
          });
          await assert.rejects(() => op({ kind: 'finish', assistantMessageId: randomUUID() }));
          const assistant = randomUUID();
          await admin.query(
            "INSERT INTO clio_messages VALUES($1,$2,$3,$4,$5,'assistant','unit reply')",
            [assistant, ctx.tenantId, ctx.userId, clientId, conversationId],
          );
          const finished = await op({ kind: 'finish', assistantMessageId: assistant });
          assert.equal(finished.terminal.allAttemptsSettled, true);
          assert.equal(finished.terminal.chargedCostMicros, 20);
          assert.equal(finished.terminal.captureAuthority, false);
          await assert.rejects(() => op({ kind: 'reserve', binding }));
          await assert.rejects(() => op({ kind: 'finish', assistantMessageId: assistant }));
          const meta = (await admin.query('SELECT metadata_jsonb FROM clio_conversations')).rows[0]
            .metadata_jsonb;
          assert.equal(meta.unrelated, true);
          assert.equal(meta.serverCaptureProviderBudget, undefined);
        },
      );
    } finally {
      if (db) await db.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
