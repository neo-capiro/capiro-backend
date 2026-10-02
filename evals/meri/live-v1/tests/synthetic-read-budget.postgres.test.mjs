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
      const {authorizeMeriCaptureMessageReadback,validateMeriCapturePolicyPair}=source('meri-capture-policy-readback');
      const {meriServerReadonlyCaptureReceipt}=source('meri-server-readonly-capture');
      const {buildApiOnlyMeriServerCaptureEvidence}=source('meri-server-capture-evidence');
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
        async (settlementTest) => {
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
          await settlementTest.test(
            'saved budget-only answer reads through real current owner without signed fixture evidence',
            async () => {
              await admin.query('ALTER TABLE clio_messages ADD COLUMN metadata_jsonb jsonb');
              const messageMetadata = {
                serverReadonlyCaptureReceipt: meriServerReadonlyCaptureReceipt(policy),
              };
              await admin.query('UPDATE clio_messages SET metadata_jsonb=$1 WHERE id=$2', [
                messageMetadata,
                assistant,
              ]);
              const message = {
                id: assistant,
                role: 'assistant',
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                clientId,
                conversationId,
                metadata: messageMetadata,
              };
              const check = (changes = {}) =>
                authorizeMeriCaptureMessageReadback({
                  prisma,
                  ctx,
                  conversationId,
                  message,
                  ...changes,
                });
              await check();
              const originalNow = Date.now;
              try {
                Date.now = () => policy.expiresAt + 60_000;
                await check(); // Completed within deadline; no new admission is granted.
                await assert.rejects(() => op({kind:'reserve', binding}));
                await admin.query("UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1",[ctx.userId]);
                await assert.rejects(()=>check());
                await admin.query("UPDATE tenant_memberships SET status='active' WHERE user_id=$1",[ctx.userId]);
              } finally { Date.now = originalNow; }
              assert.equal((await op({ kind: 'read' })).state.ledger.chargedCostMicros, 20);
              assert.deepEqual(
                (
                  await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [
                    conversationId,
                  ])
                ).rows[0].metadata_jsonb,
                meta,
              );
              await assert.rejects(() => check({ ctx: { ...ctx, userId: randomUUID() } }));
              await admin.query(
                "UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1",
                [ctx.userId],
              );
              await assert.rejects(() => check());
              await admin.query("UPDATE tenant_memberships SET status='active' WHERE user_id=$1", [
                ctx.userId,
              ]);
              await admin.query('UPDATE clients SET memory_wall=true WHERE id=$1', [clientId]);
              await assert.rejects(() => check());
              await admin.query('UPDATE clients SET memory_wall=false WHERE id=$1', [clientId]);
              for (const mutate of [
                (m) => (m.syntheticReadBudgetTerminal.assistantMessageId = randomUUID()),
                (m) => (m.syntheticReadBudgetTerminal.turnId = randomUUID()),
                (m) => (m.syntheticReadBudgetTerminal.ledgerSha256 = '0'.repeat(64)),
                (m) => (m.syntheticReadBudgetTerminal.policySha256 = '0'.repeat(64)),
                (m) => (m.syntheticReadBudgetQualification.promptSha256 = '0'.repeat(64)),
                (m) => (m.syntheticReadProviderBudget.qualificationSha256 = '0'.repeat(64)),
                (m) => (m.syntheticReadBudgetTerminal.completedAt = new Date(policy.expiresAt + 1).toISOString()),
                (m) => {m.syntheticReadProviderBudget.ledger.attempts[0].settledAt=new Date(Date.parse(m.syntheticReadBudgetTerminal.completedAt)+1).toISOString();m.syntheticReadBudgetTerminal.ledgerSha256=hash(m.syntheticReadProviderBudget.ledger);},
                (m) => {m.syntheticReadProviderBudget.ledger.attempts[0].status='uncertain';m.syntheticReadBudgetTerminal.allAttemptsSettled=false;m.syntheticReadBudgetTerminal.ledgerSha256=hash(m.syntheticReadProviderBudget.ledger);},
                (m) => delete m.syntheticReadBudgetTerminal,
              ]) {
                const changed = structuredClone(meta);
                mutate(changed);
                await admin.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2', [
                  changed,
                  conversationId,
                ]);
                await assert.rejects(() => check());
              }
              await admin.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2', [
                meta,
                conversationId,
              ]);
              for (const mutate of [
                (r) => (r.expiresAt = Date.now() - 1),
                (r) => (r.extra = 'unexpected'),
                (r) => (r.clientId = randomUUID()),
              ]) {
                const altered = structuredClone(message);
                mutate(altered.metadata.serverReadonlyCaptureReceipt);
                await assert.rejects(() => check({ message: altered }));
              }
              await assert.rejects(() =>
                check({
                  message: {
                    ...message,
                    metadata: { ...messageMetadata, serverCaptureEvidenceReceipt: {} },
                  },
                }),
              );
              const secretBefore = process.env.INTERNAL_SERVICE_SECRET;
              process.env.INTERNAL_SERVICE_SECRET = 'unit-budget-readback';
              try {
                const signed = buildApiOnlyMeriServerCaptureEvidence({
                  policy,
                  userMessageId: user,
                  assistantMessageId: assistant,
                  citations: [],
                  usage: null,
                });
                assert.equal(validateMeriCapturePolicyPair(policy, signed), policy);
                assert.throws(()=>validateMeriCapturePolicyPair(policy,signed,policy.expiresAt+1));
                assert.throws(() =>
                  validateMeriCapturePolicyPair({ ...policy, extra: true }, signed),
                );
                assert.throws(() =>
                  validateMeriCapturePolicyPair(
                    {
                      ...policy,
                      syntheticReadBudget: { ...policy.syntheticReadBudget, extra: true },
                    },
                    signed,
                  ),
                );
                assert.throws(() =>
                  validateMeriCapturePolicyPair({ ...policy, fixtureVersion: 'invented' }, signed),
                );
              } finally {
                if (secretBefore === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
                else process.env.INTERNAL_SERVICE_SECRET = secretBefore;
              }
              await check();
              await admin.query('ALTER TABLE clio_messages DROP COLUMN metadata_jsonb');
            },
          );
        },
      );
      await t.test('new reviewed500k/15USD qualification supports two actual transactional rounds while old admission stays unchanged', async () => {
        const nextConversation = randomUUID(), nextUser = randomUUID();
        await admin.query('INSERT INTO clio_conversations VALUES($1,$2,$3,$4,NULL,\'{"unrelated":true}\')',
          [nextConversation, ctx.tenantId, ctx.userId, clientId]);
        const nextRate = { ...rate, inputMicrosPerMillion: 25000000, outputMicrosPerMillion: 75000000 };
        const nextEvidence = { ...evidence, maxTokens: 500000, rates: [nextRate] };
        const nextQ = { ...q, captureRunId: randomUUID(), aggregateReservationId: randomUUID(),
          conversationId: nextConversation, maxTokens: 500000, maxCostMicros: 15000000, maxAttempts: 3,
          rates: [nextRate], rateEvidenceSha256: hash(nextEvidence) };
        await assert.rejects(() => installSyntheticReadBudget({ prisma, ctx,
          qualification: { ...nextQ, maxCostMicros: 15000001 }, rateEvidence: nextEvidence }));
        await installSyntheticReadBudget({ prisma, ctx, qualification: nextQ, rateEvidence: nextEvidence });
        let nextPolicy = await issueMeriServerReadonlyCapturePolicy({ prisma, ctx, conversationId: nextConversation });
        const nextOp = operation => syntheticReadBudgetOwner({ prisma, ctx, policy: nextPolicy, operation });
        await nextOp({ kind: 'admit', prompt });
        await admin.query("INSERT INTO clio_messages VALUES($1,$2,$3,$4,$5,'user',$6)",
          [nextUser, ctx.tenantId, ctx.userId, clientId, nextConversation, prompt]);
        nextPolicy = { ...nextPolicy, turnId: nextUser };
        await nextOp({ kind: 'admit' });
        for (const [i, inputTokens] of [200000, 250000].entries()) {
          const binding = { logicalOperationId: `long-${i}`, attemptId: `long-${i}`, retryOfAttemptId: null,
            kind: 'openai_responses', phase: 'synthesis', provider: 'openai', model: 'test-only',
            maxInputTokens: inputTokens, maxOutputTokens: 16384 };
          const reserved = await nextOp({ kind: 'reserve', binding });
          await nextOp({ kind: 'settle', input: { reservationId: reserved.reservationId, binding,
            outcome: { kind: 'known', inputTokens, outputTokens: 16384 } } });
        }
        const current = await nextOp({ kind: 'read' });
        assert.equal(current.state.ledger.chargedCostMicros, 13707600);
        assert.equal(current.state.ledger.chargedTokens, 482768);
        await assert.rejects(() => nextOp({ kind: 'reserve', binding: {
          logicalOperationId: 'long-3', attemptId: 'long-3', retryOfAttemptId: null,
          kind: 'openai_responses', phase: 'synthesis', provider: 'openai', model: 'test-only',
          maxInputTokens: 20000, maxOutputTokens: 16384 } }), /tokens_exhausted/);
        const prior = (await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [conversationId])).rows[0].metadata_jsonb;
        assert.equal(prior.syntheticReadBudgetQualification.maxCostMicros, 350);
        assert.equal(prior.syntheticReadProviderBudget.ledger.chargedCostMicros, 20);
      });
      await t.test('actual conversation GET reads expired budget metadata without issuing new admission and keeps current ownership', async () => {
        // Complete the canonical conversation columns used by the actual service
        // query; no ensureConversation or admission function is mocked.
        await admin.query(`ALTER TABLE clio_conversations
          ADD COLUMN workspace_id uuid, ADD COLUMN workspace_key text DEFAULT 'workspace',
          ADD COLUMN title text DEFAULT 'Owned local test', ADD COLUMN status text DEFAULT 'active',
          ADD COLUMN nanoclaw_platform_id text, ADD COLUMN nanoclaw_agent_group_id text,
          ADD COLUMN summary text, ADD COLUMN summary_up_to_message_id uuid,
          ADD COLUMN summary_tokens integer, ADD COLUMN created_at timestamptz DEFAULT now(),
          ADD COLUMN updated_at timestamptz DEFAULT now()`);
        const { MeriService } = source('meri.service');
        const service = Object.assign(Object.create(MeriService.prototype), { prisma });
        const before = (await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [conversationId])).rows[0].metadata_jsonb;
        const result = await service.getConversation(ctx, conversationId);
        assert.deepEqual(result.metadata, before);
        assert.equal(result.captureAdmission, undefined);
        const realNow = Date.now;
        try {
          Date.now = () => policy.expiresAt + 60_000;
          const historical = await service.getConversation(ctx, conversationId);
          assert.deepEqual(historical.metadata, before);
          assert.equal(historical.captureAdmission, undefined);
          await assert.rejects(() => issueMeriServerReadonlyCapturePolicy({prisma,ctx,conversationId}),
            error => error?.getResponse?.().reason === 'signed_policy_scope_or_contract_invalid');
          await assert.rejects(() => service.getConversation({...ctx,userId:randomUUID()}, conversationId));
          await assert.rejects(() => service.getConversation({...ctx,role:'user_admin'}, conversationId));
          await assert.rejects(() => service.getConversation({...ctx,clerkUserId:'wrong'}, conversationId));
          await admin.query("UPDATE tenant_memberships SET status='inactive' WHERE user_id=$1", [ctx.userId]);
          await assert.rejects(() => service.getConversation(ctx, conversationId));
          await admin.query("UPDATE tenant_memberships SET status='active' WHERE user_id=$1", [ctx.userId]);
          await admin.query('UPDATE clients SET memory_wall=true WHERE id=$1', [clientId]);
          await assert.rejects(() => service.getConversation(ctx, conversationId));
          await admin.query('UPDATE clients SET memory_wall=false WHERE id=$1', [clientId]);
          const malformed=structuredClone(before);malformed.syntheticReadBudgetQualification.actorUserId=randomUUID();
          await admin.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2', [malformed,conversationId]);
          await assert.rejects(() => service.getConversation(ctx, conversationId));
          await admin.query('UPDATE clio_conversations SET metadata_jsonb=$1 WHERE id=$2', [before,conversationId]);
          assert.deepEqual((await service.getConversation(ctx, conversationId)).metadata,before);
        } finally { Date.now=realNow; }
        assert.deepEqual((await admin.query('SELECT metadata_jsonb FROM clio_conversations WHERE id=$1', [conversationId])).rows[0].metadata_jsonb,before);
        // Ordinary conversations still take the previous read path and retain
        // their DTO unchanged; no synthetic role/expiry contract is imposed.
        const ordinaryCtx={...ctx,tenantId:randomUUID(),tenantSlug:'ordinary-test',role:'user_admin'};
        const ordinaryId=randomUUID(), ordinaryMeta={custom:'unchanged'};
        await admin.query('INSERT INTO clio_conversations(id,tenant_id,user_id,client_id,metadata_jsonb) VALUES($1,$2,$3,NULL,$4)',
          [ordinaryId,ordinaryCtx.tenantId,ordinaryCtx.userId,ordinaryMeta]);
        const ordinary=await service.getConversation(ordinaryCtx,ordinaryId);
        assert.deepEqual(ordinary.metadata,ordinaryMeta);assert.equal(ordinary.captureAdmission,undefined);
      });
    } finally {
      if (db) await db.$disconnect();
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
