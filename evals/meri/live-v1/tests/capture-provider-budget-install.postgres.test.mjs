import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { versionDependencies } from './case01-memory-lifecycle.postgres.test.mjs';
import {
  withOwnedApprovedMemory,
  TENANT,
  CLIENT,
  PROPOSER,
} from './approved-memory-postgres-harness.mjs';
import { createCase01MemoryFixtureRuntime } from '../fixture-provisioning/case01-memory-runtime.mjs';
import { buildFixtureManifest } from '../fixture-provisioning/manifest.mjs';
import { createCaptureBindingOwner } from '../fixture-provisioning/capture-binding-owner.mjs';
import {
  createHydratedCase01MemoryOwner,
  case01MemoryOwnerLocator,
} from '../fixture-provisioning/case01-memory-owner.mjs';
import { sha256Stable } from '../artifact-collector.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from '../fixture-provisioning/contract.mjs';

const require = createRequire(new URL('../../../../apps/api/package.json', import.meta.url));
const source = (name) =>
  require(fileURLToPath(new URL(`../../../../apps/api/src/${name}.ts`, import.meta.url)));
const config = process.env.MERI_APPROVED_MEMORY_PG_CONFIG;

it(
  'installs reviewed provider qualification using actual hydrated source authority, CAS and rollback',
  { skip: !config },
  async () =>
    withOwnedApprovedMemory(config, async ({ deps, tx, manifest, memoryStore }) => {
      const versions = await versionDependencies(deps, tx, memoryStore);
      const dependencies = {
        ...deps,
        ...source('memory/synthetic-candidate-withdrawal.helpers'),
        ...source('memory/synthetic-approved-memory.helpers'),
        ...versions,
        memoryVersions: versions.versions,
        memoryAuthorization: memoryStore.authz,
      };
      const ctx = {
        tenantId: TENANT,
        tenantSlug: AUTHORIZED_TENANTS.T1.slug,
        userId: PROPOSER,
        clerkUserId: 'unit-clerk',
        role: 'standard_user',
      };
      const scope = { caseId: '01', clientId: CLIENT };
      const previous = createCase01MemoryFixtureRuntime(dependencies);
      await previous.seed();
      await previous.retire();
      const replacement = await buildFixtureManifest({
        fixtureInstanceId: randomUUID(),
        clients: manifest.clients,
        actors: manifest.actors,
        uploaderActors: manifest.uploaderActors,
      });
      const current = createCase01MemoryFixtureRuntime({
        ...dependencies,
        manifest: replacement,
        previousOwner: previous,
      });
      await current.seed();
      await tx.$executeRawUnsafe(
        "ALTER TABLE tenants ADD COLUMN settings_jsonb jsonb DEFAULT '{}'",
      );
      await tx.$executeRawUnsafe(
        'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid',
        JSON.stringify({
          unrelated: { value: 'keep  ' },
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
        `${FIXTURE_NAMESPACE}-pat@example.com`,
        'Synthetic',
        'Pat',
      );
      const bindingOwner = createCaptureBindingOwner({
        prisma: deps.prisma,
        sourceAuthority: current,
      });
      const request = {
        tenantId: TENANT,
        tenantSlug: ctx.tenantSlug,
        actorUserId: PROPOSER,
        clerkUserId: ctx.clerkUserId,
        caseId: '01',
        clientId: CLIENT,
        captureRunId: randomUUID(),
      };
      const bindingPlan = await bindingOwner.inspect(request);
      const bound = await bindingOwner.bind({
        ...request,
        ...bindingPlan,
        expectedCurrentVerifySha256: bindingPlan.currentVerifySha256,
      });
      const locator = case01MemoryOwnerLocator(replacement, manifest, PROPOSER);
      await createHydratedCase01MemoryOwner(dependencies).installLocatorInTx(tx, ctx, {
        locator,
        expectedPriorLocatorSha256: sha256Stable(null),
        expectedTenantRowVersion: bound.tenantRowVersion,
      });
      const {
        inspectCaptureProviderBudgetInstallation,
        installCaptureProviderBudgetQualification,
      } = source('meri/meri-capture-provider-budget-install');
      const { captureBudgetHash } = source('meri/meri-capture-provider-budget');
      const plan = await inspectCaptureProviderBudgetInstallation(dependencies, {
        ctx,
        clientId: CLIENT,
      });
      assert.equal(plan.status, 'READY_FOR_RATE_QUALIFICATION');
      const rates = [
        {
          kind: 'openai_responses',
          provider: 'openai',
          model: 'test-only-model',
          inputMicrosPerMillion: 1_000_000,
          outputMicrosPerMillion: 2_000_000,
        },
      ];
      const rateEvidence = {
        kind: 'meri-capture-reviewed-provider-rates',
        version: 1,
        priceKind: 'qualified_text_token_upper_bound',
        observedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        maxTokens: 1000,
        rates,
        sources: [
          {
            kind: 'openai_responses',
            provider: 'openai',
            model: 'test-only-model',
            url: 'https://example.com/unit-test-rate-contract',
            unitContract: 'unit test only; no actual provider or billing claim',
          },
        ],
      };
      const qualification = {
        version: 1,
        caseId: '01',
        captureRunId: request.captureRunId,
        currentVerifySha256: plan.currentVerifySha256,
        rateEvidenceSha256: captureBudgetHash(rateEvidence),
        rateEvidenceExpiresAt: rateEvidence.expiresAt,
        priceKind: rateEvidence.priceKind,
        maxAttempts: 3,
        maxTokens: 1000,
        maxCostMicros: 3_000_000,
        rates,
      };
      const input = {
        ctx,
        clientId: CLIENT,
        qualification,
        rateEvidence,
        expectedCurrentVerifySha256: plan.currentVerifySha256,
        expectedCaptureBindingSha256: plan.captureBindingSha256,
        expectedPriorQualificationSha256: plan.priorQualificationSha256,
        expectedTenantRowVersion: plan.tenantRowVersion,
      };
      const read = async () =>
        (
          await tx.$queryRawUnsafe(
            'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid',
            TENANT,
          )
        )[0].settings;
      const before = await read();
      await assert.rejects(
        installCaptureProviderBudgetQualification(dependencies, {
          ...input,
          expectedPriorQualificationSha256: 'f'.repeat(64),
        }),
        /compare_and_swap_conflict/,
      );
      await assert.rejects(
        installCaptureProviderBudgetQualification(dependencies, {
          ...input,
          rateEvidence: { ...rateEvidence, rates: [] },
        }),
        /rate_evidence_invalid/,
      );
      await assert.rejects(
        installCaptureProviderBudgetQualification(dependencies, {
          ...input,
          qualification: { ...qualification, maxTokens: 2000 },
        }),
        /rate_evidence_invalid/,
      );
      await assert.rejects(
        installCaptureProviderBudgetQualification(dependencies, {
          ...input,
          qualification: { ...qualification, currentVerifySha256: 'f'.repeat(64) },
        }),
        /current_verify_changed/,
      );
      assert.deepEqual(await read(), before);
      await tx.$executeRawUnsafe('SAVEPOINT qualified_install_rollback');
      try {
        const installed = await installCaptureProviderBudgetQualification(dependencies, input);
        assert.equal(installed.status, 'PROVIDER_QUALIFICATION_INSTALLED');
        assert.equal(installed.liveAcceptance, 'NOT_RUN');
        assert.equal(installed.qualificationSha256, captureBudgetHash(qualification));
        const stored = await read();
        assert.deepEqual(stored.unrelated, before.unrelated);
        assert.deepEqual(stored.meriFoundationFixture.captureEvidence, bound.binding);
        assert.deepEqual(stored.meriFoundationFixture.case01MemoryOwner, locator);
        assert.deepEqual(stored.meriFoundationFixture.captureProviderBudget, qualification);
        await assert.rejects(
          installCaptureProviderBudgetQualification(dependencies, input),
          /compare_and_swap_conflict/,
        );
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT qualified_install_rollback');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT qualified_install_rollback');
      }
      assert.deepEqual(await read(), before);
      await tx.$executeRawUnsafe('SAVEPOINT source_authority_changed');
      try {
        await tx.$executeRawUnsafe(
          "UPDATE memory_candidate SET payload_jsonb=jsonb_set(payload_jsonb,'{value}','\"changed\"') WHERE status='pending'",
        );
        await assert.rejects(installCaptureProviderBudgetQualification(dependencies, input));
        assert.deepEqual(await read(), before);
      } finally {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT source_authority_changed');
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT source_authority_changed');
      }
    }),
);
