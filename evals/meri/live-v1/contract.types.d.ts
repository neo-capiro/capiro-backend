export type LiveCaseId = `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7}${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type Surface = 'api' | 'workspace' | 'research';
export type ActorId = 'PAT' | 'PRIYA' | 'ELI';
export type ClientId = 'ASTER' | 'BLUEHAVEN' | 'CEDAR' | null;
export type TerminalState = 'complete' | 'partial' | 'failed' | 'cancelled';
export type OperationKind =
  | 'read'
  | 'memory_proposal'
  | 'memory_decision'
  | 'artifact_create'
  | 'email_send'
  | 'portfolio_save'
  | 'prospect_save'
  | 'stop'
  | 'resume';

export interface HardGate {
  id: string;
  assertion: string;
}

export interface HumanRubric {
  dimensions: readonly ['factual_support', 'evidence_coverage_citation_validity', 'client_relevance', 'directness_clarity', 'actionable_judgment'];
  target: 8;
  minimumPerDimension: 1;
  instructions: string;
}

export interface ExpectedOperation {
  kind: OperationKind;
  approvalRequired: boolean;
  expectedLogicalEffectCount: number;
  maxLogicalEffectCount: number;
  description: string;
}

export interface LiveCase {
  id: LiveCaseId;
  source: {
    document: '01-Meri-Foundation-and-Reliability.md';
    appendix: 'F';
    contract: 'Original 75-case live benchmark';
  };
  category: string;
  surface: Surface;
  actor: ActorId;
  client: ClientId;
  fixtureVersion: 'meri-live-v1-2026-09-26.1';
  sourceIds: readonly string[];
  prompt: string;
  setup: string;
  exactFacts: readonly string[];
  requiredSources: readonly string[];
  forbiddenSources: readonly string[];
  expectedOperation: ExpectedOperation;
  terminal: { allowed: readonly TerminalState[]; description: string };
  hardGates: readonly HardGate[];
  humanRubric: HumanRubric;
}

export interface SavedPredicateArtifactRef {
  applicable: boolean;
  notApplicableReason: string | null;
  artifact: { ref: string; sha256: string } | null;
}

export type SavedEvidenceAuthorityClass = 'UNIT_FIXTURE_NOT_LIVE' | 'AUTHORITATIVE_CAPTURE';

export interface SavedEvidenceBinding {
  captureRunId: string;
  caseId: LiveCaseId;
  runId: string;
  traceId: string;
  sessionId: string;
  actorId: ActorId;
  tenantId: string;
  clientId: ClientId;
  route: string | null;
  authorityClass: SavedEvidenceAuthorityClass;
}
