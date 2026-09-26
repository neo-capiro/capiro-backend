import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BD_CLAIM_CITED_EVIDENCE_COUNT,
  BD_CLAIM_EXACT_CHECK_COUNT,
  BD_CLAIM_EXACT_CHECK_KINDS,
  BD_CLAIM_MAX_TEXT_CHARS,
  bdClaimInputSchema,
  buildBdClaimQuestion,
  evaluateBdClaimExactChecks,
  type BdClaimExactCheck,
} from './bd-claim-question';
import { jevTaskEvaluationFixtureSchema } from './task-evaluation-fixture';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from './task-registry';
import { createJevChoiceTaskProvider, type JevChoiceTaskDecision } from './task-choice-provider';
import { JevMalformedResponseError, JevRequestError, JevTimeoutError } from './jev-client';
import { hashEvidenceContent } from '../grounding/evidence';
import { hashEvidenceEnvelope, type EvidenceEnvelope } from './decision-contract';
import type { EvidenceOperationalState } from './decision-contract';
import { runJevTaskPairedEvaluation, type JevTaskEvaluationCase } from './evaluation/task-paired-evaluation';

/**
 * BD-CLAIM recorded replay (Phase 3, dark-only).
 *
 * PROVENANCE / NON-CLAIMS: every case comes from the repository fixture
 * `__fixtures__/bd-claim-replay-v1.json`, which contains only public/synthetic
 * redacted examples with `humanReview: proposed` — NOT human-reviewed. This
 * replay proves schema conformance, code-owned exact-check refusal, typed
 * parsing, malformed/empty/timeout/failure handling, source/version hash
 * behavior and compatibility. It does NOT prove semantic accuracy, and no
 * accuracy or calibration claim may be made from it.
 */

interface BdClaimFixtureCase {
  id: string;
  category: string;
  input: {
    claim: { text: string };
    exactChecks: BdClaimExactCheck[];
    evidenceIds: string[];
  };
  expected: { kind: 'outcome'; outcome: string } | { kind: 'failure'; state: EvidenceOperationalState };
  replay: {
    jev: { kind: string; outcome?: string; confidence?: number; action?: string; latencyMs: number };
    baseline: { kind: string; outcome?: string; confidence?: number; action?: string; latencyMs: number };
  };
}

const fixturePath = path.join(__dirname, '__fixtures__', 'bd-claim-replay-v1.json');
const rawFixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
const fixture = jevTaskEvaluationFixtureSchema.parse(rawFixture);
const cases = (fixture.cases as unknown as BdClaimFixtureCase[])
  .filter((item) => item.id.startsWith('bd-claim-'));
const provenance = rawFixture.provenance as Record<string, unknown>;

const claimSource = (): EvidenceEnvelope['sources'][number] => ({
  evidenceId: 'e-award', sourceType: 'award', sourceId: 'W912XYZ12345678', documentId: 'doc-1',
  version: 'v1', locator: 'usaspending award line 1',
  passage: 'Award W912XYZ12345678 of $12,500,000 awarded to Corvus Analytics Inc on August 14, 2026 for data analytics services.',
  sourceDate: '2026-08-14', publishedAt: null, effectiveAt: null, retrievedAt: '2026-08-20',
  authority: { sourceAuthority: 'USAspending', publisher: 'Treasury', jurisdiction: 'US' },
  documentCompleteness: 'complete', relationScope: 'pe_specific', financialStage: 'awarded',
  provenance: { evidenceClass: 'official_budget_exhibit_mark_law', primary: true, authoritative: true },
});
const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1', claimId: 'c1',
  claimText: 'Corvus Analytics Inc received a $12.5M awarded contract.', claimKind: 'fact',
  claimCategory: 'bd_claim', tenantId: 'tenant', clientId: null, scopeQualifiers: [], asOf: null,
  sources: [claimSource()],
};

const passingChecks = (): BdClaimExactCheck[] => [
  { kind: 'amount', claimValue: '12500000:USD', sourceValue: '12500000:USD', matchesExactly: true },
  { kind: 'identifier', claimValue: 'W912XYZ12345678', sourceValue: 'W912XYZ12345678', matchesExactly: true },
  { kind: 'date', claimValue: '2026-08-14', sourceValue: '2026-08-14', matchesExactly: true },
  { kind: 'source_locator', claimValue: 'usaspending:award:line-1', sourceValue: 'usaspending:award:line-1', matchesExactly: true },
  { kind: 'financial_stage', claimValue: 'awarded', sourceValue: 'awarded', matchesExactly: true },
];
const baseInput = { claim: { text: 'Corvus Analytics Inc received a $12.5M awarded contract.' } };

