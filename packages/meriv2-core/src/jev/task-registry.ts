import type { ClaimCategory } from '../assurance/evidence-plan';
import type { CapabilityRolloutMode } from '../rollout/capability-rollout';
import type { EvidenceEnvelope } from './decision-contract';
import { DEFAULT_JEV_MODEL, JEV_TASKS, type JevConfig, type JevTask } from './jev-config';

export const JEV_TASK_REGISTRY_VERSION = 'jev-task-registry.v5' as const;

export type JevRequiredEvidenceMetadata =
  | 'authority'
  | 'provenance'
  | 'document_completeness'
  | 'relation_scope'
  | 'financial_stage'
  | 'source_locator';

export type JevCacheIdentityField =
  | 'task'
  | 'registry_version'
  | 'question_version'
  | 'question_hash'
  | 'model_version'
  | 'envelope_hash'
  | 'provenance'
  | 'candidates';

export interface JevTaskRegistration {
  task: JevTask;
  ownerRole: string;
  lifecycle: 'active' | 'shadow_only' | 'inactive';
  questionVersion: string;
  questionId?: string;
  primitive: 'choice' | 'noul' | 'score';
  allowedOutcomes: readonly string[];
  abstentionOutcomes: readonly string[];
  evidenceRequirements: {
    minimumSources: number;
    requiredMetadata: readonly JevRequiredEvidenceMetadata[];
  };
  candidateGenerator: { id: string; version: string };
  /** Pinned model against which this task's thresholds were evaluated. */
  modelVersion: string;
  cacheIdentity: { version: string; fields: readonly JevCacheIdentityField[] };
  thresholds: Readonly<Record<string, number>>;
  thresholdsByAction: Readonly<Record<string, number>>;
  timeoutMs: number;
  fallback: 'legacy_judge' | 'unfiltered' | 'no_change';
  rolloutCapability: string | null;
  maxRolloutMode: CapabilityRolloutMode;
  permittedEffect: {
    kind: 'advisory_only' | 'filter_supplied_candidates' | 'label_only';
    canonicalFinancialWrite: false;
    requiresHumanReview: boolean;
  };
  evaluationSet: {
    id: string;
    status: 'missing' | 'proposed' | 'approved';
    path: string | null;
  };
  costBudget: {
    maxCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    /** Null until a provider price schedule has been approved and versioned. */
    maxEstimatedCostUsd: number | null;
    priceVersion: string;
  };
  calibration: {
    status: 'provisional' | 'calibrated';
    basis: string;
    evaluatedCategories?: readonly ClaimCategory[];
  };
  cascade?: {
    escalateBelowConfidence: number;
    auditSampleRate: number;
    escalateCompound: boolean;
    highImpactCategories: readonly ClaimCategory[];
  };
  /** Post-release comparison budget. It cannot affect the released answer. */
  shadowBudget?: {
    maxClaims: number;
    maxInputTokens: number;
    deadlineMs: number;
  };
}

const MODEL_EVALUATION_OWNER = 'model/evaluation lead';
const UNPRICED = 'unpriced-until-approved-provider-rate';
const CLAIM_FIXTURE = 'packages/meriv2-core/src/jev/__fixtures__/stage0-claim-evidence-v1.json';
const PACKAGE_2_FIXTURE = 'packages/meriv2-core/src/jev/__fixtures__/package2-task-evaluation-v1.json';
const BD_FIXTURE = 'packages/meriv2-core/src/jev/__fixtures__/bd-task-evaluation-v1.json';
const BD_CLAIM_FIXTURE = 'packages/meriv2-core/src/jev/__fixtures__/bd-claim-replay-v1.json';

