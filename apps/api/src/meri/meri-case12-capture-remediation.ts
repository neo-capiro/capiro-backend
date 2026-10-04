import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { meriCase12SetupBindingsEqual, validateMeriCase12SetupPolicyBinding } from '@capiro/meriv2-core';
import type { PrismaService } from '../prisma/prisma.service.js';
import { readMeriCase12CompletedCorpusInTx } from './meri-case12-capture-authority.js';
import { captureBudgetHash } from './meri-capture-provider-budget.js';

const TENANT = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const OLD_RUN = '4a32f9ce-3caa-49f2-95ef-2a512c854468';
const OLD_CONVERSATION = '40dd8401-dcfe-46bd-b010-c30e7098297c';
const OLD_ADMISSION = '52907cb0-88c7-401a-a15d-fff3bf068b05';
const QUALIFICATION_SHA = 'd267a5985fc3caeb94416393a684877bfa81a33b3db27d99a48d76afa6ece905';
const POLICY_SHA = '43cb66d1b41c094caa5377f0da5f600efd3e94c1e61d7f10be85542f9800a083';
const DEADLINE = '2026-10-04T20:46:05.417Z';
const VERIFY_SHA = '5ff329511d93d308aac9fc4ff335788040db8740994906c34a9cb76c15042e3d';
const RATE_EVIDENCE_SHA = '166362a8fa51e19255a054babccbe73ab17d76aede9c15f6503e4f20c565a59a';
const FAILURE = Object.freeze({
  kind: 'meri-case12-failed-capture-cost-terminal', caseId: '12', captureRunId: OLD_RUN,
  reservationId: 'b4522136-07bc-4243-aac8-8cbd3101083a', conversationId: OLD_CONVERSATION,
  journalBeforeSha256: 'b3326761fd5d7b93f8c85d7c59515b4c40f9bb430f68adce4dccfcb4e0da0904',
  qualificationSha256: QUALIFICATION_SHA,
  authenticatedReadbackSha256: '30ce5bcdca71fe9c0b0b04c06867e6c415cecf7b2b9814a75619bf655a98bc51',
  streamResponseSha256: '5c8f697287bfa1b4c886ca74287414800c9a516f876476972406e1adef48a404',
  qualificationSourceSha256: '39d6f0c14ac508c45496b0722fa6a0e3ec1d3f947aafe732911a0572506d615e',
  streamRunId: '7c525f0c-2ee9-4409-9df7-8cf8389ac23f', streamHttpStatus: 201,
  streamErrorCode: 'MERI_STREAM_SETUP_ERROR',
  failureReason: 'meri_capture_provider_budget_unqualified_retrieval_plan', streamAccepted: false,
  messageCount: 0, turnId: null, ledgerActivation: 'enforced', ledgerAttempts: [],
  chargedAttempts: 0, chargedTokens: 0, chargedCostMicros: 0, modelDispatch: false,
  sourceAcceptance: false, captureAuthority: false, liveAcceptance: 'NOT_RUN',
  observedAtMs: 1791146789911,
});
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const fail = (code: string): never => { throw new Error('meri_case12_capture_remediation_' + code); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type Input = {ctx: TenantContext; clientId: string; oldConversationId: string; newConversationId: string;
  newCaptureRunId: string; expectedCurrentVerifySha256: string; expectedApiSourceSha: string};

function validateIds(input: Input) {
  if (input.ctx.tenantId !== TENANT || input.ctx.tenantSlug !== 'meri-foundation-20260928-t1' ||
      input.ctx.role !== 'standard_user' || !UUID.test(input.clientId) ||
      !UUID.test(input.oldConversationId) || !UUID.test(input.newConversationId) ||
      !UUID.test(input.newCaptureRunId) || !/^[a-f0-9]{64}$/.test(input.expectedCurrentVerifySha256) ||
      !/^[a-f0-9]{40}$/.test(input.expectedApiSourceSha) ||
      input.ctx.userId !== 'b1f758fc-17bd-40f8-bef2-fa2d2380300f' ||
      input.ctx.clerkUserId !== 'user_3Jw2FvWZkYGKmxWGx13tNJxFD2A' ||
      input.clientId !== '41f9ec63-3963-479f-b747-59a3767ef44b') fail('input_invalid');
  const servedSha = process.env.GIT_SHA ?? process.env.SOURCE_VERSION ?? process.env.CODEBUILD_RESOLVED_SOURCE_VERSION;
  if (input.expectedApiSourceSha !== servedSha) fail('code_sha_mismatch');
  if (input.expectedCurrentVerifySha256 !== VERIFY_SHA) fail('current_verify_mismatch');
  if (input.oldConversationId !== OLD_CONVERSATION || input.oldConversationId === input.newConversationId ||
      input.newCaptureRunId === OLD_RUN) fail('historical_identity_replayed');
}
function validateOldBudget(metadata: unknown, nowMs: number) {
  const envelope = record(metadata), budget = record(envelope.serverCaptureProviderBudget), ledger = record(budget.ledger);
  if (Object.keys(budget).sort().join('|') !== 'admissionId|ledger|policySha256|qualification|qualificationSha256|turnId|version' ||
      budget.version !== 1 || budget.admissionId !== OLD_ADMISSION || budget.turnId !== null ||
      budget.policySha256 !== POLICY_SHA || budget.qualificationSha256 !== QUALIFICATION_SHA || captureBudgetHash(budget.qualification) !== QUALIFICATION_SHA ||
      record(budget.qualification).version !== 1 || record(budget.qualification).caseId !== '12' ||
      record(budget.qualification).captureRunId !== OLD_RUN || record(budget.qualification).currentVerifySha256 !== VERIFY_SHA ||
      record(budget.qualification).rateEvidenceSha256 !== RATE_EVIDENCE_SHA ||
      Object.keys(ledger).sort().join('|') !== 'activation|attempts|chargedAttempts|chargedCostMicros|chargedTokens|limits|version' ||
      ledger.version !== 1 || ledger.activation !== 'enforced' || !Array.isArray(ledger.attempts) || ledger.attempts.length !== 0 ||
      ledger.chargedAttempts !== 0 || ledger.chargedTokens !== 0 || ledger.chargedCostMicros !== 0 ||
      captureBudgetHash(ledger.limits) !== captureBudgetHash({maxTokens: 500000, maxAttempts: 16,
        maxCostMicros: 13797053, deadlineAt: DEADLINE}) || Date.parse(DEADLINE) >= nowMs) fail('old_budget_not_expired_zero_cost');
  return budget;
}

async function inspect(prisma: PrismaService, tx: Prisma.TransactionClient, input: Input) {
  validateIds(input);
  const tenantRows = await tx.$queryRaw<Array<{settings: unknown; rowVersion: string; nowMs: bigint}>>`
    SELECT settings_jsonb AS settings, xmin::text AS "rowVersion",
      (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "nowMs" FROM tenants
    WHERE id=${input.ctx.tenantId}::uuid FOR UPDATE`;
  if (tenantRows.length !== 1) fail('tenant_missing');
  const settings = record(tenantRows[0]!.settings), fixture = record(settings.meriFoundationFixture);
  if (fixture.case12CaptureRemediation !== undefined) fail('already_remediated');
  const priorBinding = record(fixture.captureEvidence), priorQualification = fixture.captureProviderBudget;
  if (priorBinding.caseId !== '12' || priorBinding.captureRunId !== OLD_RUN ||
      priorBinding.remediationConversationId !== undefined ||
      priorBinding.clientId !== input.clientId || priorBinding.actorUserId !== input.ctx.userId ||
      priorBinding.currentVerifySha256 !== VERIFY_SHA || !priorQualification ||
      captureBudgetHash(priorQualification) !== QUALIFICATION_SHA) fail('prior_binding_changed');

  // Current completion/corpus/actor authority is re-read natively in this transaction.
  const {proof, completion} = await readMeriCase12CompletedCorpusInTx(prisma, tx, input.ctx, input.clientId);
  if (proof.corpusQualified !== true || proof.caseId !== '12' || proof.tenantId !== TENANT ||
      proof.actorUserId !== input.ctx.userId || proof.clientId !== input.clientId ||
      proof.currentVerifySha256 !== VERIFY_SHA || completion.binding.setupClaimSha256 !== proof.setupClaimSha256 ||
      completion.binding.setupRunId !== '4aa30f1a-c852-43db-840e-62538d475373' ||
      !meriCase12SetupBindingsEqual(priorBinding.case12Setup, completion.binding) ||
      priorBinding.fixtureNamespace !== proof.fixtureNamespace || priorBinding.fixtureVersion !== proof.fixtureVersion ||
      priorBinding.physicalMapSha256 !== proof.physicalMapSha256 ||
      priorBinding.resetReceiptId !== null || priorBinding.seedReceiptId !== null)
    fail('current_setup_or_corpus_unqualified');

  const oldRows = await tx.$queryRaw<Array<{id: string; clientId: string | null; metadata: unknown; rowVersion: string}>>`
    SELECT id, client_id AS "clientId", metadata_jsonb AS metadata, xmin::text AS "rowVersion"
    FROM clio_conversations WHERE id=${OLD_CONVERSATION}::uuid AND tenant_id=${TENANT}::uuid
      AND user_id=${input.ctx.userId}::uuid FOR UPDATE`;
  if (oldRows.length !== 1 || oldRows[0]!.clientId !== input.clientId) fail('old_conversation_owner_mismatch');
  const nowMs = Number(tenantRows[0]!.nowMs);
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) fail('native_clock_required');
  validateOldBudget(oldRows[0]!.metadata, nowMs);
  const oldMessages = await tx.$queryRaw<Array<{count: bigint}>>`
    SELECT count(*)::bigint AS count FROM clio_messages
    WHERE conversation_id=${OLD_CONVERSATION}::uuid`;
  if (oldMessages.length !== 1 || Number(oldMessages[0]!.count) !== 0) fail('old_conversation_has_messages');

  const newRows = await tx.$queryRaw<Array<{id: string; clientId: string | null; metadata: unknown;
    summary: string | null; summaryUpToMessageId: string | null; rowVersion: string}>>`
    SELECT id, client_id AS "clientId", metadata_jsonb AS metadata, summary,
      summary_up_to_message_id AS "summaryUpToMessageId", xmin::text AS "rowVersion" FROM clio_conversations
    WHERE id=${input.newConversationId}::uuid AND tenant_id=${TENANT}::uuid AND user_id=${input.ctx.userId}::uuid
      AND archived_at IS NULL AND status='active' FOR UPDATE`;
  if (newRows.length !== 1 || newRows[0]!.clientId !== input.clientId) fail('new_conversation_owner_mismatch');
  if (newRows[0]!.summary !== null || newRows[0]!.summaryUpToMessageId !== null ||
      Object.keys(record(newRows[0]!.metadata)).some(key => /^(serverCapture|serverReadonlyCapture|case12Capture)/.test(key)))
    fail('new_conversation_has_capture_state');
  const newMessages = await tx.$queryRaw<Array<{count: bigint}>>`
    SELECT count(*)::bigint AS count FROM clio_messages
    WHERE conversation_id=${input.newConversationId}::uuid`;
  if (newMessages.length !== 1 || Number(newMessages[0]!.count) !== 0) fail('new_conversation_not_empty');
  const artifacts = await tx.$queryRaw<Array<{count: bigint}>>`
    SELECT count(*)::bigint AS count FROM clio_artifacts
    WHERE conversation_id IN (${OLD_CONVERSATION}::uuid, ${input.newConversationId}::uuid)`;
  if (artifacts.length !== 1 || Number(artifacts[0]!.count) !== 0) fail('conversation_has_artifacts');

  const binding = {...priorBinding, caseId: '12', resetReceiptId: null, seedReceiptId: null,
    captureRunId: input.newCaptureRunId,
    actorUserId: input.ctx.userId, clientId: input.clientId, currentVerifySha256: proof.currentVerifySha256,
    case12Setup: completion.binding, remediationConversationId: input.newConversationId};
  validateMeriCase12SetupPolicyBinding(binding);
  const archive = {kind: 'meri-case12-one-time-capture-remediation', version: 1,
    historicalFailure: FAILURE, priorCaptureBinding: priorBinding,
    priorProviderQualification: priorQualification, oldConversationMetadata: oldRows[0]!.metadata,
    oldBudgetSha256: captureBudgetHash(record(oldRows[0]!.metadata).serverCaptureProviderBudget),
    oldConversationId: OLD_CONVERSATION, newConversationId: input.newConversationId,
    newCaptureRunId: input.newCaptureRunId, actorUserId: input.ctx.userId, clientId: input.clientId,
    setupRunId: completion.binding.setupRunId, currentVerifySha256: proof.currentVerifySha256,
    apiSourceSha: input.expectedApiSourceSha,
    bindingRemediationConversationId: input.newConversationId, liveAcceptance: 'NOT_RUN'};
  const body = {kind: 'meri-case12-capture-remediation-plan', schemaVersion: 1,
    tenantId: TENANT, actorUserId: input.ctx.userId, clientId: input.clientId,
    oldConversationId: OLD_CONVERSATION, oldConversationRowVersion: oldRows[0]!.rowVersion,
    newConversationId: input.newConversationId, newConversationRowVersion: newRows[0]!.rowVersion,
    tenantRowVersion: tenantRows[0]!.rowVersion, apiSourceSha: input.expectedApiSourceSha,
    oldConversationMetadataSha256: captureBudgetHash(oldRows[0]!.metadata),
    newConversationMetadataSha256: captureBudgetHash(newRows[0]!.metadata),
    priorCaptureBindingSha256: captureBudgetHash(priorBinding),
    priorProviderQualificationSha256: captureBudgetHash(priorQualification), oldBudgetSha256: archive.oldBudgetSha256,
    currentVerifySha256: proof.currentVerifySha256, newCaptureRunId: input.newCaptureRunId, binding, archive};
  return {...body, planSha256: captureBudgetHash(body)};
}

