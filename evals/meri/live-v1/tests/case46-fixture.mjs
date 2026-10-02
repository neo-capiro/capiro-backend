import { randomUUID } from 'node:crypto';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
import { CASE46_SCOPE } from '../case46-receipt-joins.mjs';
import { CASE46_EXPECTED } from '../case46-artifact-evidence.mjs';

export function case46Sample() {
  const now = Date.now(), scope = { ...CASE46_SCOPE, captureRunId: randomUUID(), conversationId: randomUUID(),
    clerkUserId: 'user_syntheticPat', apiSha: 'a'.repeat(40), orchestratorSha: 'b'.repeat(40), webSha: 'c'.repeat(40), bindingSha256: 'd'.repeat(64) };
  const source = { owner: 'engagement_attachment', logicalId: 'ARTIFACT-BRIEF-1', physicalId: randomUUID(),
    rowVersion: '123456', ownershipSha256: 'e'.repeat(64), contentSha256: CASE46_EXPECTED.byteSha256, byteLength: 28 };
  scope.currentVerifySha256 = sha256Stable({ version: 1, caseId: '46', fixtureNamespace: scope.fixtureNamespace,
    tenantId: scope.tenantId, actorUserId: scope.userId, clientId: scope.clientId, conversationId: scope.conversationId,
    captureRunId: scope.captureRunId, source });
  scope.qualification = { version: 1, caseId: '46', captureRunId: scope.captureRunId, currentVerifySha256: scope.currentVerifySha256,
    rateEvidenceSha256: 'f'.repeat(64), rateEvidenceExpiresAt: new Date(now + 900000).toISOString(),
    priceKind: 'qualified_text_token_upper_bound', maxAttempts: 32, maxTokens: 200000, maxCostMicros: 3000000,
    rates: [{ kind: 'openai_responses', provider: 'openai', model: 'test-only', inputMicrosPerMillion: 1, outputMicrosPerMillion: 1 }] };
  scope.qualificationSha256 = sha256Stable(scope.qualification);
  const before = { version: 1, kind: 'meri_case46_current_capture', caseId: '46', phase: 'READY',
    fixtureNamespace: scope.fixtureNamespace, tenantId: scope.tenantId, actorUserId: scope.userId, clientId: scope.clientId,
    conversationId: scope.conversationId, captureRunId: scope.captureRunId, policyId: randomUUID(), policySha256: '1'.repeat(64),
    currentVerifySha256: scope.currentVerifySha256, source, qualificationSha256: scope.qualificationSha256,
    expiresAt: now + 600000, originalPromptSha256: sha256Bytes(scope.prompt), userMessageId: null, assistant: null,
    proposalId: null, providerUsage: null, effect: null, counts: { userTurns: 0, assistantTurns: 0, proposals: 0, artifactEffects: 0 } };
  const assistant = { id: randomUUID(), role: 'assistant', body: 'The export is ready for your approval.', metadata: {} };
  const proposed = structuredClone(before);
  Object.assign(proposed, { phase: 'AWAITING_APPROVAL', userMessageId: randomUUID(), proposalId: randomUUID(),
    assistant: { id: assistant.id, bodySha256: sha256Bytes(assistant.body), bodyByteLength: Buffer.byteLength(assistant.body) },
    counts: { userTurns: 1, assistantTurns: 1, proposals: 1, artifactEffects: 0 } });
  proposed.providerUsage = { version: 1, kind: 'governed_artifact_provider_usage', caseId: '46', captureRunId: scope.captureRunId,
    policyId: before.policyId, conversationId: scope.conversationId, turnId: proposed.userMessageId,
    currentVerifySha256: scope.currentVerifySha256, qualificationSha256: scope.qualificationSha256,
    ledgerSha256: '2'.repeat(64), attempts: 2, tokens: 100, costMicros: 3, allAttemptsSettled: true };
  const action = { version: 1, kind: 'meri_text_artifact_current_action', proposalId: proposed.proposalId,
    status: 'succeeded', artifactEffectCount: 1, attemptCount: 2, approvedBy: scope.userId,
    approvedAt: new Date(now - 2000).toISOString(), executedAt: new Date(now - 1000).toISOString() };
  const after = structuredClone(proposed); after.phase = 'ARTIFACT_CREATED'; after.counts.artifactEffects = 1;
  after.effect = { version: 1, kind: 'meri_text_artifact_creation', tenantId: scope.tenantId, userId: scope.userId,
    clientId: scope.clientId, conversationId: scope.conversationId, actionProposalId: proposed.proposalId,
    artifactId: randomUUID(), operationId: randomUUID(), filename: CASE46_EXPECTED.filename, mimeType: 'text/plain',
    sha256: CASE46_EXPECTED.byteSha256, byteLength: 28, currentAction: action };
  assistant.metadata.governedArtifactCaptureReceipt = structuredClone(after.providerUsage);
  assistant.metadata.case46CaptureAuthority = structuredClone(after);
  const checked = { status: 'DETERMINISTIC_DOWNLOAD_CHECK_ONLY', caseId: '46', artifactId: after.effect.artifactId,
    operationId: after.effect.operationId, proposalId: proposed.proposalId, filename: after.effect.filename,
    sha256: after.effect.sha256, byteLength: 28, currentAction: action, receiptSha256: '3'.repeat(64) };
  const ui = { status: 'UI_SUBSTEP_ONLY', caseId: '46', captureRunId: scope.captureRunId, approvalRequests: 1, blockedWrites: 0,
    scope: { ...scope, proposalId: proposed.proposalId },
    rounds: [{ phase: 'initial', checked: structuredClone(checked) }, { phase: 'after-reload', checked: structuredClone(checked) }] };
  return { scope, before, proposed, after, assistant, ui, now };
}

