// Draft bounded cost-only proof. Mirror of Case01 pattern, intentionally stricter
// for Case20. This module does not grade, retry, or create capture authority.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256Stable } from './lib/stable.mjs';
import { CASE20_TERMINAL_COST_PINS as pins, CASE20_TERMINAL_COST_EXPECTED as s,
  CASE20_TERMINAL_COST_PINS_READY } from './case20-terminal-cost-pins.mjs';

const authorities = new WeakMap();
const need = (ok) => { if (!ok) throw new Error('CASE20_TERMINAL_COST_REJECTED'); };
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Pure assertion over retained observations; caller-provided objects are never authority. */
export function inspectCase20TerminalCost(input) {
  const { execution: e, checkpoint, readback: post, me, conversation: response } = input;
  need(e?.caseId === s.caseId && e.captureRunId === s.captureRunId && e.conversationId === s.conversationId);
  need(e.verdict === 'BLOCKED' && e.executionAttempted === true && e.sessionRevoked === true &&
    e.originalEvidencePreserved === true && e.newReservationAttempted === false &&
    e.conversationCreationAttempted === false && e.browserApplicationWrites === 0 &&
    e.maximumNewTurns === 1 && e.automaticPaidRetryAllowed === false &&
    e.outcome?.status === 'CAPTURE_UNCERTAIN' && e.outcome.acceptanceStatus === 'NOT_RUN' &&
    e.outcome.synthesisSubmissionCount === 1);
  need(e.restoredReservation?.caseId === s.caseId && e.restoredReservation.captureRunId === s.captureRunId &&
    e.restoredReservation.reservationId === s.reservationId && e.restoredReservation.ceilingMicros === s.ceilingMicros);
  need(checkpoint?.kind === 'meri-fresh-capture-spend-checkpoint' && checkpoint.snapshot?.protocolVersion === 3 &&
    checkpoint.snapshot.eventCount === 23 && checkpoint.snapshot.activeRun === `${s.caseId}:${s.captureRunId}` &&
    checkpoint.snapshot.knownSettledCostMicros === s.knownSettledBeforeMicros &&
    checkpoint.state?.files?.['fresh-spend.jsonl']?.sha256 === s.preAppendJournalSha256 &&
    checkpoint.snapshot.runs?.[`${s.caseId}:${s.captureRunId}`]?.reservationId === s.reservationId &&
    checkpoint.snapshot.runs[`${s.caseId}:${s.captureRunId}`]?.ceilingMicros === s.ceilingMicros);
  need(post?.kind === 'case20-postdeadline-owned-provider-budget-readback' && post.status === 'READBACK_CAPTURED' &&
    post.sessionRevoked === true && post.journalUnchanged === true && post.afterProviderDeadline === true &&
    post.captureAuthority === false && post.applicationWrites === 0 && post.modelSubmissions === 0 &&
    post.providerLedgerMatchesSignedReceipt === true && post.messagesReadAfterDeadline === false &&
    post.priorExecutionSha256 && post.priorMessagesObservationSha256);
  need(post.captureRunId === s.captureRunId && post.conversationId === s.conversationId &&
    post.providerBudget?.ledger?.limits?.maxCostMicros === s.ceilingMicros &&
    post.providerBudget.ledger.activation === 'enforced' &&
    post.providerBudget.ledger.chargedCostMicros === s.chargedCostMicros &&
    post.providerBudget.ledger.chargedTokens === s.chargedTokens &&
    post.providerBudget.ledger.chargedAttempts === s.settledAttempts &&
    post.providerBudget.ledger.attempts?.length === s.settledAttempts);
  need(isDeepStrictEqual(post.reads?.[0], me.observation) && isDeepStrictEqual(post.reads?.[1], response.observation));
  need(me.observation.path === '/api/me' && me.observation.status === 200 &&
    response.observation.path === `/api/clio/conversations/${s.conversationId}` && response.observation.status === 200);
  const state = response.value?.metadata?.serverCaptureProviderBudget;
  need(state && isDeepStrictEqual(state, post.providerBudget) && sha256Stable(state) === s.wholeProviderStateSha256);
  const ledger = state.ledger, q = state.qualification;
  need(state.admissionId === ledger.attempts[0].runId && state.turnId && state.version === 1 &&
    state.qualificationSha256 === sha256Stable(q) && q.caseId === s.caseId && q.captureRunId === s.captureRunId &&
    q.maxCostMicros === s.ceilingMicros && ledger.limits.maxCostMicros === s.ceilingMicros &&
    ledger.limits.deadlineAt === '2026-10-04T01:56:56.119Z');
  let cost = 0, tokens = 0;
  need(new Set(ledger.attempts.map(a => a.attemptId)).size === s.settledAttempts &&
    new Set(ledger.attempts.map(a => a.reservationId)).size === s.settledAttempts);
  for (const a of ledger.attempts) {
    const rates = q.rates.filter(r => r.kind === a.kind && r.provider === a.provider && r.model === a.model);
    need(rates.length === 1 && a.status === 'settled' && a.priceKnown === true &&
      a.runId === state.admissionId && a.leaseEpoch === 1 && a.retryOfAttemptId === null);
    const r = rates[0];
    const price = (n, rate) => {
      need(Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(rate) && rate >= 0);
      return Number((BigInt(n) * BigInt(rate) + 999999n) / 1000000n);
    };
    const actual = price(a.actualInputTokens, r.inputMicrosPerMillion) + price(a.actualOutputTokens, r.outputMicrosPerMillion);
    const reserved = price(a.reservedInputTokens, r.inputMicrosPerMillion) + price(a.reservedOutputTokens, r.outputMicrosPerMillion);
    need(actual === a.actualCostMicros && actual <= a.reservedCostMicros && reserved === a.reservedCostMicros &&
      Date.parse(a.settledAt) >= Date.parse(a.reservedAt));
    cost += actual; tokens += a.actualInputTokens + a.actualOutputTokens;
  }
  need(cost === s.chargedCostMicros && tokens === s.chargedTokens &&
    ledger.chargedCostMicros === cost && ledger.chargedTokens === tokens && ledger.chargedAttempts === s.settledAttempts);
  const observed = Date.parse(post.reads[1].observedAt), deadline = Date.parse(ledger.limits.deadlineAt), completed = Date.parse(e.completedAt);
  need(observed > deadline && completed < deadline && Date.parse(post.finishedAt) >= observed &&
    post.afterProviderDeadline === true);
  return Object.freeze({ caseId: s.caseId, captureRunId: s.captureRunId, reservationId: s.reservationId,
    chargedCostMicros: cost, providerTokens: tokens, providerAttempts: s.settledAttempts,
    pendingProviderAttempts: 0, providerStateSha256: sha256Stable(state), journalBeforeSha256: s.preAppendJournalSha256,
    disposition: 'FAILED_CAPTURE_TERMINAL_PROVIDER_COST_RECONCILED', captureAuthority: false,
    answerGrade: 'NOT_EVALUATED', captureStatus: 'CAPTURE_UNCERTAIN' });
}