/** Operator-only inspect. The ordinary installer remains intentionally non-reentrant. */
export async function inspectCase12FailedCaptureRemediationInTx(prisma: PrismaService, tx: Prisma.TransactionClient,
  input: Input) {
  return {status: 'PLAN_ONLY', ...(await inspect(prisma, tx, input)), liveAcceptance: 'NOT_RUN'};
}
export async function installCase12FailedCaptureRemediationInTx(prisma: PrismaService, tx: Prisma.TransactionClient,
  input: Input & {expectedPlanSha256: string; confirmation: string}) {
  if (input.confirmation !== 'REMEDIATE_CASE12_FAILED_CAPTURE_ONCE') fail('confirmation');
  const plan = await inspect(prisma, tx, input);
  if (plan.planSha256 !== input.expectedPlanSha256) fail('stale_plan');
  const rows = await tx.$queryRaw<Array<{binding: unknown; archive: unknown; oldBudget: unknown; rowVersion: string}>>`
  UPDATE tenants SET settings_jsonb=jsonb_set(
    jsonb_set(settings_jsonb #- '{meriFoundationFixture,captureProviderBudget}',
      '{meriFoundationFixture,captureEvidence}', ${JSON.stringify(plan.binding)}::jsonb, true),
    '{meriFoundationFixture,case12CaptureRemediation}', ${JSON.stringify(plan.archive)}::jsonb, true)
  WHERE id=${TENANT}::uuid AND xmin::text=${plan.tenantRowVersion}
    AND settings_jsonb #> '{meriFoundationFixture,captureEvidence}' = ${JSON.stringify(record(plan).archive.priorCaptureBinding)}::jsonb
    AND settings_jsonb #> '{meriFoundationFixture,captureProviderBudget}' = ${JSON.stringify(record(plan).archive.priorProviderQualification)}::jsonb
    AND settings_jsonb #> '{meriFoundationFixture,case12CaptureRemediation}' IS NULL
  RETURNING settings_jsonb #> '{meriFoundationFixture,captureEvidence}' AS binding,
    settings_jsonb #> '{meriFoundationFixture,case12CaptureRemediation}' AS archive,
    settings_jsonb #> '{meriFoundationFixture,captureProviderBudget}' AS "oldBudget", xmin::text AS "rowVersion"`;
  if (rows.length !== 1 || captureBudgetHash(rows[0]!.binding) !== captureBudgetHash(plan.binding) ||
      captureBudgetHash(rows[0]!.archive) !== captureBudgetHash(plan.archive) ||
      rows[0]!.oldBudget !== null) fail('cas_readback');
  return {kind: 'meri-case12-capture-remediation', schemaVersion: 1, status: 'NEW_BINDING_INSTALLED_REQUIRES_NEW_PROVIDER_QUALIFICATION',
    planSha256: plan.planSha256, bindingSha256: captureBudgetHash(plan.binding), archiveSha256: captureBudgetHash(plan.archive),
    tenantRowVersion: rows[0]!.rowVersion, liveAcceptance: 'NOT_RUN'};
}

export const case12FailedCaptureRemediationHistoricalProof = FAILURE;
export const case12FailedCaptureRemediationConstants = Object.freeze({OLD_RUN, OLD_CONVERSATION, DEADLINE, QUALIFICATION_SHA});
