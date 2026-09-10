import { describe, expect, it } from '@jest/globals';
import {
  assertNoConfidentialEvaluationContent,
  buildInstitutionalContextControlProjection,
  computeEvaluationIdempotencyKey,
  computeEvaluationSamplingKey,
  decideEvaluationEligibility,
  deterministicUnitInterval,
  evaluationEnabled,
  evaluationSampleRate,
  shouldSampleForEvaluation,
  type EvaluationEligibilityInput,
} from './contract.js';

function baseEligibility(
  overrides: Partial<EvaluationEligibilityInput> = {},
): EvaluationEligibilityInput {
  return {
    enabled: true,
    contextPacketId: 'packet-1',
    institutionalItemCount: 3,
    authoritativeInputReplayable: true,
    operationSupported: true,
    providerAvailable: true,
    withinBudget: true,
    ...overrides,
  };
}

describe('evaluationEnabled', () => {
  it('is dark by default — only the literal "enabled" turns it on', () => {
    expect(evaluationEnabled(undefined)).toBe(false);
    expect(evaluationEnabled('')).toBe(false);
    expect(evaluationEnabled('true')).toBe(false);
    expect(evaluationEnabled('ENABLED')).toBe(true);
    expect(evaluationEnabled('  enabled  ')).toBe(true);
  });
});

describe('evaluationSampleRate', () => {
  it('defaults to 0 (no sampling) for missing/invalid input', () => {
    expect(evaluationSampleRate(undefined)).toBe(0);
    expect(evaluationSampleRate('not-a-number')).toBe(0);
  });
  it('clamps to [0, 1]', () => {
    expect(evaluationSampleRate('-0.5')).toBe(0);
    expect(evaluationSampleRate('0.05')).toBe(0.05);
    expect(evaluationSampleRate('5')).toBe(1);
  });
});

describe('decideEvaluationEligibility', () => {
  it('is eligible when every condition holds', () => {
    expect(decideEvaluationEligibility(baseEligibility())).toEqual({ eligible: true });
  });

  it('reports feature_disabled first, before any other condition', () => {
    expect(
      decideEvaluationEligibility(baseEligibility({ enabled: false, operationSupported: false })),
    ).toEqual({
      eligible: false,
      reason: 'feature_disabled',
    });
  });

  it('reports unsupported_operation', () => {
    expect(decideEvaluationEligibility(baseEligibility({ operationSupported: false }))).toEqual({
      eligible: false,
      reason: 'unsupported_operation',
    });
  });

  it('reports sensitive_operation', () => {
    expect(decideEvaluationEligibility(baseEligibility({ sensitive: true }))).toEqual({
      eligible: false,
      reason: 'sensitive_operation',
    });
  });

  it('reports missing_packet when no ContextPacket was resolved', () => {
    expect(decideEvaluationEligibility(baseEligibility({ contextPacketId: null }))).toEqual({
      eligible: false,
      reason: 'missing_packet',
    });
  });

  it('reports insufficient_authoritative_input when the request cannot be replayed deterministically', () => {
    expect(
      decideEvaluationEligibility(baseEligibility({ authoritativeInputReplayable: false })),
    ).toEqual({ eligible: false, reason: 'insufficient_authoritative_input' });
  });

  it('reports no_institutional_context when there is nothing to withhold', () => {
    expect(decideEvaluationEligibility(baseEligibility({ institutionalItemCount: 0 }))).toEqual({
      eligible: false,
      reason: 'no_institutional_context',
    });
  });

  it('reports provider_unavailable', () => {
    expect(decideEvaluationEligibility(baseEligibility({ providerAvailable: false }))).toEqual({
      eligible: false,
      reason: 'provider_unavailable',
    });
  });

  it('reports budget_exceeded', () => {
    expect(decideEvaluationEligibility(baseEligibility({ withinBudget: false }))).toEqual({
      eligible: false,
      reason: 'budget_exceeded',
    });
  });
});

