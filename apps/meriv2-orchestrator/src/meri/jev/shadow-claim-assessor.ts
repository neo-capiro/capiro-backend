import { randomUUID } from 'node:crypto';
import type { MeriCitation } from '@capiro/shared';
import {
  DEFAULT_HIGH_RISK_CATEGORIES,
  buildClaimSupportQuestion,
  buildEvidenceEnvelope,
  evaluateClaimDeterministically,
  checkExactSourceEligibility,
  isDocumentSpecificClaim,
  JEV_TASK_REGISTRY,
  LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
  runCalibratedCascade,
  type ClaimLedger,
  type DecisionProvider,
  type DocumentReference,
  type EvidenceDecision,
  type EvidenceOperationalState,
  type EvidencePassage,
  type ExactSourceEligibility,
  type MaterialClaim,
  type JevRouting,
} from '@capiro/meriv2-core';

export interface EvidenceShadowLogger {
  log(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface ShadowAssessmentBudget {
  maxClaims: number;
  maxInputTokens: number;
  deadlineMs: number;
}

export type ShadowAssessmentStopReason =
  | 'completed'
  | 'max_claims'
  | 'max_input_tokens'
  | 'deadline'
  | 'parent_abort';

type ShadowProviderSlot = 'jev' | 'legacy';
type ShadowProviderWaitState = 'ineligible' | 'not_started' | 'waiting' | 'settled' | 'cancelled_by_shared_budget';
type ShadowProviderState = 'not_started' | 'pending' | 'settled' | 'provider_timeout' | 'provider_error';

interface ShadowProviderLifecycle {
  event: 'meri.evidence_shadow.provider_lifecycle';
  lifecycleId: string;
  conversationId: string | null;
  turnId: string | null;
  claimId: string;
  envelopeHash: string;
  provider: ShadowProviderSlot;
  dispatchBoundary: 'decision_provider_assess';
  eligible: boolean;
  waitState: ShadowProviderWaitState;
  providerState: ShadowProviderState;
  cancellationReason: 'shared_deadline' | 'parent_abort' | null;
  eligibilityCheckedAt: string;
  eligibleAt: string | null;
  attemptedAt: string | null;
  dispatchedAt: string | null;
  settledAt: string | null;
  cancelledAt: string | null;
  actualUsage: { inputTokens?: number; outputTokens?: number } | null;
  usageStatus: 'reported' | 'not_returned' | 'unknown_due_cancellation' | 'not_applicable';
  costStatus: 'unknown' | 'unknown_due_cancellation' | 'not_applicable';
}

interface TrackedProviderCall {
  lifecycle: ShadowProviderLifecycle;
  call?: Promise<EvidenceDecision>;
}

function logProviderLifecycle(logger: EvidenceShadowLogger, lifecycle: ShadowProviderLifecycle): void {
  logger.log(lifecycle.event, {
    ...lifecycle,
    actualUsage: lifecycle.actualUsage ? { ...lifecycle.actualUsage } : null,
  });
}

export interface AssessReleasedClaimsInput {
  claims: readonly MaterialClaim[];
  ledger: ClaimLedger;
  citations: readonly MeriCitation[];
  passages: Record<string, EvidencePassage>;
  tenantId: string;
  clientId?: string | null;
  conversationId?: string;
  turnId?: string;
  asOf: string;
  providers: { jev: DecisionProvider | null; legacy: DecisionProvider };
  routing?: JevRouting;
  budget: ShadowAssessmentBudget;
  signal?: AbortSignal;
  logger: EvidenceShadowLogger;
}

const COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

function documentReferences(citations: readonly MeriCitation[]): DocumentReference[] {
  return citations.flatMap((citation) => {
    const evidence = citation.documentEvidence;
    if (!evidence) return [];
    const recordId = typeof evidence.record.recordId === 'string'
      ? evidence.record.recordId
      : typeof evidence.record.id === 'string' ? evidence.record.id : null;
    return [{
      kind: 'client_document' as const,
      id: evidence.documentId,
      filename: citation.title,
      version: evidence.contentHash,
      contentState: recordId ? 'indexed_or_extracted' as const : 'metadata_only' as const,
      readable: Boolean(recordId),
      relevantPassageIds: recordId ? [recordId] : [],
      resolution: 'explicit_id' as const,
      clientId: evidence.clientId,
      requestedClientId: evidence.clientId,
    }];
  });
}

function priority(claim: MaterialClaim, ledger: ClaimLedger): number {
  if (isDocumentSpecificClaim(claim, ledger) || DEFAULT_HIGH_RISK_CATEGORIES.has(claim.category)) return 0;
  if (claim.uncited) return 1;
  return 2;
}

function failure(provider: string, model: string, state: EvidenceOperationalState, reason: string): EvidenceDecision {
  return {
    kind: 'failure', state, reasonCodes: [reason],
    provider: { name: provider, model,
      questionVersion: JEV_TASK_REGISTRY.claim_support.questionVersion }, latencyMs: 0,
  };
}

function normalizeSettled(
  result: PromiseSettledResult<EvidenceDecision> | undefined,
  provider: DecisionProvider | null,
): EvidenceDecision {
  if (!provider) return failure('jev', 'unavailable', 'judge_unavailable', 'provider_disabled');
  if (result?.status === 'fulfilled') return result.value;
  return failure(provider.name, 'unknown', 'judge_unavailable', 'provider_rejected');
}

function proposedAction(decision: EvidenceDecision, claim: MaterialClaim): string {
  if (decision.kind === 'failure') return 'none:failure';
  switch (decision.outcome) {
    case 'supported': return 'retain';
    case 'insufficient_evidence': return 'retrieve_missing_evidence';
    case 'conflicting_evidence': return DEFAULT_HIGH_RISK_CATEGORIES.has(claim.category)
      ? 'compare_authority_scope_dates' : 'retrieve_and_compare';
    case 'contradicted': return 'qualify_or_omit';
  }
}

function loggedDecision(decision: EvidenceDecision): Record<string, unknown> {
  return decision.kind === 'outcome'
    ? {
        kind: decision.kind, outcome: decision.outcome, confidence: decision.confidence,
        probabilities: decision.probabilities, reasonCodes: decision.reasonCodes,
        model: decision.provider.model, questionVersion: decision.provider.questionVersion,
        latencyMs: decision.latencyMs, inputTokens: decision.usage?.inputTokens ?? 0,
      }
    : {
        kind: decision.kind, state: decision.state, confidence: null, probabilities: null,
        reasonCodes: decision.reasonCodes, model: decision.provider.model,
        questionVersion: decision.provider.questionVersion, latencyMs: decision.latencyMs,
        inputTokens: 0,
      };
}

function resultKey(decision: EvidenceDecision): string {
  return decision.kind === 'outcome' ? decision.outcome : `failure:${decision.state}`;
}

function createTrackedProviderCall(input: {
  slot: ShadowProviderSlot;
  provider: DecisionProvider | null;
  eligible: boolean;
  envelope: Parameters<DecisionProvider['assess']>[0];
  question: Parameters<DecisionProvider['assess']>[1];
  signal: AbortSignal;
  parentSignal?: AbortSignal;
  deadlineAt: number;
  logger: EvidenceShadowLogger;
  conversationId?: string;
  turnId?: string;
  claimId: string;
  envelopeHash: string;
}): TrackedProviderCall {
  const lifecycle: ShadowProviderLifecycle = {
    event: 'meri.evidence_shadow.provider_lifecycle',
    lifecycleId: randomUUID(),
    conversationId: input.conversationId ?? null,
    turnId: input.turnId ?? null,
    claimId: input.claimId,
    envelopeHash: input.envelopeHash,
    provider: input.slot,
    dispatchBoundary: 'decision_provider_assess',
    eligible: input.eligible,
    waitState: !input.eligible ? 'ineligible' : !input.provider ? 'not_started' : 'waiting',
    providerState: !input.eligible || !input.provider ? 'not_started' : 'pending',
    cancellationReason: null,
    eligibilityCheckedAt: new Date().toISOString(),
    eligibleAt: input.eligible ? new Date().toISOString() : null,
    attemptedAt: null,
    dispatchedAt: null,
    settledAt: null,
    cancelledAt: null,
    actualUsage: null,
    usageStatus: !input.eligible || !input.provider ? 'not_applicable' : 'not_returned',
    costStatus: !input.eligible || !input.provider ? 'not_applicable' : 'unknown',
  };
  if (!input.eligible || !input.provider) {
    logProviderLifecycle(input.logger, lifecycle);
    return { lifecycle };
  }

  lifecycle.attemptedAt = new Date().toISOString();
  let call: Promise<EvidenceDecision>;
  try {
    call = input.provider.assess(input.envelope, input.question, {
      signal: input.signal, deadlineAt: input.deadlineAt,
    });
    lifecycle.dispatchedAt = new Date().toISOString();
  } catch {
    lifecycle.providerState = 'provider_error';
    lifecycle.waitState = 'settled';
    lifecycle.settledAt = new Date().toISOString();
    return { lifecycle, call: Promise.reject(new Error('Provider assess invocation failed')) };
  }

  const observed = call.then((decision) => {
    lifecycle.settledAt = new Date().toISOString();
    const cancelledBySharedBudget = Boolean(lifecycle.cancelledAt || input.signal.aborted);
    if (cancelledBySharedBudget && !lifecycle.cancelledAt) {
      lifecycle.cancelledAt = lifecycle.settledAt;
      lifecycle.cancellationReason = input.parentSignal?.aborted ? 'parent_abort' : 'shared_deadline';
    }
    const usage = decision.kind === 'outcome' ? decision.usage : undefined;
    lifecycle.actualUsage = usage ? {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    } : null;
    lifecycle.usageStatus = usage
      ? 'reported'
      : cancelledBySharedBudget ? 'unknown_due_cancellation' : 'not_returned';
    if (cancelledBySharedBudget) lifecycle.costStatus = 'unknown_due_cancellation';
    if (cancelledBySharedBudget) lifecycle.waitState = 'cancelled_by_shared_budget';
    lifecycle.providerState = cancelledBySharedBudget
      ? 'settled'
      : decision.kind === 'failure'
        ? decision.state === 'timeout' ? 'provider_timeout' : 'provider_error'
        : 'settled';
    if (!lifecycle.cancelledAt) lifecycle.waitState = 'settled';
    if (lifecycle.cancelledAt) logProviderLifecycle(input.logger, lifecycle);
    return decision;
  }, () => {
    lifecycle.settledAt = new Date().toISOString();
    if (!lifecycle.cancelledAt) lifecycle.actualUsage = null;
    lifecycle.usageStatus = lifecycle.cancelledAt ? 'unknown_due_cancellation' : 'not_returned';
    if (lifecycle.cancelledAt) lifecycle.costStatus = 'unknown_due_cancellation';
    lifecycle.providerState = 'provider_error';
    if (!lifecycle.cancelledAt) lifecycle.waitState = 'settled';
    if (lifecycle.cancelledAt) logProviderLifecycle(input.logger, lifecycle);
    throw new Error('Provider assess rejected');
  });
  return { lifecycle, call: observed };
}

function chainedDeadlineSignal(parent: AbortSignal | undefined, deadlineMs: number): {
  signal: AbortSignal; dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException('Shadow assessment deadline exceeded', 'TimeoutError')),
    Math.max(0, deadlineMs),
  );
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', abort); },
  };
}

