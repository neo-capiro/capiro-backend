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

export type RepairOutcomeStatus =
  | 'corrected'
  | 'qualified'
  | 'omitted'
  | 'unresolved'
  | 'cancelled'
  | 'budget_exhausted';

export interface ClaimRevision {
  claimId: string;
  originalText: string;
  replacementText: string;
  sourceIds: string[];
  ledgerVersion: number;
  dependentSentences: string[];
  outcome: 'corrected' | 'qualified' | 'omitted';
}

export interface RepairOutcome {
  status: RepairOutcomeStatus;
  reply: string;
  citations: string[];
  ledger: RepairLedgerVersion;
  trace: RepairTraceEvent[];
  toolCalls: number;
  inputTokens: number;
}

export interface RepairLedgerVersion {
  version: number;
  ledger: ClaimLedger;
  passages: Record<string, string>;
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
  signal?: AbortSignal;
  now?: () => number;
}

export interface DerivedRequirementInput {
  decision: EvidenceDecision;
  claim: AssuredClaim;
  envelope: EvidenceEnvelope;
  evidencePlan: DomainEvidencePlan;
  deterministic?: DeterministicClaimEvaluation;
}
