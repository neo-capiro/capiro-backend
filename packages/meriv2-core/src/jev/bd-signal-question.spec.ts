import { describe, expect, it } from '@jest/globals';
import { hashEvidenceEnvelope, type EvidenceEnvelope } from './decision-contract';
import { JevMalformedResponseError, JevTimeoutError } from './jev-client';
import {
  BD_SIGNAL_MAX_EVIDENCE,
  BD_SIGNAL_MAX_SIGNALS,
  bdSignalInputSchema,
  buildBdSignalQuestion,
} from './bd-signal-question';
import { createJevChoiceTaskProvider } from './task-choice-provider';
import { JEV_TASK_REGISTRY } from './task-registry';

const source = (id: string): EvidenceEnvelope['sources'][number] => ({
  evidenceId: id, sourceType: 'budget', sourceId: `source-${id}`, documentId: 'doc', version: 'v1',
  locator: 'award line 1', passage: 'Award to recipient organization.',
  sourceDate: null, publishedAt: null, effectiveAt: null, retrievedAt: null,
  authority: { sourceAuthority: 'USAspending', publisher: 'Treasury', jurisdiction: 'US' },
  documentCompleteness: 'complete', relationScope: 'pe_specific', financialStage: 'awarded',
  provenance: { evidenceClass: 'official_budget_exhibit_mark_law', primary: true, authoritative: true },
});
const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c', claimText: 'Is this signal explicit?',
  claimKind: 'fact', claimCategory: 'bd_signal', tenantId: 'tenant', clientId: null,
  scopeQualifiers: [], asOf: null, sources: [source('e1')],
};
const input = {
  company: { name: 'Corvus Analytics Inc', description: 'A defense data analytics firm.' },
  signals: [{ recordType: 'award' as const, text: 'Award for data analytics services.', financialStage: 'awarded' as const }],
};

function provider(systemOne: (...args: unknown[]) => Promise<unknown>) {
  return createJevChoiceTaskProvider({ task: 'bd_signal', model: 'jev-1.13.0',
    scope: { tenantId: 'tenant', surface: 'chat' }, client: { systemOne } as never });
}

function response(confidence = 0.95, choice = 'explicit_link') {
  const outcomes = ['explicit_link', 'conditional_alignment', 'thematic_fit', 'unrelated', 'insufficient_evidence'];
  return { response: { model: 'jev-1.13.0', answers: {
    bd_signal: { type: 'choice', choice, confidence,
      probabilities: Object.fromEntries(outcomes.map((o) => [o, o === choice ? confidence : 0.01])) },
  }, usage: { input_tokens: 10, output_tokens: 2 } }, latencyMs: 4, attempts: 1 };
}

describe('bd_signal question builder', () => {
  it('binds the envelope hash, company and signals only, and documents code verification', () => {
    const question = buildBdSignalQuestion({ ...input, envelope });
    const state = question.state as Record<string, unknown>;
    expect(state.envelopeHash).toBe(hashEvidenceEnvelope(envelope));
    expect(Object.keys(state).sort()).toEqual(['company', 'envelopeHash', 'evidence', 'signals']);
    const choice = question.questions.bd_signal!;
    if (choice.type !== 'choice') throw new Error('expected Choice');
    expect(Object.keys(choice.criteria).sort()).toEqual(['conditional_alignment', 'explicit_link',
      'insufficient_evidence', 'thematic_fit', 'unrelated']);
    expect(choice.instructions).toContain('explicit_link is only a semantic suggestion');
    expect(choice.instructions).toContain('identifiers, record type, event/financial stage and locator');
    expect(choice.instructions).toContain('untrusted data');
  });

  it('excludes forbidden fields at the runtime boundary', () => {
    expect(() => bdSignalInputSchema.parse({ ...input, notes: 'private' })).toThrow();
    expect(() => bdSignalInputSchema.parse({ ...input, contact: { email: 'a@b.c' } })).toThrow();
    expect(() => bdSignalInputSchema.parse({ ...input, conflictReason: 'x' })).toThrow();
    expect(() => bdSignalInputSchema.parse({ ...input, serviceHypotheses: ['x'] })).toThrow();
    expect(() => bdSignalInputSchema.parse({ ...input, dossier: 'blob' })).toThrow();
    expect(() => bdSignalInputSchema.parse({ company: { ...input.company, description: 'y'.repeat(2_001) },
      signals: input.signals })).toThrow();
    expect(() => bdSignalInputSchema.parse({ company: input.company, signals:
      [{ ...input.signals[0]!, text: 'x'.repeat(4_001) }] })).toThrow();
    expect(() => bdSignalInputSchema.parse({ company: input.company,
      signals: Array.from({ length: BD_SIGNAL_MAX_SIGNALS + 1 }, (_, i) =>
        ({ recordType: 'award' as const, text: `s${i}`, financialStage: 'awarded' as const })) })).toThrow();
    expect(() => bdSignalInputSchema.parse({ company: input.company, signals: [] })).toThrow();
  });

  it('rejects duplicate, missing, out-of-envelope and oversized evidence', () => {
    expect(() => buildBdSignalQuestion({ ...input, envelope: { ...envelope, sources: [] } }))
      .toThrow(/requires envelope evidence/);
    expect(() => buildBdSignalQuestion({ ...input, envelope, evidenceIds: ['e1', 'e1'] })).toThrow(/unique/);
    expect(() => buildBdSignalQuestion({ ...input, envelope, evidenceIds: ['missing'] }))
      .toThrow(/not in the envelope/);
    expect(() => buildBdSignalQuestion({ ...input, envelope: { ...envelope,
      sources: Array.from({ length: BD_SIGNAL_MAX_EVIDENCE + 1 }, (_, i) => source(`e${i}`)) } }))
      .toThrow(/16-item limit/);
  });
});

