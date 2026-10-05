import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { MERI_CASE46 as f } from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import {
  assertCase46CurrentActorInTx,
  case46Record,
  case46SourceIdentity,
  installCase46CaptureBinding,
  readCase46CurrentAuthorityInTx,
} from './meri-case46-authority.js';
import {
  case46BudgetHash,
  validateCase46BudgetQualification,
  type Case46ProviderBudgetQualification,
} from './meri-case46-provider-budget.js';
import type { createCase46SetupDependencies } from './meri-case46-setup-dependencies.js';
import { assertCase46RemediationInTx } from './meri-case46-remediation.js';

const KEY = 'case46ExecutionSetup';
const HASH = /^[a-f0-9]{64}$/;
const inputSchema = z
  .object({
    version: z.literal(1),
    caseId: z.literal('46'),
    fixtureNamespace: z.literal(f.namespace),
    captureRunId: z.string().uuid(),
    // A fixed generation's proof or, from generation five, the operator's native
    // close proof; eligibility is derived from retained state either way.
    remediationProofSha256: z.string().regex(HASH).optional(),
    ctx: z
      .object({
        tenantId: z.literal(f.tenantId),
        tenantSlug: z.literal(f.tenantSlug),
        userId: z.literal(f.actorUserId),
        role: z.literal('standard_user'),
        clerkUserId: z.string().regex(/^user_[A-Za-z0-9_-]{1,100}$/),
      })
      .strict(),
    rateEvidence: z
      .object({
        version: z.literal(1),
        caseId: z.literal('46'),
        expiresAt: z.string().datetime(),
        priceKind: z.literal('qualified_text_token_upper_bound'),
        maxAttempts: z.number().int().min(1).max(64),
        maxTokens: z.number().int().min(1).max(1_000_000),
        // Declared accounting expectation; the capture ledger no longer caps it.
        maxCostMicros: z.number().int().min(1),
        rates: z
          .array(
            z
              .object({
                kind: z.enum([
                  'openai_responses',
                  'anthropic_messages',
                  'jev',
                  'bedrock_embeddings',
                  'nvidia_rerank',
                ]),
                provider: z.string().min(1).max(256),
                model: z.string().min(1).max(256),
                inputMicrosPerMillion: z.number().int().min(0),
                outputMicrosPerMillion: z.number().int().min(0),
              })
              .strict(),
          )
          .min(1)
          .max(32),
      })
      .strict(),
  })
  .strict();
