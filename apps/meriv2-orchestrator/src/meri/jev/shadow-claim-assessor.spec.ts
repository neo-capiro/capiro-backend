import {
  buildAssuredClaimLedger,
  createLlmSkepticJudge,
  createSkepticDecisionProvider,
  LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION,
  type DecisionProvider,
  type EvidenceDecision,
  type EvidenceEnvelope,
  type EvidenceQuestion,
  type MaterialClaim,
} from '@capiro/meriv2-core';
import { assessReleasedClaims } from './shadow-claim-assessor';

const TENANT = '17b63099-bc0f-4ac5-b596-496161e9481e';
const outcome = (
  name: string,
  value: 'supported' | 'contradicted' | 'insufficient_evidence' | 'conflicting_evidence' = 'supported',
): EvidenceDecision => ({
  kind: 'outcome', outcome: value,
  probabilities: { supported: 1, contradicted: 0, insufficient_evidence: 0, conflicting_evidence: 0 },
  confidence: 1, reasonCodes: [], evidenceIds: ['e1'],
  provider: { name, model: `${name}-model`, questionVersion: 'claim_support.v1' },
  latencyMs: 1, usage: { inputTokens: 20, outputTokens: 2 },
});
const provider = (name: string, assess?: DecisionProvider['assess']): DecisionProvider => ({
  name, available: () => true, assess: assess ?? jest.fn(async () => outcome(name)),
});
const materialClaim = (id: string, overrides: Partial<MaterialClaim> = {}): MaterialClaim => ({
  id, text: 'The award was $42.', sentenceIndex: 0, clauseIndex: 0, kind: 'fact',
  category: 'grant_award', markers: [1], evidenceIds: ['e1'], uncited: false,
  compound: false, material: true, asOf: '2026-09-22T00:00:00.000Z', ...overrides,
});
const ledger = buildAssuredClaimLedger([
  { id: 'c1', text: 'The award was $42.', type: 'fact', category: 'grant_award', sourceIds: ['e1'] },
], [{
  id: 'e1', sourceType: 'search_grants', sourceId: 'record-1', evidenceClass: 'official_government_data',
  primary: true, authoritative: true, requirementIds: [],
}]);

function input(overrides: Record<string, unknown> = {}) {
  return {
    claims: [materialClaim('c1')], ledger, citations: [], passages: { e1: { text: 'The award was $42.' } },
    tenantId: TENANT, clientId: null, conversationId: 'conversation-1', turnId: 'turn-1',
    asOf: '2026-09-22T00:00:00.000Z',
    providers: { jev: provider('jev'), legacy: provider('legacy-skeptic') },
    budget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 6_000 },
    logger: { log: jest.fn(), warn: jest.fn() }, ...overrides,
  } as Parameters<typeof assessReleasedClaims>[0];
}

function providerLifecycleEvents(args: ReturnType<typeof input>): Record<string, unknown>[] {
  return (args.logger.log as jest.Mock).mock.calls
    .filter(([name]) => name === 'meri.evidence_shadow.provider_lifecycle')
    .map(([, fields]) => fields as Record<string, unknown>);
}

