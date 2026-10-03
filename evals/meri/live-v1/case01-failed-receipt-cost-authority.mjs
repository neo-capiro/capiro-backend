import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256Stable } from './lib/stable.mjs';
import { CASE01_FAILED_RECEIPT_COST_PINS as pins } from './case01-failed-receipt-cost-pins.mjs';

const authorities = new WeakMap();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const need = (ok) => { if (!ok) throw new Error('CASE01_FAILED_RECEIPT_COST_REJECTED'); };
export const CASE01_FAILED_RECEIPT_COST_SCOPE = Object.freeze({
  caseId: '01', captureRunId: 'bd35c0f4-1604-4371-b7e9-a1338369e53f',
  reservationId: 'cf7ea1df-6996-4d29-a5d5-b98db9c85c61', ceilingMicros: 15000000,
  conversationId: 'f493355c-ee97-44a1-a0b0-e05e7b104b59',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f', userId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  turnId: '8c8e1c76-c7b2-4c98-9fc4-ac433be980a0', assistantMessageId: '71395f9b-92e4-47aa-8b9c-ed908a5127b1',
  sourceSha: '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642',
  orchestratorSha: 'fb17c7ebfa010ce964919068f61830cb78ca620d',
});

/** Pure regression predicate. Returned data alone grants no mutation authority. */
export function inspectCase01FailedReceiptCost(input) {
  const s = CASE01_FAILED_RECEIPT_COST_SCOPE;
  const { execution: e, stream, database: db, databaseCleanup: cleanup, postdeadline: post,
    postdeadlineMe: me, postdeadlineConversation: response, checkpoint } = input;
  need(e?.caseId === s.caseId && e.captureRunId === s.captureRunId && e.conversationId === s.conversationId &&
    e.sourceSha === s.sourceSha && e.orchestratorSha === s.orchestratorSha && e.verdict === 'BLOCKED' &&
    e.executionAttempted === true && e.sessionRevoked === true && e.originalEvidencePreserved === true &&
    e.newReservationAttempted === false && e.conversationCreationAttempted === false &&
    e.browserApplicationWrites === 0 && e.maximumNewTurns === 1 && e.automaticPaidRetryAllowed === false &&
    e.outcome?.status === 'CAPTURE_UNCERTAIN' && e.outcome.synthesisSubmissionCount === 1);
  need(stream?.status === 201 && stream.releaseSha === s.sourceSha && stream.captureAuthority === false &&
    hash(stream.text) === stream.bodySha256 && Buffer.byteLength(stream.text) === stream.bodyBytes);
  const events = stream.text.trim().split(/\n\n/u).map(line => {
    need(line.startsWith('data: ')); return JSON.parse(line.slice(6));
  });
  need(events.length === 15 && events.slice(0, -2).every(x => x.type === 'progress' && x.accepted === false));
  need(isDeepStrictEqual(events.at(-2), { type: 'error', code: 'MERI_STREAM_SETUP_ERROR',
    message: 'meri_capture_receipt_readback_mismatch', accepted: false }) &&
    isDeepStrictEqual(events.at(-1), { type: 'done' }));
  need(db?.status === 'READ_ONLY_RAW_AND_PRISMA_DIAGNOSTIC' && db.acceptanceAuthority === false &&
    db.businessWrites === 0 && db.providerCalls === 0 && db.readOnlyTransaction === true && db.sourceSha === s.sourceSha);
  need(cleanup?.cleanupComplete === true && cleanup.taskStopped === true && cleanup.status === 'INACTIVE' &&
    isDeepStrictEqual(cleanup.cleanupErrors, []));
  for (const field of ['captureRunId','conversationId','tenantId','userId','clientId','turnId']) need(db[field] === s[field]);
  need(db.ormMessages?.length === 2 && db.rawMessages?.length === 2);
  const [user, assistant] = db.ormMessages;
  for (const message of db.ormMessages) {
    for (const field of ['conversationId','tenantId','userId','clientId']) need(message[field] === s[field]);
    const raw = db.rawMessages.find(row => row.id === message.id);
    need(raw && isDeepStrictEqual(JSON.parse(raw.metadata_text), message.metadata));
  }
  need(user.id === s.turnId && user.role === 'user' &&
    hash(user.body) === '9d516d7276e3a2de959def23af9e09e76adc5ae361eba13334ede4e9c031cb42');
  need(assistant.id === s.assistantMessageId && assistant.role === 'assistant' && assistant.body.length > 0 &&
    !assistant.metadata.serverCaptureEvidenceReceipt && !assistant.metadata.serverReadonlyCapturePolicy);
  const dispatch = assistant.metadata.serverReadonlyCaptureReceipt;
  need(dispatch?.authority === 'server_current' && dispatch.dispatchBoundary === 'read_only_enforced' &&
    dispatch.incidentalWriters === 'suppressed' && dispatch.dynamicMcpAllowed === false &&
    dispatch.policyId === 'ac809efc-4ccb-45db-bfda-fb3549221bfb');
  for (const field of ['conversationId','tenantId','clientId']) need(dispatch[field] === s[field]);
  need(dispatch.actorUserId === s.userId);
  need(post?.kind === 'case01-postdeadline-owned-provider-budget-readback' && post.status === 'READBACK_CAPTURED' &&
    post.sessionRevoked === true && post.journalUnchanged === true && post.providerBudgetUnchanged === true &&
    post.afterProviderDeadline === true && post.captureAuthority === false && post.applicationWrites === 0 && post.modelSubmissions === 0 &&
    post.priorDiagnosticSha256 === pins.database.sha256);
  for (const field of ['captureRunId','conversationId','tenantId','userId']) need(post[field] === s[field]);
  need(post.reads?.length === 2 && isDeepStrictEqual(post.reads[0], me.observation) && isDeepStrictEqual(post.reads[1], response.observation));
  need(me.value.tenant?.id === s.tenantId && me.value.user?.id === s.userId && me.value.role === 'standard_user');
  for (const [index, path] of ['/api/me', `/api/clio/conversations/${s.conversationId}`].entries())
    need(post.reads[index].path === path && post.reads[index].status === 200 && post.reads[index].apiReleaseSha === s.sourceSha);
  need(isDeepStrictEqual(post.conversation, response.value) && post.conversation.archivedAt === null);
  for (const conversation of [db.conversation, post.conversation]) {
    need(conversation.id === s.conversationId);
    for (const field of ['tenantId','userId','clientId']) need(conversation[field] === s[field]);
  }
  const state = post.conversation.metadata.serverCaptureProviderBudget, ledger = state.ledger, q = state.qualification;
  need(isDeepStrictEqual(state, db.conversation.metadata.serverCaptureProviderBudget) &&
    sha256Stable(state) === '134637a3196af3b91c53ced6af4b6103e8c6b9d962254ba46c5858c376c5d011');
  need(state.turnId === s.turnId && state.admissionId === '42ee50b8-7a16-4b04-af18-2f8fb7e82b3d' &&
    state.qualificationSha256 === sha256Stable(q) && q.captureRunId === s.captureRunId && q.caseId === s.caseId &&
    q.maxCostMicros === s.ceilingMicros && ledger.limits.maxCostMicros === s.ceilingMicros && ledger.activation === 'enforced');
  const deadline = Date.parse(ledger.limits.deadlineAt), observed = Date.parse(post.reads[1].observedAt), completed = Date.parse(e.completedAt);
  need(deadline === dispatch.expiresAt && deadline === Date.parse('2026-10-03T22:57:18.896Z') &&
    observed > deadline && completed < deadline && Date.parse(db.observedAt) >= completed &&
    Date.parse(post.finishedAt) >= observed);
  let cost = 0, tokens = 0;
  need(ledger.attempts.length === 5 && new Set(ledger.attempts.map(a => a.attemptId)).size === 5 &&
    new Set(ledger.attempts.map(a => a.reservationId)).size === 5);
  const price = (count, rate) => { need(Number.isSafeInteger(count) && count >= 0); return Number((BigInt(count) * BigInt(rate) + 999999n) / 1000000n); };
  for (const a of ledger.attempts) {
    const rates = q.rates.filter(r => r.kind === a.kind && r.provider === a.provider && r.model === a.model);
    need(rates.length === 1 && a.status === 'settled' && a.priceKnown === true && a.runId === state.admissionId &&
      a.leaseEpoch === 1 && a.retryOfAttemptId === null && Date.parse(a.reservedAt) >= dispatch.issuedAt &&
      Date.parse(a.settledAt) >= Date.parse(a.reservedAt) && Date.parse(a.settledAt) <= completed);
    const r = rates[0], actual = price(a.actualInputTokens, r.inputMicrosPerMillion) + price(a.actualOutputTokens, r.outputMicrosPerMillion);
    need(actual === a.actualCostMicros && actual <= a.reservedCostMicros &&
      a.reservedCostMicros === price(a.reservedInputTokens, r.inputMicrosPerMillion) + price(a.reservedOutputTokens, r.outputMicrosPerMillion));
    cost += actual; tokens += a.actualInputTokens + a.actualOutputTokens;
  }
  need(cost === 2292602 && tokens === 90733 && ledger.chargedCostMicros === cost && ledger.chargedTokens === tokens && ledger.chargedAttempts === 5);
  const key = `01:${s.captureRunId}`, snapshot = checkpoint?.snapshot;
  need(checkpoint.kind === 'meri-fresh-capture-spend-checkpoint' && snapshot.eventCount === 21 && snapshot.activeRun === key &&
    snapshot.runs[key].reservationId === s.reservationId && snapshot.runs[key].ceilingMicros === s.ceilingMicros &&
    snapshot.knownSettledCostMicros === 9841281 && checkpoint.state.files['fresh-spend.jsonl'].sha256 === pins.journal.sha256);
  return {
    caseId: s.caseId, captureRunId: s.captureRunId, reservationId: s.reservationId,
    conversationId: s.conversationId, chargedCostMicros: cost, providerTokens: tokens, providerAttempts: 5,
    pendingProviderAttempts: 0, ledgerSha256: sha256Stable(ledger), providerStateSha256: sha256Stable(state),
    providerDeadlineAtMs: deadline, observedAtMs: observed, executionCompletedAtMs: completed,
    evidenceSha256: sha256Stable(pins), journalBeforeSha256: pins.journal.sha256,
    disposition: 'FAILED_CAPTURE_TERMINAL_PROVIDER_COST_RECONCILED', captureAuthority: false,
    answerGrade: 'NOT_EVALUATED', captureStatus: 'CAPTURE_UNCERTAIN',
    failure: 'meri_capture_receipt_readback_mismatch',
  };
}

function loadPinned() {
  const input = {};
  for (const [name, descriptor] of Object.entries(pins)) {
    const bytes = readFileSync(descriptor.path);
    need(bytes.length === descriptor.bytes && hash(bytes) === descriptor.sha256);
    if (!['history','journal','databaseOperator','databaseInner','postdeadlineOperator','authHelper'].includes(name)) input[name] = JSON.parse(bytes);
  }
  return input;
}

/** Exact retained observations only. No network, new auth, dispatch, or answer grading. */
export function prepareCase01FailedReceiptCostAuthority() {
  const input = loadPinned(), proof = inspectCase01FailedReceiptCost(input);
  const capability = Object.freeze({ kind: 'case01-failed-receipt-terminal-cost' });
  authorities.set(capability, { proof, checkpoint: input.checkpoint });
  return capability;
}

export function consumeCase01FailedReceiptCostAuthority(capability) {
  const value = authorities.get(capability); need(value); authorities.delete(capability);
  const current = loadPinned(); need(isDeepStrictEqual(inspectCase01FailedReceiptCost(current), value.proof));
  need(isDeepStrictEqual(current.checkpoint, value.checkpoint));
  return structuredClone(value);
}
