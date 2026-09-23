import type { AssuredClaim, AssuredEvidence, ClaimLedger } from '../assurance/claim-ledger';
import type { DomainEvidencePlan, EvidenceClass, EvidenceRequirement } from '../assurance/evidence-plan';
import type { EvidenceDecision, EvidenceEnvelope } from '../jev/decision-contract';
import type { DeterministicClaimEvaluation } from '../assurance/deterministic-evaluation';

export type RepairRequirementKind =
  | 'missing_evidence'
  | 'contradiction'
  | 'conflict'
  | 'document_unavailable'
  | 'stale_status';

export interface RepairRequirement {
  claimId: string;
  kind: RepairRequirementKind;
  evidenceClass: EvidenceClass;
  toolFamilies: string[];
  requiredFields: string[];
  freshness?: EvidenceRequirement['freshness'];
  /**
   * Concrete identities already present in the governed turn (for example a
   * client document id). They are merged into the remedy arguments; nothing is
   * inferred from them.
   */
  route?: Record<string, unknown>;
}

export type RemedyKind =
  | 'read_document_section'
  | 'query_primary_source'
  | 'inspect_structured_record'
  | 'resolve_entity'
  | 'fetch_comparison_source'
  | 'refresh_status';

export interface RepairToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface Remedy {
  id: string;
  kind: RemedyKind;
  toolCall: RepairToolCall;
  readOnly: true;
  dedupeKey: string;
}

export interface RepairBudget {
  maxPasses: 1 | 2;
  maxToolCalls: number;
  maxMs: number;
  maxInputTokens: number;
}

export interface RepairEvidence extends AssuredEvidence {
  passage: string;
  documentId?: string;
  version?: string;
  locator?: string;
}

export type RepairToolResult =
  | { ok: true; evidence: RepairEvidence[]; inputTokens?: number }
  | { ok: false; state: 'retrieval_failed' | 'document_unavailable'; reason: string; inputTokens?: number };

export interface RepairTraceEvent {
  at: number;
  type:
    | 'requirement'
    | 'remedy_planned'
    | 'remedy_refused'
    | 'tool_result'
    | 'revision'
    | 'recheck'
    | 'qualification'
    | 'omission'
    | 'cancelled'
    | 'budget_exhausted'
    | 'stale_revision_rejected';
  claimId?: string;
  pass?: number;
  detail: Record<string, unknown>;
}

/**
 * Per-turn summary derived from the per-claim outcomes: one shared terminal
 * outcome keeps its own name; mixed resolved outcomes are `repaired`; a turn
 * with both resolved and unresolved claims is `partial`.
 */
export type RepairOutcomeStatus =
  | 'corrected'
  | 'qualified'
  | 'omitted'
  | 'repaired'
  | 'partial'
  | 'unresolved'
  | 'cancelled'
  | 'budget_exhausted';

export type RepairClaimTerminalOutcome = 'corrected' | 'qualified' | 'omitted' | 'unresolved' | 'aborted';

/** Exactly one terminal outcome per attempted claim. */
export interface RepairClaimOutcome {
  claimId: string;
  outcome: RepairClaimTerminalOutcome;
  reason?: ClaimRevisionReason | 'stale_revision' | 'affected_text_not_found' | 'no_new_evidence';
}

export type RepairSummary = 'repaired' | 'partial' | 'unresolved' | 'aborted';

/** Why a non-corrective revision (qualification/omission) was produced. */
export type ClaimRevisionReason =
  | 'document_unavailable'
  | 'budget_exhausted'
  | 'remedy_refused'
  | 'retrieval_failed'
  | 'recheck_unsupported';

export interface ClaimRevision {
  claimId: string;
  originalText: string;
  replacementText: string;
  sourceIds: string[];
  /** Ledger version current when this revision was generated. */
  ledgerVersion: number;
  dependentSentences: string[];
  outcome: 'corrected' | 'qualified' | 'omitted';
  reason?: ClaimRevisionReason;
}

export interface RepairTokenUsage {
  /** Prompt tokens consumed by the revision model. */
  revisionInput: number;
  /** Completion tokens produced by the revision model. */
  revisionOutput: number;
  /** Prompt tokens consumed by the recheck decision provider. */
  recheckInput: number;
}

export interface RepairOutcome {
  status: RepairOutcomeStatus;
  reply: string;
  citations: string[];
  ledger: RepairLedgerVersion;
  trace: RepairTraceEvent[];
  toolCalls: number;
  /** Total prompt tokens (tool projections, revision prompts and rechecks). */
  inputTokens: number;
  /** Revisions actually applied to the released reply, in application order. */
  applied?: ClaimRevision[];
  /** One terminal outcome for every attempted (non-supported) claim. */
  claimOutcomes?: RepairClaimOutcome[];
  /** Turn-level summary: all resolved, some resolved, none, or aborted/budget. */
  summary?: RepairSummary;
  tokens?: RepairTokenUsage;
}

export interface RepairLedgerVersion {
  version: number;
  ledger: ClaimLedger;
  passages: Record<string, string>;
  /**
   * Ledger version at which each evidence id was last added or replaced. A
   * revision is stale only when evidence it cites changed after it was made.
   */
  evidenceVersions?: Record<string, number>;
}

export interface RepairContext {
  tenantId: string;
  clientId?: string | null;
  scopeQualifiers?: string[];
  evidencePlan: DomainEvidencePlan;
  /** Runtime registry lookup. Unknown or non-read-only tools fail closed. */
  toolRegistry: { get(name: string): { readOnly: boolean } | undefined };
  failedDedupeKeys?: ReadonlySet<string>;
  previousRemedyKinds?: ReadonlySet<RemedyKind>;
}

export interface RecheckResult {
  supported: boolean;
  decisions: Array<{ claim: AssuredClaim; envelope: EvidenceEnvelope; decision: EvidenceDecision }>;
  unresolvedClaims: AssuredClaim[];
}

/**
 * A document the turn already knows about. Structurally compatible with the
 * grounding `DocumentReference`; only the fields the repair loop reads are
 * declared.
 */
export interface RepairDocumentReference {
  id: string;
  filename?: string | null;
  readable?: boolean;
  contentState?: string;
}

export interface RunRepairLoopInput {
  reply: string;
  claims: AssuredClaim[];
  decisions: ReadonlyMap<string, EvidenceDecision> | Record<string, EvidenceDecision>;
  ledger: RepairLedgerVersion;
  providers: { decision: import('../jev/decision-contract').DecisionProvider };
  executor: import('./tool-executor').ToolExecutor;
  generate: import('./revise').RevisionGenerator;
  budget: RepairBudget;
  evidencePlan: DomainEvidencePlan;
  toolRegistry: RepairContext['toolRegistry'];
  tenantId: string;
  clientId?: string | null;
  scopeQualifiers?: string[];
  /** Human-visible name of an exact source the user must provide, when known. */
  missingDocumentName?: string;
  /** Documents referenced by the turn; a claim's route and request name come from here. */
  documentReferences?: readonly RepairDocumentReference[];
  /** Deterministic evaluations by claim id, computed before the judges ran. */
  deterministic?: Readonly<Record<string, DeterministicClaimEvaluation>>;
  signal?: AbortSignal;
  now?: () => number;
}

export interface DerivedRequirementInput {
  decision: EvidenceDecision;
  claim: AssuredClaim;
  envelope: EvidenceEnvelope;
  evidencePlan: DomainEvidencePlan;
  deterministic?: DeterministicClaimEvaluation;
  route?: Record<string, unknown>;
}
