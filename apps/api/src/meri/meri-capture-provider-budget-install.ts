import {
  isMeriControlledReadCase,
  qualifyMeriControlledReadInTx,
} from './meri-controlled-read-fixture.js';
import { qualifyMeriCase14RecallInTx } from './meri-case14-capture-authority.js';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import {
  loadHydratedCase01FixtureOwner,
  type Case01FixtureDependencies,
} from './meri-case01-fixture-loader.js';
import {
  captureBudgetHash,
  validateCaptureBudgetQualification,
  type CaptureProviderBudgetQualification,
  type CaptureProviderRate,
} from './meri-capture-provider-budget.js';

/** Reviewed operator input, never an HTTP body or a provider's claimed price. */
export interface ReviewedCaptureProviderRates {
  kind: 'meri-capture-reviewed-provider-rates';
  version: 1;
  priceKind: 'qualified_text_token_upper_bound';
  observedAt: string;
  expiresAt: string;
  /** Token ceiling under which the reviewed provider pricing is applicable. */
  maxTokens: number;
  rates: CaptureProviderRate[];
  sources: Array<{
    kind: CaptureProviderRate['kind'];
    provider: string;
    model: string;
    url: string;
    unitContract: string;
  }>;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function fail(reason: string): never {
  throw new Error(`meri_capture_provider_budget_install_${reason}`);
}

function assertRateEvidence(
  evidence: ReviewedCaptureProviderRates,
  qualification: CaptureProviderBudgetQualification,
) {
  const now = Date.now();
  if (
    !evidence ||
    evidence.kind !== 'meri-capture-reviewed-provider-rates' ||
    evidence.version !== 1 ||
    evidence.priceKind !== qualification.priceKind ||
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    Date.parse(evidence.observedAt) > now ||
    !Number.isFinite(Date.parse(evidence.expiresAt)) ||
    Date.parse(evidence.expiresAt) <= now ||
    evidence.expiresAt !== qualification.rateEvidenceExpiresAt ||
    evidence.maxTokens !== qualification.maxTokens ||
    captureBudgetHash(evidence) !== qualification.rateEvidenceSha256 ||
    captureBudgetHash(evidence.rates) !== captureBudgetHash(qualification.rates) ||
    !Array.isArray(evidence.sources) ||
    !evidence.sources.length
  )
    fail('rate_evidence_invalid');
  for (const rate of qualification.rates) {
    const sources = evidence.sources.filter(
      (source) =>
        source.kind === rate.kind &&
        source.provider === rate.provider &&
        source.model === rate.model,
    );
    if (!sources.length) fail('rate_source_missing');
    for (const source of sources) {
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        return fail('rate_source_invalid');
      }
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        typeof source.unitContract !== 'string' ||
        !source.unitContract.trim()
      )
        fail('rate_source_invalid');
    }
  }
}

async function currentState(
  dependencies: Case01FixtureDependencies,
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clientId: string,
) {
  const rows = await tx.$queryRaw<Array<{ settings: unknown; version: string }>>`
    SELECT settings_jsonb AS settings, xmin::text AS version FROM tenants
    WHERE id = ${ctx.tenantId}::uuid FOR UPDATE`;
  if (rows.length !== 1) fail('tenant_missing');
  const fixture = record(record(rows[0]!.settings).meriFoundationFixture);
  const binding = record(fixture.captureEvidence);
  const qualified = record(
    binding.caseId === '14'
      ? await qualifyMeriCase14RecallInTx(dependencies.prisma, tx, ctx, { caseId:'14',clientId,captureRunId:String(binding.captureRunId??'') })
      : isMeriControlledReadCase(binding.caseId)
      ? await qualifyMeriControlledReadInTx(tx, ctx, {
          caseId: binding.caseId,
          clientId,
          captureRunId: String(binding.captureRunId ?? ''),
        })
      : await (
          await loadHydratedCase01FixtureOwner(dependencies)
        ).qualifyInTx(tx, ctx, { caseId: '01', clientId }),
  );
  if (
    qualified.fixtureReady !== true ||
    !Array.isArray(qualified.missing) ||
    qualified.missing.length ||
    typeof qualified.currentVerifySha256 !== 'string'
  )
    fail('current_fixture_not_ready');
  if (
    !['01', '14', '20', '72'].includes(String(binding.caseId)) ||
    binding.actorUserId !== ctx.userId ||
    binding.clientId !== clientId ||
    typeof binding.captureRunId !== 'string' ||
    !binding.captureRunId ||
    binding.currentVerifySha256 !== qualified.currentVerifySha256
  )
    fail('current_binding_missing');
  return {
    caseId: binding.caseId as string,
    captureRunId: binding.captureRunId,
    currentVerifySha256: qualified.currentVerifySha256,
    captureBindingSha256: captureBudgetHash(binding),
    priorQualificationSha256: captureBudgetHash(fixture.captureProviderBudget ?? null),
    tenantRowVersion: rows[0]!.version,
  };
}

