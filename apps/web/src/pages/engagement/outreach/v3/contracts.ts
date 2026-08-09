export type OutreachV3SponsorKind =
  | 'undecided'
  | 'firm'
  | 'client'
  | 'multi_client'
  | 'coalition'
  | 'internal_team'
  | 'none';

export type OutreachV3DeliveryPattern =
  | 'undecided'
  | 'personalized_separate'
  | 'uniform_separate'
  | 'shared_thread';

export type OutreachV3Personalization = 'undecided' | 'high' | 'light' | 'none';
export type OutreachV3Length = 'undecided' | 'short' | 'medium' | 'long' | 'custom';
export type OutreachV3ContextClass =
  | 'required_policy'
  | 'writing_guidance'
  | 'campaign_fact'
  | 'target_specific'
  | 'group_safe';

export interface OutreachV3TargetLocator {
  source: string;
  id: string;
  clientId?: string;
  [key: string]: unknown;
}

export interface OutreachV3ResolvedTargetRef {
  targetKey: string;
  locator: OutreachV3TargetLocator;
  recommendationRef?: string | null;
  displayName: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  phone?: string | null;
  clientId: string | null;
  roleStatus: 'current' | 'historical' | 'unknown';
  profileStatus?: string;
  snapshotHash: string;
  jurisdiction: {
    governmentLevel: string;
    chamber: string | null;
    state: string | null;
    district: string | null;
    committees: string[];
    issueAreas: string[];
  };
  sourceSnapshot?: { version?: string | null; asOf?: string | null };
  [key: string]: unknown;
}

export interface OutreachV3ContextScope {
  kind: 'campaign' | 'target' | 'group';
  targetKey?: string;
  groupKey?: string;
  [key: string]: unknown;
}

export interface OutreachV3ContextLocator {
  source: string;
  id: string;
  [key: string]: unknown;
}

export interface OutreachV3ResolvedContextRef {
  contextKey: string;
  locator: OutreachV3ContextLocator;
  contextClass: OutreachV3ContextClass;
  scope: OutreachV3ContextScope;
  title: string;
  summary: string;
  verificationClass: string;
  sensitivity: string;
  instructionsAllowed: boolean;
  usableAsEvidence: boolean;
  usableAsWritingGuidance: boolean;
  snapshotHash: string;
  sourceSnapshot?: { version?: string | null; asOf?: string | null };
  [key: string]: unknown;
}

export interface OutreachV3ExcludedContextRef {
  contextKey: string;
  reasonCode?: string | null;
  [key: string]: unknown;
}

export interface OutreachV3CampaignSpec {
  schemaVersion: 'outreach_campaign_spec_v1';
  goal: {
    goal: string | null;
    objective: string | null;
    topic: string | null;
    desiredOutcome: string | null;
    ask: { mode: 'undecided' | 'explicit' | 'none'; text: string | null };
    whyNow: string | null;
  };
  sponsor: {
    kind: OutreachV3SponsorKind;
    label: string | null;
    clientRefs: Array<{ clientId: string }>;
  };
  targeting: {
    criteria: {
      notes: string | null;
      governmentLevels: string[];
      chambers: string[];
      committees: string[];
      agencies: string[];
      states: string[];
      relationshipPreference: 'any' | 'existing' | 'new' | 'mixed';
      includeStaff: boolean;
      includePrincipals: boolean;
    } | null;
    selectedTargetRefs: OutreachV3ResolvedTargetRef[];
    rejectedRecommendationRefs: Array<Record<string, unknown>>;
  };
  delivery: {
    pattern: OutreachV3DeliveryPattern;
    personalization: OutreachV3Personalization;
  };
  context: {
    requiredPolicyRefs: OutreachV3ResolvedContextRef[];
    writingGuidanceRefs: OutreachV3ResolvedContextRef[];
    campaignFactRefs: OutreachV3ResolvedContextRef[];
    targetSpecificRefs: OutreachV3ResolvedContextRef[];
    groupSafeRefs: OutreachV3ResolvedContextRef[];
    excludedRefs: OutreachV3ExcludedContextRef[];
  };
  strategy: {
    campaignAngle: string | null;
    tone: string | null;
    length: OutreachV3Length;
    customLengthInstruction: string | null;
  };
}

export interface OutreachV3ReadinessBlocker {
  code: string;
  message?: string;
  stage?: string;
  [key: string]: unknown;
}

export interface OutreachV3Readiness {
  ready?: boolean;
  status?: string;
  blockers?: OutreachV3ReadinessBlocker[];
  warnings?: OutreachV3ReadinessBlocker[];
  [key: string]: unknown;
}