function governance(input: {
  task: JevTask;
  lifecycle: JevTaskRegistration['lifecycle'];
  allowedOutcomes: readonly string[];
  abstentionOutcomes?: readonly string[];
  requiredMetadata?: readonly JevRequiredEvidenceMetadata[];
  minimumSources?: number;
  candidateGenerator: string;
  cacheFields?: readonly JevCacheIdentityField[];
  thresholdsByAction?: Readonly<Record<string, number>>;
  timeoutMs?: number;
  maxRolloutMode?: CapabilityRolloutMode;
  effect?: JevTaskRegistration['permittedEffect']['kind'];
  requiresHumanReview?: boolean;
  evaluationSet?: JevTaskRegistration['evaluationSet'];
  maxCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxEstimatedCostUsd?: number;
  priceVersion?: string;
}): Pick<JevTaskRegistration,
  | 'ownerRole'
  | 'lifecycle'
  | 'allowedOutcomes'
  | 'abstentionOutcomes'
  | 'evidenceRequirements'
  | 'candidateGenerator'
  | 'cacheIdentity'
  | 'thresholdsByAction'
  | 'timeoutMs'
  | 'maxRolloutMode'
  | 'permittedEffect'
  | 'evaluationSet'
  | 'costBudget'> {
  return {
    ownerRole: MODEL_EVALUATION_OWNER,
    lifecycle: input.lifecycle,
    allowedOutcomes: input.allowedOutcomes,
    abstentionOutcomes: input.abstentionOutcomes ?? input.allowedOutcomes.filter((outcome) =>
      ['insufficient_evidence', 'none', 'ambiguous', 'not_stated'].includes(outcome)),
    evidenceRequirements: {
      minimumSources: input.minimumSources ?? 1,
      requiredMetadata: input.requiredMetadata ?? ['source_locator'],
    },
    candidateGenerator: { id: input.candidateGenerator, version: 'v1' },
    cacheIdentity: {
      version: `${input.task}-cache.v1`,
      fields: input.cacheFields ?? [
        'task', 'registry_version', 'question_version', 'question_hash', 'model_version', 'envelope_hash',
      ],
    },
    thresholdsByAction: input.thresholdsByAction ?? { abstain_below: 1 },
    timeoutMs: input.timeoutMs ?? 8_000,
    maxRolloutMode: input.maxRolloutMode ?? 'shadow',
    permittedEffect: {
      kind: input.effect ?? 'advisory_only',
      canonicalFinancialWrite: false,
      requiresHumanReview: input.requiresHumanReview ?? true,
    },
    evaluationSet: input.evaluationSet ?? { id: `${input.task}.unqualified`, status: 'missing', path: null },
    costBudget: {
      maxCalls: input.maxCalls ?? 1,
      maxInputTokens: input.maxInputTokens ?? 32_000,
      maxOutputTokens: input.maxOutputTokens ?? 2_000,
      maxEstimatedCostUsd: input.maxEstimatedCostUsd ?? null,
      priceVersion: input.priceVersion ?? UNPRICED,
    },
  };
}

