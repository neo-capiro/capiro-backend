import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256Stable } from './lib/stable.mjs';

// This is a root-operated reconciliation of one recorded request, not a generic
// way to settle captures or accept caller-supplied successful/zero-cost receipts.
export const CASE01_TERMINAL_SCOPE = Object.freeze({
  caseId: '01', captureRunId: 'c6ffa5ad-dd9f-4912-bc31-a03231a9b903',
  conversationId: 'd7a74b15-873b-4256-a1d1-c6b4da3f8e1f',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  reservationId: 'd63fd741-aac6-4d3d-9c4d-1276b96bd1a3',
  sourceSha: '42988dae5fb7bc2fff3af582ca15a0836a4477c5',
  requestIdSha256: 'f6e630bcbdccc28db3a03c51ff58d90c14aa3588494df70063a55bb8f877a12c',
  traceIdSha256: '7f872a4fea09b9a19687d2b2d53d920fe2c8fed0d08ac4e92deb59da021352db',
  inventorySha256: '113c55d76637edfd807e5e3efced931e2b2dd73052dabba4d2e0607aff6e57b8',
});
export const CASE01_TERMINAL_EVIDENCE = Object.freeze({
  failedExecution: { file: 'case01-live-execution-aggregate-v7.json', sha256: 'c0c8e241fb5e902374610af57ea46da3f5b697aecc2b58e0a94903e4a8a16bb7' },
  terminalLog: { file: 'failed-case01-log-diagnosis-v2.json', sha256: 'c4d9d31fdf10db0a8e69e61837c9fdd39f4bbea2d12cf9ff25b63c1542bcf128' },
  authenticatedReadback: { file: 'case01-terminal-api-readback-v2.json', sha256: 'e8c2a5b1a7471e158be39914e5d21391a7ff1300dca4cf1e54868e8f92bf4cb6' },
  readbackOperator: { file: 'read-case01-terminal-state-v2.mjs', sha256: '8a7d5db96c83053af69158dd3b5b16f5f80695bc5fde6eb0465e22803d2ad804' },
});
const EVIDENCE_ROOT = 'C:/dev/cap-meri-foundation-evidence/oct02-original-aggregate-operator-v7';
const authorities = new WeakMap();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = condition => { if (!condition) throw new Error('CASE01_TERMINAL_RECONCILIATION_REJECTED'); };
const HASH = /^[a-f0-9]{64}$/u;

