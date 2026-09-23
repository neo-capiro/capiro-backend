import {
  buildClaimSupportQuestion,
  checkExactSourceEligibility,
  evaluateClaimDeterministically,
  JEV_TASK_REGISTRY,
  runRepairLoop,
  type AssuredClaim,
  type ClaimCategory,
  type ClaimLedger,
  type DecisionProvider,
  type DeterministicClaimEvaluation,
  type DocumentContentState,
  type DocumentReference,
  type DomainEvidencePlan,
  type EvidenceDecision,
  type EvidenceEnvelope,
  type ExactSourceEligibilityReason,
  type LedgerEntry,
  type MaterialClaim,
  type RepairBudget,
  type RepairClaimOutcome,
  type RepairLedgerVersion,
  type RepairOutcomeStatus,
  type RevisionGenerator,
  type RepairToolExecutor,
} from '@capiro/meriv2-core';
import { MERI_CAPABILITY_REGISTRY, computeAiCostUsd, type MeriCitation } from '@capiro/shared';

export interface LiveRepairLogger {
  log(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}

/** Runtime tool classification. The orchestrator's `ToolRegistry` satisfies it directly. */
export interface LiveRepairToolRegistry {
  get(name: string): { readOnly: boolean } | undefined;
}

export interface LiveRepairPricing {
  /** USD per Jev input token; defaults to the TypeSafe rate used since Stage 1. */
  jevUsdPerInputToken?: number;
  /** Model whose public rate prices legacy-judge, recheck and revision tokens. */
  llmModel?: string;
}

export interface LiveRepairInput {
  released: string;
  claims: readonly MaterialClaim[];
  ledger: ClaimLedger;
  citations: MeriCitation[];
  passages: Record<string, { text: string }>;
  evidencePlan: DomainEvidencePlan;
  residualGaps?: readonly unknown[];
  /**
   * Documents the turn actually observed, with truthful `readable`/`contentState`
   * (see `buildRepairDocumentReferences`). `[]` when the turn touched no document.
   */
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
  /**
   * Real read-only classification for remedy planning. Defaults to the shared
   * capability registry so unknown and mutating tools fail closed.
   */
  toolRegistry?: LiveRepairToolRegistry;
  pricing?: LiveRepairPricing;
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
    /** Claims enforce would have attempted; reported by shadow only (attempted stays 0). */
    wouldAttempt: number;
    unresolved: number;
    claimOutcomes: RepairClaimOutcome[];
    assessmentMs: number;
    repairMs: number;
    inputTokens: number;
    jevInputTokens: number;
    legacyInputTokens: number;
    revisionInputTokens: number;
    revisionOutputTokens: number;
    recheckInputTokens: number;
    estimatedCostUsd: number;
    sampled: boolean;
  };
}

export const JEV_COST_PER_INPUT_TOKEN_USD = 0.042 / 1_000_000;
/** Conservative default for pricing revision/recheck/legacy tokens when the caller passes no model. */
export const DEFAULT_REPAIR_LLM_MODEL = 'claude-sonnet-4-5';

/** Eligibility failures meaning the referenced document cannot be read as requested. */
const DOCUMENT_UNAVAILABLE_REASONS: ReadonlySet<ExactSourceEligibilityReason> = new Set<ExactSourceEligibilityReason>([
  'metadata_only', 'unreadable', 'wrong_client', 'version_mismatch',
]);

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Read-only classification from the shared capability registry; unknown tools are undefined. */
export const capabilityToolRegistry: LiveRepairToolRegistry = {
  get(name: string) {
    const tool = MERI_CAPABILITY_REGISTRY.find((item) => item.name === name);
    return tool ? { readOnly: tool.readOnly === true } : undefined;
  },
};

export interface RepairDocumentReferenceSources {
  ledgerEntries: readonly LedgerEntry[];
  citations: readonly MeriCitation[];
  selectedDocumentIds?: readonly string[] | null;
  request?: string;
  clientId?: string | null;
}