export const JEV_TASK_REGISTRY: Readonly<Record<JevTask, JevTaskRegistration>> = {
  claim_support: {
    task: 'claim_support',
    ...governance({
      task: 'claim_support', lifecycle: 'active',
      allowedOutcomes: ['supported', 'contradicted', 'insufficient_evidence', 'conflicting_evidence'],
      candidateGenerator: 'assured-claim-source-binding', thresholdsByAction: { accept_supported: 0.5, abstain_below: 0.5 },
      maxRolloutMode: 'enforce', requiresHumanReview: false,
      evaluationSet: { id: 'jev_claim_evidence_fixture_v1', status: 'proposed', path: CLAIM_FIXTURE },
      maxCalls: 12, maxInputTokens: 60_000, maxOutputTokens: 8_000,
    }),
    questionVersion: 'claim_support.v1',
    questionId: 'claim_support',
    primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL,
    thresholds: {},
    fallback: 'legacy_judge',
    rolloutCapability: 'CLAIM_ASSESSMENT',
    calibration: {
      status: 'provisional',
      basis: 'Existing Stage 1 cascade values; no production calibration study has been completed.',
    },
    cascade: {
      escalateBelowConfidence: 0.5,
      auditSampleRate: 0.1,
      escalateCompound: true,
      highImpactCategories: [],
    },
    shadowBudget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 6_000 },
  },
  citation_support: {
    task: 'citation_support',
    ...governance({ task: 'citation_support', lifecycle: 'inactive',
      allowedOutcomes: ['supported', 'contradicted', 'insufficient_evidence', 'conflicting_evidence'],
      candidateGenerator: 'citation-source-binding', minimumSources: 1 }),
    questionVersion: 'citation_support.v1', questionId: 'citation_support', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: null,
    calibration: { status: 'provisional', basis: 'Registry placeholder only; there is no live consumer or production calibration.' },
  },
  passage_relevance: {
    task: 'passage_relevance',
    ...governance({ task: 'passage_relevance', lifecycle: 'active',
      allowedOutcomes: ['relevant', 'not_relevant'], candidateGenerator: 'governed-passage-candidates',
      minimumSources: 0, thresholdsByAction: { retain_relevant: 0.35, retain_usable: 0.5, abstain_below: 0.35 },
      maxRolloutMode: 'enforce', effect: 'filter_supplied_candidates', requiresHumanReview: false,
      maxCalls: 4, maxInputTokens: 60_000, maxOutputTokens: 4_000 }),
    questionVersion: 'passage_selection.v1', primitive: 'noul', modelVersion: DEFAULT_JEV_MODEL,
    thresholds: { relevant: 0.35, usable: 0.5, contradicts: 0.5 }, fallback: 'unfiltered',
    rolloutCapability: 'PASSAGE_SELECTION',
    calibration: { status: 'provisional', basis: 'Existing Stage 2 passage-selection values; no production calibration study has been completed.' },
  },
  conflict_detection: {
    task: 'conflict_detection',
    ...governance({ task: 'conflict_detection', lifecycle: 'inactive',
      allowedOutcomes: ['conflict', 'no_conflict', 'insufficient_evidence'],
      candidateGenerator: 'claim-conflict-candidates', minimumSources: 2 }),
    questionVersion: 'conflict_detection.v1', questionId: 'conflict_detection', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: null,
    calibration: { status: 'provisional', basis: 'Registry placeholder only; there is no live consumer or production calibration.' },
  },
  client_fit: {
    task: 'client_fit',
    ...governance({ task: 'client_fit', lifecycle: 'active',
      allowedOutcomes: ['explicit_linkage', 'conditional_linkage', 'capability_class_alignment', 'adjacency',
        'insufficient_evidence'], candidateGenerator: 'governed-client-fit-state',
      requiredMetadata: ['provenance', 'source_locator'], thresholdsByAction: { apply_label: 0.8, abstain_below: 0.8 },
      maxRolloutMode: 'enforce', effect: 'label_only', requiresHumanReview: false }),
    questionVersion: 'client_fit.v1', questionId: 'client_fit', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'MATCH_LABEL',
    calibration: { status: 'provisional', basis: 'No human-labelled client_fit.v1 evaluation has been completed.' },
  },
  status_selection: {
    task: 'status_selection',
    ...governance({ task: 'status_selection', lifecycle: 'shadow_only',
      allowedOutcomes: ['candidate_id', 'not_stated', 'ambiguous'], candidateGenerator: 'status-span-candidates',
      thresholdsByAction: { select_candidate: 0.9, abstain_below: 0.9 }, effect: 'filter_supplied_candidates' }),
    questionVersion: 'status_selection.v1', questionId: 'status_selection', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'STATUS_PROVENANCE',
    calibration: { status: 'provisional', basis: 'Bounded-candidate status selection is not wired to a live source adapter and has no production calibration.' },
  },
  program_identity: {
    task: 'program_identity',
    ...governance({ task: 'program_identity', lifecycle: 'shadow_only',
      allowedOutcomes: ['same_entity', 'related_entity', 'different_entity', 'insufficient_evidence'],
      candidateGenerator: 'qualified-program-alias-candidates',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'relation_scope', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { propose_same_entity: 0.99, abstain_below: 0.99 },
      evaluationSet: { id: 'package2_program_identity_v1', status: 'proposed', path: PACKAGE_2_FIXTURE },
      maxInputTokens: 16_000 }),
    questionVersion: 'program_identity.v1', questionId: 'program_identity', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Package 2 proposed fixtures only; no automatic entity merge is permitted.' },
  },
  mention_scope: {
    task: 'mention_scope',
    ...governance({ task: 'mention_scope', lifecycle: 'shadow_only',
      allowedOutcomes: ['pe_specific', 'project_specific', 'program_wide', 'capability_only', 'incidental',
        'insufficient_evidence'],
      candidateGenerator: 'qualified-legislative-mention-candidates',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'relation_scope', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { propose_scope: 0.95, abstain_below: 0.95 },
      evaluationSet: { id: 'package2_mention_scope_v1', status: 'proposed', path: PACKAGE_2_FIXTURE },
      maxInputTokens: 16_000 }),
    questionVersion: 'mention_scope.v1', questionId: 'mention_scope', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Package 2 proposed fixtures only; scope remains review-only.' },
  },
  evidence_selection: {
    task: 'evidence_selection',
    ...governance({ task: 'evidence_selection', lifecycle: 'shadow_only',
      allowedOutcomes: ['candidate_id', 'none', 'ambiguous'], candidateGenerator: 'bounded-evidence-span-candidates',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'financial_stage', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { select_candidate: 0.95, abstain_below: 0.95 },
      effect: 'filter_supplied_candidates',
      evaluationSet: { id: 'package2_evidence_selection_v1', status: 'proposed', path: PACKAGE_2_FIXTURE },
      maxInputTokens: 16_000 }),
    questionVersion: 'evidence_selection.v1', questionId: 'evidence_selection', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'unfiltered', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Package 2 proposed fixtures only; selections are bounded to supplied candidates.' },
  },
  bd_entity: {
    task: 'bd_entity',
    ...governance({ task: 'bd_entity', lifecycle: 'shadow_only',
      allowedOutcomes: ['same_legal_entity', 'related_not_same', 'different', 'insufficient_evidence'],
      candidateGenerator: 'bounded-bd-organization-descriptions',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'relation_scope', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { propose_same_legal_entity: 0.99, abstain_below: 0.99 },
      evaluationSet: { id: 'bd_entity_task_evaluation_v1', status: 'proposed', path: BD_FIXTURE },
      maxCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1_000,
      maxEstimatedCostUsd: 0.001,
      priceVersion: 'typesafe-public-2026-09-15-usd-0.042-per-million-input-v1' }),
    questionVersion: 'bd_entity.v1', questionId: 'bd_entity', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Proposed fixtures only; no human-reviewed BD-ENTITY evaluation exists. Advisory outcome; always requires human review and can never write canonical identity facts.' },
  },
  bd_signal: {
    task: 'bd_signal',
    ...governance({ task: 'bd_signal', lifecycle: 'shadow_only',
      allowedOutcomes: ['explicit_link', 'conditional_alignment', 'thematic_fit', 'unrelated',
        'insufficient_evidence'],
      candidateGenerator: 'bounded-bd-company-signal-pairs',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'financial_stage', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { label_explicit_link: 0.95, abstain_below: 0.95 },
      effect: 'label_only',
      evaluationSet: { id: 'bd_signal_task_evaluation_v1', status: 'proposed', path: BD_FIXTURE },
      maxCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1_000,
      maxEstimatedCostUsd: 0.001,
      priceVersion: 'typesafe-public-2026-09-15-usd-0.042-per-million-input-v1' }),
    questionVersion: 'bd_signal.v1', questionId: 'bd_signal', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Proposed fixtures only; no human-reviewed BD-SIGNAL evaluation exists. Label-only while shadow-only; explicit_link is a semantic suggestion that application code must independently verify against identifiers, record type, event/financial stage and locator before any direct label.' },
  },
  bd_claim: {
    task: 'bd_claim',
    ...governance({ task: 'bd_claim', lifecycle: 'shadow_only',
      allowedOutcomes: ['supported', 'contradicted', 'insufficient_evidence', 'conflicting_evidence'],
      candidateGenerator: 'bounded-bd-claim-exact-check-binding',
      requiredMetadata: ['authority', 'provenance', 'document_completeness', 'financial_stage', 'source_locator'],
      cacheFields: ['task', 'registry_version', 'question_version', 'question_hash', 'model_version',
        'envelope_hash', 'provenance', 'candidates'],
      thresholdsByAction: { propose_supported: 0.99, abstain_below: 0.99 },
      evaluationSet: { id: 'bd_claim_replay_v1', status: 'proposed', path: BD_CLAIM_FIXTURE },
      maxCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1_000,
      maxEstimatedCostUsd: 0.001,
      priceVersion: 'typesafe-public-2026-09-15-usd-0.042-per-million-input-v1' }),
    questionVersion: 'bd_claim.v1', questionId: 'bd_claim', primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL, thresholds: {}, fallback: 'no_change', rolloutCapability: 'JEV_PROVIDER',
    calibration: { status: 'provisional', basis: 'Proposed recorded replay fixtures only; no human-reviewed BD-CLAIM evaluation exists. Dark-only: shadow_only lifecycle, max rollout shadow, advisory outcome only, one-call budget, no live effect, no application caller is wired. Code-owned exact amount/identifier/date/source-locator/financial-stage validation precedes any semantic judgment; Jev cannot approve an exact mismatch. Not calibrated for semantic accuracy; not for use on non-claim text.' },
  },
};