/** Pure comparison for regression tests. Its returned object grants no authority. */
export function inspectOriginalCase01TerminalEvidence({ failedExecution: failed, terminalLog: logs, authenticatedReadback: readback }) {
  const s = CASE01_TERMINAL_SCOPE, key = `01:${s.captureRunId}`;
  need(failed?.caseId === '01' && failed.captureRunId === s.captureRunId &&
    failed.conversationId === s.conversationId && failed.sourceSha === s.sourceSha &&
    failed.verdict === 'BLOCKED' && failed.failureCode === 'CASE01_RESPONSE_REJECTED' &&
    failed.sessionRevoked === true && failed.outcome?.status === 'CAPTURE_UNCERTAIN' &&
    failed.outcome.synthesisSubmissionCount === 1 && failed.maximumNewTurns === 1);
  const snapshot = failed.aggregateSnapshot;
  need(snapshot?.activeRun === key && snapshot.eventCount === 1 &&
    snapshot.reservedCeilingsMicros === 3000000 && snapshot.knownSettledCostMicros === 0 &&
    snapshot.remainingReservationMicros === 27000000 && snapshot.refundsAllowed === false &&
    Object.keys(snapshot.runs ?? {}).length === 1 && snapshot.runs[key]?.kind === 'reserve' &&
    snapshot.runs[key].reservationId === s.reservationId && snapshot.runs[key].ceilingMicros === 3000000);
  need(logs?.kind === 'case01-failed-http-readonly-log-diagnosis' &&
    logs.conversationSha256 === hash(s.conversationId));
  const apis = logs.services?.filter(row => row.service === 'api');
  need(apis?.length === 1 && apis[0].sourceSha === s.sourceSha &&
    apis[0].taskDefinition === 'arn:aws:ecs:us-east-1:967807252336:task-definition/capiro-dev-api:507');
  const received = apis[0].events.filter(row => row.name === 'meri.api.request.received');
  const finalized = apis[0].events.filter(row => row.name === 'meri.api.request.finalized');
  const guards = apis[0].events.filter(row => row.knownStaticReasons?.includes('meri_capture_provider_budget_unqualified_retrieval_plan'));
  need(received.length === 1 && finalized.length === 1 && guards.length === 1);
  for (const event of [...received, ...finalized]) need(event.requestIdSha256 === s.requestIdSha256 &&
    event.traceIdSha256 === s.traceIdSha256 && HASH.test(event.eventSha256) && HASH.test(event.streamSha256));
  need(finalized[0].outcome === 'error' && finalized[0].atMs >= received[0].atMs &&
    guards[0].atMs === finalized[0].atMs && guards[0].streamSha256 === finalized[0].streamSha256 &&
    guards[0].safeCodes?.includes('MERI_STREAM_SETUP_ERROR'));
  need(readback?.kind === 'meri-original01-terminal-owned-api-readback' && readback.status === 'READBACK_CAPTURED' &&
    readback.priorExecutionSha256 === CASE01_TERMINAL_EVIDENCE.failedExecution.sha256 &&
    readback.applicationWrites === 0 && readback.modelSubmissions === 0 && readback.sessionRevoked === true);
  for (const field of ['captureRunId', 'conversationId', 'tenantId', 'userId', 'clientId']) need(readback[field] === s[field]);
  need(readback.apiSourceSha === s.sourceSha && readback.conversation?.id === s.conversationId &&
    readback.conversation.clientId === s.clientId && readback.conversation.archivedAt === null);
  need(readback.reads?.length === 2);
  for (const [index, suffix] of ['', '/messages'].entries()) {
    const response = readback.reads[index];
    need(response.path === `/api/clio/conversations/${s.conversationId}${suffix}` && response.status === 200 &&
      response.apiReleaseSha === s.sourceSha && HASH.test(response.bodySha256));
  }
  need(readback.messageCount === 0 && isDeepStrictEqual(readback.messageRoles, []) &&
    readback.reads[1].bodySha256 === hash('[]'));
  const state = readback.budget, ledger = state?.ledger, q = state?.qualification;
  need(state?.version === 1 && state.turnId === null &&
    state.admissionId === '1c760bd8-19a1-4b00-9941-7927453352c9' &&
    state.policySha256 === 'a64fab12315db35ff5da5a777fa2aa15dff05f0ae4bcb35dcd21efbbaf0181b0' &&
    state.qualificationSha256 === sha256Stable(q) &&
    state.qualificationSha256 === 'f5c7e845fb9a45d99055387e3b47fceb9c6c9f0d3ec5771bfe3ad427abb64faf');
  need(q?.caseId === '01' && q.captureRunId === s.captureRunId && q.maxCostMicros === 3000000 &&
    ledger?.version === 1 && ledger.activation === 'enforced' && isDeepStrictEqual(ledger.attempts, []) &&
    ledger.chargedAttempts === 0 && ledger.chargedTokens === 0 && ledger.chargedCostMicros === 0 &&
    ledger.limits?.maxCostMicros === 3000000 && ledger.limits.maxAttempts === q.maxAttempts &&
    ledger.limits.maxTokens === q.maxTokens);
  const readbackAtMs = Date.parse(readback.observedAt), providerDeadlineAtMs = Date.parse(ledger.limits.deadlineAt);
  need(Number.isFinite(readbackAtMs) && readbackAtMs >= finalized[0].atMs && Number.isFinite(providerDeadlineAtMs));
  // Positive finalized-error telemetry plus the source guard's synchronous throw
  // before retrieval and current zero-attempt/null-turn owner readback establish
  // termination. Missing orchestrator events alone are intentionally not used.
  return { failedExecutionSha256: CASE01_TERMINAL_EVIDENCE.failedExecution.sha256,
    terminalLogSha256: CASE01_TERMINAL_EVIDENCE.terminalLog.sha256,
    authenticatedReadbackSha256: CASE01_TERMINAL_EVIDENCE.authenticatedReadback.sha256,
    requestIdSha256: s.requestIdSha256, ledgerSha256: sha256Stable(ledger),
    finalizedAtMs: finalized[0].atMs, readbackAtMs, providerDeadlineAtMs,
    turnId: null, providerAttempts: [], pendingProviderAttempts: 0, messageCount: 0,
    requestOutcome: 'error', failureReason: 'meri_capture_provider_budget_unqualified_retrieval_plan' };
}

/** Reads only the four exact already-reviewed artifacts. No credentials/network.
 * Root owns these files and invocation; this does not defend against root editing
 * this source. A caller-authored object or copied JSON cannot create authority. */
export function prepareOriginalCase01TerminalClosure() {
  const inputs = {};
  for (const [key, descriptor] of Object.entries(CASE01_TERMINAL_EVIDENCE)) {
    const bytes = readFileSync(`${EVIDENCE_ROOT}/${descriptor.file}`);
    need(hash(bytes) === descriptor.sha256);
    if (key !== 'readbackOperator') inputs[key] = JSON.parse(bytes.toString('utf8'));
  }
  const proof = inspectOriginalCase01TerminalEvidence(inputs);
  proof.reconciliationSha256 = sha256Stable({ kind: 'original01-terminal-cost-unknown', proof,
    scope: CASE01_TERMINAL_SCOPE, evidence: CASE01_TERMINAL_EVIDENCE });
  const capability = Object.freeze({ kind: 'original01-terminal-uncertain-closure' });
  authorities.set(capability, structuredClone(proof));
  return capability;
}

export function currentOriginalCase01TerminalClosure(capability) {
  const proof = authorities.get(capability);
  need(proof);
  return structuredClone(proof);
}
