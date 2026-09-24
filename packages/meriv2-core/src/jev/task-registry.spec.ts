import { describe, expect, it } from '@jest/globals';
import { resolveJevConfig, JEV_TASKS } from './jev-config';
import {
  JEV_TASK_REGISTRY,
  JEV_TASK_REGISTRY_VERSION,
  resolveJevTaskRegistration,
  resolveJevTaskRollout,
  validateJevTaskEvidence,
  validateJevTaskRegistry,
} from './task-registry';

const liveConfig = () => resolveJevConfig({
  TYPESAFE_API_KEY: 'test-key',
  MERI_JEV_MODEL: 'jev-1.13.0',
  MERI_JEV_TASKS: 'claim_support,passage_relevance',
  MERI_CHAT_EVIDENCE_JUDGE: 'paired',
  MERI_JEV_TIMEOUT_MS: '8000',
  MERI_JEV_MAX_ATTEMPTS: '2',
});

describe('Jev task registry', () => {
  it('covers every configured task and preserves the live constants', () => {
    expect(JEV_TASK_REGISTRY_VERSION).toBe('jev-task-registry.v4');
    expect(Object.keys(JEV_TASK_REGISTRY).sort()).toEqual([...JEV_TASKS].sort());
    expect(JEV_TASK_REGISTRY.claim_support).toMatchObject({
      questionVersion: 'claim_support.v1', questionId: 'claim_support', primitive: 'choice',
      modelVersion: 'jev-1.13.0', fallback: 'legacy_judge', rolloutCapability: 'CLAIM_ASSESSMENT',
      cascade: { escalateBelowConfidence: 0.5, auditSampleRate: 0.1, escalateCompound: true,
        highImpactCategories: [] },
      shadowBudget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 6_000 },
    });
    expect(JEV_TASK_REGISTRY.claim_support.calibration.status).toBe('provisional');
    expect(JEV_TASK_REGISTRY.passage_relevance).toMatchObject({
      questionVersion: 'passage_selection.v1', primitive: 'noul', modelVersion: 'jev-1.13.0',
      thresholds: { relevant: 0.35, usable: 0.5, contradicts: 0.5 },
      fallback: 'unfiltered', rolloutCapability: 'PASSAGE_SELECTION',
    });
    expect(JEV_TASK_REGISTRY.client_fit).toMatchObject({
      questionVersion: 'client_fit.v1', questionId: 'client_fit', primitive: 'choice',
      modelVersion: 'jev-1.13.0', fallback: 'no_change', rolloutCapability: 'MATCH_LABEL',
      calibration: { status: 'provisional' },
    });
    expect(JEV_TASK_REGISTRY.program_identity).toMatchObject({
      ownerRole: 'model/evaluation lead', lifecycle: 'shadow_only', questionVersion: 'program_identity.v1',
      allowedOutcomes: ['same_entity', 'related_entity', 'different_entity', 'insufficient_evidence'],
      thresholdsByAction: { propose_same_entity: 0.99, abstain_below: 0.99 },
      permittedEffect: { kind: 'advisory_only', canonicalFinancialWrite: false, requiresHumanReview: true },
      evaluationSet: { id: 'package2_program_identity_v1', status: 'proposed' },
      costBudget: { maxCalls: 1, maxInputTokens: 16_000, maxEstimatedCostUsd: null },
    });
    expect(JEV_TASK_REGISTRY.mention_scope.maxRolloutMode).toBe('shadow');
    expect(JEV_TASK_REGISTRY.evidence_selection.cacheIdentity.fields).toEqual(expect.arrayContaining([
      'task', 'question_hash', 'provenance', 'candidates',
    ]));
  });

  it('applies task enablement and the registered shadow ceiling', () => {
    const config = resolveJevConfig({ TYPESAFE_API_KEY: 'test-key', MERI_JEV_MODEL: 'jev-1.13.0',
      MERI_JEV_TASKS: 'program_identity,claim_support' });
    expect(resolveJevTaskRollout('program_identity', config, 'enforce')).toBe('shadow');
    expect(resolveJevTaskRollout('claim_support', config, 'enforce')).toBe('enforce');
    expect(resolveJevTaskRollout('mention_scope', config, 'shadow')).toBe('off');
  });

  it('refuses a Package 2 task envelope that drops required provenance metadata', () => {
    expect(validateJevTaskEvidence('program_identity', {
      envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c', claimText: 'alias', claimKind: 'fact',
      claimCategory: 'program_identity', tenantId: 'tenant', clientId: null, scopeQualifiers: [], asOf: null,
      sources: [{ evidenceId: 'e', sourceType: 'document', sourceId: 's', documentId: 'd', version: 'v1',
        locator: 'section 1', passage: 'alias', sourceDate: null, publishedAt: null, effectiveAt: null,
        retrievedAt: null }],
    })).toEqual(['missing_authority', 'missing_provenance', 'missing_document_completeness', 'missing_relation_scope']);
  });

  it('is identity-compatible with the exact live Jev environment', () => {
    const config = liveConfig();
    expect(validateJevTaskRegistry(config)).toEqual({ ok: true, issues: [] });
    expect(resolveJevTaskRegistration('passage_relevance', config)).toMatchObject({ modelMatches: true });
    expect(resolveJevTaskRegistration('claim_support', config)).toMatchObject({ modelMatches: true });
  });

  it('reports model mismatches for enabled tasks', () => {
    const config = { ...liveConfig(), model: 'jev-1.14.0' };
    expect(validateJevTaskRegistry(config)).toEqual({ ok: false, issues: [
      'model_mismatch:claim_support:jev-1.13.0:jev-1.14.0',
      'model_mismatch:passage_relevance:jev-1.13.0:jev-1.14.0',
    ] });
  });

  it('catches out-of-range thresholds and sample rates', () => {
    const passage = JEV_TASK_REGISTRY.passage_relevance;
    const claim = JEV_TASK_REGISTRY.claim_support;
    const originalThresholds = passage.thresholds;
    const originalCascade = claim.cascade;
    try {
      (passage as JevMutable).thresholds = { relevant: 1.1 };
      (claim as JevMutable).cascade = { ...originalCascade!, auditSampleRate: -0.1 };
      expect(validateJevTaskRegistry(liveConfig()).issues).toEqual(expect.arrayContaining([
        'threshold_out_of_range:passage_relevance:relevant',
        'audit_sample_rate_out_of_range:claim_support',
      ]));
    } finally {
      (passage as JevMutable).thresholds = originalThresholds;
      (claim as JevMutable).cascade = originalCascade;
    }
  });

  it('rejects an invalid shadow budget', () => {
    const claim = JEV_TASK_REGISTRY.claim_support;
    const original = claim.shadowBudget;
    try {
      (claim as JevMutable).shadowBudget = { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 0 };
      expect(validateJevTaskRegistry(liveConfig()).issues).toContain('invalid_shadow_budget:claim_support');
    } finally {
      (claim as JevMutable).shadowBudget = original;
    }
  });
});

type JevMutable = {
  thresholds: Readonly<Record<string, number>>;
  cascade?: typeof JEV_TASK_REGISTRY.claim_support.cascade;
  shadowBudget?: typeof JEV_TASK_REGISTRY.claim_support.shadowBudget;
};