export function resolveJevTaskRegistration(
  task: JevTask,
  config: JevConfig,
): { registration: JevTaskRegistration; modelMatches: boolean } {
  const registration = JEV_TASK_REGISTRY[task];
  return { registration, modelMatches: registration.modelVersion === config.model };
}

export function validateJevTaskEvidence(task: JevTask, envelope: EvidenceEnvelope): string[] {
  const requirements = JEV_TASK_REGISTRY[task].evidenceRequirements;
  const issues: string[] = [];
  if (envelope.sources.length < requirements.minimumSources) issues.push('minimum_sources');
  for (const metadata of requirements.requiredMetadata) {
    const missing = envelope.sources.some((source) => {
      if (metadata === 'authority') return !source.authority;
      if (metadata === 'provenance') return !source.provenance;
      if (metadata === 'document_completeness') return !source.documentCompleteness;
      if (metadata === 'relation_scope') return !source.relationScope;
      if (metadata === 'financial_stage') return source.financialStage == null;
      return !source.locator?.trim();
    });
    if (missing) issues.push(`missing_${metadata}`);
  }
  return issues;
}

/** Combine global provider enrollment with the registered per-task lifecycle ceiling. */
export function resolveJevTaskRollout(
  task: JevTask,
  config: JevConfig,
  providerMode: CapabilityRolloutMode,
): CapabilityRolloutMode {
  const registration = JEV_TASK_REGISTRY[task];
  if (!config.available || providerMode === 'off' || !config.tasks.includes(task)
    || registration.lifecycle === 'inactive' || registration.modelVersion !== config.model) return 'off';
  if (registration.maxRolloutMode === 'shadow' && providerMode === 'enforce') return 'shadow';
  return providerMode;
}

