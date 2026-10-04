import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256Stable } from './lib/stable.mjs';
import { CASE20_TERMINAL_COST_PINS as pins } from './case20-terminal-cost-pins.mjs';

const authorities = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const need = ok => { if (!ok) throw new Error('CASE20_TERMINAL_COST_REJECTED'); };
export const CASE20_TERMINAL_COST_SCOPE = Object.freeze({
  caseId: '20', captureRunId: 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b',
  reservationId: '7ea73cdc-526e-4b31-8c28-b0636ea8d2ae', ceilingMicros: 15000000,
  conversationId: 'db0e01ac-60a1-4e3c-b8ba-66748d087a2e',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  actorUserId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f', clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  turnId: '3a50a9fd-8afa-4b3d-9a74-ba69f02122e6', assistantMessageId: '09967dee-533c-4177-bfb8-68366cfa0e3f',
  policyId: '026d5d8a-b655-41b4-a4e8-5ad4cbd93c6f', requestId: 'f161ebdf-323e-4995-9a7f-4509541d71f9',
  traceId: '5f6c9bfe-a113-4b63-93d5-e1edb1defd32', admissionId: '1bbf8e44-e4b8-4952-abb3-84435991f392',
  sourceSha: '4f0253874357c272fda1ae2a5271ee4af645f0bc',
  providerStateSha256: '3d665a2323c36e38733b7c1576af13976c0c4a573fa1a2ccc91f668a630ca5f5',
});
const scope = (value, fields) => { for (const field of fields) need(value?.[field] === CASE20_TERMINAL_COST_SCOPE[field]); };