function choiceResponse(choice: string, confidence: number) {
  const outcomes = ['supported', 'contradicted', 'insufficient_evidence', 'conflicting_evidence'];
  return { response: { model: 'jev-1.13.0', answers: {
    bd_claim: { type: 'choice', choice, confidence,
      probabilities: Object.fromEntries(outcomes.map((o) => [o, o === choice ? confidence : 0.005])) },
  }, usage: { input_tokens: 180, output_tokens: 22 } }, latencyMs: 16, attempts: 1 };
}

/** Replays a fixture case through the real question builder + Choice provider. */
async function replayCase(item: BdClaimFixtureCase): Promise<JevChoiceTaskDecision> {
  const builderProvider = { name: 'jev:bd_claim', model: 'jev-1.13.0', questionVersion: 'bd_claim.v1' };
  let question: ReturnType<typeof buildBdClaimQuestion> | null = null;
  try {
    question = buildBdClaimQuestion({
      claim: item.input.claim,
      exactChecks: item.input.exactChecks,
      envelope,
      evidenceIds: item.input.evidenceIds,
    });
  } catch {
    // Code-owned fail-closed refusal: no Jev call is possible.
    return { kind: 'failure', task: 'bd_claim', state: 'judge_unavailable',
      reasonCodes: ['exact_validation_refused'], provider: builderProvider, latencyMs: 0 };
  }
  let systemOne: () => Promise<unknown>;
  if (item.expected.kind === 'failure' && item.expected.state === 'malformed_response') {
    systemOne = async () => { throw new JevMalformedResponseError(); };
  } else if (item.expected.kind === 'failure' && item.expected.state === 'timeout') {
    systemOne = async () => { throw new JevTimeoutError(); };
  } else if (item.expected.kind === 'outcome') {
    const answer = choiceResponse(item.expected.outcome, item.replay.jev.confidence ?? 0.99);
    systemOne = async () => answer;
  } else {
    systemOne = async () => { throw new JevRequestError(); };
  }
  const provider = createJevChoiceTaskProvider({
    task: 'bd_claim', model: 'jev-1.13.0', scope: { tenantId: 'tenant', surface: 'chat' },
    client: { systemOne } as never,
  });
  const decision = await provider.assess(envelope, question);
  // Failure paths measure real wall-clock latency; pin it to the recorded
  // fixture latency so the paired-evaluation hash stays deterministic.
  return { ...decision, latencyMs: item.replay.jev.latencyMs };
}

describe('bd_claim replay fixture provenance', () => {
  it('is proposed-only, never human-reviewed, and makes no accuracy claim', () => {
    expect(provenance.humanReview).toBe('proposed');
    expect(provenance.notHumanReviewed).toBe(true);
    for (const raw of rawFixture.cases as Array<{ humanReview: { status: string } }>) {
      expect(raw.humanReview.status).toBe('proposed');
    }
    expect(JEV_TASK_REGISTRY.bd_claim.evaluationSet).toMatchObject({
      id: 'bd_claim_replay_v1', status: 'proposed',
      path: 'packages/meriv2-core/src/jev/__fixtures__/bd-claim-replay-v1.json',
    });
    expect(cases.length).toBeGreaterThanOrEqual(5);
  });

  it('parses with the shared task evaluation fixture schema against the current registry', () => {
    expect(fixture.registryVersion).toBe(JEV_TASK_REGISTRY_VERSION);
    expect(fixture.model).toBe('jev-1.13.0');
  });
});

describe('bd_claim exact validation fails closed before any Jev judgment', () => {
  it('passes only when all five required checks are present once and explicitly exact', () => {
    const report = evaluateBdClaimExactChecks(passingChecks());
    expect(report.ok).toBe(true);
    expect(report.reasons).toEqual([]);
    expect([...report.verifiedKinds].sort()).toEqual([...BD_CLAIM_EXACT_CHECK_KINDS].sort());
  });

  it('refuses a non-exact amount, identifier, date, locator or stage check', () => {
    for (const kind of BD_CLAIM_EXACT_CHECK_KINDS) {
      const checks = passingChecks().map((check) =>
        check.kind === kind ? { ...check, matchesExactly: false } : check);
      const report = evaluateBdClaimExactChecks(checks);
      expect(report.ok).toBe(false);
      expect(report.reasons).toEqual([`exact_check_refused:${kind}:not_exact`]);
    }
  });

  it('refuses missing and duplicated required checks', () => {
    const duplicated = [...passingChecks().slice(0, 4), passingChecks()[0]!];
    expect(evaluateBdClaimExactChecks(duplicated).ok).toBe(false);
    expect(evaluateBdClaimExactChecks([]).reasons).toHaveLength(BD_CLAIM_EXACT_CHECK_COUNT);
  });

  it('the builder refuses an exact mismatch so Jev can never approve one', () => {
    const checks = passingChecks().map((check) =>
      check.kind === 'identifier' ? { ...check, matchesExactly: false } : check);
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: checks, envelope }))
      .toThrow(JevRequestError);
    expect(() => buildBdClaimQuestion({
      ...baseInput, exactChecks: checks, envelope,
    })).toThrow(/exact validation refused the claim/);
  });
});