function loadPinned() {
  need(CASE20_TERMINAL_COST_PINS_READY === true);
  const input = {};
  for (const [name, d] of Object.entries(pins)) {
    need(Number.isSafeInteger(d.bytes) && /^[a-f0-9]{64}$/.test(d.sha256));
    const bytes = readFileSync(d.path);
    need(bytes.length === d.bytes && hash(bytes) === d.sha256);
    if (name === 'journal') input.journalSha256 = hash(bytes);
    else input[name] = JSON.parse(bytes);
  }
  need(input.journalSha256 === s.preAppendJournalSha256 &&
    input.checkpoint?.state?.files?.['fresh-spend.jsonl']?.sha256 === s.preAppendJournalSha256);
  return input;
}

/** One-shot private capability. Not exported as a ledger/adoption/settlement primitive. */
export function prepareCase20TerminalCostAuthority() {
  const input = loadPinned();
  const proof = inspectCase20TerminalCost(input);
  const capability = Object.freeze({ kind: 'case20-terminal-provider-cost' });
  authorities.set(capability, proof);
  return capability;
}
export function consumeCase20TerminalCostAuthority(capability) {
  const proof = authorities.get(capability); need(proof); authorities.delete(capability);
  const current = inspectCase20TerminalCost(loadPinned());
  need(isDeepStrictEqual(current, proof));
  return structuredClone(proof);
}
// Numeric receipt fields, if redacted in captured source evidence, are never
// compared to a raw receipt. A BLOCKED source execution remains non-acceptance.