/** Pure exact-evidence regression predicate. Returned data cannot mutate a journal. */
export function inspectCase20TerminalCost(input) {
  const s = CASE20_TERMINAL_COST_SCOPE;
  // Canonical pins also bind fields not projected into the cost proof. This is a
  // one-off retained-evidence authority, never a general caller-selected proof.
  for (const [name,pin] of Object.entries(pins)) if (pin.semanticSha256) need(sha256Stable(input[name]) === pin.semanticSha256);
  const { execution:e, checkpoint, captured:c, readback:post, me, conversation:response, scope:original } = input;
  scope(e,['caseId','captureRunId','conversationId','sourceSha']);
  need(e.orchestratorSha === s.sourceSha && e.verdict === 'BLOCKED' && e.executionAttempted === true &&
    e.sessionRevoked === true && e.originalEvidencePreserved === true && e.newReservationAttempted === false &&
    e.conversationCreationAttempted === false && e.browserApplicationWrites === 0 && e.maximumNewTurns === 1 &&
    e.automaticPaidRetryAllowed === false && e.outcome.status === 'CAPTURE_UNCERTAIN' &&
    e.outcome.acceptanceStatus === 'NOT_RUN' && e.outcome.reason === 'CONTROLLED_READ_FULL_PASSAGE_UNPROVED' &&
    e.outcome.synthesisSubmissionCount === 1 && e.submissionObservation.turnsSent === 1);
  need(isDeepStrictEqual(input.blocked,e.outcome) && isDeepStrictEqual(input.manifest.summary,e.outcome));
  scope(e.restoredReservation,['caseId','captureRunId','reservationId','ceilingMicros']);
  scope(input.intent,['caseId','captureRunId','conversationId']);
  need(e.scopeFileSha256 === pins.scope.sha256 && e.scriptSha256 === pins.operator.sha256 && e.manifestSha256 === pins.authManifest.sha256);
  scope(original.config,['caseId','captureRunId']);
  const actor = original.config.scope.actors.PAT, client = original.config.scope.clients.ASTER;
  need(actor.userId === s.userId && actor.tenantPhysicalId === s.tenantId && actor.role === 'standard_user' &&
    client.physicalId === s.clientId && client.tenantPhysicalId === s.tenantId && original.config.limits.maxSpendUsd === 15);
  for (const name of ['originalClaim','recoveryClaim']) scope(input[name],['captureRunId']);
  need(input.originalClaim.kind === 'meri-controlled-read-one-shot-claim' && input.originalClaim.caseId === '20' &&
    input.recoveryClaim.kind === 'case20-presubmission-recovery-once' && input.recoveryClaim.noAutomaticRetry === true &&
    input.recoveryClaim.noNewReservation === true && input.recoveryClaim.priorClaimSha256 === pins.originalClaim.sha256 &&
    input.recoveryClaim.journalSha256 === pins.journal.sha256 && e.recoveryProof.claimSha256 === pins.recoveryClaim.sha256);
  scope(input.recoveryClaim,['conversationId','reservationId','ceilingMicros']);
  const key = `20:${s.captureRunId}`, snapshot = checkpoint.snapshot;
  need(checkpoint.kind === 'meri-fresh-capture-spend-checkpoint' && checkpoint.version === 1 &&
    snapshot.protocolVersion === 3 && snapshot.eventCount === 23 && snapshot.activeRun === key &&
    snapshot.knownSettledCostMicros === 12133883 && snapshot.committedCostMicros === 27133883 &&
    checkpoint.state.files['fresh-spend.jsonl'].sha256 === pins.journal.sha256 &&
    checkpoint.state.files['fresh-spend.jsonl'].bytes === pins.journal.bytes &&
    checkpoint.state.files['run-authorization.json'].sha256 === pins.authorization.sha256);
  scope(snapshot.runs[key],['caseId','captureRunId','reservationId','ceilingMicros']);
  need(input.authorization.maxCostMicros === 30000000 && input.authorization.perCaseMaxCostMicros === 15000000 && input.authorization.concurrency === 1);
  for (const [ref,name] of [['captured-inputs.json','captured'],['blocked.json','blocked'],['saved-messages-observation.json','messages'],['stream-response-observation.json','stream']]) {
    const descriptor = input.manifest.artifacts.find(a=>a.ref === ref);
    need(descriptor?.sha256 === pins[name].sha256 && descriptor.bytes === pins[name].bytes);
  }
  need(post.kind === 'case20-postdeadline-owned-provider-budget-readback' && post.status === 'READBACK_CAPTURED' &&
    post.sessionRevoked === true && post.journalUnchanged === true && post.afterProviderDeadline === true &&
    post.captureAuthority === false && post.applicationWrites === 0 && post.modelSubmissions === 0 && post.journalMutations === 0 &&
    post.providerLedgerMatchesSignedReceipt === true && post.messagesReadAfterDeadline === false &&
    post.priorMessagesEvidence === 'RETAINED_PRE_DEADLINE_OBSERVATION_ONLY' &&
    post.priorExecutionSha256 === pins.execution.sha256 && post.priorMessagesObservationSha256 === pins.messages.sha256);
  scope(post,['captureRunId','conversationId','tenantId','userId']);
  need(post.reads.length === 2 && isDeepStrictEqual(post.reads,[me.observation,response.observation]));
  need(me.value.tenant.id === s.tenantId && me.value.user.id === s.userId && me.value.user.clerkUserId === actor.clerkUserId && me.value.role === actor.role);
  for (const [index,path] of ['/api/me',`/api/clio/conversations/${s.conversationId}`].entries())
    need(post.reads[index].path === path && post.reads[index].status === 200 && post.reads[index].apiReleaseSha === s.sourceSha);
  scope(response.value,['tenantId','userId','clientId']);
  need(response.value.id === s.conversationId && response.value.archivedAt === null);
  const state = response.value.metadata.serverCaptureProviderBudget, ledger = state.ledger, q = state.qualification;
  need(isDeepStrictEqual(state,post.providerBudget) && isDeepStrictEqual(state,input.earlierConversation.value.metadata.serverCaptureProviderBudget) &&
    sha256Stable(state) === s.providerStateSha256 && state.qualificationSha256 === sha256Stable(q));
  scope(state,['turnId','admissionId']); scope(q,['caseId','captureRunId']);
  need(state.version === 1 && state.policySha256 === sha256Stable({...c.policy,turnId:null}) && ledger.version === 1 && ledger.activation === 'enforced' &&
    q.maxCostMicros === s.ceilingMicros && ledger.limits.maxCostMicros === s.ceilingMicros &&
    q.maxTokens === ledger.limits.maxTokens && q.maxAttempts === ledger.limits.maxAttempts &&
    q.currentVerifySha256 === e.setupProof.currentVerifySha256 && state.qualificationSha256 === e.setupProof.qualificationSha256 &&
    q.rateEvidenceExpiresAt === original.qualificationExpiresAt);
  for (const value of [c.expected,c.admission,c.authority,c.policy,c.envelope.receipt,c.doneEnvelope.receipt])
    scope(value,['caseId','captureRunId','conversationId','tenantId','actorUserId','clientId']);
  need(isDeepStrictEqual(c.admission,{...input.admission.admission,issuedAt:c.admission.issuedAt,expiresAt:c.admission.expiresAt}) &&
    input.admission.admission.issuedAt <= c.admission.issuedAt && c.admission.issuedAt <= c.policy.issuedAt &&
    c.admission.expiresAt > c.policy.issuedAt && c.admission.status === 'READY' &&
    c.admission.apiReleaseSha === s.sourceSha && c.expected.apiSha === s.sourceSha && c.expected.orchestratorSha === s.sourceSha &&
    c.authority.messageId === s.assistantMessageId && c.expected.assistantMessageId === s.assistantMessageId);
  const receipt = c.envelope.receipt;
  for (const value of [c.authority,c.policy,receipt]) scope(value,['turnId','policyId','requestId','traceId']);
  need(isDeepStrictEqual(c.envelope,c.doneEnvelope) && sha256Stable(c.envelope) === c.authority.envelopeSha256 &&
    hash(c.answer) === c.authority.answerSha256 && c.envelope.purpose === 'server_capture_evidence' &&
    c.envelope.audience === 'capiro:meri:server-readonly-capture:evidence:v1' && /^[a-f0-9]{64}$/u.test(c.envelope.signature) &&
    receipt.status === 'BLOCKED' && receipt.blockers.length === 3 &&
    receipt.releases.api.releaseRevision.value === s.sourceSha && receipt.releases.orchestrator.releaseRevision.value === s.sourceSha);
  const signed = receipt.providerBudget;
  need(signed.status === 'SETTLED' && signed.boundary === 'case20_controlled_read_turn' && signed.ledgerSha256 === sha256Stable(state) &&
    signed.qualificationSha256 === state.qualificationSha256 && signed.turnId === state.turnId && signed.admissionId === state.admissionId &&
    signed.attempts === 2 && signed.chargedTokens === 59737 && signed.chargedCostMicros === 1497175 &&
    signed.maxCostMicros === s.ceilingMicros && isDeepStrictEqual(signed.unaccountedBoundaries,[]));
  // Saved HTTP observations redact keys containing "Token". Join identities and
  // signature only; raw numeric accounting comes exclusively from captured-inputs.
  need(input.messages.status === 200 && input.stream.status === 201 && input.messages.redacted === true && input.stream.redacted === true &&
    input.messages.releaseSha === s.sourceSha && input.stream.releaseSha === s.sourceSha &&
    input.messages.captureAuthority === false && input.stream.captureAuthority === false);
  const messages = JSON.parse(input.messages.text);
  need(messages.length === 2);
  for (const message of messages) scope(message,['conversationId','tenantId','userId','clientId']);
  const [user,assistant] = messages;
  need(user.id === s.turnId && user.role === 'user' && hash(user.content ?? user.body) === input.intent.promptSha256 &&
    assistant.id === s.assistantMessageId && assistant.role === 'assistant' &&
    assistant.metadata.serverCaptureEvidenceReceipt.signature === c.envelope.signature &&
    assistant.metadata.serverCaptureEvidenceReceipt.receipt.status === 'BLOCKED' &&
    assistant.metadata.controlledReadCaptureAuthority.envelopeSha256 === c.authority.envelopeSha256);
  const deadline = Date.parse(ledger.limits.deadlineAt), observed = Date.parse(response.observation.observedAt), completed = Date.parse(e.completedAt);
  need(deadline === Date.parse('2026-10-04T01:56:56.119Z') && deadline === c.policy.expiresAt && deadline === receipt.expiresAt &&
    observed > deadline && Date.parse(post.startedAt) > deadline && Date.parse(post.finishedAt) >= observed &&
    c.policy.issuedAt <= receipt.startedAt && receipt.startedAt <= receipt.completedAt && receipt.completedAt <= c.authority.verifiedAt &&
    c.authority.verifiedAt <= completed && completed < deadline && Date.parse(q.rateEvidenceExpiresAt) > deadline);
  let cost=0, tokens=0, inputTokens=0, outputTokens=0;
  need(ledger.attempts.length === 2 && new Set(ledger.attempts.map(a=>a.attemptId)).size === 2 && new Set(ledger.attempts.map(a=>a.reservationId)).size === 2);
  const price = (n,rate) => { need(Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(rate) && rate >= 0); return Number((BigInt(n)*BigInt(rate)+999999n)/1000000n); };
  for (const attempt of ledger.attempts) {
    const rates = q.rates.filter(r=>r.kind === attempt.kind && r.provider === attempt.provider && r.model === attempt.model);
    need(rates.length === 1 && attempt.status === 'settled' && attempt.priceKnown === true && attempt.runId === s.admissionId &&
      attempt.leaseEpoch === 1 && attempt.retryOfAttemptId === null && attempt.attemptId === attempt.logicalOperationId+':0' &&
      Date.parse(attempt.reservedAt) >= receipt.startedAt && Date.parse(attempt.settledAt) >= Date.parse(attempt.reservedAt) && Date.parse(attempt.settledAt) <= receipt.completedAt);
    const rate = rates[0], actual = price(attempt.actualInputTokens,rate.inputMicrosPerMillion)+price(attempt.actualOutputTokens,rate.outputMicrosPerMillion);
    need(actual === attempt.actualCostMicros && actual <= attempt.reservedCostMicros && attempt.reservedCostMicros === price(attempt.reservedInputTokens,rate.inputMicrosPerMillion)+price(attempt.reservedOutputTokens,rate.outputMicrosPerMillion));
    cost += actual; inputTokens += attempt.actualInputTokens; outputTokens += attempt.actualOutputTokens;
  }
  tokens=inputTokens+outputTokens;
  need(cost === 1497175 && tokens === 59737 && ledger.chargedCostMicros === cost && ledger.chargedTokens === tokens && ledger.chargedAttempts === 2 &&
    receipt.usage.inputTokens.status === 'OBSERVED' && receipt.usage.inputTokens.value === inputTokens &&
    receipt.usage.outputTokens.status === 'OBSERVED' && receipt.usage.outputTokens.value === outputTokens);
  return { caseId:s.caseId,captureRunId:s.captureRunId,reservationId:s.reservationId,conversationId:s.conversationId,
    chargedCostMicros:cost,providerTokens:tokens,providerAttempts:2,pendingProviderAttempts:0,
    ledgerSha256:sha256Stable(ledger),providerStateSha256:sha256Stable(state),
    providerDeadlineAtMs:deadline,observedAtMs:observed,executionCompletedAtMs:completed,
    evidenceSha256:sha256Stable(pins),journalBeforeSha256:pins.journal.sha256,
    disposition:'FAILED_CAPTURE_TERMINAL_PROVIDER_COST_RECONCILED',captureAuthority:false,
    answerGrade:'NOT_EVALUATED',captureStatus:'CAPTURE_UNCERTAIN',failure:e.outcome.reason };
}

function loadPinned() {
  const input = {};
  for (const [name,pin] of Object.entries(pins)) {
    const bytes=readFileSync(pin.path);
    need(bytes.length === pin.bytes && hash(bytes) === pin.sha256);
    if (pin.semanticSha256) input[name]=JSON.parse(bytes);
  }
  return input;
}
/** No network, auth, provider dispatch, grading, or journal mutation. */
export function prepareCase20TerminalCostAuthority() {
  const input=loadPinned(), proof=inspectCase20TerminalCost(input);
  const capability=Object.freeze({kind:'case20-terminal-provider-cost'});
  authorities.set(capability,{proof,checkpoint:input.checkpoint});
  return capability;
}
export function consumeCase20TerminalCostAuthority(capability) {
  const value=authorities.get(capability); need(value); authorities.delete(capability);
  const current=loadPinned(); need(isDeepStrictEqual(inspectCase20TerminalCost(current),value.proof) && isDeepStrictEqual(current.checkpoint,value.checkpoint));
  return structuredClone(value);
}