/**
 * Truthful document references for repair, built only from what the turn
 * observed: `read_client_documents` content reads (readable when text was
 * extracted; `relevantPassageIds` are the citation/record ids that content
 * produced) and listing rows for documents the user selected or named in the
 * request (metadata only, `readable` from the listing's `usable` flag). Nothing
 * is synthesised; a turn with no document activity yields `[]`.
 */
export function buildRepairDocumentReferences(input: RepairDocumentReferenceSources): DocumentReference[] {
  const byId = new Map<string, DocumentReference>();
  const selected = new Set(input.selectedDocumentIds ?? []);
  const request = (input.request ?? '').toLowerCase();
  const passageIds = (documentId: string): string[] =>
    input.citations
      .filter((citation) => citation.documentEvidence?.documentId === documentId)
      .flatMap((citation) => [citation.id, ...(citation.stableId ? [citation.stableId] : [])]);
  const scope = (result: Record<string, unknown>) => ({
    clientId: typeof result.clientId === 'string' ? result.clientId : input.clientId ?? null,
    ...(input.clientId !== undefined ? { requestedClientId: input.clientId } : {}),
  });

  for (const entry of input.ledgerEntries) {
    if (entry.tool !== 'read_client_documents') continue;
    const result = object(entry.result);
    if (!result) continue;
    const document = object(result.document);
    if (document && typeof document.id === 'string') {
      const coverage = object(result.coverage);
      const rows = Array.isArray(result.records) ? result.records.map(object) : [];
      const text =
        rows.map((row) => object(row?.payload)?.text).find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0,
        ) ?? (typeof result.text === 'string' && result.text.trim() ? result.text : undefined);
      const readable = Boolean(text) && coverage?.continuationBlocked !== true && coverage?.missingContent !== true;
      const contentState: DocumentContentState = readable ? (coverage?.complete === true ? 'ready' : 'partial') : 'failed';
      const filename =
        typeof document.fileName === 'string' ? document.fileName
          : typeof document.filename === 'string' ? document.filename
            : document.id;
      const recordIds = rows.flatMap((row) => (typeof row?.recordId === 'string' ? [row.recordId] : []));
      const existing = byId.get(document.id);
      const state = existing?.readable && !readable
        ? { readable: true, contentState: existing.contentState }
        : { readable, contentState };
      byId.set(document.id, {
        kind: 'client_document',
        id: document.id,
        filename,
        version: typeof document.contentHash === 'string' ? document.contentHash : null,
        ...state,
        relevantPassageIds: [...new Set([...(existing?.relevantPassageIds ?? []), ...passageIds(document.id), ...recordIds])],
        resolution: selected.has(document.id) || request.includes(document.id.toLowerCase()) ? 'explicit_id' : 'filename',
        ...scope(result),
      });
      continue;
    }
    const listing = Array.isArray(result.documents) ? result.documents.map(object) : [];
    for (const row of listing) {
      if (!row || typeof row.id !== 'string' || byId.has(row.id)) continue;
      const fileName =
        typeof row.fileName === 'string' ? row.fileName : typeof row.filename === 'string' ? row.filename : null;
      const named = fileName ? mentionsFilename(request, fileName) : false;
      if (!selected.has(row.id) && !named) continue;
      const usable = row.usable !== false;
      byId.set(row.id, {
        kind: 'client_document',
        id: row.id,
        filename: fileName ?? row.id,
        version: null,
        // A listing proves the file exists and whether it can be read, never its content.
        contentState: usable ? 'indexed_or_extracted' : 'unsupported',
        readable: usable,
        relevantPassageIds: [],
        resolution: selected.has(row.id) ? 'explicit_id' : 'filename',
        ...scope(result),
      });
    }
  }
  return [...byId.values()];
}

function mentionsFilename(text: string, filename: string): boolean {
  const lower = filename.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, '');
  return text.includes(lower) || (stem.length >= 4 && text.includes(stem));
}

