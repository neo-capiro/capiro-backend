/**
 * Ordered Universal Entity Resolution stages required by the shared Knowledge
 * Plane. This is identity infrastructure, not Meri-specific retrieval.
 *
 * Deterministic/private and authoritative public stages run first. Public-web
 * and model-assisted stages may surface candidates, but they may never create,
 * merge, or auto-select a canonical entity on their own.
 */
export const ENTITY_RESOLUTION_STAGE_ORDER = [
  'existing_canonical',
  'crm_identity',
  'contact_email',
  'email_domain',
  'directory_government_id',
  'sam_uei_cage',
  'usaspending',
  'lda',
  'sec_cik',
  'official_website',
  'public_web',
  'model_candidate_reconciliation',
] as const;

export type EntityResolutionStage = (typeof ENTITY_RESOLUTION_STAGE_ORDER)[number];

export const ENTITY_RESOLUTION_CANDIDATE_ONLY_STAGES = [
  'public_web',
  'model_candidate_reconciliation',
] as const satisfies readonly EntityResolutionStage[];

export const ENTITY_RESOLUTION_GLOBAL_REGISTRATION_STAGES = [
  'directory_government_id',
  'sam_uei_cage',
  'usaspending',
  'lda',
  'sec_cik',
] as const satisfies readonly EntityResolutionStage[];

export type EntityResolutionEvidenceKind =
  | 'existing_canonical_id'
  | 'tenant_source_id'
  | 'reviewed_mapping'
  | 'verified_email'
  | 'verified_official_domain'
  | 'exact_authoritative_identifier'
  | 'exact_verified_alias'
  | 'name_only'
  | 'public_web_claim'
  | 'model_suggestion';

export interface EntityResolutionStageEvidence {
  candidateCount: number;
  evidenceKinds: readonly EntityResolutionEvidenceKind[];
  conflictingIdentifiers?: boolean;
  candidateAlreadyCanonical?: boolean;
}

export interface EntityResolutionStagePolicyDecision {
  autoResolve: boolean;
  mayRegisterGlobalPublic: boolean;
  candidateOnly: boolean;
  requiresHumanConfirmation: boolean;
  reason:
    | 'unique_deterministic_match'
    | 'unique_authoritative_public_identifier'
    | 'candidate_only_stage'
    | 'conflicting_identifiers'
    | 'insufficient_evidence'
    | 'multiple_candidates';
}

const HARD_STOP_RESOLUTION_METHODS = new Set([
  'conflicting_identifiers',
  'multiple_authoritative_identifiers',
  'cross_scope_conflict',
]);

/**
 * Decide whether one stage may automatically select or register identity.
 * Confidence scores alone are deliberately ignored: the kind of evidence is
 * what determines whether an identity action is safe.
 */
export function decideEntityResolutionStagePolicy(
  stage: EntityResolutionStage,
  evidence: EntityResolutionStageEvidence,
): EntityResolutionStagePolicyDecision {
  const candidateOnly = (
    ENTITY_RESOLUTION_CANDIDATE_ONLY_STAGES as readonly EntityResolutionStage[]
  ).includes(stage);

  if (evidence.conflictingIdentifiers) {
    return {
      autoResolve: false,
      mayRegisterGlobalPublic: false,
      candidateOnly,
      requiresHumanConfirmation: true,
      reason: 'conflicting_identifiers',
    };
  }

  if (candidateOnly) {
    return {
      autoResolve: false,
      mayRegisterGlobalPublic: false,
      candidateOnly: true,
      requiresHumanConfirmation: evidence.candidateCount > 0,
      reason: 'candidate_only_stage',
    };
  }

  if (evidence.candidateCount > 1) {
    return {
      autoResolve: false,
      mayRegisterGlobalPublic: false,
      candidateOnly: false,
      requiresHumanConfirmation: true,
      reason: 'multiple_candidates',
    };
  }

  if (evidence.candidateCount !== 1) {
    return {
      autoResolve: false,
      mayRegisterGlobalPublic: false,
      candidateOnly: false,
      requiresHumanConfirmation: false,
      reason: 'insufficient_evidence',
    };
  }

  const kinds = new Set(evidence.evidenceKinds);
  const deterministicMatch =
    kinds.has('existing_canonical_id') ||
    kinds.has('tenant_source_id') ||
    kinds.has('reviewed_mapping') ||
    kinds.has('verified_email') ||
    kinds.has('exact_authoritative_identifier') ||
    kinds.has('exact_verified_alias') ||
    (stage === 'email_domain' && kinds.has('verified_official_domain')) ||
    (stage === 'official_website' &&
      evidence.candidateAlreadyCanonical === true &&
      kinds.has('verified_official_domain'));

  if (!deterministicMatch) {
    return {
      autoResolve: false,
      mayRegisterGlobalPublic: false,
      candidateOnly: false,
      requiresHumanConfirmation: evidence.candidateCount > 0,
      reason: 'insufficient_evidence',
    };
  }

  const mayRegisterGlobalPublic = (
    ENTITY_RESOLUTION_GLOBAL_REGISTRATION_STAGES as readonly EntityResolutionStage[]
  ).includes(stage) && kinds.has('exact_authoritative_identifier');

  return {
    autoResolve: true,
    mayRegisterGlobalPublic,
    candidateOnly: false,
    requiresHumanConfirmation: false,
    reason: mayRegisterGlobalPublic
      ? 'unique_authoritative_public_identifier'
      : 'unique_deterministic_match',
  };
}

/**
 * Continue automatically after an unresolved or soft-ambiguous stage, but do
 * not allow later fuzzy/public/model stages to override an authoritative
 * identifier conflict.
 */
export function shouldContinueEntityResolution(params: {
  stage: EntityResolutionStage;
  status: 'resolved' | 'ambiguous' | 'unresolved';
  resolutionMethod?: string | null;
}): boolean {
  if (params.status === 'resolved') return false;
  if (
    params.status === 'ambiguous' &&
    params.resolutionMethod &&
    HARD_STOP_RESOLUTION_METHODS.has(params.resolutionMethod)
  ) {
    return false;
  }
  return nextEntityResolutionStage(params.stage) !== null;
}

export function nextEntityResolutionStage(
  stage: EntityResolutionStage,
): EntityResolutionStage | null {
  const index = ENTITY_RESOLUTION_STAGE_ORDER.indexOf(stage);
  return index < 0 || index >= ENTITY_RESOLUTION_STAGE_ORDER.length - 1
    ? null
    : ENTITY_RESOLUTION_STAGE_ORDER[index + 1]!;
}
