import { describe, expect, it } from '@jest/globals';
import type { EvidenceEnvelope } from './decision-contract';
import { JevMalformedResponseError, JevTimeoutError } from './jev-client';
import { buildEvidenceSelectionQuestion } from './evidence-selection-question';
import { buildProgramIdentityQuestion } from './program-identity-question';
import { createJevChoiceTaskProvider } from './task-choice-provider';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'c',
  claimText: 'The AEGIS alias appears.',
  claimKind: 'fact',
  claimCategory: 'program_identity',
  tenantId: 'tenant',
  clientId: null,
  scopeQualifiers: [],
  asOf: null,
  sources: [
    {
      evidenceId: 'e',
      sourceType: 'legislative',
      sourceId: 's',
      documentId: 'd',
      version: 'v1',
      locator: 'section 2',
      passage: 'AEGIS',
      sourceDate: null,
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: null,
      authority: { sourceAuthority: 'Congress', publisher: 'Congress', jurisdiction: 'US' },
      documentCompleteness: 'complete',
      relationScope: 'program_wide',
      financialStage: null,
      provenance: {
        evidenceClass: 'primary_legislative_legal_text',
        primary: true,
        authoritative: true,
      },
    },
  ],
};
const question = buildProgramIdentityQuestion({
  mention: 'AEGIS',
  candidateProgram: { id: 'aegis', name: 'Aegis Combat System' },
  envelope,
});

function provider(systemOne: (...args: unknown[]) => Promise<unknown>) {
  return createJevChoiceTaskProvider({
    task: 'program_identity',
    model: 'jev-1.13.0',
    scope: { tenantId: 'tenant', surface: 'chat' },
    client: { systemOne } as never,
  });
}

