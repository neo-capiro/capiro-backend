import type { ClaimCategory } from '../assurance/evidence-plan';
import { DEFAULT_JEV_MODEL, JEV_TASKS, type JevConfig, type JevTask } from './jev-config';

export const JEV_TASK_REGISTRY_VERSION = 'jev-task-registry.v1' as const;

export interface JevTaskRegistration {
  task: JevTask;
  questionVersion: string;
  questionId?: string;
  primitive: 'choice' | 'noul' | 'score';
  /** Pinned model against which this task's thresholds were evaluated. */
  modelVersion: string;
  thresholds: Readonly<Record<string, number>>;
  fallback: 'legacy_judge' | 'unfiltered' | 'no_change';
  rolloutCapability: string | null;
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

export const JEV_TASK_REGISTRY: Readonly<Record<JevTask, JevTaskRegistration>> = {
  claim_support: {
    task: 'claim_support',
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
    questionVersion: 'citation_support.v1',
    questionId: 'citation_support',
    primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL,
    thresholds: {},
    fallback: 'no_change',
    rolloutCapability: null,
    calibration: {
      status: 'provisional',
      basis: 'Registry placeholder only; there is no live consumer or production calibration.',
    },
  },
  passage_relevance: {
    task: 'passage_relevance',
    questionVersion: 'passage_selection.v1',
    primitive: 'noul',
    modelVersion: DEFAULT_JEV_MODEL,
    thresholds: { relevant: 0.35, usable: 0.5, contradicts: 0.5 },
    fallback: 'unfiltered',
    rolloutCapability: 'PASSAGE_SELECTION',
    calibration: {
      status: 'provisional',
      basis: 'Existing Stage 2 passage-selection values; no production calibration study has been completed.',
    },
  },
  conflict_detection: {
    task: 'conflict_detection',
    questionVersion: 'conflict_detection.v1',
    questionId: 'conflict_detection',
    primitive: 'choice',
    modelVersion: DEFAULT_JEV_MODEL,
    thresholds: {},
    fallback: 'no_change',
    rolloutCapability: null,
    calibration: {
      status: 'provisional',
      basis: 'Registry placeholder only; there is no live consumer or production calibration.',
    },
  },
};

export function resolveJevTaskRegistration(
  task: JevTask,
  config: JevConfig,
): { registration: JevTaskRegistration; modelMatches: boolean } {
  const registration = JEV_TASK_REGISTRY[task];
  return { registration, modelMatches: registration.modelVersion === config.model };
}

export function validateJevTaskRegistry(config: JevConfig): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const task of JEV_TASKS) {
    const registration = JEV_TASK_REGISTRY[task];
    if (!registration) {
      issues.push(`missing_registration:${task}`);
      continue;
    }
    if (config.tasks.includes(task) && registration.modelVersion !== config.model) {
      issues.push(`model_mismatch:${task}:${registration.modelVersion}:${config.model}`);
    }
    for (const [name, value] of Object.entries(registration.thresholds)) {
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        issues.push(`threshold_out_of_range:${task}:${name}`);
      }
    }
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
