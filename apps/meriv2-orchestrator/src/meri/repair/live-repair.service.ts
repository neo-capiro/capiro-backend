import {
  buildClaimSupportQuestion,
  checkExactSourceEligibility,
  evaluateClaimDeterministically,
  runRepairLoop,
  type AssuredClaim,
  type ClaimCategory,
  type ClaimLedger,
  type DecisionProvider,
  type DomainEvidencePlan,
  type DocumentReference,
  type EvidenceDecision,
  type EvidenceEnvelope,
  type MaterialClaim,
  type RepairBudget,
  type RepairLedgerVersion,
  type RevisionGenerator,
  type RepairToolExecutor,
} from '@capiro/meriv2-core';
import type { MeriCitation } from '@capiro/shared';

export interface LiveRepairLogger {
  log(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

export interface LiveRepairInput {
  released: string;
  claims: readonly MaterialClaim[];
  ledger: ClaimLedger;
  citations: MeriCitation[];
  passages: Record<string, { text: string }>;
  evidencePlan: DomainEvidencePlan;
  residualGaps?: readonly unknown[];
  documentReferences?: readonly DocumentReference[];
  tenantId: string;
  clientId?: string | null;
  conversationId?: string;
  providers: { jev: DecisionProvider | null; legacy: DecisionProvider };
  executor: RepairToolExecutor;
  generate: RevisionGenerator;
  promotedCategories: ReadonlySet<ClaimCategory>;
  budget: RepairBudget;
  signal?: AbortSignal;
  logger: LiveRepairLogger;
  mode?: 'off' | 'shadow' | 'enforce';
  now?: () => number;
}

export interface LiveRepairResult {
  reply: string;
  citations: MeriCitation[];
  changed: boolean;
  outcomes: Record<string, string>;
  toolCalls: number;
  passes: number;
  metrics: {
    repairs: {
      attempted: number; corrected: number; qualified: number; omitted: number;
      documentRequested: number; budgetExhausted: number;
    };
    assessmentMs: number;
    repairMs: number;
    inputTokens: number;
    jevInputTokens: number;
    legacyInputTokens: number;
    estimatedCostUsd: number;
    sampled: boolean;
  };
}

const COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;

export async function applyLiveRepair(input: LiveRepairInput): Promise<LiveRepairResult> {
  if (input.mode === 'off') {
    return {
      reply: input.released, citations: input.citations, changed: false, outcomes: {}, toolCalls: 0, passes: 0,
      metrics: {
        repairs: { attempted: 0, corrected: 0, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
        assessmentMs: 0, repairMs: 0, inputTokens: 0, jevInputTokens: 0, legacyInputTokens: 0,
        estimatedCostUsd: 0, sampled: false,
      },
    };
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const promoted = input.claims.filter(
    (claim) => claim.material && claim.category !== 'unclassified' && input.promotedCategories.has(claim.category),
  );
  const decisions: Record<string, EvidenceDecision> = {};
  const assured: AssuredClaim[] = [];
  const outcomes: Record<string, string> = {};
  let jevCalls = 0;
  let legacyCalls = 0;
  let sampledApprovals = 0;
  let sampledDisagreements = 0;
  let inputTokens = 0;
  let jevInputTokens = 0;
  let legacyInputTokens = 0;
  const assessmentStartedAt = now();

  for (const claim of promoted) {
    if (input.signal?.aborted) break;
    const current = toAssuredClaim(claim);
    assured.push(current);
    const envelope = envelopeFor(current, input);
    const evidence = input.ledger.evidence
      .filter((item) => current.sourceIds.includes(item.id))
      .map((item) => ({ ...item, passage: input.passages[item.id]?.text }));
    const deterministic = evaluateClaimDeterministically({
      claim: current,
      evidence,
      evidencePassages: current.sourceIds.flatMap((id) => input.passages[id] ? [input.passages[id]!] : []),
      asOf: current.asOf ?? new Date().toISOString(),
    });
    const exactSource = checkExactSourceEligibility(claim, input.documentReferences ?? [], input.ledger);
    let decision = exactSource.eligible
      ? deterministicDecision(deterministic, current)
      : failure('exact-source', 'document_unavailable', 'document_unavailable');
    let jev: EvidenceDecision | null = null;
    let legacy: EvidenceDecision | null = null;
    if (!decision) {
      if (input.providers.jev?.available()) {
        jevCalls += 1;
        jev = await safeAssess(input.providers.jev, envelope, input.signal);
        jevInputTokens += usage(jev);
        inputTokens += usage(jev);
      }
      const shouldCascade = !jev || jev.kind === 'failure' ||
        (jev.kind === 'outcome' && jev.confidence < 0.5) || claim.compound ||
        (jev?.kind === 'outcome' && jev.outcome === 'supported' && sampled(input.conversationId, claim.id));
      if (shouldCascade) {
        if (jev?.kind === 'outcome' && jev.outcome === 'supported') sampledApprovals += 1;
        legacyCalls += 1;
        legacy = await safeAssess(input.providers.legacy, envelope, input.signal);
        legacyInputTokens += usage(legacy);
        inputTokens += usage(legacy);
        if (jev?.kind === 'outcome' && legacy.kind === 'outcome' && jev.outcome !== legacy.outcome) {
          sampledDisagreements += 1;
        }
      }
      decision = selectDecision(jev, legacy);
    }
    decisions[current.id] = decision;
    outcomes[current.id] = decision.kind === 'outcome' ? decision.outcome : decision.state;
    input.logger.log('meri.auto_correction.claim', {
      conversationId: input.conversationId ?? null,
      claimId: current.id,
      category: current.category,
      promoted: true,
      outcome: outcomes[current.id],
      cascaded: Boolean(legacy),
      sampledApproval: Boolean(jev?.kind === 'outcome' && jev.outcome === 'supported' && legacy),
    });
  }

  const assessmentMs = now() - assessmentStartedAt;
  const repairStartedAt = now();
  const repairable = assured.filter((claim) => {
    const decision = decisions[claim.id];
    if (decision?.kind === 'failure') return decision.state === 'document_unavailable';
    return decision?.kind === 'outcome' && decision.outcome !== 'supported';
  });
  let reply = input.released;
  let toolCalls = 0;
  let passes = 0;
  let status = 'unresolved';
  if (repairable.length && !input.signal?.aborted && input.mode !== 'shadow') {
    const ledger: RepairLedgerVersion = {
      version: 1,
      ledger: input.ledger,
      passages: Object.fromEntries(Object.entries(input.passages).map(([id, passage]) => [id, passage.text])),
    };
    const outcome = await runRepairLoop({
      reply: input.released,
      claims: repairable,
      decisions,
      ledger,
      providers: { decision: input.providers.legacy },
      executor: input.executor,
      generate: input.generate,
      budget: {
        maxPasses: input.budget.maxPasses,
        maxToolCalls: Math.min(3, input.budget.maxToolCalls),
        maxMs: Math.min(8_000, input.budget.maxMs),
        maxInputTokens: Math.min(60_000, input.budget.maxInputTokens),
      },
      evidencePlan: input.evidencePlan,
      toolRegistry: { get: () => ({ readOnly: true }) },
      tenantId: input.tenantId,
      clientId: input.clientId,
      ...({
        missingDocumentName: documentNameFor(repairable[0]!, input.documentReferences ?? []),
      } as Pick<import('@capiro/meriv2-core').RunRepairLoopInput, never> & { missingDocumentName?: string }),
      signal: input.signal,
      now,
    });
    reply = outcome.reply;
    toolCalls = outcome.toolCalls;
    passes = Math.max(0, ...outcome.trace.map((item) => item.pass ?? 0));
    inputTokens += outcome.inputTokens;
    status = outcome.status;
  }
  const changed = reply !== input.released;
  const totalMs = now() - startedAt;
  const repairs = {
    attempted: repairable.length,
    corrected: status === 'corrected' ? 1 : 0,
    qualified: status === 'qualified' ? 1 : 0,
    omitted: status === 'omitted' ? 1 : 0,
    documentRequested: Object.values(decisions).filter(
      (decision) => decision.kind === 'failure' && decision.state === 'document_unavailable',
    ).length,
    budgetExhausted: status === 'budget_exhausted' ? 1 : 0,
    unresolved: status === 'unresolved' ? repairable.length : 0,
    cancelled: status === 'cancelled' ? 1 : 0,
  };
  input.logger.log('meri.auto_correction.turn', {
    conversationId: input.conversationId ?? null,
    mode: input.mode ?? 'enforce',
    promotedCategories: [...input.promotedCategories],
    claimsAssessed: assured.length,
    byOutcome: countValues(outcomes),
    repairs,
    toolCalls,
    passes,
    jevCalls,
    legacyCalls,
    sampledApprovals,
    sampledDisagreements,
    latencyMs: { assessment: assessmentMs, retrieval: now() - repairStartedAt, revision: 0, recheck: 0, total: totalMs },
    inputTokens,
    estimatedCostUsd: inputTokens * COST_PER_INPUT_TOKEN_USD,
    replyChanged: changed,
    timeToTextMs: totalMs,
  });
  return {
    reply, citations: input.citations, changed, outcomes, toolCalls, passes,
    metrics: {
      repairs: {
        attempted: repairs.attempted, corrected: repairs.corrected,
        qualified: repairs.qualified, omitted: repairs.omitted,
        documentRequested: repairs.documentRequested, budgetExhausted: repairs.budgetExhausted,
      },
      assessmentMs,
      repairMs: Math.max(0, totalMs - assessmentMs),
      inputTokens,
      jevInputTokens,
      legacyInputTokens,
      estimatedCostUsd: inputTokens * COST_PER_INPUT_TOKEN_USD,
      sampled: sampledApprovals > 0,
    },
  };
}

export function sampled(conversationId: string | undefined, claimId: string): boolean {
  let hash = 2166136261;
  for (const char of `${conversationId ?? ''}:${claimId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % 10 === 0;
}

function toAssuredClaim(claim: MaterialClaim): AssuredClaim {
  return {
    id: claim.id, text: claim.text, type: claim.kind, category: claim.category,
    sourceIds: claim.evidenceIds, primarySourcePresent: claim.evidenceIds.length > 0,
    confidence: 'unknown', ...(claim.asOf ? { asOf: claim.asOf } : {}),
  };
}

function envelopeFor(claim: AssuredClaim, input: LiveRepairInput): EvidenceEnvelope {
  const byId = new Map(input.ledger.evidence.map((item) => [item.id, item]));
  return {
    envelopeVersion: 'meri-evidence-envelope-v1', claimId: claim.id, claimText: claim.text,
    claimKind: claim.type, claimCategory: claim.category, tenantId: input.tenantId,
    clientId: input.clientId ?? null, scopeQualifiers: [], asOf: claim.asOf ?? null,
    sources: claim.sourceIds.flatMap((id) => {
      const item = byId.get(id);
      return item ? [{
        evidenceId: id, sourceType: item.sourceType, sourceId: item.sourceId,
        documentId: null, version: null, locator: null, passage: input.passages[id]?.text ?? '',
        sourceDate: item.asOf ?? null, publishedAt: item.publishedAt ?? null,
        effectiveAt: item.effectiveAt ?? null, retrievedAt: item.retrievedAt ?? null,
      }] : [];
    }),
  };
}

function deterministicDecision(
  evaluation: ReturnType<typeof evaluateClaimDeterministically>,
  claim: AssuredClaim,
): EvidenceDecision | null {
  let outcome: 'contradicted' | 'insufficient_evidence' | null = null;
  if (evaluation.exact.result === 'mismatch') outcome = 'contradicted';
  else if (evaluation.exact.result === 'absent' || evaluation.freshness.state === 'stale') outcome = 'insufficient_evidence';
  if (!outcome) return null;
  return {
    kind: 'outcome', outcome,
    probabilities: { supported: 0, contradicted: outcome === 'contradicted' ? 1 : 0, insufficient_evidence: outcome === 'insufficient_evidence' ? 1 : 0, conflicting_evidence: 0 },
    confidence: 1, reasonCodes: [`deterministic:${evaluation.exact.result}:${evaluation.freshness.state}`],
    evidenceIds: claim.sourceIds,
    provider: { name: 'deterministic', model: 'rules', questionVersion: 'claim_support.v1' }, latencyMs: 0,
  };
}

async function safeAssess(provider: DecisionProvider, envelope: EvidenceEnvelope, signal?: AbortSignal): Promise<EvidenceDecision> {
  try {
    return await provider.assess(envelope, buildClaimSupportQuestion(envelope), { signal });
  } catch {
    return failure(provider.name, 'provider_failure');
  }
}

function selectDecision(jev: EvidenceDecision | null, legacy: EvidenceDecision | null): EvidenceDecision {
  if (legacy?.kind === 'outcome') return legacy;
  if (jev?.kind === 'outcome') return jev;
  return legacy ?? jev ?? failure('no-provider', 'judge_unavailable');
}

function failure(
  name: string,
  reason: string,
  state: Extract<EvidenceDecision, { kind: 'failure' }>['state'] = 'judge_unavailable',
): EvidenceDecision {
  return { kind: 'failure', state, reasonCodes: [reason], provider: { name, model: 'unknown', questionVersion: 'claim_support.v1' }, latencyMs: 0 };
}
function documentNameFor(claim: Pick<AssuredClaim, 'text' | 'sourceIds'>, references: readonly DocumentReference[]): string | undefined {
  return references.find((reference) =>
    claim.sourceIds.includes(reference.id) || claim.text.toLowerCase().includes(reference.filename.toLowerCase()),
  )?.filename ?? (references.length === 1 ? references[0]?.filename : undefined);
}
function usage(decision: EvidenceDecision | null): number { return decision?.kind === 'outcome' ? decision.usage?.inputTokens ?? 0 : 0; }
function countValues(values: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of Object.values(values)) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}
