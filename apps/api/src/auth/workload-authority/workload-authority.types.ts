/** Proposal-local pure policy types. None is a credential, grant or verified service identity. */
export type WorkloadAudience =
  'capiro:objective-strategy-generation:v1' | 'capiro:objective-planner-materialization:v1';
export type WorkloadOperation = 'objective.strategy.draft' | 'objective.plan.prepare';
export type WorkloadPhase =
  'dispatch' | 'resume' | 'source_read' | 'result_read' | 'persist' | 'retained_result_read';

export interface WorkloadBinding {
  delegationRef: string;
  audience: WorkloadAudience;
  operation: WorkloadOperation;
  /** Core-stored delegated attempt; consumer job claim/lease fences remain separate. */
  attemptId: string;
  runId: string | null;
  requestFingerprint: string;
}

export interface WorkloadPlannerSource {
  strategyId: string;
  strategyVersionId: string;
  strategyVersionDigest: string;
  generationReceiptId: string;
  groupsDigest: string;
}

export interface WorkloadAuthorityRequest extends WorkloadBinding {
  schemaVersion: 1;
  phase: WorkloadPhase;
  resultRef: string | null;
  resultHash: string | null;
}

export interface WorkloadScope {
  tenantId: string;
  nativeActorId: string;
  membershipId: string;
  clientId: string;
  objectiveId: string;
  objectiveRevisionId: string;
  objectiveVersion: number;
  policyRevision: string;
  plannerSource: WorkloadPlannerSource | null;
}

export interface WorkloadCompletedResult {
  attemptId: string;
  runId: string;
  requestFingerprint: string;
  resultRef: string;
  resultHash: string;
  completedAtMs: number;
}

/** Only a future trusted Core adapter may derive these facts. Caller JSON is not authority.
 * Service identity verification, transaction locks, typed-result validation and issuance
 * are intentionally absent. Policy revision equality is initially strict: a changed
 * policy requires reviewed reconsent, never silent adoption by an old intent. */
export interface WorkloadAuthorityFacts {
  enabled: boolean;
  databaseNowMs: number;
  confirmedAtMs: number;
  absoluteExpiresAtMs: number;
  originalRunExpiresAtMs: number | null;
  binding: WorkloadBinding;
  original: WorkloadScope;
  current: WorkloadScope;
  tenantActive: boolean;
  membershipActive: boolean;
  roleAllowed: boolean;
  clientActive: boolean;
  clientWallAllowed: boolean;
  objectiveReady: boolean;
  policyAllowed: boolean;
  cancelled: boolean;
  superseded: boolean;
  attemptActive: boolean;
  completedResult: WorkloadCompletedResult | null;
}

export type WorkloadIneligibilityReason =
  | 'malformed_request'
  | 'malformed_facts'
  | 'disabled'
  | 'invalid_clock'
  | 'expired_intent'
  | 'cancelled'
  | 'superseded'
  | 'identity_changed'
  | 'source_changed'
  | 'policy_changed'
  | 'current_authority_denied'
  | 'binding_mismatch'
  | 'inactive_attempt'
  | 'run_expired'
  | 'result_mismatch'
  | 'result_not_effect_eligible';

/** Eligibility only: never a reusable authorization receipt or evidence of model validity. */
export type WorkloadAuthorityEligibility =
  | { eligible: true; reason: null; validUntilMs: number }
  | { eligible: false; reason: WorkloadIneligibilityReason; validUntilMs: null };