async function settleBeforeAbort(
  call: Promise<EvidenceDecision>,
  signal: AbortSignal,
): Promise<EvidenceDecision> {
  if (signal.aborted) throw signal.reason;
  return new Promise<EvidenceDecision>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    void call.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function assessReleasedClaims(input: AssessReleasedClaimsInput): Promise<void> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + input.budget.deadlineMs;
  const linked = chainedDeadlineSignal(input.signal, input.budget.deadlineMs);
  const references = documentReferences(input.citations);
  const ordered = input.claims.filter((claim) => claim.material)
    .map((claim, index) => ({ claim, index }))
    .sort((a, b) => priority(a.claim, input.ledger) - priority(b.claim, input.ledger) || a.index - b.index);
  let selected = 0;
  let estimatedInputTokens = 0;
  let budgetExhausted = false;
  let stopReason: ShadowAssessmentStopReason = 'completed';
  let providerAssessmentInFlight = false;

  try {
    for (const { claim } of ordered) {
      if (input.signal?.aborted) {
        stopReason = 'parent_abort';
        budgetExhausted = true;
        break;
      }
      if (Date.now() >= deadlineAt || linked.signal.aborted) {
        stopReason = 'deadline';
        budgetExhausted = true;
        break;
      }
      if (selected >= input.budget.maxClaims) {
        stopReason = 'max_claims';
        budgetExhausted = true;
        break;
      }
      const assuredClaim = {
        id: claim.id, text: claim.text, type: claim.kind, category: claim.category,
        sourceIds: claim.evidenceIds, primarySourcePresent: claim.evidenceIds.length > 0,
        confidence: 'unknown' as const, ...(claim.asOf ? { asOf: claim.asOf } : {}),
      };
      const { envelope, hash } = buildEvidenceEnvelope({
        claim: assuredClaim, ledger: input.ledger, citations: [...input.citations],
        passages: input.passages, tenantId: input.tenantId, clientId: input.clientId,
        asOf: input.asOf, includeProvenance: true,
      });
      const question = buildClaimSupportQuestion(envelope);
      // Admission uses the envelope's size, not the (narrower, provenance-stripped) question
      // state actually sent to Jev below: this must stay byte-identical to the pre-Stage-3
      // admission estimate (R5 finding 1) so live claim selection near the budget boundary is
      // unchanged. The envelope is always at least as large as its own question projection, so
      // this remains a conservative (over-, never under-) estimate of the real request size.
      const claimTokens = Math.ceil(JSON.stringify(envelope).length / 4);
      if (estimatedInputTokens + claimTokens > input.budget.maxInputTokens) {
        stopReason = 'max_input_tokens';
        budgetExhausted = true;
        break;
      }
      selected += 1;
      estimatedInputTokens += claimTokens;
      const eligibility: ExactSourceEligibility = checkExactSourceEligibility(claim, references, input.ledger);
      let jev: EvidenceDecision;
      let legacy: EvidenceDecision;
      let cascadeFields: Record<string, unknown> = {};
      if (!eligibility.eligible) {
        if (input.routing !== 'cascade') {
          for (const slot of ['jev', 'legacy'] as const) {
            createTrackedProviderCall({
              slot,
              provider: slot === 'jev' ? input.providers.jev : input.providers.legacy,
              eligible: false, envelope, question, signal: linked.signal, parentSignal: input.signal, deadlineAt,
              logger: input.logger, conversationId: input.conversationId, turnId: input.turnId,
              claimId: claim.id, envelopeHash: hash,
            });
          }
        }
        jev = failure('jev', 'not-called', 'document_unavailable', eligibility.reason);
        legacy = failure('legacy-skeptic', 'not-called', 'document_unavailable', eligibility.reason);
      } else {
        providerAssessmentInFlight = true;
        if (input.routing === 'cascade') {
          const result = await runCalibratedCascade({
            claim: {
              id: claim.id,
              category: claim.category,
              compound: claim.compound,
              materialHighImpact: DEFAULT_HIGH_RISK_CATEGORIES.has(claim.category),
            },
            jev: input.providers.jev,
            legacy: input.providers.legacy,
            envelope,
            question,
            registration: JEV_TASK_REGISTRY.claim_support,
            sampleKey: `${input.conversationId ?? ''}:${claim.id}`,
            signal: linked.signal,
            deadlineAt,
          });
          jev = result.jev ?? failure('jev', 'unavailable', 'judge_unavailable', 'provider_disabled');
          legacy = result.legacy ?? failure('legacy-skeptic', 'not-called', 'not_checked', 'cascade_not_escalated');
          cascadeFields = {
            escalated: result.escalated,
            escalationReasons: result.escalationReasons,
            audited: result.audited,
            auditDisagreement: result.auditDisagreement,
          };
        } else {
          const tracked = (['jev', 'legacy'] as const).map((slot) => createTrackedProviderCall({
            slot,
            provider: slot === 'jev' ? input.providers.jev : input.providers.legacy,
            eligible: true, envelope, question, signal: linked.signal, parentSignal: input.signal, deadlineAt,
            logger: input.logger, conversationId: input.conversationId, turnId: input.turnId,
            claimId: claim.id, envelopeHash: hash,
          }));
          const callSlots: ShadowProviderSlot[] = [];
          const calls = tracked.flatMap((item, index) => {
            if (!item.call) return [];
            callSlots.push(index === 0 ? 'jev' : 'legacy');
            return [settleBeforeAbort(item.call, linked.signal)];
          });
          const settled = await Promise.allSettled(calls);
          const settledBySlot = new Map<ShadowProviderSlot, PromiseSettledResult<EvidenceDecision>>();
          callSlots.forEach((slot, index) => settledBySlot.set(slot, settled[index]!));
          for (const item of tracked) {
            const lifecycle = item.lifecycle;
            if (!lifecycle.settledAt && linked.signal.aborted) {
              lifecycle.waitState = 'cancelled_by_shared_budget';
              lifecycle.cancellationReason = input.signal?.aborted ? 'parent_abort' : 'shared_deadline';
              lifecycle.cancelledAt = new Date().toISOString();
              lifecycle.usageStatus = 'unknown_due_cancellation';
              lifecycle.costStatus = 'unknown_due_cancellation';
            }
            logProviderLifecycle(input.logger, lifecycle);
          }
          if (input.providers.jev) {
            jev = normalizeSettled(settledBySlot.get('jev'), input.providers.jev);
            legacy = normalizeSettled(settledBySlot.get('legacy'), input.providers.legacy);
          } else {
            jev = normalizeSettled(undefined, null);
            legacy = normalizeSettled(settledBySlot.get('legacy'), input.providers.legacy);
          }
        }
        if (linked.signal.aborted) {
          stopReason = input.signal?.aborted ? 'parent_abort' : 'deadline';
        }
        providerAssessmentInFlight = false;
      }
      const actualTokens = (jev.kind === 'outcome' ? jev.usage?.inputTokens ?? 0 : 0)
        + (legacy.kind === 'outcome' ? legacy.usage?.inputTokens ?? 0 : 0);
      if (actualTokens > claimTokens) estimatedInputTokens += actualTokens - claimTokens;
      const evidence = input.ledger.evidence.filter((item) => assuredClaim.sourceIds.includes(item.id))
        .map((item) => ({ ...item, passage: input.passages[item.id]?.text }));
      const deterministic = evaluateClaimDeterministically({
        claim: assuredClaim, evidence, asOf: input.asOf,
        evidencePassages: assuredClaim.sourceIds.flatMap((id) => input.passages[id] ? [input.passages[id]!] : []),
      });
      input.logger.log('meri.evidence_shadow', {
        schemaVersion: 'meri.evidence_shadow.v2',
        conversationId: input.conversationId ?? null, turnId: input.turnId ?? null,
        claimId: claim.id, claimKind: claim.kind, claimCategory: claim.category,
        envelopeHash: hash, eligibility, jev: loggedDecision(jev), legacy: loggedDecision(legacy),
        legacyAdapterVersion: LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
        agreement: resultKey(jev) === resultKey(legacy),
        freshness: {
          requiredDocumentEligible: eligibility.eligible,
          claimLinkedEvidencePresent: evidence.length > 0,
          sourceDateKnown: evidence.some((item) => Boolean(item.effectiveAt || item.publishedAt || item.retrievedAt)),
          eligibleSourceFreshness: {
            state: eligibility.eligible ? deterministic.freshness.state : 'unknown',
            ageDays: eligibility.eligible ? deterministic.freshness.ageDays : null,
            basis: eligibility.eligible ? deterministic.freshness.basis : 'none',
          },
          linkedLedgerTemporalInformation: {
            state: deterministic.freshness.state,
            ageDays: deterministic.freshness.ageDays,
            basis: deterministic.freshness.basis,
          },
        },
        exact: { result: deterministic.exact.result, kind: deterministic.exact.kind },
        proposedAction: { jev: proposedAction(jev, claim), legacy: proposedAction(legacy, claim) },
        ...cascadeFields,
      });
    }
  } finally {
    if (stopReason === 'completed') {
      if (input.signal?.aborted && (providerAssessmentInFlight || selected < ordered.length)) {
        stopReason = 'parent_abort';
      } else if ((linked.signal.aborted || Date.now() >= deadlineAt)
          && (providerAssessmentInFlight || selected < ordered.length)) {
        stopReason = 'deadline';
      }
    }
    if ((linked.signal.aborted || Date.now() >= deadlineAt) && selected < ordered.length) {
      budgetExhausted = true;
    }
    linked.dispose();
    const skipped = Math.max(0, ordered.length - selected);
    const durationMs = Date.now() - startedAt;
    input.logger.log('meri.evidence_shadow.turn', {
      conversationId: input.conversationId ?? null, turnId: input.turnId ?? null,
      selected, skipped, budgetExhausted, stopReason, durationMs, inputTokens: estimatedInputTokens,
      estimatedCostUsd: estimatedInputTokens * COST_PER_INPUT_TOKEN_USD,
      sampled: Number.parseInt(hashSample(`${input.conversationId ?? ''}:${input.turnId ?? ''}`), 16) % 10 === 0,
    });
  }
}

function hashSample(value: string): string {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
