import { isDeepStrictEqual } from 'node:util';
import { sha256Bytes, sha256Stable } from './artifact-collector.mjs';
import { CASE46_EXPECTED, inspectCase46ArtifactReload } from './case46-artifact-evidence.mjs';
import { cases } from './cases.mjs';

export const CASE46_SCOPE = Object.freeze({ caseId: '46', fixtureNamespace: 'meri-foundation-20260928',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', tenantSlug: 'meri-foundation-20260928-t1',
  userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f', clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  role: 'standard_user', actorLogicalId: 'PAT', clientLogicalId: 'ASTER',
  prompt: cases.find(row => row.id === '46').prompt });
const HASH = /^[a-f0-9]{64}$/u, SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
export const case46Need = (ok, code) => { if (!ok) throw new Error(`CASE46_${code}`); };
const need = case46Need;
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const IMMUTABLE = ['fixtureNamespace', 'tenantId', 'actorUserId', 'clientId', 'conversationId',
  'captureRunId', 'policyId', 'policySha256', 'currentVerifySha256', 'source', 'qualificationSha256',
  'expiresAt', 'originalPromptSha256'];

/** Pure scope validation only. Actual native capture binds this to authenticated owner reads. */
export function inspectCase46Scope(scope) {
  for (const [key, expected] of Object.entries(CASE46_SCOPE)) need(scope?.[key] === expected, `SCOPE_${key.toUpperCase()}`);
  need(UUID.test(scope.captureRunId ?? '') && UUID.test(scope.conversationId ?? '') &&
    /^user_[A-Za-z0-9]+$/u.test(scope.clerkUserId ?? ''), 'SCOPE_IDENTITY');
  for (const key of ['apiSha', 'orchestratorSha', 'webSha']) need(SHA.test(scope[key] ?? ''), 'SCOPE_RELEASE');
  for (const key of ['currentVerifySha256', 'qualificationSha256', 'bindingSha256']) need(HASH.test(scope[key] ?? ''), 'SCOPE_BINDING');
  const q = scope.qualification;
  need(q?.version === 1 && q.caseId === '46' && q.captureRunId === scope.captureRunId &&
    q.currentVerifySha256 === scope.currentVerifySha256 && sha256Stable(q) === scope.qualificationSha256 &&
    integer(q.maxCostMicros, 1, 15_000_000) && integer(q.maxAttempts, 1, 64) && integer(q.maxTokens, 1, 1_000_000) &&
    q.priceKind === 'qualified_text_token_upper_bound' && HASH.test(q.rateEvidenceSha256 ?? '') &&
    Number.isFinite(Date.parse(q.rateEvidenceExpiresAt)) && Array.isArray(q.rates) && q.rates.length > 0,
    'SCOPE_QUALIFICATION');
  return structuredClone(scope);
}

export function inspectCase46CurrentReadback({ scope, current, phase, now = Date.now() }) {
  inspectCase46Scope(scope);
  need(current?.version === 1 && current.kind === 'meri_case46_current_capture' && current.caseId === '46', 'OWNER_KIND');
  for (const key of ['fixtureNamespace', 'tenantId', 'clientId', 'conversationId', 'captureRunId', 'currentVerifySha256', 'qualificationSha256'])
    need(current[key] === scope[key], 'OWNER_SCOPE');
  need(current.actorUserId === scope.userId && UUID.test(current.policyId ?? '') && HASH.test(current.policySha256 ?? ''), 'OWNER_ACTOR');
  need(current.originalPromptSha256 === sha256Bytes(CASE46_SCOPE.prompt), 'ORIGINAL_PROMPT');
  need(Number.isSafeInteger(now) && integer(current.expiresAt, now + 1, now + 900_000) &&
    Date.parse(scope.qualification.rateEvidenceExpiresAt) >= current.expiresAt, 'OWNER_EXPIRY');
  const s = current.source;
  need(s?.owner === 'engagement_attachment' && s.logicalId === 'ARTIFACT-BRIEF-1' && UUID.test(s.physicalId ?? '') &&
    /^[0-9]{1,10}$/u.test(s.rowVersion ?? '') && HASH.test(s.ownershipSha256 ?? '') &&
    s.contentSha256 === CASE46_EXPECTED.byteSha256 && s.byteLength === 28, 'SOURCE_BYTES');
  const expectedVerify = { version: 1, caseId: '46', fixtureNamespace: scope.fixtureNamespace,
    tenantId: scope.tenantId, actorUserId: scope.userId, clientId: scope.clientId,
    conversationId: scope.conversationId, captureRunId: scope.captureRunId, source: s };
  need(sha256Stable(expectedVerify) === current.currentVerifySha256, 'CURRENT_VERIFY_HASH');
  const counts = { READY: [0, 0, 0, 0], AWAITING_APPROVAL: [1, 1, 1, 0], ARTIFACT_CREATED: [1, 1, 1, 1] }[phase];
  need(counts && current.phase === phase && ['userTurns', 'assistantTurns', 'proposals', 'artifactEffects']
    .every((k, i) => current.counts?.[k] === counts[i]), 'PHASE_COUNTS');
  if (phase === 'READY') need(current.userMessageId === null && current.assistant === null &&
    current.proposalId === null && current.providerUsage === null && current.effect === null, 'EMPTY_OWNER');
  else {
    need(UUID.test(current.userMessageId ?? '') && UUID.test(current.assistant?.id ?? '') &&
      HASH.test(current.assistant?.bodySha256 ?? '') && integer(current.assistant?.bodyByteLength, 1, 262144) &&
      UUID.test(current.proposalId ?? ''), 'SAVED_TURN');
    const u = current.providerUsage;
    need(u?.version === 1 && u.kind === 'governed_artifact_provider_usage' && u.caseId === '46' &&
      u.captureRunId === scope.captureRunId && u.policyId === current.policyId && u.conversationId === scope.conversationId &&
      u.turnId === current.userMessageId && u.currentVerifySha256 === current.currentVerifySha256 &&
      u.qualificationSha256 === current.qualificationSha256 && HASH.test(u.ledgerSha256 ?? '') &&
      integer(u.attempts, 1, scope.qualification.maxAttempts) && integer(u.tokens, 0, scope.qualification.maxTokens) &&
      integer(u.costMicros, 0, scope.qualification.maxCostMicros) && u.allAttemptsSettled === true, 'SETTLED_USAGE');
    need(phase === 'ARTIFACT_CREATED' ? current.effect !== null : current.effect === null, 'EFFECT_PHASE');
  }
  return structuredClone(current);
}