function response(inputTokens = 10, outputTokens = 2) {
  return {
    response: {
      model: 'jev-1.13.0',
      answers: {
        program_identity: {
          type: 'choice',
          choice: 'same_entity',
          confidence: 0.98,
          probabilities: {
            same_entity: 0.98,
            related_entity: 0.01,
            different_entity: 0,
            insufficient_evidence: 0.01,
          },
        },
      },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
    latencyMs: 4,
    attempts: 1,
  };
}

describe('Jev Choice task provider', () => {
  it('binds evidence identity, applies the task threshold and caps the deadline', async () => {
    let deadlineAt: number | undefined;
    let maxAttempts: number | undefined;
    const started = Date.now();
    const result = await provider(async (_request, options) => {
      deadlineAt = (options as { deadlineAt?: number }).deadlineAt;
      maxAttempts = (options as { maxAttempts?: number }).maxAttempts;
      return response();
    }).assess(envelope, question);
    expect(result).toMatchObject({
      kind: 'outcome',
      task: 'program_identity',
      outcome: 'same_entity',
      action: 'abstain',
      evidenceIds: ['e'],
      reasonCodes: ['below_action_threshold'],
      provider: { questionVersion: 'program_identity.v1' },
    });
    expect(deadlineAt).toBeGreaterThanOrEqual(started);
    expect(deadlineAt).toBeLessThanOrEqual(started + 8_100);
    expect(maxAttempts).toBe(1);
  });

  it.each([
    [new JevTimeoutError(), 'timeout'],
    [new JevMalformedResponseError(), 'malformed_response'],
  ])('maps provider failure %s without emitting an outcome', async (error, state) => {
    const result = await provider(async () => {
      throw error;
    }).assess(envelope, question);
    expect(result).toMatchObject({ kind: 'failure', task: 'program_identity', state });
  });

  it('refuses question identity or evidence-envelope mismatches before calling the client', async () => {
    let calls = 0;
    const candidate = provider(async () => {
      calls += 1;
      return response();
    });
    const wrongQuestion = {
      ...question,
      questions: { wrong: question.questions.program_identity! },
    };
    expect(await candidate.assess(envelope, wrongQuestion)).toMatchObject({
      kind: 'failure',
      state: 'malformed_response',
    });
    const original = question.questions.program_identity!;
    if (original.type !== 'choice') throw new Error('expected Choice question');
    const extraOutcome = {
      ...question,
      questions: {
        program_identity: {
          ...original,
          criteria: { ...original.criteria, invented_outcome: 'not registered' },
        },
      },
    };
    expect(await candidate.assess(envelope, extraOutcome)).toMatchObject({
      kind: 'failure',
      state: 'malformed_response',
    });
    const differentEnvelope = {
      ...envelope,
      sources: envelope.sources.map((source) => ({ ...source, passage: 'Other' })),
    };
    const unbound = buildProgramIdentityQuestion({
      mention: 'AEGIS',
      candidateProgram: { id: 'aegis', name: 'Aegis Combat System' },
      envelope: differentEnvelope,
    });
    expect(await candidate.assess(envelope, unbound)).toMatchObject({
      kind: 'failure',
      state: 'judge_unavailable',
      reasonCodes: ['request_rejected'],
    });
    expect(calls).toBe(0);
  });

  it('accepts only envelope-bound evidence-selection candidate outcomes', async () => {
    const selectionEnvelope: EvidenceEnvelope = {
      ...envelope,
      claimCategory: 'evidence_selection',
      sources: envelope.sources.map((source) => ({ ...source, financialStage: 'request' })),
    };
    const selectionQuestion = buildEvidenceSelectionQuestion({
      question: 'Which source?',
      envelope: selectionEnvelope,
      candidates: [{ id: 'candidate:e', evidenceId: 'e' }],
    });
    const selectionProvider = createJevChoiceTaskProvider({
      task: 'evidence_selection',
      model: 'jev-1.13.0',
      scope: { tenantId: 'tenant', surface: 'chat' },
      client: {
        systemOne: async () => ({
          response: {
            model: 'jev-1.13.0',
            answers: {
              evidence_selection: {
                type: 'choice',
                choice: 'candidate:e',
                confidence: 0.99,
                probabilities: { 'candidate:e': 0.99, none: 0.005, ambiguous: 0.005 },
              },
            },
            usage: { input_tokens: 10, output_tokens: 2 },
          },
          latencyMs: 3,
          attempts: 1,
        }),
      } as never,
    });
    expect(await selectionProvider.assess(selectionEnvelope, selectionQuestion)).toMatchObject({
      kind: 'outcome',
      outcome: 'candidate:e',
      action: 'propose',
      evidenceIds: ['e'],
    });

    const choice = selectionQuestion.questions.evidence_selection!;
    if (choice.type !== 'choice') throw new Error('expected Choice question');
    const tampered = {
      ...selectionQuestion,
      questions: {
        evidence_selection: {
          ...choice,
          criteria: { ...choice.criteria, 'model-authored': 'not a supplied candidate' },
        },
      },
    };
    expect(await selectionProvider.assess(selectionEnvelope, tampered)).toMatchObject({
      kind: 'failure',
      state: 'malformed_response',
    });
  });

  it('refuses preflight and provider-reported token overruns without an actionable outcome', async () => {
    let calls = 0;
    const oversized = buildProgramIdentityQuestion({
      mention: 'AEGIS',
      candidateProgram: { id: 'aegis', name: 'Aegis', aliases: ['x'.repeat(70_000)] },
      envelope,
    });
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
    expect(
      await provider(async () => response(16_001, 2)).assess(envelope, question),
    ).toMatchObject({
      kind: 'failure',
      state: 'repair_budget_exhausted',
      reasonCodes: ['provider_token_budget_exceeded'],
    });
    const tooManyAttempts = { ...response(), attempts: 2 };
    expect(await provider(async () => tooManyAttempts).assess(envelope, question)).toMatchObject({
      kind: 'failure',
      state: 'repair_budget_exhausted',
      reasonCodes: ['provider_call_budget_exceeded'],
    });
  });
});