export interface OutreachV3SessionRecord {
  id: string;
  title: string | null;
  status: 'active' | 'archived' | string;
  currentStateVersion: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface OutreachV3SessionEnvelope {
  session: OutreachV3SessionRecord;
  currentStateVersion: number;
  spec: OutreachV3CampaignSpec;
  specHash: string;
  readiness: OutreachV3Readiness;
  pendingProposalCount: number;
}

export interface OutreachV3Command<T = unknown> {
  type: string;
  schemaVersion: 1;
  payload: T;
}

export interface OutreachV3CommandBatchResult {
  status: 'applied' | 'no_change';
  batchId: string;
  stateVersion: number;
  specHash: string;
  changed: boolean;
  commandCount: number;
  replayed: boolean;
}

export interface OutreachV3Proposal {
  id: string;
  sessionId?: string;
  status: 'pending' | 'applied' | 'rejected' | 'stale' | 'superseded' | string;
  expectedStateVersion: number;
  commands: OutreachV3Command[];
  createdAt?: string;
  rejectionCode?: string | null;
  [key: string]: unknown;
}

export interface OutreachV3Conversation {
  id: string;
  sessionId: string;
  provider: string;
  stateMode: string;
  model: string;
  reasoningEffort: string;
  status: string;
  currentStateVersion?: number;
  createdAt?: string;
}

export interface OutreachV3TranscriptTurn {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  status?: 'complete' | 'pending' | 'failed';
  createdAt?: string;
  proposalIds?: string[];
  [key: string]: unknown;
}

export interface OutreachV3ReasoningTurnResult {
  conversationId: string;
  sessionId: string;
  stateVersion: number;
  assistantMessage: string;
  proposalIds: string[];
  proposedCommands: OutreachV3Command[];
  openQuestions: Array<{ id: string; question: string }>;
  referencedToolResults: Array<{ resultId: string; capability: string }>;
  usage: Record<string, number | null>;
  providerResponseRef: string | null;
}

export interface CapabilityResult<T> {
  capability: string;
  version: number;
  data: T;
  provenance: Array<Record<string, unknown>>;
  generatedAt?: string;
  [key: string]: unknown;
}

export interface OutreachV3TargetSignal {
  code: string;
  label: string;
}

export interface OutreachV3TargetCandidate {
  recommendationRef: string;
  targetKey: string;
  locator: OutreachV3TargetLocator;
  displayName: string;
  title: string | null;
  organization: string | null;
  email: string | null;
  clientId: string | null;
  score: number;
  signals: OutreachV3TargetSignal[];
  roleStatus: 'current' | 'historical' | 'unknown';
  emailStatus: 'available' | 'missing';
  jurisdiction: OutreachV3ResolvedTargetRef['jurisdiction'];
}

export interface OutreachV3TargetSearchData {
  candidates: OutreachV3TargetCandidate[];
  totalConsidered: number;
  unsupportedCriteria: string[];
}

export interface OutreachV3TargetCoverageResponse {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  coverage: {
    selectedCount?: number;
    sendReadyCount?: number;
    staffCount?: number;
    principalCount?: number;
    gaps?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  snapshotRevalidation: Array<Record<string, unknown>>;
}

export interface OutreachV3TargetProfileResponse {
  data?: {
    target?: OutreachV3ResolvedTargetRef;
    facts?: Array<Record<string, unknown>>;
    warnings?: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  provenance?: Array<Record<string, unknown>>;
  selectionSnapshot?: {
    status: 'unselected' | 'current' | 'changed' | 'unavailable';
    changedFields: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OutreachV3ContextReviewResponse {
  sessionId: string;
  stateVersion: number;
  specHash: string;
  summary: {
    requiredPolicyCount: number;
    writingGuidanceCount: number;
    campaignFactCount: number;
    targetSpecificCount: number;
    groupSafeCount: number;
    excludedCount: number;
    unverifiedEvidenceCount: number;
  };
  accepted: OutreachV3CampaignSpec['context'];
  snapshotRevalidation: Array<Record<string, unknown>>;
  readiness: OutreachV3Readiness;
}

export interface OutreachV3StrategyData {
  campaignAngle?: string | null;
  tone?: string | null;
  length?: OutreachV3Length;
  rationale?: string[];
  warnings?: string[];
  recommendation?: {
    campaignAngle?: string | null;
    tone?: string | null;
    length?: OutreachV3Length;
    rationale?: string[];
    warnings?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type OutreachV3Stage =
  | 'goal'
  | 'sponsor'
  | 'targets'
  | 'delivery'
  | 'context'
  | 'strategy'
  | 'ready_for_generation';