export function validateJevTaskRegistry(config: JevConfig): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const task of JEV_TASKS) {
    const registration = JEV_TASK_REGISTRY[task];
    if (!registration) { issues.push(`missing_registration:${task}`); continue; }
    if (registration.task !== task) issues.push(`task_identity_mismatch:${task}`);
    if (!registration.ownerRole.trim()) issues.push(`missing_owner:${task}`);
    if (!registration.allowedOutcomes.length
      || new Set(registration.allowedOutcomes).size !== registration.allowedOutcomes.length) {
      issues.push(`invalid_allowed_outcomes:${task}`);
    }
    if (registration.abstentionOutcomes.some((outcome) => !registration.allowedOutcomes.includes(outcome))) {
      issues.push(`invalid_abstention_outcome:${task}`);
    }
    if (!Number.isInteger(registration.evidenceRequirements.minimumSources)
      || registration.evidenceRequirements.minimumSources < 0) issues.push(`invalid_evidence_requirement:${task}`);
    if (!registration.candidateGenerator.id.trim() || !registration.candidateGenerator.version.trim()) {
      issues.push(`invalid_candidate_generator:${task}`);
    }
    const identityFields = new Set(registration.cacheIdentity.fields);
    if (!registration.cacheIdentity.version.trim()
      || !['task', 'question_version', 'question_hash', 'model_version'].every((field) => identityFields.has(field as JevCacheIdentityField))) {
      issues.push(`invalid_cache_identity:${task}`);
    }
    if (config.tasks.includes(task) && registration.modelVersion !== config.model) {
      issues.push(`model_mismatch:${task}:${registration.modelVersion}:${config.model}`);
    }
    for (const [name, value] of Object.entries({ ...registration.thresholds, ...registration.thresholdsByAction })) {
      if (!Number.isFinite(value) || value < 0 || value > 1) issues.push(`threshold_out_of_range:${task}:${name}`);
    }
    if (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 500 || registration.timeoutMs > 30_000) {
      issues.push(`invalid_timeout:${task}`);
    }
    if (registration.permittedEffect.canonicalFinancialWrite !== false) issues.push(`canonical_write_forbidden:${task}`);
    if (!registration.evaluationSet.id.trim()
      || (registration.evaluationSet.status !== 'missing' && !registration.evaluationSet.path)) {
      issues.push(`invalid_evaluation_set:${task}`);
    }
    const cost = registration.costBudget;
    if (!Number.isInteger(cost.maxCalls) || cost.maxCalls < 1
      || !Number.isInteger(cost.maxInputTokens) || cost.maxInputTokens < 1
      || !Number.isInteger(cost.maxOutputTokens) || cost.maxOutputTokens < 0
      || (cost.maxEstimatedCostUsd !== null
        && (!Number.isFinite(cost.maxEstimatedCostUsd) || cost.maxEstimatedCostUsd < 0))
      || !cost.priceVersion.trim()) issues.push(`invalid_cost_budget:${task}`);
    const rate = registration.cascade?.auditSampleRate;
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 1)) {
      issues.push(`audit_sample_rate_out_of_range:${task}`);
    }
    const confidence = registration.cascade?.escalateBelowConfidence;
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      issues.push(`cascade_confidence_out_of_range:${task}`);
    }
    const budget = registration.shadowBudget;
    if (budget && (!Number.isInteger(budget.maxClaims) || budget.maxClaims < 1
      || !Number.isInteger(budget.maxInputTokens) || budget.maxInputTokens < 1
      || !Number.isFinite(budget.deadlineMs) || budget.deadlineMs < 1)) {
      issues.push(`invalid_shadow_budget:${task}`);
    }
  }
  return { ok: issues.length === 0, issues };
}