export async function applyLiveRepair(input: LiveRepairInput): Promise<LiveRepairResult> {
  if (input.mode === 'off') {
    return {
      reply: input.released, citations: input.citations, changed: false, outcomes: {}, toolCalls: 0, passes: 0,
      metrics: {
        repairs: { attempted: 0, corrected: 0, qualified: 0, omitted: 0, documentRequested: 0, budgetExhausted: 0 },
        wouldAttempt: 0, unresolved: 0, claimOutcomes: [],
        assessmentMs: 0, repairMs: 0, inputTokens: 0, jevInputTokens: 0, legacyInputTokens: 0,
        revisionInputTokens: 0, revisionOutputTokens: 0, recheckInputTokens: 0,
        estimatedCostUsd: 0, sampled: false,
      },
    };
  }
  const now = input.now ?? Date.now;
  const startedAt = now();
  const shadow = input.mode === 'shadow';
  const promoted = input.claims.filter(
    (claim) => claim.material && claim.category !== 'unclassified' && input.promotedCategories.has(claim.category),
  );
  const decisions: Record<string, EvidenceDecision> = {};
  const deterministicByClaim: Record<string, DeterministicClaimEvaluation> = {};
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
  const cascade = JEV_TASK_REGISTRY.claim_support.cascade!;

  for (const claim of promoted) {
    if (input.signal?.aborted) break;
    const current = toAssuredClaim(claim);
    assured.push(current);
    const envelope = envelopeFor(current, input);
    const evidence = input.ledger.evidence
      .filter((item) => current.sourceIds.includes(item.id))
      .map((item) => ({ ...item, passage: input.passages[item.id]?.text }));
    const boundPassages = current.sourceIds.flatMap((id) => (input.passages[id] ? [input.passages[id]!] : []));
    const deterministic = evaluateClaimDeterministically({
      claim: current,
      evidence,
      evidencePassages: boundPassages,
      asOf: current.asOf ?? new Date().toISOString(),
    });
    deterministicByClaim[current.id] = deterministic;
    const exactSource = checkExactSourceEligibility(claim, input.documentReferences ?? [], input.ledger);
    // Only a document the turn knows cannot be read as requested short-circuits
    // to a document request. No document at all, or a readable document without
    // a bound passage, is assessed normally (and may be read during repair).
    let decision: EvidenceDecision | null = DOCUMENT_UNAVAILABLE_REASONS.has(exactSource.reason)
      ? failure('exact-source', exactSource.reason, 'document_unavailable')
      : deterministicDecision(deterministic, current, boundPassages.length);
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
        (jev.kind === 'outcome' && jev.confidence < cascade.escalateBelowConfidence) ||
        (cascade.escalateCompound && claim.compound) ||
        (jev?.kind === 'outcome' && jev.outcome === 'supported'
          && sampled(input.conversationId, claim.id, cascade.auditSampleRate));
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
      deterministic: { exact: deterministic.exact.result, freshness: deterministic.freshness.state, houseSenateComplete: deterministic.houseSenateComplete },
      exactSource: exactSource.reason,
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
  let status: RepairOutcomeStatus | 'not_run' = 'not_run';
  let claimOutcomes: RepairClaimOutcome[] = [];
  let tokens = { revisionInput: 0, revisionOutput: 0, recheckInput: 0 };
  if (repairable.length && !shadow) {
    if (input.signal?.aborted) {
      status = 'cancelled';
      claimOutcomes = repairable.map((claim) => ({ claimId: claim.id, outcome: 'aborted' as const }));
    } else {
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
        toolRegistry: input.toolRegistry ?? capabilityToolRegistry,
        tenantId: input.tenantId,
        clientId: input.clientId,
        missingDocumentName: documentNameFor(repairable[0]!, input.documentReferences ?? []),
        documentReferences: input.documentReferences,
        deterministic: deterministicByClaim,
        signal: input.signal,
        now,
      });
      reply = outcome.reply;
      toolCalls = outcome.toolCalls;
      passes = Math.max(0, ...outcome.trace.map((item) => item.pass ?? 0));
      inputTokens += outcome.inputTokens;
      status = outcome.status;
      claimOutcomes = outcome.claimOutcomes ?? [];
      tokens = outcome.tokens ?? tokens;
    }
  }
  const changed = reply !== input.released;
  const totalMs = now() - startedAt;
  const count = (predicate: (item: RepairClaimOutcome) => boolean) => claimOutcomes.filter(predicate).length;
  // Per-claim counts: corrected + qualified + omitted + unresolved === attempted.
  // Shadow never repairs, so it reports attempted = 0 and the would-be count separately.
  const repairs = {
    attempted: claimOutcomes.length,
    corrected: count((item) => item.outcome === 'corrected'),
    qualified: count((item) => item.outcome === 'qualified'),
    omitted: count((item) => item.outcome === 'omitted'),
    documentRequested: count((item) => item.outcome === 'qualified' && item.reason === 'document_unavailable'),
    budgetExhausted: status === 'budget_exhausted' ? 1 : 0,
    unresolved: count((item) => item.outcome === 'unresolved' || item.outcome === 'aborted'),
    cancelled: status === 'cancelled' ? 1 : 0,
    wouldAttempt: shadow ? repairable.length : 0,
  };
  const jevRate = input.pricing?.jevUsdPerInputToken ?? JEV_COST_PER_INPUT_TOKEN_USD;
  const llmModel = input.pricing?.llmModel ?? DEFAULT_REPAIR_LLM_MODEL;
  // Jev tokens at Jev's rate; legacy judge, recheck and revision tokens at the LLM's rate.
  const estimatedCostUsd =
    jevInputTokens * jevRate +
    computeAiCostUsd(llmModel, legacyInputTokens + tokens.recheckInput + tokens.revisionInput, tokens.revisionOutput);
  input.logger.log('meri.auto_correction.turn', {
    conversationId: input.conversationId ?? null,
    mode: input.mode ?? 'enforce',
    promotedCategories: [...input.promotedCategories],
    claimsAssessed: assured.length,
    byOutcome: countValues(outcomes),
    repairs,
    repairStatus: status,
    claimOutcomes,
    toolCalls,
    passes,
    jevCalls,
    legacyCalls,
    sampledApprovals,
    sampledDisagreements,
    latencyMs: { assessment: assessmentMs, retrieval: now() - repairStartedAt, revision: 0, recheck: 0, total: totalMs },
    inputTokens,
    tokens: { jev: jevInputTokens, legacy: legacyInputTokens, ...tokens },
    estimatedCostUsd,
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
      wouldAttempt: repairs.wouldAttempt,
      unresolved: repairs.unresolved,
      claimOutcomes,
      assessmentMs,
      repairMs: Math.max(0, totalMs - assessmentMs),
      inputTokens,
      jevInputTokens,
      legacyInputTokens,
      revisionInputTokens: tokens.revisionInput,
      revisionOutputTokens: tokens.revisionOutput,
      recheckInputTokens: tokens.recheckInput,
      estimatedCostUsd,
      sampled: sampledApprovals > 0,
    },
  };
}

