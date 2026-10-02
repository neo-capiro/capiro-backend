import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { sha256Stable } from './artifact-collector.mjs';
import { frozenFixture } from './fixture.mjs';
import { inspectControlledReadScope } from './controlled-read-live-capture.mjs';
import { createControlledReadDefinition } from './fixture-provisioning/controlled-read-definitions.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  assertReceiptHash,
  fixtureReceiptId,
} from './fixture-provisioning/contract.mjs';

const lock = JSON.parse(readFileSync(new URL('./contract-lock.json', import.meta.url), 'utf8'));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const need = (value, code) => {
  if (!value) throw new Error(`CONTROLLED_READ_INPUT_${code}`);
};

/** Private manifest stays in process. This returns only ordinary synthetic scope,
 * never tokens, Clerk sessions, credentials or a claim of current authorization. */
export function controlledReadSetupInput(manifest, { caseId, clientId, captureRunId }) {
  const actor = manifest?.ids?.users?.pat,
    tenant = manifest?.ids?.tenants?.t1;
  need(
    manifest?.namespace === FIXTURE_NAMESPACE &&
      manifest.target === 'capiro-dev' &&
      manifest.status === 'ready' &&
      tenant?.tenantId === AUTHORIZED_TENANTS.T1.id &&
      UUID.test(actor?.userId ?? '') &&
      typeof actor?.clerkUserId === 'string' &&
      actor.clerkUserId &&
      ['20', '72'].includes(caseId) &&
      UUID.test(clientId ?? '') &&
      UUID.test(captureRunId ?? ''),
    'SCOPE',
  );
  return {
    target: 'capiro-dev',
    fixtureNamespace: FIXTURE_NAMESPACE,
    ctx: {
      tenantId: tenant.tenantId,
      tenantSlug: AUTHORIZED_TENANTS.T1.slug,
      userId: actor.userId,
      clerkUserId: actor.clerkUserId,
      role: 'standard_user',
    },
    caseId,
    clientId,
    captureRunId,
  };
}
function definition(input) {
  need(
    input?.target === 'capiro-dev' &&
      input.fixtureNamespace === FIXTURE_NAMESPACE &&
      ['20', '72'].includes(input.caseId) &&
      input.ctx?.tenantId === AUTHORIZED_TENANTS.T1.id &&
      input.ctx.tenantSlug === AUTHORIZED_TENANTS.T1.slug &&
      input.ctx.role === 'standard_user' &&
      UUID.test(input.ctx.userId ?? '') &&
      typeof input.ctx.clerkUserId === 'string' &&
      input.ctx.clerkUserId,
    'SCOPE',
  );
  return createControlledReadDefinition({ ...input, tenantId: input.ctx.tenantId });
}
export function controlledReadExecuteInput(input, plan) {
  const expected = definition(input),
    { planSha256, ...body } = plan ?? {};
  need(
    plan?.kind === 'meri-controlled-read-setup-plan' &&
      plan.version === 1 &&
      plan.tenantId === input.ctx.tenantId &&
      plan.actorUserId === input.ctx.userId &&
      plan.clientId === input.clientId &&
      plan.caseId === input.caseId &&
      plan.captureRunId === input.captureRunId &&
      plan.definitionSha256 === sha256Stable(expected) &&
      plan.physicalMapSha256 === expected.physicalMapSha256 &&
      isDeepStrictEqual(plan.sourceMap, expected.sourceMap) &&
      HASH.test(plan.priorSettingsSha256 ?? '') &&
      /^\d+$/u.test(plan.tenantRowVersion ?? '') &&
      plan.sharedCorpusWrites === 0 &&
      planSha256 === sha256Stable(body),
    'PLAN_JOIN',
  );
  return {
    ...input,
    expectedPlanSha256: planSha256,
    confirmation: 'INSTALL_OWNED_CONTROLLED_READ_FIXTURE',
  };
}
export function inspectControlledReadSetupReceipt(input, setup) {
  const expected = definition(input),
    binding = setup?.binding;
  const seed = assertReceiptHash(setup?.seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  const reset = assertReceiptHash(setup?.resetReceipt, 'meri-synthetic-fixture-reset-receipt');
  need(
    setup.status === 'CONTROLLED_READ_BOUND' &&
      setup.sharedCorpusWrites === 0 &&
      UUID.test(setup.operationId ?? '') &&
      seed.operationId === setup.operationId &&
      reset.operationId === setup.operationId &&
      seed.owner === 'meri_controlled_read_v1' &&
      reset.owner === seed.owner &&
      seed.caseId === input.caseId &&
      seed.captureRunId === input.captureRunId &&
      seed.tenantId === input.ctx.tenantId &&
      seed.actorUserId === input.ctx.userId &&
      seed.clientId === input.clientId &&
      seed.definitionSha256 === sha256Stable(expected) &&
      seed.physicalMapSha256 === expected.physicalMapSha256 &&
      seed.sourceStorage === 'immutable_source_owned_controlled_adapter' &&
      seed.sharedCorpusWrites === 0 &&
      reset.scope === 'replace_owned_capture_binding_and_controlled_locator_only' &&
      reset.sharedCorpusWrites === 0 &&
      HASH.test(reset.priorSettingsSha256 ?? '') &&
      isDeepStrictEqual(setup.sourceMap, expected.sourceMap) &&
      HASH.test(setup.currentVerifySha256 ?? '') &&
      isDeepStrictEqual(binding, {
        caseId: input.caseId,
        captureRunId: input.captureRunId,
        fixtureVersion: frozenFixture.version,
        physicalMapSha256: expected.physicalMapSha256,
        seedReceiptId: fixtureReceiptId(setup.seedReceipt, 'meri-synthetic-fixture-seed-receipt'),
        resetReceiptId: fixtureReceiptId(
          setup.resetReceipt,
          'meri-synthetic-fixture-reset-receipt',
        ),
        fixtureNamespace: FIXTURE_NAMESPACE,
        actorUserId: input.ctx.userId,
        clientId: input.clientId,
        currentVerifySha256: setup.currentVerifySha256,
      }),
    'SETUP_JOIN',
  );
  return { definition: expected, binding, bindingSha256: sha256Stable(binding) };
}
export function controlledReadBudgetPlanInput(input, setup) {
  inspectControlledReadSetupReceipt(input, setup);
  return {
    target: input.target,
    fixtureNamespace: input.fixtureNamespace,
    ctx: input.ctx,
    clientId: input.clientId,
  };
}
export function controlledReadBudgetInstallInput(input, setup, plan, rates, now = Date.now()) {
  const proof = inspectControlledReadSetupReceipt(input, setup);
  need(
    plan?.status === 'READY_FOR_RATE_QUALIFICATION' &&
      plan.caseId === input.caseId &&
      plan.captureRunId === input.captureRunId &&
      plan.currentVerifySha256 === setup.currentVerifySha256 &&
      plan.captureBindingSha256 === proof.bindingSha256 &&
      HASH.test(plan.priorQualificationSha256 ?? '') &&
      /^\d+$/u.test(plan.tenantRowVersion ?? ''),
    'BUDGET_PLAN_JOIN',
  );
  need(
    rates?.kind === 'meri-capture-reviewed-provider-rates' &&
      rates.version === 1 &&
      rates.priceKind === 'qualified_text_token_upper_bound' &&
      rates.maxTokens === 200000 &&
      Number.isFinite(Date.parse(rates.observedAt)) &&
      Date.parse(rates.observedAt) <= now &&
      Date.parse(rates.expiresAt) > now + 900000 &&
      Array.isArray(rates.rates) &&
      rates.rates.length > 0 &&
      Array.isArray(rates.sources) &&
      rates.sources.length > 0,
    'CURRENT_REVIEWED_RATES_REQUIRED',
  );
  return {
    ...controlledReadBudgetPlanInput(input, setup),
    qualification: {
      version: 1,
      caseId: input.caseId,
      captureRunId: input.captureRunId,
      currentVerifySha256: setup.currentVerifySha256,
      rateEvidenceSha256: sha256Stable(rates),
      rateEvidenceExpiresAt: rates.expiresAt,
      priceKind: rates.priceKind,
      maxAttempts: 32,
      maxTokens: rates.maxTokens,
      maxCostMicros: 3000000,
      rates: rates.rates,
    },
    rateEvidence: rates,
    expectedCurrentVerifySha256: plan.currentVerifySha256,
    expectedCaptureBindingSha256: plan.captureBindingSha256,
    expectedPriorQualificationSha256: plan.priorQualificationSha256,
    expectedTenantRowVersion: plan.tenantRowVersion,
  };
}
/** Local consistency only. Actual collector re-reads AWS, current authenticated
 * admission, provider ledger and signed messages; these JSON inputs mint no authority. */
export function controlledReadLiveConfig(
  input,
  setup,
  installInput,
  installed,
  deployment,
  now = Date.now(),
) {
  const { binding } = inspectControlledReadSetupReceipt(input, setup);
  const q = installInput?.qualification;
  need(
    q?.caseId === input.caseId &&
      q.captureRunId === input.captureRunId &&
      q.currentVerifySha256 === setup.currentVerifySha256 &&
      q.maxCostMicros === 3000000 &&
      q.maxTokens === 200000 &&
      q.maxAttempts === 32 &&
      q.priceKind === 'qualified_text_token_upper_bound' &&
      q.rateEvidenceSha256 === sha256Stable(installInput.rateEvidence) &&
      isDeepStrictEqual(q.rates, installInput.rateEvidence.rates) &&
      q.rateEvidenceExpiresAt === installInput.rateEvidence.expiresAt &&
      Date.parse(q.rateEvidenceExpiresAt) > now + 900000 &&
      installed?.status === 'PROVIDER_QUALIFICATION_INSTALLED' &&
      installed.tenantId === input.ctx.tenantId &&
      installed.clientId === input.clientId &&
      installed.captureRunId === input.captureRunId &&
      installed.currentVerifySha256 === setup.currentVerifySha256 &&
      installed.captureBindingSha256 === sha256Stable(binding) &&
      installed.qualificationSha256 === sha256Stable(q) &&
      installed.maxCostMicros === q.maxCostMicros &&
      installed.rateEvidenceSha256 === q.rateEvidenceSha256 &&
      installed.rateEvidenceExpiresAt === q.rateEvidenceExpiresAt,
    'BUDGET_INSTALL_JOIN',
  );
  need(
    SHA.test(deployment?.apiSha ?? '') &&
      SHA.test(deployment?.orchestratorSha ?? '') &&
      SHA.test(deployment?.webSha ?? '') &&
      SHA.test(deployment?.operatorSourceSha ?? ''),
    'RELEASE_SOURCE_REQUIRED',
  );
  for (const [service, sourceSha] of [
    ['api', deployment.apiSha],
    ['meriv2-orchestrator', deployment.orchestratorSha],
  ]) {
    const build = deployment.builds?.[service];
    need(
      build?.service === service &&
        build.sourceSha === sourceSha &&
        /^sha256:[a-f0-9]{64}$/u.test(build.imageDigest ?? '') &&
        /^capiro-build-[a-z0-9-]+:[a-f0-9-]{36}$/u.test(build.buildId ?? '') &&
        HASH.test(build.buildspecSha256 ?? ''),
      'BUILD_BINDING',
    );
  }
  const config = {
    schemaVersion: 1,
    provenance: 'LIVE_CAPTURE',
    caseId: input.caseId,
    target: { apiOrigin: 'https://os.capiro.ai', environment: 'capiro-dev' },
    limits: { concurrency: 1, deadlineMs: 600000, maxSpendUsd: 3 },
    contract: {
      fixtureSha256: lock.fixtureSha256,
      contractSourceSha256: lock.contractSourceSha256,
    },
    fixture: {
      version: frozenFixture.version,
      namespace: FIXTURE_NAMESPACE,
      sha256: lock.fixtureSha256,
      mappingSha256: binding.physicalMapSha256,
      seedReceiptId: binding.seedReceiptId,
      resetReceiptId: binding.resetReceiptId,
    },
    scope: {
      actors: {
        PAT: {
          userId: input.ctx.userId,
          clerkUserId: input.ctx.clerkUserId,
          role: 'standard_user',
          tenantPhysicalId: input.ctx.tenantId,
        },
      },
      tenants: { T1: { physicalId: input.ctx.tenantId, slug: input.ctx.tenantSlug } },
      clients: { ASTER: { physicalId: input.clientId, tenantPhysicalId: input.ctx.tenantId } },
      sources: setup.sourceMap,
    },
    captureRunId: input.captureRunId,
    conversationId: null,
    deployment: {
      apiSha: deployment.apiSha,
      orchestratorSha: deployment.orchestratorSha,
      builds: deployment.builds,
    },
  };
  // This ID is used ONLY for static field validation. Actual config remains null;
  // the operator must create/read back a real empty owned conversation before capture.
  inspectControlledReadScope(
    { ...config, conversationId: config.captureRunId },
    { MERI_LIVE_BEARER_TOKEN: 'static-shape-inspection-only' },
  );
  return {
    config,
    setupReceipt: setup,
    expectedWebSha: deployment.webSha,
    qualificationExpiresAt: q.rateEvidenceExpiresAt,
    operatorSourceSha: deployment.operatorSourceSha,
  };
}
