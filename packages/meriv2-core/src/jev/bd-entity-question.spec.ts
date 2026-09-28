import { describe, expect, it } from '@jest/globals';
import { hashEvidenceEnvelope, type EvidenceEnvelope } from './decision-contract';
import { JevMalformedResponseError, JevTimeoutError } from './jev-client';
import {
  BD_ENTITY_MAX_EVIDENCE,
  buildBdEntityQuestion,
  bdEntityOrganizationSchema,
} from './bd-entity-question';
import { createJevChoiceTaskProvider } from './task-choice-provider';

const source = (id: string): EvidenceEnvelope['sources'][number] => ({
  evidenceId: id,
  sourceType: 'registry',
  sourceId: `source-${id}`,
  documentId: 'doc',
  version: 'v1',
  locator: 'record header',
  passage: 'Registered organization record.',
  sourceDate: null,
  publishedAt: null,
  effectiveAt: null,
  retrievedAt: null,
  authority: { sourceAuthority: 'SAM.gov', publisher: 'GSA', jurisdiction: 'US' },
  documentCompleteness: 'complete',
  relationScope: 'pe_specific',
  financialStage: null,
  provenance: {
    evidenceClass: 'primary_legislative_legal_text',
    primary: true,
    authoritative: true,
  },
});
const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'c',
  claimText: 'Are these the same entity?',
  claimKind: 'fact',
  claimCategory: 'bd_entity',
  tenantId: 'tenant',
  clientId: null,
  scopeQualifiers: [],
  asOf: null,
  sources: [source('e1'), source('e2')],
};
const organizationA = {
  name: 'Apex Defense Systems LLC',
  identifiers: [{ kind: 'uei' as const, value: 'UEI123' }],
};
const organizationB = { name: 'Apex Defense Systems, LLC', legalName: 'Apex Defense Systems LLC' };

function provider(systemOne: (...args: unknown[]) => Promise<unknown>) {
  return createJevChoiceTaskProvider({
    task: 'bd_entity',
    model: 'jev-1.13.0',
    scope: { tenantId: 'tenant', surface: 'chat' },
    client: { systemOne } as never,
  });
}