describe('bd_claim strict input boundary', () => {
  it('rejects arbitrary extra/private fields and unbounded text', () => {
    expect(() => bdClaimInputSchema.parse({ ...baseInput, exactChecks: passingChecks(), notes: 'private' })).toThrow();
    expect(() => bdClaimInputSchema.parse({ ...baseInput, exactChecks: passingChecks(), dossier: 'blob' })).toThrow();
    expect(() => bdClaimInputSchema.parse({ ...baseInput, exactChecks: passingChecks(), contact: { email: 'a@b.c' } })).toThrow();
    expect(() => bdClaimInputSchema.parse({ claim: { text: 'x'.repeat(BD_CLAIM_MAX_TEXT_CHARS + 1) },
      exactChecks: passingChecks() })).toThrow();
    expect(() => bdClaimInputSchema.parse({ ...baseInput, exactChecks: passingChecks().slice(0, 4) })).toThrow();
    expect(() => bdClaimInputSchema.parse({ ...baseInput,
      exactChecks: [...passingChecks(), passingChecks()[0]!] })).toThrow();
    expect(() => bdClaimInputSchema.parse({ ...baseInput, exactChecks:
      passingChecks().map((check) => ({ ...check, claimValue: 'x'.repeat(301) })) })).toThrow();
  });

  it('requires exactly one cited evidence source from the envelope', () => {
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(),
      envelope: { ...envelope, sources: [] }, evidenceIds: [] })).toThrow(JevRequestError);
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope,
      evidenceIds: [] })).toThrow(/exactly 1 cited evidence source, found 0/);
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(),
      envelope: { ...envelope, sources: [claimSource(), { ...claimSource(), evidenceId: 'e-2' }] },
      evidenceIds: ['e-award', 'e-2'] })).toThrow(JevRequestError);
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope,
      evidenceIds: ['e-award', 'e-award'] })).toThrow(/exactly 1 cited evidence source, found 2/);
    expect(() => buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope,
      evidenceIds: ['missing'] })).toThrow(/not in the envelope/);
    expect(BD_CLAIM_CITED_EVIDENCE_COUNT).toBe(1);
  });
});