describe('assessReleasedClaims', () => {
  it('emits exact claim and turn event fields with paired agreement and actions', async () => {
    jest.useFakeTimers();
    try {
      const args = input();
      await assessReleasedClaims(args);
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', {
        schemaVersion: 'meri.evidence_shadow.v2',
        conversationId: 'conversation-1', turnId: 'turn-1', claimId: 'c1', claimKind: 'fact',
        claimCategory: 'grant_award', envelopeHash: expect.any(String), eligibility: { eligible: true, reason: 'ok' },
        jev: expect.objectContaining({ kind: 'outcome', outcome: 'supported', confidence: 1, inputTokens: 20 }),
        legacy: expect.objectContaining({ kind: 'outcome', outcome: 'supported', confidence: 1, inputTokens: 20 }),
        legacyAdapterVersion: 'legacy-skeptic-adapter.v2',
        agreement: true,
        freshness: {
          requiredDocumentEligible: true, claimLinkedEvidencePresent: true, sourceDateKnown: false,
          eligibleSourceFreshness: { state: 'fresh', ageDays: null, basis: 'none' },
          linkedLedgerTemporalInformation: { state: 'fresh', ageDays: null, basis: 'none' },
        },
        exact: { result: 'match', kind: 'amount' },
        proposedAction: { jev: 'retain', legacy: 'retain' },
      });
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', {
        conversationId: 'conversation-1', turnId: 'turn-1', selected: 1, skipped: 0,
        budgetExhausted: false, stopReason: 'completed', durationMs: expect.any(Number), inputTokens: expect.any(Number),
        estimatedCostUsd: expect.any(Number), sampled: expect.any(Boolean),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps paired routing byte-identical to the existing event and calls both providers', async () => {
    const jev = provider('jev');
    const legacy = provider('legacy');
    const implicit = input({ providers: { jev, legacy } });
    await assessReleasedClaims(implicit);
    const implicitEvent = (implicit.logger.log as jest.Mock).mock.calls.find(([name]) => name === 'meri.evidence_shadow');

    const explicit = input({ providers: { jev: provider('jev'), legacy: provider('legacy') }, routing: 'paired' });
    await assessReleasedClaims(explicit);
    const explicitEvent = (explicit.logger.log as jest.Mock).mock.calls.find(([name]) => name === 'meri.evidence_shadow');
    expect(explicitEvent).toEqual(implicitEvent);
    expect(explicitEvent?.[1]).not.toHaveProperty('escalationReasons');
    expect(jev.assess).toHaveBeenCalledTimes(1);
    expect(legacy.assess).toHaveBeenCalledTimes(1);
  });

  it('logs real request-scoped legacy usage end to end', async () => {
    const legacy = createSkepticDecisionProvider(createLlmSkepticJudge({
      completeJson: jest.fn(),
      completeWithSchema: jest.fn(async () => ({
        input: { refuted: true, confidence: 'low', reason: 'Could not confirm.' },
        usage: { inputTokens: 137, outputTokens: 9 },
      })),
    }), 'request-scoped-llm', LEGACY_SKEPTIC_BASELINE_ADAPTER_VERSION);
    const args = input({ providers: { jev: provider('jev'), legacy } });
    await assessReleasedClaims(args);
    expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({
      legacyAdapterVersion: 'legacy-skeptic-adapter.v2',
      legacy: expect.objectContaining({
        model: 'request-scoped-llm', inputTokens: 137, reasonCodes: ['legacy_refuted'],
      }),
    }));
  });

  it('runs the calibrated cascade only under cascade routing and logs its reasons', async () => {
    const jevAssess = jest.fn(async () => outcome('jev'));
    const legacyAssess = jest.fn(async () => outcome('legacy', 'contradicted'));
    const args = input({
      routing: 'cascade',
      providers: { jev: provider('jev', jevAssess), legacy: provider('legacy', legacyAssess) },
      claims: [materialClaim('c1', { category: 'general_background', compound: true })],
    });
    await assessReleasedClaims(args);
    expect(jevAssess).toHaveBeenCalledTimes(1);
    expect(legacyAssess).toHaveBeenCalledTimes(1);
    expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({
      escalated: true, escalationReasons: ['compound_claim', 'out_of_distribution'],
      audited: false, auditDisagreement: false,
    }));
  });

  it('keeps the claim_support Jev request state unchanged while carrying provenance', async () => {
    const assess = jest.fn<Promise<EvidenceDecision>, [EvidenceEnvelope, EvidenceQuestion]>(
      async () => outcome('jev'),
    );
    const args = input({ providers: { jev: provider('jev', assess), legacy: provider('legacy', assess) } });
    await assessReleasedClaims(args);

    expect(assess).toHaveBeenCalledTimes(2);
    const [sentEnvelope, sentQuestion] = assess.mock.calls[0]!;
    expect(sentEnvelope.sources[0]?.provenance).toEqual({
      evidenceClass: 'official_government_data', primary: true, authoritative: true,
    });
    expect(sentQuestion.state).toEqual({
      claim: {
        id: 'c1', text: 'The award was $42.', kind: 'fact', category: 'grant_award',
        asOf: '2026-09-22T00:00:00.000Z',
      },
      scope: {
        qualifiers: ['as-of:2026-09-22T00:00:00.000Z', 'category:grant_award'],
        tenantId: TENANT, clientId: null,
      },
      sources: [{
        evidenceId: 'e1', sourceType: 'search_grants', sourceId: 'record-1', documentId: null,
        version: null, locator: null, passage: 'The award was $42.', sourceDate: null,
        publishedAt: null, effectiveAt: null, retrievedAt: null,
      }],
    });
    expect((sentQuestion.state as { sources: unknown[] }).sources[0]).not.toHaveProperty('provenance');
  });

  it('short-circuits unavailable document evidence without provider calls', async () => {
    const jevAssess = jest.fn();
    const legacyAssess = jest.fn();
    const args = input({
      claims: [materialClaim('doc', { text: 'The attached memo says $42.', category: 'report_language' })],
      providers: { jev: provider('jev', jevAssess), legacy: provider('legacy-skeptic', legacyAssess) },
    });
    await assessReleasedClaims(args);
    expect(jevAssess).not.toHaveBeenCalled();
    expect(legacyAssess).not.toHaveBeenCalled();
    expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({
      schemaVersion: 'meri.evidence_shadow.v2',
      eligibility: { eligible: false, reason: 'no_document' },
      jev: expect.objectContaining({ state: 'document_unavailable' }),
    }));
    expect(providerLifecycleEvents(args)).toHaveLength(2);
    expect(providerLifecycleEvents(args).every((event) => event.waitState === 'ineligible'
      && event.eligible === false && event.attemptedAt === null && event.dispatchedAt === null)).toBe(true);
  });

  it('keeps undated durable linked evidence while marking required-source freshness unknown when no document matches', async () => {
    const args = input({
      claims: [materialClaim('doc', { text: 'The attached memo says $42.', category: 'report_language' })],
    });
    await assessReleasedClaims(args);
    expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({
      schemaVersion: 'meri.evidence_shadow.v2',
      eligibility: { eligible: false, reason: 'no_document' },
      freshness: {
        requiredDocumentEligible: false, claimLinkedEvidencePresent: true, sourceDateKnown: false,
        eligibleSourceFreshness: { state: 'unknown', ageDays: null, basis: 'none' },
        linkedLedgerTemporalInformation: { state: 'fresh', ageDays: null, basis: 'none' },
      },
    }));
  });

  it('prioritizes high risk and stops at claim/token budgets', async () => {
    jest.useFakeTimers();
    try {
      const assess = jest.fn(async () => outcome('jev'));
      const claims = [
        materialClaim('ordinary', { category: 'unclassified' }),
        materialClaim('high-risk', { category: 'bill_status' }),
        materialClaim('third', { category: 'unclassified' }),
      ];
      const args = input({ claims, providers: { jev: provider('jev', assess), legacy: provider('legacy') },
        budget: { maxClaims: 1, maxInputTokens: 60_000, deadlineMs: 6_000 } });
      await assessReleasedClaims(args);
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({ claimId: 'high-risk' }));
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
        selected: 1, skipped: 2, budgetExhausted: true, stopReason: 'max_claims',
      }));

      const tokenArgs = input({ budget: { maxClaims: 12, maxInputTokens: 1, deadlineMs: 6_000 } });
      await assessReleasedClaims(tokenArgs);
      expect(tokenArgs.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
        selected: 0, skipped: 1, budgetExhausted: true, stopReason: 'max_input_tokens',
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('logs provider rejection as an operational failure and does not throw', async () => {
    const args = input({ providers: {
      jev: provider('jev', jest.fn(async () => { throw new Error('down'); })),
      legacy: provider('legacy'),
    } });
    await expect(assessReleasedClaims(args)).resolves.toBeUndefined();
    expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow', expect.objectContaining({
      jev: expect.objectContaining({ kind: 'failure', state: 'judge_unavailable' }), agreement: false,
    }));
    expect(providerLifecycleEvents(args)).toMatchObject([
      { provider: 'jev', waitState: 'settled', providerState: 'provider_error', settledAt: expect.any(String) },
      { provider: 'legacy', waitState: 'settled', providerState: 'settled', actualUsage: { inputTokens: 20, outputTokens: 2 } },
    ]);
  });

  it('separates one settled provider from the other provider timeout and records returned usage', async () => {
    jest.useFakeTimers();
    try {
      const jev = provider('jev');
      const legacyTimeout: EvidenceDecision = {
        kind: 'failure', state: 'timeout', reasonCodes: ['provider_deadline'],
        provider: { name: 'legacy-skeptic', model: 'legacy-model', questionVersion: 'claim_support.v1' },
        latencyMs: 5,
      };
      const legacyAssessment: DecisionProvider['assess'] = async () => new Promise((resolve) => {
        setTimeout(() => resolve(legacyTimeout), 5);
      });
      const args = input({ providers: { jev, legacy: provider('legacy-skeptic', legacyAssessment) } });
      const work = assessReleasedClaims(args);
      await jest.advanceTimersByTimeAsync(5);
      await work;
      const bySlot = new Map(providerLifecycleEvents(args).map((event) => [event.provider, event]));
      expect(bySlot.get('jev')).toMatchObject({
        eligible: true, waitState: 'settled', providerState: 'settled',
        actualUsage: { inputTokens: 20, outputTokens: 2 }, usageStatus: 'reported', costStatus: 'unknown',
      });
      expect(bySlot.get('legacy')).toMatchObject({
        eligible: true, waitState: 'settled', providerState: 'provider_timeout',
        actualUsage: null, usageStatus: 'not_returned', costStatus: 'unknown',
      });
      for (const event of bySlot.values()) {
        expect(Date.parse(event.eligibleAt as string)).toBeLessThanOrEqual(Date.parse(event.attemptedAt as string));
        expect(Date.parse(event.attemptedAt as string)).toBeLessThanOrEqual(Date.parse(event.dispatchedAt as string));
        expect(Date.parse(event.dispatchedAt as string)).toBeLessThanOrEqual(Date.parse(event.settledAt as string));
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('chains request abort into both in-flight provider calls', async () => {
    jest.useFakeTimers();
    try {
      const abort = new AbortController();
      const observed: AbortSignal[] = [];
      const pending = jest.fn((_envelope, _question, options) => new Promise<EvidenceDecision>((resolve) => {
        observed.push(options.signal);
        options.signal.addEventListener('abort', () => resolve({
          kind: 'failure', state: 'cancelled', reasonCodes: ['cancelled'],
          provider: { name: 'fake', model: 'fake', questionVersion: 'claim_support.v1' }, latencyMs: 0,
        }), { once: true });
      }));
      const args = input({ signal: abort.signal, providers: { jev: provider('jev', pending), legacy: provider('legacy', pending) } });
      const work = assessReleasedClaims(args);
      abort.abort();
      await work;
      expect(observed).toHaveLength(2);
      expect(observed.every((signal) => signal.aborted)).toBe(true);
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
        stopReason: 'parent_abort',
      }));
      expect(providerLifecycleEvents(args).every((event) => event.waitState === 'cancelled_by_shared_budget'
        && event.cancellationReason === 'parent_abort' && event.usageStatus === 'unknown_due_cancellation'
        && event.costStatus === 'unknown_due_cancellation')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports a pre-aborted request as parent_abort without selecting a claim', async () => {
    jest.useFakeTimers();
    try {
      const abort = new AbortController();
      abort.abort();
      const args = input({ signal: abort.signal });
      await assessReleasedClaims(args);
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
        selected: 0, skipped: 1, budgetExhausted: true, stopReason: 'parent_abort',
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('marks a shared deadline as exhausted and cancels both providers', async () => {
    jest.useFakeTimers();
    try {
      const pending: DecisionProvider['assess'] = async (_envelope, _question, options) =>
        new Promise<EvidenceDecision>((resolve) => options?.signal?.addEventListener('abort', () => resolve({
          kind: 'failure', state: 'timeout', reasonCodes: ['deadline'],
          provider: { name: 'fake', model: 'fake', questionVersion: 'claim_support.v1' }, latencyMs: 1,
        }), { once: true }));
      const args = input({
        claims: [materialClaim('one'), materialClaim('two')],
        providers: { jev: provider('jev', pending), legacy: provider('legacy', pending) },
        budget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 10 },
      });
      const work = assessReleasedClaims(args);
      await jest.advanceTimersByTimeAsync(10);
      await work;
      expect(args.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
        selected: 1, skipped: 1, budgetExhausted: true, stopReason: 'deadline',
      }));
      expect(providerLifecycleEvents(args).every((event) => event.waitState === 'cancelled_by_shared_budget'
        && event.cancellationReason === 'shared_deadline' && event.usageStatus === 'unknown_due_cancellation'
        && event.costStatus === 'unknown_due_cancellation' && event.providerState === 'settled')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records a late provider result after shared-deadline cancellation without reclassifying the cancelled wait', async () => {
    jest.useFakeTimers();
    try {
      let resolveLate!: (decision: EvidenceDecision) => void;
      const lateCall = new Promise<EvidenceDecision>((resolve) => { resolveLate = resolve; });
      const args = input({
        providers: { jev: provider('jev', async () => outcome('jev')), legacy: provider('legacy', async () => lateCall) },
        budget: { maxClaims: 12, maxInputTokens: 60_000, deadlineMs: 10 },
      });
      const work = assessReleasedClaims(args);
      await jest.advanceTimersByTimeAsync(10);
      await work;
      const initial = providerLifecycleEvents(args).find((event) => event.provider === 'legacy');
      expect(initial).toMatchObject({
        waitState: 'cancelled_by_shared_budget', providerState: 'pending',
        cancellationReason: 'shared_deadline', cancelledAt: expect.any(String), settledAt: null,
        actualUsage: null, usageStatus: 'unknown_due_cancellation', costStatus: 'unknown_due_cancellation',
      });

      resolveLate(outcome('legacy'));
      await Promise.resolve();
      await Promise.resolve();
      const updates = providerLifecycleEvents(args).filter((event) => event.provider === 'legacy');
      expect(updates).toHaveLength(2);
      expect(updates[1]).toMatchObject({
        lifecycleId: initial?.lifecycleId, waitState: 'cancelled_by_shared_budget', providerState: 'settled',
        cancellationReason: 'shared_deadline', cancelledAt: expect.any(String), settledAt: expect.any(String),
        actualUsage: { inputTokens: 20, outputTokens: 2 }, usageStatus: 'reported', costStatus: 'unknown_due_cancellation',
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
