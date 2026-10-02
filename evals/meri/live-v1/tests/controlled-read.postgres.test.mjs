import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';
import {
  inspectControlledReadSetup,
  executeControlledReadSetup,
  qualifyControlledReadInTx,
} from '../fixture-provisioning/controlled-read-owner.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';
const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;
// Explicit requested test: absence of owned DB configuration is a failure, not a skipped pass.
test('actual PostgreSQL controlled20/72 owner, provider install, dispatch and current revocation', async () => {
  assert.ok(config, 'explicit owned loopback configuration required');
  await withOwnedApprovedMemory(config, async ({ deps, tx }) => {
    const ctx = {
      tenantId: TENANT,
      tenantSlug: AUTHORIZED_TENANTS.T1.slug,
      userId: PROPOSER,
      clerkUserId: 'unit-clerk',
      role: 'standard_user',
    };
    await tx.$executeRawUnsafe("ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}' ");
    await tx.$executeRawUnsafe(
      'ALTER TABLE tenant_memberships ADD COLUMN id uuid DEFAULT gen_random_uuid()',
    );
    await tx.$executeRawUnsafe("CREATE TYPE membership_status AS ENUM ('active','inactive')");
    await tx.$executeRawUnsafe(
      'ALTER TABLE tenant_memberships ALTER COLUMN status TYPE membership_status USING status::membership_status',
    );
    await tx.$executeRawUnsafe(
      'ALTER TABLE client_memory_access ADD COLUMN id uuid DEFAULT gen_random_uuid()',
    );
    await tx.$executeRawUnsafe("ALTER TABLE clients ADD COLUMN name text DEFAULT 'Aster Defense'");
    await tx.$executeRawUnsafe(
      'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
      JSON.stringify({
        unrelated: { retain: true },
        meriFoundationFixture: { fixtureNamespace: FIXTURE_NAMESPACE },
      }),
      TENANT,
    );
    await tx.$executeRawUnsafe(
      'CREATE TABLE users(id uuid PRIMARY KEY,clerk_user_id text,email text,first_name text,last_name text)',
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO users VALUES($1::uuid,$2,$3,$4,$5)',
      PROPOSER,
      'unit-clerk',
      FIXTURE_NAMESPACE + '-pat@example.com',
      'Pat',
      'Synthetic',
    );
    const conversationId = randomUUID(),
      turnId = randomUUID();
    await tx.$executeRawUnsafe(
      'CREATE TABLE clio_conversations(id uuid PRIMARY KEY, tenant_id uuid,user_id uuid,client_id uuid,archived_at timestamptz,metadata_jsonb jsonb)',
    );
    await tx.$executeRawUnsafe(
      'CREATE TABLE clio_messages(id uuid PRIMARY KEY, tenant_id uuid,user_id uuid,conversation_id uuid,client_id uuid,role text)',
    );
    await tx.$executeRawUnsafe(
      'INSERT INTO clio_conversations VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,NULL,$5::jsonb)',
      conversationId,
      TENANT,
      PROPOSER,
      CLIENT,
      '{}',
    );
    await tx.$executeRawUnsafe(
      "INSERT INTO clio_messages VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'user')",
      turnId,
      TENANT,
      PROPOSER,
      conversationId,
      CLIENT,
    );
    const { inspectCaptureProviderBudgetInstallation, installCaptureProviderBudgetQualification } =
      source('meri/meri-capture-provider-budget-install');
    const { captureBudgetHash } = source('meri/meri-capture-provider-budget');
    const { issueMeriServerReadonlyCapturePolicy, admitMeriServerReadonlyCaptureTransport } =
      source('meri/meri-server-readonly-capture');
    const { tryExecuteMeriControlledRead, readMeriControlledSource, meriControlledReadHttpStatus } =
      source('meri/meri-controlled-read-fixture');
    const { withMeriToolRequestControl } = source('meri/meri-tool-request-control');
    const { captureProviderBudgetOwner } = source('meri/meri-capture-provider-budget-owner');
    const { MeriController } = source('meri/meri.controller');
    const controller = Object.assign(Object.create(MeriController.prototype), {
      logger: { log() {} },
      tools: {
        executeFromAuthenticatedUser: (context, tool, input) =>
          tryExecuteMeriControlledRead(deps.prisma, context, tool, input),
      },
    });
    const core = require('@capiro/meriv2-core');
    const {
      classifyApiToolReadOutcome,
      extractCitationsFromToolResult,
    } = require('@capiro/shared');
    for (const caseId of ['20', '72']) {
      const args = { ctx, caseId, clientId: CLIENT, captureRunId: randomUUID() };
      const plan = await inspectControlledReadSetup(deps, args);
      await assert.rejects(
        executeControlledReadSetup(deps, {
          ...args,
          expectedPlanSha256: '0'.repeat(64),
          confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
        }),
        /STALE_PLAN/,
      );
      const bound = await executeControlledReadSetup(deps, {
        ...args,
        expectedPlanSha256: plan.planSha256,
        confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
      });
      const proof = await qualifyControlledReadInTx(tx, ctx, args);
      assert.equal(proof.currentVerifySha256, bound.binding.currentVerifySha256);
      await assert.rejects(
        issueMeriServerReadonlyCapturePolicy({ prisma: deps.prisma, ctx, conversationId }),
        /Server-owned/,
      );
      const ratePlan = await inspectCaptureProviderBudgetInstallation(deps, {
        ctx,
        clientId: CLIENT,
      });
      const rates = [
        {
          kind: 'openai_responses',
          provider: 'openai',
          model: 'test-only',
          inputMicrosPerMillion: 1000000,
          outputMicrosPerMillion: 2000000,
        },
      ];
      const evidence = {
        kind: 'meri-capture-reviewed-provider-rates',
        version: 1,
        priceKind: 'qualified_text_token_upper_bound',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        maxTokens: 1000,
        rates,
        sources: [
          {
            kind: 'openai_responses',
            provider: 'openai',
            model: 'test-only',
            url: 'https://example.com/unit-test-only',
            unitContract: 'test only; not live billing',
          },
        ],
      };
      const q = {
        version: 1,
        caseId,
        captureRunId: args.captureRunId,
        currentVerifySha256: ratePlan.currentVerifySha256,
        rateEvidenceSha256: captureBudgetHash(evidence),
        rateEvidenceExpiresAt: evidence.expiresAt,
        priceKind: evidence.priceKind,
        maxAttempts: 3,
        maxTokens: 1000,
        maxCostMicros: 3000000,
        rates,
      };
      const installed = await installCaptureProviderBudgetQualification(deps, {
        ctx,
        clientId: CLIENT,
        qualification: q,
        rateEvidence: evidence,
        expectedCurrentVerifySha256: ratePlan.currentVerifySha256,
        expectedCaptureBindingSha256: ratePlan.captureBindingSha256,
        expectedPriorQualificationSha256: ratePlan.priorQualificationSha256,
        expectedTenantRowVersion: ratePlan.tenantRowVersion,
      });
      assert.equal(installed.captureRunId, args.captureRunId);
      const policy = {
        ...(await issueMeriServerReadonlyCapturePolicy({
          prisma: deps.prisma,
          ctx,
          conversationId,
        })),
        turnId,
      };
      await captureProviderBudgetOwner({
        prisma: deps.prisma,
        ctx,
        policy,
        operation: { kind: 'admit' },
      });
      const req = new EventEmitter();
      req.headers = {};
      req.res = new EventEmitter();
      req.res.writableEnded = true;
      const tool = caseId === '20' ? 'get_pe_budget_timeline' : 'read_client_documents';
      const input =
        caseId === '20'
          ? { peCode: '0912345T' }
          : { clientId: CLIENT, documentId: proof.definition.reads[0].physicalId };
      const result = await withMeriToolRequestControl(
        req,
        () => tryExecuteMeriControlledRead(deps.prisma, ctx, tool, input),
        policy,
      );
      assert.equal(meriControlledReadHttpStatus(result), 200);
      assert.equal(meriControlledReadHttpStatus(structuredClone(result)), undefined);
      assert.equal(result.controlledRead.requestId, policy.requestId);
      assert.equal(result.controlledRead.sourceId, proof.definition.reads[0].physicalId);
      // Exercise the real route method and signed policy admission. The response
      // starts at Nest's normal POST default; only the private owner object sets200.
      const previousSecret = process.env.INTERNAL_SERVICE_SECRET;
      try {
        process.env.INTERNAL_SERVICE_SECRET = 'controlled-read-local-test-secret';
        const routeReq = new EventEmitter();
        routeReq.res = new EventEmitter();
        routeReq.res.writableEnded = true;
        let actualStatus = 201;
        routeReq.res.status = (value) => {
          actualStatus = value;
          return routeReq.res;
        };
        routeReq.headers = {
          [core.MERI_CAPTURE_POLICY_HEADER]: core.encodeMeriCapturePolicyTransport(
            policy,
            'tool',
            tool,
            process.env.INTERNAL_SERVICE_SECRET,
          ),
        };
        const routed = await controller.executeTool(ctx, tool, input, routeReq);
        assert.equal(actualStatus, 200);
        assert.deepEqual(routed, result);
        routeReq.headers = {};
        await assert.rejects(controller.executeTool(ctx, tool, input, routeReq), /Server-owned/);
      } finally {
        if (previousSecret === undefined) delete process.env.INTERNAL_SERVICE_SECRET;
        else process.env.INTERNAL_SERVICE_SECRET = previousSecret;
      }
      if (caseId === '20') {
        assert.match(result.records[0].text, /0912345T/);
        assert.equal(result.currentFundingClaim.value, 42);
        const cites = extractCitationsFromToolResult(tool, result, 1);
        assert.equal(cites.length, 1);
        assert.equal(cites[0].source.kind, 'controlled_read');
        const opened = await readMeriControlledSource(deps.prisma, ctx, cites[0].source);
        assert.equal(opened.text, proof.definition.reads[0].content);
      } else {
        assert.deepEqual(classifyApiToolReadOutcome(tool, result), {
          kind: 'failed',
          reason: 'document unavailable',
        });
        assert.deepEqual(extractCitationsFromToolResult(tool, result, 1), []);
      }
      await assert.rejects(
        withMeriToolRequestControl(
          req,
          () =>
            tryExecuteMeriControlledRead(deps.prisma, ctx, tool, {
              ...input,
              clientId: randomUUID(),
            }),
          policy,
        ),
      );
      await assert.rejects(qualifyControlledReadInTx(tx, { ...ctx, userId: randomUUID() }, args));
      await assert.rejects(
        qualifyControlledReadInTx(tx, { ...ctx, tenantId: AUTHORIZED_TENANTS.T2.id }, args),
      );
      await assert.rejects(
        qualifyControlledReadInTx(tx, ctx, { ...args, captureRunId: randomUUID() }),
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenant_memberships SET status=$1::membership_status WHERE tenant_id=$2::uuid AND user_id=$3::uuid',
        'inactive',
        TENANT,
        PROPOSER,
      );
      await assert.rejects(
        withMeriToolRequestControl(
          req,
          () => tryExecuteMeriControlledRead(deps.prisma, ctx, tool, input),
          policy,
        ),
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenant_memberships SET status=$1::membership_status WHERE tenant_id=$2::uuid AND user_id=$3::uuid',
        'active',
        TENANT,
        PROPOSER,
      );
      // A new run requires a new owned conversation ledger; existing admissions cannot be relabeled.
      await tx.$executeRawUnsafe(
        "UPDATE clio_conversations SET metadata_jsonb='{}'::jsonb WHERE id=$1::uuid",
        conversationId,
      );
    }
    const rows = await tx.$queryRawUnsafe(
      'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
      TENANT,
    );
    assert.deepEqual(rows[0].settings.unrelated, { retain: true });
  });
});