describe('bd_signal provider behavior', () => {
  const question = buildBdSignalQuestion({ ...input, envelope });

  it('returns a propose outcome for a high-confidence explicit_link answer', async () => {
    const result = await provider(async () => response()).assess(envelope, question);
    expect(result).toMatchObject({ kind: 'outcome', task: 'bd_signal', outcome: 'explicit_link',
      action: 'propose', evidenceIds: ['e1'], provider: { questionVersion: 'bd_signal.v1' } });
  });

  it('abstains on insufficient_evidence and below the action threshold', async () => {
    expect(await provider(async () => response(0.95, 'insufficient_evidence')).assess(envelope, question))
      .toMatchObject({ kind: 'outcome', action: 'abstain', reasonCodes: ['abstention_outcome'] });
    expect(await provider(async () => response(0.5)).assess(envelope, question))
      .toMatchObject({ kind: 'outcome', action: 'abstain', reasonCodes: ['below_action_threshold'] });
  });

  it('maps timeout and malformed responses to failure states without an outcome', async () => {
    expect(await provider(async () => { throw new JevTimeoutError(); }).assess(envelope, question))
      .toMatchObject({ kind: 'failure', state: 'timeout' });
    expect(await provider(async () => { throw new JevMalformedResponseError(); }).assess(envelope, question))
      .toMatchObject({ kind: 'failure', state: 'malformed_response' });
  });

  it('refuses a cross-tenant scope before any provider call', async () => {
    expect(await provider(async () => response()).assess({ ...envelope, tenantId: 'other' }, question))
      .toMatchObject({ kind: 'failure', state: 'scope_refused' });
  });

  it('refuses provider-reported token overruns without an actionable outcome', async () => {
    expect(await provider(async () => { const r = response(); r.response.usage.input_tokens = 16_001; return r; })
      .assess(envelope, question))
      .toMatchObject({ kind: 'failure', state: 'repair_budget_exhausted',
        reasonCodes: ['provider_token_budget_exceeded'] });
  });
});

describe('bd tasks registry dark defaults', () => {
  it('keeps both BD tasks shadow_only with no canonical write and required human review', () => {
    for (const task of ['bd_entity', 'bd_signal'] as const) {
      const registration = JEV_TASK_REGISTRY[task];
      expect(registration.lifecycle).toBe('shadow_only');
      expect(registration.maxRolloutMode).toBe('shadow');
      expect(registration.modelVersion).toBe('jev-1.13.0');
      expect(registration.fallback).toBe('no_change');
      expect(registration.permittedEffect.canonicalFinancialWrite).toBe(false);
      expect(registration.permittedEffect.requiresHumanReview).toBe(true);
      expect(registration.rolloutCapability).toBe('JEV_PROVIDER');
      expect(registration.costBudget.maxCalls).toBeGreaterThanOrEqual(1);
      expect(registration.costBudget.maxEstimatedCostUsd).toBe(0.001);
      expect(registration.costBudget.priceVersion)
        .toBe('typesafe-public-2026-09-15-usd-0.042-per-million-input-v1');
      expect(registration.evaluationSet.status).toBe('proposed');
      expect(registration.calibration.status).toBe('provisional');
    }
    expect(JEV_TASK_REGISTRY.bd_entity.permittedEffect.kind).toBe('advisory_only');
    expect(JEV_TASK_REGISTRY.bd_signal.permittedEffect.kind).toBe('label_only');
  });
});