export type Case46SetupInput = z.infer<typeof inputSchema>;
type Runtime = Awaited<ReturnType<typeof createCase46SetupDependencies>>;
type Journal = (entry: Record<string, unknown>) => Promise<void> | void;
function fail(code: string): never {
  throw new Error(`meri_case46_setup_${code}`);
}
function parse(value: unknown): Case46SetupInput {
  const parsed = inputSchema.safeParse(structuredClone(value));
  if (!parsed.success) fail('input_invalid');
  case46SourceIdentity(parsed.data.captureRunId);
  const q = qualification(parsed.data, '0'.repeat(64));
  validateCase46BudgetQualification(q, {
    caseId: '46',
    captureRunId: parsed.data.captureRunId,
    currentVerifySha256: q.currentVerifySha256,
    qualificationSha256: case46BudgetHash(q),
    expiresAt: Date.now() + 20 * 60_000,
  });
  return parsed.data;
}
function qualification(
  input: Case46SetupInput,
  currentVerifySha256: string,
): Case46ProviderBudgetQualification {
  const { rates, maxAttempts, maxTokens, maxCostMicros, priceKind, expiresAt } = input.rateEvidence;
  return {
    version: 1,
    caseId: '46',
    captureRunId: input.captureRunId,
    currentVerifySha256,
    rateEvidenceSha256: case46BudgetHash(input.rateEvidence),
    rateEvidenceExpiresAt: expiresAt,
    priceKind,
    maxAttempts,
    maxTokens,
    maxCostMicros,
    rates,
  };
}
async function settingsInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  lock: 'SHARE' | 'UPDATE',
) {
  // Only the fixed lock mode is interpolated; every identity remains bound.
  const rows = await tx.$queryRawUnsafe<Array<{ settings: unknown }>>(
    `SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid FOR ${lock}`,
    ctx.tenantId,
  );
  if (rows.length !== 1) fail('tenant_missing');
  const settings = case46Record(rows[0]!.settings);
  const fixture = case46Record(settings.meriFoundationFixture);
  if (fixture.fixtureNamespace !== f.namespace) fail('namespace_changed');
  return { settings, fixture };
}
async function planInTx(
  tx: Prisma.TransactionClient,
  input: Case46SetupInput,
  fixture: Record<string, unknown>,
) {
  await assertCase46CurrentActorInTx(tx, input.ctx);
  let retirement: Record<string, unknown> = {};
  if (input.remediationProofSha256)
    retirement = await assertCase46RemediationInTx(tx, input.ctx, fixture, input);
  else if (fixture[KEY] !== undefined) fail('existing_claim_requires_reconciliation');
  const identity = case46SourceIdentity(input.captureRunId);
  const title = `${f.namespace} case46 ${input.captureRunId}`;
  const rows = await tx.$queryRaw<Array<{ sources: bigint; conversations: bigint }>>`
    SELECT (SELECT count(*) FROM engagement_attachments WHERE tenant_id=${f.tenantId}::uuid
      AND id=${identity.physicalId}::uuid) AS sources,
      (SELECT count(*) FROM clio_conversations WHERE tenant_id=${f.tenantId}::uuid
      AND user_id=${f.actorUserId}::uuid AND title=${title}) AS conversations`;
  if (rows.length !== 1 || rows[0]!.sources !== 0n || rows[0]!.conversations !== 0n)
    fail('existing_source_or_conversation');
  return {
    version: 1,
    caseId: '46',
    fixtureNamespace: f.namespace,
    captureRunId: input.captureRunId,
    tenantId: f.tenantId,
    actorUserId: f.actorUserId,
    clientId: f.clientId,
    sourceId: identity.physicalId,
    sourceSha256: f.sha256,
    recipeSha256: case46BudgetHash(input),
    priorFixtureSha256: case46BudgetHash(fixture),
    rateEvidenceSha256: case46BudgetHash(input.rateEvidence),
    effects: [
      'create_canonical_input_document',
      'create_empty_owned_conversation',
      'install_sealed_capture_binding',
    ],
    // The exact retirement entry is part of the approved plan hash.
    ...(input.remediationProofSha256 ? { retirement } : {}),
    chatTurns: 0,
    outputArtifacts: 0,
    liveAcceptance: 'NOT_RUN',
  };
}
export async function planCase46Setup(runtime: Runtime, value: unknown) {
  const input = parse(value);
  return runtime.deps.prisma.withTenantUser(f.tenantId, f.actorUserId, async (tx) => {
    const state = await settingsInTx(tx, input.ctx, 'SHARE');
    const plan = await planInTx(tx, input, state.fixture);
    return { ...plan, planSha256: case46BudgetHash(plan) };
  });
}

/** Trusted fixed operator only. A durable claim precedes S3/index/conversation
 * effects. Any post-claim error preserves it and must be reconciled; this owner
 * permits only the explicitly reconciled prior failure, retaining its claim.
 * It contains no automatic retry, reset, cleanup, approval, or generation path. */