export function sampled(
  conversationId: string | undefined,
  claimId: string,
  rate = JEV_TASK_REGISTRY.claim_support.cascade!.auditSampleRate,
): boolean {
  let hash = 2166136261;
  for (const char of `${conversationId ?? ''}:${claimId}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  return (hash >>> 0) % Math.round(1 / rate) === 0;
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
        provenance: {
          evidenceClass: item.evidenceClass,
          primary: item.primary,
          authoritative: item.authoritative,
        },
      }] : [];
    }),
  };
}

/**
 * Only an exact value positively contradicted by a passage bound to the claim
 * may bypass the judges. An absent value or stale evidence is routed to the
 * judge; the deterministic evaluation still shapes the remedy afterwards.
 */
function deterministicDecision(
  evaluation: DeterministicClaimEvaluation,
  claim: AssuredClaim,
  boundPassages: number,
): EvidenceDecision | null {
  if (evaluation.exact.result !== 'mismatch' || boundPassages === 0 || !claim.sourceIds.length) return null;
  return {
    kind: 'outcome', outcome: 'contradicted',
    probabilities: { supported: 0, contradicted: 1, insufficient_evidence: 0, conflicting_evidence: 0 },
    confidence: 1, reasonCodes: [`deterministic:mismatch:${evaluation.freshness.state}`],
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