describe('deterministicUnitInterval / shouldSampleForEvaluation', () => {
  it('is deterministic for the same key', () => {
    const key = computeEvaluationSamplingKey({
      tenantId: 't-1',
      operation: 'outreach.draft_version.generate',
      artifactId: 'draft-1',
    });
    const first = deterministicUnitInterval(key);
    const second = deterministicUnitInterval(key);
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
  });

  it('never samples at rate 0, always samples at rate 1', () => {
    expect(shouldSampleForEvaluation('any-key', 0)).toBe(false);
    expect(shouldSampleForEvaluation('any-key', 1)).toBe(true);
  });

  it('produces a roughly uniform distribution across many distinct keys at a mid rate', () => {
    let sampled = 0;
    const total = 2000;
    for (let i = 0; i < total; i += 1) {
      if (shouldSampleForEvaluation(`tenant:op:artifact-${i}`, 0.1)) sampled += 1;
    }
    const rate = sampled / total;
    expect(rate).toBeGreaterThan(0.05);
    expect(rate).toBeLessThan(0.15);
  });
});

describe('buildInstitutionalContextControlProjection', () => {
  it('strips items/rendered and leaves every other field untouched', () => {
    const packet = {
      packetId: 'packet-1',
      items: [{ id: 'i1', layer: 'firm-identity' }],
      rendered: [{ id: 'i1', layer: 'firm-identity', body: 'steering text' }],
      exclusions: [{ layer: 'client-people', reason: 'unauthorized' }],
      evidenceRefs: [{ domain: 'clients', recordId: 'c1' }],
      coverageManifest: { complete: true },
      subjectScope: { kind: 'client' },
    };
    const projection = buildInstitutionalContextControlProjection(packet);
    expect(projection.items).toEqual([]);
    expect(projection.rendered).toEqual([]);
    expect(projection.evaluationProjectionPolicy).toBe('withhold_all_institutional_layers');
    // Non-institutional fields are byte-identical.
    expect(projection.evidenceRefs).toBe(packet.evidenceRefs);
    expect(projection.coverageManifest).toBe(packet.coverageManifest);
    expect(projection.subjectScope).toBe(packet.subjectScope);
    // The original packet is never mutated.
    expect(packet.items).toHaveLength(1);
    expect(packet.rendered).toHaveLength(1);
  });

  it('records a withheld-layer exclusion for all five frozen layers, in addition to any pre-existing exclusion', () => {
    const packet = {
      items: [],
      rendered: [],
      exclusions: [{ layer: 'client-people', reason: 'unauthorized' }],
    };
    const projection = buildInstitutionalContextControlProjection(packet);
    const withheld = (projection.exclusions as Array<{ layer: string; reason: string }>).filter(
      (e) => e.reason === 'evaluation_control_withheld',
    );
    expect(withheld).toHaveLength(5);
    expect((projection.exclusions as unknown[]).length).toBe(6);
  });
});

describe('computeEvaluationIdempotencyKey', () => {
  it('is stable for the same input and distinguishes a new evaluationType/configVersion', () => {
    const base = {
      surface: 'outreach' as const,
      operation: 'outreach.draft_version.generate',
      treatmentArtifactId: 'draft-1',
      treatmentArtifactVersionSeq: 2,
      evaluationType: 'institutional_context_ablation' as const,
      configVersion: 'evaluation-config-v1',
    };
    expect(computeEvaluationIdempotencyKey(base)).toBe(computeEvaluationIdempotencyKey(base));
    expect(computeEvaluationIdempotencyKey(base)).not.toBe(
      computeEvaluationIdempotencyKey({ ...base, configVersion: 'evaluation-config-v2' }),
    );
  });
});

describe('assertNoConfidentialEvaluationContent', () => {
  it('allows numeric/enum-only metrics', () => {
    expect(() =>
      assertNoConfidentialEvaluationContent({
        metrics: { normalizedEditDistance: 0.3, ctaPresent: true },
        judge: null,
        cost: {
          model: 'gpt-5',
          inputTokens: 100,
          outputTokens: 50,
          providerDurationMs: 900,
          estimatedCostUsd: 0.01,
        },
      }),
    ).not.toThrow();
  });

  it('rejects a banned content-shaped key', () => {
    expect(() => assertNoConfidentialEvaluationContent({ metrics: { note: 'short' } })).toThrow(
      /banned field name/,
    );
  });

  it('rejects an over-long string value', () => {
    expect(() =>
      assertNoConfidentialEvaluationContent({ metrics: { reasonCode: 'x'.repeat(500) } }),
    ).toThrow(/carries a string/);
  });
});