function response(confidence = 0.99, choice = 'same_legal_entity') {
  return {
    response: {
      model: 'jev-1.13.0',
      answers: {
        bd_entity: {
          type: 'choice',
          choice,
          confidence,
          probabilities: {
            same_legal_entity: choice === 'same_legal_entity' ? confidence : 0.01,
            related_not_same: choice === 'related_not_same' ? confidence : 0.01,
            different: choice === 'different' ? confidence : 0.01,
            insufficient_evidence: choice === 'insufficient_evidence' ? confidence : 0.01,
          },
        },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    },
    latencyMs: 4,
    attempts: 1,
  };
}

describe('bd_entity question builder', () => {
  it('binds the envelope hash and only the two bounded organization descriptions plus evidence', () => {
    const question = buildBdEntityQuestion({ organizationA, organizationB, envelope });
    const state = question.state as Record<string, unknown>;
    expect(state.envelopeHash).toBe(hashEvidenceEnvelope(envelope));
    expect(Object.keys(state).sort()).toEqual([
      'envelopeHash',
      'evidence',
      'organizationA',
      'organizationB',
    ]);
    expect(question.questions.bd_entity?.type).toBe('choice');
    if (question.questions.bd_entity?.type !== 'choice') throw new Error('expected Choice');
    expect(Object.keys(question.questions.bd_entity.criteria).sort()).toEqual([
      'different',
      'insufficient_evidence',
      'related_not_same',
      'same_legal_entity',
    ]);
    expect(question.questions.bd_entity.instructions).toContain('advisory');
    expect(question.questions.bd_entity.instructions).toContain('untrusted data');
  });

  it('excludes forbidden fields at the runtime boundary', () => {
    expect(() =>
      bdEntityOrganizationSchema.parse({ ...organizationA, notes: 'private note' }),
    ).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({ ...organizationA, conflictReason: 'x' }),
    ).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({ ...organizationA, contacts: [{ email: 'a@b.c' }] }),
    ).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({ ...organizationA, dossier: { arbitrary: true } }),
    ).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({ ...organizationA, serviceHypotheses: ['x'] }),
    ).toThrow();
    expect(() => bdEntityOrganizationSchema.parse({ name: 'x'.repeat(2_001) })).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({
        name: 'x',
        identifiers: Array.from({ length: 9 }, (_, i) => ({
          kind: 'uei' as const,
          value: `v${i}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      bdEntityOrganizationSchema.parse({ name: 'x', registrationJurisdiction: 'y'.repeat(257) }),
    ).toThrow();
  });

  it('rejects duplicate, missing, out-of-envelope and oversized evidence', () => {
    expect(() =>
      buildBdEntityQuestion({
        organizationA,
        organizationB,
        envelope: { ...envelope, sources: [] },
      }),
    ).toThrow(/requires envelope evidence/);
    expect(() =>
      buildBdEntityQuestion({ organizationA, organizationB, envelope, evidenceIds: ['e1', 'e1'] }),
    ).toThrow(/unique/);
    expect(() =>
      buildBdEntityQuestion({ organizationA, organizationB, envelope, evidenceIds: ['missing'] }),
    ).toThrow(/not in the envelope/);
    expect(() =>
      buildBdEntityQuestion({
        organizationA,
        organizationB,
        envelope: {
          ...envelope,
          sources: Array.from({ length: BD_ENTITY_MAX_EVIDENCE + 1 }, (_, i) => source(`e${i}`)),
        },
      }),
    ).toThrow(/16-item limit/);
  });
});

describe('bd_entity provider behavior', () => {
  const question = buildBdEntityQuestion({ organizationA, organizationB, envelope });

  it('returns a propose outcome for a high-confidence same_legal_entity answer', async () => {
    const result = await provider(async () => response()).assess(envelope, question);
    expect(result).toMatchObject({
      kind: 'outcome',
      task: 'bd_entity',
      outcome: 'same_legal_entity',
      action: 'propose',
      evidenceIds: ['e1', 'e2'],
      provider: { questionVersion: 'bd_entity.v1' },
    });
  });

  it('abstains on insufficient_evidence and below the action threshold', async () => {
    const abstaining = await provider(async () => response(0.99, 'insufficient_evidence')).assess(
      envelope,
      question,
    );
    expect(abstaining).toMatchObject({
      kind: 'outcome',
      action: 'abstain',
      reasonCodes: ['abstention_outcome'],
    });
    const lowConfidence = await provider(async () => response(0.5)).assess(envelope, question);
    expect(lowConfidence).toMatchObject({
      kind: 'outcome',
      action: 'abstain',
      reasonCodes: ['below_action_threshold'],
    });
  });

  it('maps timeout and malformed responses to failure states without an outcome', async () => {
    expect(
      await provider(async () => {
        throw new JevTimeoutError();
      }).assess(envelope, question),
    ).toMatchObject({ kind: 'failure', state: 'timeout' });
    expect(
      await provider(async () => {
        throw new JevMalformedResponseError();
      }).assess(envelope, question),
    ).toMatchObject({ kind: 'failure', state: 'malformed_response' });
  });

  it('refuses a cross-tenant scope before any provider call', async () => {
    const result = await provider(async () => response()).assess(
      { ...envelope, tenantId: 'other' },
      question,
    );
    expect(result).toMatchObject({ kind: 'failure', state: 'scope_refused' });
  });

  it('refuses an unbound question (different envelope) before any provider call', async () => {
    let calls = 0;
    const differentEnvelope = {
      ...envelope,
      sources: envelope.sources.map((s) => ({ ...s, passage: 'Other' })),
    };
    const unbound = buildBdEntityQuestion({
      organizationA,
      organizationB,
      envelope: differentEnvelope,
    });
    expect(
      await provider(async () => {
        calls += 1;
        return response();
      }).assess(envelope, unbound),
    ).toMatchObject({
      kind: 'failure',
      state: 'judge_unavailable',
      reasonCodes: ['request_rejected'],
    });
    expect(calls).toBe(0);
  });

  it('rejects malformed answers with unregistered outcomes', async () => {
    const badOutcome = {
      response: {
        model: 'jev-1.13.0',
        answers: {
          bd_entity: {
            type: 'choice',
            choice: 'definitely_same',
            confidence: 0.99,
            probabilities: { definitely_same: 0.99 },
          },
        },
        usage: { input_tokens: 10, output_tokens: 2 },
      },
      latencyMs: 4,
      attempts: 1,
    };
    expect(await provider(async () => badOutcome).assess(envelope, question)).toMatchObject({
      kind: 'failure',
      state: 'malformed_response',
    });
  });

  it('refuses input-token overruns without an actionable outcome', async () => {
    let calls = 0;
    const oversized = buildBdEntityQuestion({
      organizationA,
      organizationB,
      envelope,
      evidenceIds: undefined,
    });
    const oversizedState = oversized.state as { organizationA: { name: string } };
    oversizedState.organizationA = { name: 'x'.repeat(70_000) };
    expect(
      await provider(async () => {
        calls += 1;
        return response();
      }).assess(envelope, oversized),
    ).toMatchObject({
      kind: 'failure',
      state: 'repair_budget_exhausted',
      reasonCodes: ['input_token_budget_exceeded'],
    });
    expect(calls).toBe(0);
  });
});
