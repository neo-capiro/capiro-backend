import { describe, expect, it } from '@jest/globals';
import * as jevIndex from './index';
import { resolveJevConfig } from './jev-config';
import { JEV_TASK_REGISTRY, validateJevTaskRegistry, resolveJevTaskRollout } from './task-registry';
import {
  BD_CLAIM_QUESTION_ID,
  BD_CLAIM_QUESTION_VERSION,
  buildBdClaimQuestion,
} from './bd-claim-question';
import type { EvidenceEnvelope } from './decision-contract';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'c1',
  claimText: 'claim',
  claimKind: 'fact',
  claimCategory: 'bd_claim',
  tenantId: 'tenant',
  clientId: null,
  scopeQualifiers: [],
  asOf: null,
  sources: [
    {
      evidenceId: 'e1',
      sourceType: 'award',
      sourceId: 's1',
      documentId: 'd',
      version: 'v1',
      locator: 'line 1',
      passage: 'text',
      sourceDate: null,
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: null,
      authority: { sourceAuthority: 'USAspending', publisher: null, jurisdiction: 'US' },
      documentCompleteness: 'complete',
      relationScope: 'pe_specific',
      financialStage: 'awarded',
      provenance: {
        evidenceClass: 'official_budget_exhibit_mark_law',
        primary: true,
        authoritative: true,
      },
    },
  ],
};
const exactChecks = [
  {
    kind: 'amount' as const,
    claimValue: '1000000:USD',
    sourceValue: '1000000:USD',
    matchesExactly: true,
  },
  { kind: 'identifier' as const, claimValue: 'X1', sourceValue: 'X1', matchesExactly: true },
  {
    kind: 'date' as const,
    claimValue: '2026-01-01',
    sourceValue: '2026-01-01',
    matchesExactly: true,
  },
  {
    kind: 'source_locator' as const,
    claimValue: 'line 1',
    sourceValue: 'line 1',
    matchesExactly: true,
  },
  {
    kind: 'financial_stage' as const,
    claimValue: 'awarded',
    sourceValue: 'awarded',
    matchesExactly: true,
  },
];

describe('bd_claim registry contract (dark-only)', () => {
  it('is exported through the Jev index and keeps dark registry semantics', () => {
    expect(typeof jevIndex.buildBdClaimQuestion).toBe('function');
    expect(typeof jevIndex.evaluateBdClaimExactChecks).toBe('function');
    const registration = JEV_TASK_REGISTRY.bd_claim;
    expect(registration.lifecycle).toBe('shadow_only');
    expect(registration.maxRolloutMode).toBe('shadow');
    expect(registration.modelVersion).toBe('jev-1.13.0');
    expect(registration.questionVersion).toBe('bd_claim.v1');
    expect(registration.questionId).toBe('bd_claim');
    expect(registration.primitive).toBe('choice');
    expect(registration.allowedOutcomes).toEqual([
      'supported',
      'contradicted',
      'insufficient_evidence',
      'conflicting_evidence',
    ]);
    expect(registration.fallback).toBe('no_change');
    expect(registration.permittedEffect).toEqual({
      kind: 'advisory_only',
      canonicalFinancialWrite: false,
      requiresHumanReview: true,
    });
    expect(registration.evaluationSet.status).toBe('proposed');
    expect(registration.costBudget.maxCalls).toBe(1);
    expect(registration.costBudget.maxEstimatedCostUsd).toBe(0.001);
    expect(registration.costBudget.priceVersion).toBe(
      'typesafe-public-2026-09-15-usd-0.042-per-million-input-v1',
    );
    expect(registration.calibration.status).toBe('provisional');
    expect(registration.calibration.basis).toContain(
      'no human-reviewed BD-CLAIM evaluation exists',
    );
    expect(registration.calibration.basis).toContain('Jev cannot approve an exact mismatch');
    expect(registration.calibration.basis).toContain('not for use on non-claim text');
  });

  it('keeps the shadow ceiling: an enforce provider request resolves to shadow', () => {
    const config = resolveJevConfig({ TYPESAFE_API_KEY: 'key', MERI_JEV_TASKS: 'bd_claim' });
    expect(resolveJevTaskRollout('bd_claim', config, 'enforce')).toBe('shadow');
  });

  it('passes full registry validation including bd_claim', () => {
    expect(
      validateJevTaskRegistry(
        resolveJevConfig({
          TYPESAFE_API_KEY: 'key',
          MERI_JEV_TASKS: 'bd_claim',
        }),
      ),
    ).toEqual({ ok: true, issues: [] });
  });

  it('exposes a versioned question id/version consistent with the registry', () => {
    expect(BD_CLAIM_QUESTION_ID).toBe('bd_claim');
    expect(BD_CLAIM_QUESTION_VERSION).toBe(JEV_TASK_REGISTRY.bd_claim.questionVersion);
    const question = buildBdClaimQuestion({ claim: { text: 'c' }, exactChecks, envelope });
    expect(Object.keys(question.questions)).toEqual(['bd_claim']);
    const choice = question.questions.bd_claim!;
    if (choice.type !== 'choice') throw new Error('expected Choice');
    expect(Object.keys(choice.criteria).sort()).toEqual([
      'conflicting_evidence',
      'contradicted',
      'insufficient_evidence',
      'supported',
    ]);
    expect(choice.instructions).toContain('untrusted data');
    expect(choice.instructions).toContain('requires human review');
  });

  it('rejects a stale true flag when canonical exact-check values differ', () => {
    const stale = exactChecks.map((check) =>
      check.kind === 'amount'
        ? { ...check, sourceValue: '999999:USD', matchesExactly: true as const }
        : check,
    );
    expect(() =>
      buildBdClaimQuestion({ claim: { text: 'c' }, exactChecks: stale, envelope }),
    ).toThrow('canonical_values_differ');
  });
});