describe('bd_claim recorded replay through the shared Choice provider', () => {
  it('replays every fixture case to its recorded expected decision (no accuracy claim)', async () => {
    for (const item of cases) {
      const decision = await replayCase(item);
      if (item.expected.kind === 'outcome') {
        expect(decision.kind).toBe('outcome');
        if (decision.kind !== 'outcome') throw new Error('unreachable');
        expect(decision.outcome).toBe(item.expected.outcome);
        expect(decision.task).toBe('bd_claim');
        expect(decision.provider.questionVersion).toBe('bd_claim.v1');
        expect(decision.evidenceIds).toEqual(['e-award']);
        // Typed parsing: a probability exists for every registered outcome.
        for (const outcome of ['supported', 'contradicted', 'insufficient_evidence', 'conflicting_evidence']) {
          expect(typeof decision.probabilities[outcome]).toBe('number');
        }
      } else {
        expect(decision.kind).toBe('failure');
        if (decision.kind !== 'failure') throw new Error('unreachable');
        expect(decision.state).toBe(item.expected.state);
      }
    }
  });

  it('handles empty evidence and exact-refusal as judge_unavailable failures', async () => {
    const empty = cases.find((item) => item.id === 'bd-claim-empty-evidence-envelope')!;
    const refusal = cases.find((item) => item.id === 'bd-claim-exact-mismatch-refused-before-jev')!;
    for (const item of [empty, refusal]) {
      const decision = await replayCase(item);
      expect(decision).toMatchObject({ kind: 'failure', state: 'judge_unavailable' });
      expect(decision.kind === 'failure' && decision.reasonCodes).toContain('exact_validation_refused');
    }
  });

  it('refuses a question bound to a different evidence envelope', async () => {
    const question = buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope });
    const otherEnvelope: EvidenceEnvelope = { ...envelope,
      claimText: 'A different claim', sources: [{ ...claimSource(), passage: 'different passage content' }] };
    const provider = createJevChoiceTaskProvider({
      task: 'bd_claim', model: 'jev-1.13.0', scope: { tenantId: 'tenant', surface: 'chat' },
      client: { systemOne: async () => { throw new Error('unexpected'); } } as never,
    });
    const decision = await provider.assess(otherEnvelope, question);
    expect(decision).toMatchObject({ kind: 'failure', state: 'judge_unavailable', reasonCodes: ['request_rejected'] });
  });

  it('refuses a cross-tenant scope before any provider call', async () => {
    let calls = 0;
    const question = buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope });
    const provider = createJevChoiceTaskProvider({
      task: 'bd_claim', model: 'jev-1.13.0', scope: { tenantId: 'tenant', surface: 'chat' },
      client: { systemOne: async () => { calls += 1; throw new Error('unexpected'); } } as never,
    });
    const decision = await provider.assess({ ...envelope, tenantId: 'other' }, question);
    expect(decision).toMatchObject({ kind: 'failure', state: 'scope_refused' });
    expect(calls).toBe(0);
  });

  it('keeps question and source/version hash behavior deterministic', () => {
    const question = buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope });
    expect(hashEvidenceContent(question)).toBe(hashEvidenceContent(
      buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope })));
    const state = question.state as Record<string, unknown>;
    expect(state.envelopeHash).toBe(hashEvidenceEnvelope(envelope));
    const changedEnvelope: EvidenceEnvelope = { ...envelope, sources: [{ ...claimSource(), version: 'v2' }] };
    const changedQuestion = buildBdClaimQuestion({ ...baseInput, exactChecks: passingChecks(), envelope: changedEnvelope });
    expect((changedQuestion.state as Record<string, unknown>).envelopeHash).not.toBe(state.envelopeHash);
    expect(hashEvidenceContent(changedQuestion)).not.toBe(hashEvidenceContent(question));
  });

  it('runs the paired evaluation over the fixture with zero approved labels', async () => {
    const evaluationCases: JevTaskEvaluationCase[] = cases.map((item) => ({
      id: item.id, task: 'bd_claim' as const, category: item.category,
      expected: item.expected.kind === 'outcome'
        ? { kind: 'outcome' as const, outcome: item.expected.outcome }
        : { kind: 'failure' as const, state: item.expected.state },
      humanReview: { status: 'proposed' as const },
    }));
    const baselineReplay = async (item: JevTaskEvaluationCase) => {
      const recorded = cases.find((entry) => entry.id === item.id)!.replay.baseline;
      return recorded.kind === 'outcome'
        ? { kind: 'outcome' as const, task: 'bd_claim' as const, outcome: recorded.outcome!,
          probabilities: { [recorded.outcome!]: recorded.confidence ?? 0 },
          confidence: recorded.confidence ?? 0, action: recorded.action as 'propose' | 'abstain',
          reasonCodes: [], evidenceIds: ['e-award'],
          provider: { name: 'baseline', model: 'jev-1.13.0', questionVersion: 'bd_claim.v1' },
          latencyMs: recorded.latencyMs }
        : { kind: 'failure' as const, task: 'bd_claim' as const,
          state: 'not_checked' as EvidenceOperationalState,
          reasonCodes: ['baseline_replay'], latencyMs: recorded.latencyMs,
          provider: { name: 'baseline', model: 'jev-1.13.0', questionVersion: 'bd_claim.v1' } };
    };
    const run = () => runJevTaskPairedEvaluation({
      cases: evaluationCases,
      providers: { jev: async (item) => replayCase(cases.find((entry) => entry.id === item.id)!),
        baseline: baselineReplay },
    });
    const first = await run();
    expect(first.registryVersion).toBe(JEV_TASK_REGISTRY_VERSION);
    expect(first.perTask.bd_claim!.cases).toBe(cases.length);
    expect(first.perTask.bd_claim!.approvedLabels).toBe(0);
    expect(first.perTask.bd_claim!.proposedLabels).toBe(cases.length);
    expect((await run()).hash).toBe(first.hash);
  });
});