export async function executeCase46Setup(
  runtime: Runtime,
  value: unknown,
  expectedPlanSha256: string,
  journal: Journal,
) {
  const input = parse(value);
  if (!HASH.test(expectedPlanSha256) || typeof journal !== 'function') fail('plan_required');
  let stage = 'CLAIM';
  let claimSha256: string | null = null;
  const emit = async (phase: string, data: Record<string, unknown> = {}) =>
    journal({
      kind: 'meri-case46-setup',
      version: 1,
      caseId: '46',
      captureRunId: input.captureRunId,
      stage,
      phase,
      claimSha256,
      ...data,
      liveAcceptance: 'NOT_RUN',
    });
  try {
    await emit('INTENT');
    await runtime.deps.prisma.withTenantUser(f.tenantId, f.actorUserId, async (tx) => {
      const current = await settingsInTx(tx, input.ctx, 'UPDATE');
      const plan = await planInTx(tx, input, current.fixture);
      if (case46BudgetHash(plan) !== expectedPlanSha256) fail('stale_plan');
      const claim = {
        version: 1,
        caseId: '46',
        captureRunId: input.captureRunId,
        recipeSha256: plan.recipeSha256,
        planSha256: expectedPlanSha256,
        status: 'STARTED',
      };
      const next = {
        ...current.settings,
        meriFoundationFixture: {
          ...current.fixture,
          ...(plan.retirement ?? {}),
          [KEY]: claim,
        },
      };
      const changed =
        await tx.$executeRaw`UPDATE tenants SET settings_jsonb=${JSON.stringify(next)}::jsonb
        WHERE id=${f.tenantId}::uuid AND settings_jsonb=${JSON.stringify(current.settings)}::jsonb`;
      if (changed !== 1) fail('claim_cas_failed');
      claimSha256 = case46BudgetHash(claim);
    });
    await emit('VERIFIED');
    stage = 'INPUT_SOURCE';
    await emit('INTENT');
    const source = await runtime.createSource(input.ctx, input.captureRunId);
    await emit('VERIFIED', { source });
    stage = 'EMPTY_CONVERSATION';
    await emit('INTENT');
    const conversation = await runtime.createConversation(input.ctx, input.captureRunId);
    await emit('VERIFIED', { conversationId: conversation.id });
    stage = 'CAPTURE_BINDING';
    await emit('INTENT');
    const current = await runtime.deps.prisma.withTenantUser(f.tenantId, f.actorUserId, (tx) =>
      readCase46CurrentAuthorityInTx(tx, runtime.deps, input.ctx, {
        conversationId: conversation.id,
        captureRunId: input.captureRunId,
      }),
    );
    const binding = await installCase46CaptureBinding(runtime.deps, {
      ctx: input.ctx,
      captureRunId: input.captureRunId,
      conversationId: conversation.id,
      expectedMetadataSha256: case46BudgetHash(current.metadata),
      qualification: qualification(input, current.currentVerifySha256),
    });
    await emit('VERIFIED', { binding });
    stage = 'COMPLETE';
    const receipt = {
      version: 1,
      caseId: '46',
      fixtureNamespace: f.namespace,
      captureRunId: input.captureRunId,
      tenantId: f.tenantId,
      actorUserId: f.actorUserId,
      clientId: f.clientId,
      conversationId: conversation.id,
      source,
      binding,
      claimSha256,
      planSha256: expectedPlanSha256,
      chatTurns: 0,
      outputArtifacts: 0,
      liveAcceptance: 'NOT_RUN',
    };
    await runtime.deps.prisma.withTenantUser(f.tenantId, f.actorUserId, async (tx) => {
      const state = await settingsInTx(tx, input.ctx, 'UPDATE');
      await assertCase46CurrentActorInTx(tx, input.ctx);
      if (case46BudgetHash(state.fixture[KEY]) !== claimSha256) fail('claim_changed');
      const next = {
        ...state.settings,
        meriFoundationFixture: {
          ...state.fixture,
          [KEY]: {
            ...case46Record(state.fixture[KEY]),
            status: 'COMPLETE',
            receiptSha256: case46BudgetHash(receipt),
          },
        },
      };
      const changed =
        await tx.$executeRaw`UPDATE tenants SET settings_jsonb=${JSON.stringify(next)}::jsonb
        WHERE id=${f.tenantId}::uuid AND settings_jsonb=${JSON.stringify(state.settings)}::jsonb`;
      if (changed !== 1) fail('completion_cas_failed');
    });
    await emit('VERIFIED', { receipt });
    return receipt;
  } catch (error) {
    const candidate = error as { code?: unknown; meta?: { code?: unknown } } | null;
    const state = candidate?.meta?.code;
    await emit('RECONCILIATION_REQUIRED', {
      code: 'CASE46_SETUP_FAILED',
      errorClass: error instanceof Error ? 'Error' : 'Unknown',
      prismaCode: /^P[0-9]{4}$/.test(String(candidate?.code)) ? candidate!.code : null,
      sqlState:
        typeof state === 'string' &&
        [
          '42883',
          '42501',
          '23505',
          '23503',
          '40001',
          '40P01',
          '57014',
          '42P01',
          '42703',
          '22P02',
        ].includes(state)
          ? state
          : null,
    });
    throw new Error('meri_case46_setup_reconciliation_required');
  }
}