/** Read-only plan: exact source/row/prior-value fences for the installation. */
export async function inspectCaptureProviderBudgetInstallation(
  dependencies: Case01FixtureDependencies,
  args: { ctx: TenantContext; clientId: string },
) {
  return dependencies.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => ({
    status: 'READY_FOR_RATE_QUALIFICATION' as const,
    ...(await currentState(dependencies, tx, args.ctx, args.clientId)),
    liveAcceptance: 'NOT_RUN' as const,
  }));
}

/** Operator-only setup, deliberately not registered as an HTTP mutation route. */
export async function installCaptureProviderBudgetQualification(
  dependencies: Case01FixtureDependencies,
  args: {
    ctx: TenantContext;
    clientId: string;
    qualification: CaptureProviderBudgetQualification;
    rateEvidence: ReviewedCaptureProviderRates;
    expectedCurrentVerifySha256: string;
    expectedCaptureBindingSha256: string;
    expectedPriorQualificationSha256: string;
    expectedTenantRowVersion: string;
  },
) {
  return dependencies.prisma.withTenantUser(args.ctx.tenantId, args.ctx.userId, async (tx) => {
    const current = await currentState(dependencies, tx, args.ctx, args.clientId);
    if (
      current.currentVerifySha256 !== args.expectedCurrentVerifySha256 ||
      current.captureBindingSha256 !== args.expectedCaptureBindingSha256 ||
      current.priorQualificationSha256 !== args.expectedPriorQualificationSha256 ||
      current.tenantRowVersion !== args.expectedTenantRowVersion
    )
      fail('compare_and_swap_conflict');
    const q = validateCaptureBudgetQualification(args.qualification, {
      caseId: current.caseId,
      captureRunId: current.captureRunId,
      expiresAt: Date.now(),
    });
    if (q.currentVerifySha256 !== current.currentVerifySha256) fail('current_verify_changed');
    assertRateEvidence(args.rateEvidence, q);
    const json = JSON.stringify(q);
    const rows = await tx.$queryRaw<Array<{ qualification: unknown; version: string }>>`
      UPDATE tenants
      SET settings_jsonb = jsonb_set(settings_jsonb,
        '{meriFoundationFixture,captureProviderBudget}', ${json}::jsonb, true)
      WHERE id = ${args.ctx.tenantId}::uuid AND xmin::text = ${current.tenantRowVersion}
      RETURNING settings_jsonb #> '{meriFoundationFixture,captureProviderBudget}' AS qualification,
        xmin::text AS version`;
    if (rows.length !== 1 || captureBudgetHash(rows[0]!.qualification) !== captureBudgetHash(q))
      fail('readback_mismatch');
    return {
      status: 'PROVIDER_QUALIFICATION_INSTALLED' as const,
      tenantId: args.ctx.tenantId,
      clientId: args.clientId,
      captureRunId: current.captureRunId,
      currentVerifySha256: current.currentVerifySha256,
      captureBindingSha256: current.captureBindingSha256,
      qualificationSha256: captureBudgetHash(q),
      priorQualificationSha256: current.priorQualificationSha256,
      tenantRowVersion: rows[0]!.version,
      maxCostMicros: q.maxCostMicros,
      rateEvidenceSha256: q.rateEvidenceSha256,
      rateEvidenceExpiresAt: q.rateEvidenceExpiresAt,
      liveAcceptance: 'NOT_RUN' as const,
    };
  });
}