/** Deterministic joins only; serializable caller objects never confer LIVE authority. */
export function assertCase46ReceiptJoins({ scope, before, proposed, after, assistant, ui, now = Date.now() }) {
  for (const [current, phase] of [[before, 'READY'], [proposed, 'AWAITING_APPROVAL'], [after, 'ARTIFACT_CREATED']])
    inspectCase46CurrentReadback({ scope, current, phase, now });
  need(IMMUTABLE.every(key => isDeepStrictEqual(before[key], proposed[key]) && isDeepStrictEqual(before[key], after[key])), 'OWNER_DRIFT');
  need(proposed.userMessageId === after.userMessageId && proposed.proposalId === after.proposalId &&
    isDeepStrictEqual(proposed.assistant, after.assistant) && isDeepStrictEqual(proposed.providerUsage, after.providerUsage), 'TURN_DRIFT');
  need(assistant?.role === 'assistant' && assistant.id === after.assistant.id && typeof assistant.body === 'string' &&
    sha256Bytes(assistant.body) === after.assistant.bodySha256 && Buffer.byteLength(assistant.body) === after.assistant.bodyByteLength &&
    isDeepStrictEqual(assistant.metadata?.governedArtifactCaptureReceipt, after.providerUsage) &&
    isDeepStrictEqual(assistant.metadata?.case46CaptureAuthority, after), 'SERVED_ASSISTANT');
  need(ui?.status === 'UI_SUBSTEP_ONLY' && ui.caseId === '46' && ui.captureRunId === scope.captureRunId &&
    ui.approvalRequests === 1 && ui.blockedWrites === 0 && ui.rounds?.length === 2 &&
    ui.rounds[0].phase === 'initial' && ui.rounds[1].phase === 'after-reload', 'UI_OPERATION_COUNTS');
  for (const key of ['tenantId', 'tenantSlug', 'userId', 'clientId', 'conversationId', 'clerkUserId', 'apiSha', 'webSha'])
    need(ui.scope?.[key] === scope[key], 'UI_SCOPE');
  need(ui.scope.proposalId === after.proposalId, 'UI_PROPOSAL');
  const e = after.effect, checked = ui.rounds[0].checked;
  need(e?.version === 1 && e.kind === 'meri_text_artifact_creation' && e.tenantId === scope.tenantId &&
    e.userId === scope.userId && e.clientId === scope.clientId && e.conversationId === scope.conversationId &&
    e.actionProposalId === after.proposalId && UUID.test(e.artifactId ?? '') && UUID.test(e.operationId ?? '') &&
    e.filename === CASE46_EXPECTED.filename && e.sha256 === CASE46_EXPECTED.byteSha256 && e.byteLength === 28 &&
    e.mimeType === 'text/plain', 'EFFECT_RECEIPT');
  need(checked.artifactId === e.artifactId && checked.operationId === e.operationId && checked.proposalId === e.actionProposalId &&
    checked.filename === e.filename && checked.sha256 === e.sha256 && checked.byteLength === e.byteLength &&
    isDeepStrictEqual(checked.currentAction, e.currentAction), 'DOWNLOAD_OWNER_JOIN');
  const action = e.currentAction;
  need(action?.status === 'succeeded' && action.proposalId === after.proposalId && action.approvedBy === scope.userId &&
    action.artifactEffectCount === 1 && integer(action.attemptCount, 1, Number.MAX_SAFE_INTEGER) &&
    Number.isFinite(Date.parse(action.approvedAt)) && Number.isFinite(Date.parse(action.executedAt)) &&
    Date.parse(action.approvedAt) <= Date.parse(action.executedAt), 'CURRENT_APPROVAL');
  inspectCase46ArtifactReload(checked, ui.rounds[1].checked);
  return Object.freeze({ status: 'SAVED_CHECKS_ONLY', caseId: '46', captureRunId: scope.captureRunId,
    turnId: after.userMessageId, assistantMessageId: assistant.id, proposalId: after.proposalId,
    artifactId: e.artifactId, operationId: e.operationId, costMicros: after.providerUsage.costMicros,
    ledgerSha256: after.providerUsage.ledgerSha256, liveAcceptance: 'NOT_RUN', fullFile01Acceptance: false });
}
