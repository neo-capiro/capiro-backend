import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { sha256Stable } from './lib/stable.mjs';
import { AUTHORIZED_TENANTS, FIXTURE_NAMESPACE } from './fixture-provisioning/contract.mjs';

const authorities = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const CASES = new Set(['01', '14', '20', '26', '27', '72']);
const need = value => { if (!value) throw new Error('CAPTURE_SPEND_TERMINAL_UNVERIFIED'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;

/** Budget disposition only, independent of answer quality, citations, or capture
 * PASS. Pure comparison grants no authority and accepts no local cost estimate. */
export function inspectCaptureSpendTerminalReadback(readback, expected, now = Date.now()) {
  need(CASES.has(expected.caseId) && /^[a-f0-9]{40}$/u.test(expected.apiSourceSha));
  for (const key of ['captureRunId', 'conversationId', 'userId', 'clientId', 'reservationId'])
    need(UUID.test(expected[key]));
  need(Object.values(AUTHORIZED_TENANTS).some(t => t.id === expected.tenantId) &&
    HASH.test(expected.promptSha256) && HASH.test(expected.priorExecutionSha256) &&
    integer(expected.ceilingMicros) && expected.ceilingMicros > 0 && expected.ceilingMicros <= 15000000);
  need(['meri-original01-terminal-owned-api-readback', 'meri-capture-terminal-owned-api-readback'].includes(readback?.kind) &&
    readback.status === 'READBACK_CAPTURED' && readback.applicationWrites === 0 &&
    readback.modelSubmissions === 0 && readback.sessionRevoked === true &&
    readback.apiSourceSha === expected.apiSourceSha &&
    readback.priorExecutionSha256 === expected.priorExecutionSha256);
  for (const key of ['captureRunId', 'conversationId', 'tenantId', 'userId', 'clientId'])
    need(readback[key] === expected[key]);
  need(readback.conversation?.id === expected.conversationId &&
    readback.conversation.clientId === expected.clientId && readback.conversation.archivedAt === null);
  const observedAtMs = Date.parse(readback.observedAt);
  need(Number.isSafeInteger(observedAtMs) && observedAtMs <= now + 30000 && now - observedAtMs <= 3600000);
  need(readback.reads?.length === 2);
  for (const [i, suffix] of ['', '/messages'].entries()) {
    const row = readback.reads[i];
    need(row.path === `/api/clio/conversations/${expected.conversationId}${suffix}` &&
      row.status === 200 && row.apiReleaseSha === expected.apiSourceSha && HASH.test(row.bodySha256));
  }
  need(readback.messageCount === 2 && readback.messages?.length === 2);
  const messages = readback.messages, user = messages.find(m => m.role === 'user'), assistant = messages.find(m => m.role === 'assistant');
  need(user && assistant && user.id !== assistant.id && hash(user.body) === expected.promptSha256);
  for (const row of messages) {
    need(UUID.test(row.id) && typeof row.body === 'string' && row.bodySha256 === hash(row.body));
    for (const key of ['conversationId', 'tenantId', 'userId', 'clientId']) need(row[key] === expected[key]);
  }
  const metadata = assistant.metadata, policy = metadata?.serverReadonlyCapturePolicy,
    envelope = metadata?.serverCaptureEvidenceReceipt, receipt = envelope?.receipt,
    state = readback.budget, ledger = state?.ledger, q = state?.qualification;
  need(['stop', 'runtime_error', 'aborted', 'deadline_exceeded', 'length', 'content_filter'].includes(metadata?.finishReason));
  need(policy?.version === 1 && policy.kind === 'server_readonly_acceptance_capture' &&
    !policy.syntheticReadBudget && policy.fixtureNamespace === FIXTURE_NAMESPACE &&
    policy.dynamicMcpAllowed === false && policy.incidentalWriters === 'suppressed' &&
    policy.toolAuthority === 'shared_static_registry_read_only');
  for (const key of ['caseId', 'captureRunId', 'conversationId', 'tenantId', 'clientId'])
    need(policy[key] === expected[key] && receipt?.[key] === expected[key]);
  need(policy.actorUserId === expected.userId && receipt.actorUserId === expected.userId &&
    policy.turnId === user.id && receipt.turnId === user.id && receipt.policyId === policy.policyId &&
    receipt.requestId === policy.requestId && receipt.traceId === policy.traceId &&
    envelope.purpose === 'server_capture_evidence' && envelope.version === 1 && HASH.test(envelope.signature) &&
    receipt.kind === 'server_capture_evidence_receipt' && receipt.version === 1 &&
    receipt.releases?.api?.releaseRevision?.value === expected.apiSourceSha &&
    integer(receipt.completedAt) && receipt.completedAt >= receipt.startedAt && receipt.completedAt <= observedAtMs);
  need(state?.version === 1 && state.turnId === user.id && UUID.test(state.admissionId) &&
    state.policySha256 === sha256Stable({ ...policy, turnId: null }) &&
    state.qualificationSha256 === sha256Stable(q) && q?.version === 1 &&
    q.caseId === expected.caseId && q.captureRunId === expected.captureRunId &&
    q.priceKind === 'qualified_text_token_upper_bound' && q.maxCostMicros === expected.ceilingMicros &&
    HASH.test(q.rateEvidenceSha256) && Array.isArray(q.rates) &&
    ledger?.version === 1 && ledger.activation === 'enforced' && ledger.attempts?.length > 0 &&
    ledger.chargedAttempts === ledger.attempts.length && ledger.limits.maxCostMicros === q.maxCostMicros &&
    ledger.limits.maxTokens === q.maxTokens && ledger.limits.maxAttempts === q.maxAttempts &&
    ledger.limits.deadlineAt === new Date(policy.expiresAt).toISOString());
  let cost = 0, tokens = 0, uncertain = false;
  const attemptIds = new Set();
  for (const a of ledger.attempts) {
    need(a.runId === state.admissionId && a.leaseEpoch === 1 && a.priceKnown === true &&
      UUID.test(a.attemptId) && !attemptIds.has(a.attemptId));
    attemptIds.add(a.attemptId);
    // Reserved/inflight attempts cannot be closed by an answer or elapsed timer.
    need(['settled', 'rejected', 'uncertain'].includes(a.status));
    const rates = q.rates.filter(r => r.kind === a.kind && r.provider === a.provider && r.model === a.model);
    need(rates.length === 1 && integer(rates[0].inputMicrosPerMillion) && integer(rates[0].outputMicrosPerMillion));
    const price = (input, output) => Math.max(1, Math.ceil((input * rates[0].inputMicrosPerMillion + output * rates[0].outputMicrosPerMillion) / 1000000));
    need(integer(a.reservedInputTokens) && integer(a.reservedOutputTokens) &&
      a.reservedCostMicros === price(a.reservedInputTokens, a.reservedOutputTokens));
    if (a.status === 'uncertain') {
      need(a.actualCostMicros === null && policy.expiresAt <= observedAtMs);
      uncertain = true; cost += a.reservedCostMicros; tokens += a.reservedInputTokens + a.reservedOutputTokens;
    } else {
      need(integer(a.actualInputTokens) && integer(a.actualOutputTokens) && integer(a.actualCostMicros) &&
        a.actualInputTokens <= a.reservedInputTokens && a.actualOutputTokens <= a.reservedOutputTokens &&
        a.actualCostMicros === (a.status === 'rejected' ? 0 : price(a.actualInputTokens, a.actualOutputTokens)) &&
        Date.parse(a.settledAt) <= receipt.completedAt);
      if (a.status === 'rejected') need(a.actualInputTokens === 0 && a.actualOutputTokens === 0);
      cost += a.actualCostMicros; tokens += a.actualInputTokens + a.actualOutputTokens;
    }
  }
  const usage = receipt.providerBudget;
  need(cost === ledger.chargedCostMicros && tokens === ledger.chargedTokens &&
    cost <= q.maxCostMicros && tokens <= q.maxTokens && ledger.attempts.length <= q.maxAttempts &&
    usage?.version === 1 && usage.status === (uncertain ? 'UNSETTLED' : 'SETTLED') &&
    usage.admissionId === state.admissionId && usage.turnId === user.id &&
    usage.ledgerSha256 === sha256Stable(state) && usage.qualificationSha256 === state.qualificationSha256 &&
    usage.chargedCostMicros === cost && usage.chargedTokens === tokens && usage.attempts === ledger.attempts.length &&
    usage.maxCostMicros === expected.ceilingMicros && usage.unaccountedBoundaries?.length === 0);
  return { ...expected, disposition: uncertain ? 'COST_UNKNOWN' : 'SETTLED',
    chargedCostMicros: uncertain ? null : cost, ledgerSha256: sha256Stable(state),
    envelopeSha256: sha256Stable(envelope), completedAtMs: receipt.completedAt,
    observedAtMs, providerDeadlineAtMs: policy.expiresAt, pendingProviderAttempts: 0,
    providerAttempts: ledger.attempts.length, answerGrade: 'NOT_EVALUATED' };
}

/** Root explicitly supplies the hash of a readback it independently reviewed
 * as actual authenticated API output. This is operator trust, not a cryptographic
 * claim that arbitrary local JSON authenticates itself. Bytes are read once.
 * No network, credentials, application mutation, PASS grade or retry is here. */
export function prepareReviewedCaptureSpendReconciliation({ readbackPath, readbackSha256, expected, invocation }) {
  need(invocation === 'PREPARE_ROOT_REVIEWED_TERMINAL_SPEND' && isAbsolute(readbackPath) && HASH.test(readbackSha256));
  const bytes = readFileSync(readbackPath);
  need(hash(bytes) === readbackSha256);
  const proof = { ...inspectCaptureSpendTerminalReadback(JSON.parse(bytes.toString('utf8')), structuredClone(expected)), readbackSha256 };
  const capability = Object.freeze({ kind: 'reviewed_terminal_spend_reconciliation' });
  authorities.set(capability, proof);
  return capability;
}
export function currentReviewedCaptureSpendReconciliation(capability) {
  const proof = authorities.get(capability); need(proof); return structuredClone(proof);
}
