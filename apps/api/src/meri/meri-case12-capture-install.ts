import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { validateMeriCase12SetupPolicyBinding } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { readMeriCase12CompletedCorpusInTx } from './meri-case12-capture-authority.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';

const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const fail = (code: string): never => { throw new Error('meri_case12_capture_install_' + code); };
type Input = {ctx: TenantContext; clientId: string; captureRunId: string};

async function inspect(prisma: PrismaService, tx: Prisma.TransactionClient, input: Input) {
  const rows = await tx.$queryRaw<Array<{settings: unknown; rowVersion: string}>>`
    SELECT settings_jsonb AS settings, xmin::text AS "rowVersion" FROM tenants
    WHERE id=${input.ctx.tenantId}::uuid FOR UPDATE`;
  if (rows.length !== 1) fail('tenant_missing');
  const fixture = record(record(rows[0]!.settings).meriFoundationFixture);
  // A second Case12 installation is not a recovery or replay capability.
  if (record(fixture.captureEvidence).caseId === '12') fail('existing_case12_binding');
  const {proof, completion} = await readMeriCase12CompletedCorpusInTx(prisma, tx, input.ctx, input.clientId);
  if (proof.corpusQualified !== true || proof.tenantId !== input.ctx.tenantId ||
      proof.actorUserId !== input.ctx.userId || proof.clientId !== input.clientId) fail('corpus_unqualified');
  const binding = {caseId: '12', captureRunId: input.captureRunId,
    fixtureNamespace: proof.fixtureNamespace, fixtureVersion: proof.fixtureVersion,
    physicalMapSha256: proof.physicalMapSha256, resetReceiptId: null, seedReceiptId: null,
    actorUserId: input.ctx.userId, clientId: input.clientId, currentVerifySha256: proof.currentVerifySha256,
    case12Setup: completion.binding};
  validateMeriCase12SetupPolicyBinding(binding);
  const body = {kind: 'meri-case12-capture-binding-plan', schemaVersion: 1,
    tenantId: input.ctx.tenantId, actorUserId: input.ctx.userId, clientId: input.clientId,
    captureRunId: input.captureRunId, tenantRowVersion: rows[0]!.rowVersion,
    priorCaptureBindingSha256: captureBudgetHash(fixture.captureEvidence ?? null),
    priorProviderQualificationSha256: captureBudgetHash(fixture.captureProviderBudget ?? null), binding};
  return {...body, planSha256: captureBudgetHash(body)};
}

/** Operator-only plan and CAS installation. No route, provider or conversation
 * creation; a separate current provider qualification is still required. */
export async function inspectCase12CaptureBindingInTx(prisma: PrismaService, tx: Prisma.TransactionClient, input: Input) {
  return {status: 'PLAN_ONLY', ...(await inspect(prisma, tx, input)), liveAcceptance: 'NOT_RUN'};
}
export async function installCase12CaptureBindingInTx(prisma: PrismaService, tx: Prisma.TransactionClient,
  input: Input & {expectedPlanSha256: string; confirmation: string}) {
  if (input.confirmation !== 'INSTALL_CASE12_CAPTURE_BINDING_ONCE') fail('confirmation');
  const plan = await inspect(prisma, tx, input);
  if (plan.planSha256 !== input.expectedPlanSha256) fail('stale_plan');
  const rows = await tx.$queryRaw<Array<{binding: unknown; oldBudget: unknown; rowVersion: string}>>`
    UPDATE tenants SET settings_jsonb=jsonb_set(
      settings_jsonb #- '{meriFoundationFixture,captureProviderBudget}',
      '{meriFoundationFixture,captureEvidence}', ${JSON.stringify(plan.binding)}::jsonb, true)
    WHERE id=${input.ctx.tenantId}::uuid AND xmin::text=${plan.tenantRowVersion}
    RETURNING settings_jsonb #> '{meriFoundationFixture,captureEvidence}' AS binding,
      settings_jsonb #> '{meriFoundationFixture,captureProviderBudget}' AS "oldBudget", xmin::text AS "rowVersion"`;
  if (rows.length !== 1 || captureBudgetHash(rows[0]!.binding) !== captureBudgetHash(plan.binding) ||
      rows[0]!.oldBudget !== null) fail('cas_readback');
  return {kind: 'meri-case12-capture-binding-installation', schemaVersion: 1,
    status: 'BINDING_INSTALLED_REQUIRES_PROVIDER_QUALIFICATION', planSha256: plan.planSha256,
    bindingSha256: captureBudgetHash(plan.binding), binding: plan.binding,
    tenantRowVersion: rows[0]!.rowVersion, liveAcceptance: 'NOT_RUN'};
}
