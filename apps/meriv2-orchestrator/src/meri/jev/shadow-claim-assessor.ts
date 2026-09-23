import type { MeriCitation } from '@capiro/shared';
import {
  DEFAULT_HIGH_RISK_CATEGORIES,
  buildClaimSupportQuestion,
  buildEvidenceEnvelope,
  evaluateClaimDeterministically,
  checkExactSourceEligibility,
  isDocumentSpecificClaim,
  JEV_TASK_REGISTRY,
  type ClaimLedger,
  type DecisionProvider,
  type DocumentReference,
  type EvidenceDecision,
  type EvidenceOperationalState,
  type EvidencePassage,
  type ExactSourceEligibility,
  type MaterialClaim,
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

  try {
    for (const { claim } of ordered) {
      if (selected >= input.budget.maxClaims || Date.now() >= deadlineAt || linked.signal.aborted) {
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
        asOf: input.asOf,
      });
      const claimTokens = Math.ceil(JSON.stringify(envelope).length / 4);
      if (estimatedInputTokens + claimTokens > input.budget.maxInputTokens) {
        budgetExhausted = true;
        break;
      }
      selected += 1;
      estimatedInputTokens += claimTokens;
      const eligibility: ExactSourceEligibility = checkExactSourceEligibility(claim, references, input.ledger);
      let jev: EvidenceDecision;
      let legacy: EvidenceDecision;
      if (!eligibility.eligible) {
        jev = failure('jev', 'not-called', 'document_unavailable', eligibility.reason);
        legacy = failure('legacy-skeptic', 'not-called', 'document_unavailable', eligibility.reason);
      } else {
        const question = buildClaimSupportQuestion(envelope);
        const calls = [
          input.providers.jev?.assess(envelope, question, { signal: linked.signal, deadlineAt }),
          input.providers.legacy.assess(envelope, question, { signal: linked.signal, deadlineAt }),
        ].filter((call): call is Promise<EvidenceDecision> => Boolean(call));
        const settled = await Promise.allSettled(calls.map((call) => settleBeforeAbort(call, linked.signal)));
        if (input.providers.jev) {
          jev = normalizeSettled(settled[0], input.providers.jev);
          legacy = normalizeSettled(settled[1], input.providers.legacy);
        } else {
          jev = normalizeSettled(undefined, null);
          legacy = normalizeSettled(settled[0], input.providers.legacy);
        }
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
        conversationId: input.conversationId ?? null, turnId: input.turnId ?? null,
        claimId: claim.id, claimKind: claim.kind, claimCategory: claim.category,
        envelopeHash: hash, eligibility, jev: loggedDecision(jev), legacy: loggedDecision(legacy),
        agreement: resultKey(jev) === resultKey(legacy),
        freshness: {
          state: deterministic.freshness.state,
          ageDays: deterministic.freshness.ageDays,
          basis: deterministic.freshness.basis,
        },
        exact: { result: deterministic.exact.result, kind: deterministic.exact.kind },
        proposedAction: { jev: proposedAction(jev, claim), legacy: proposedAction(legacy, claim) },
      });
    }
  } finally {
    if ((linked.signal.aborted || Date.now() >= deadlineAt) && selected < ordered.length) {
      budgetExhausted = true;
    }
    linked.dispose();
    const skipped = Math.max(0, ordered.length - selected);
    const durationMs = Date.now() - startedAt;
    input.logger.log('meri.evidence_shadow.turn', {
      conversationId: input.conversationId ?? null, turnId: input.turnId ?? null,
      selected, skipped, budgetExhausted, durationMs, inputTokens: estimatedInputTokens,
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