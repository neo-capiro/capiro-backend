import {
  buildAssuredClaimLedger,
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

describe('assessReleasedClaims', () => {
  it('emits exact claim and turn event fields with paired agreement and actions', async () => {
    const args = input();
    await assessReleasedClaims(args);
    expect(args.logger.log).toHaveBeenNthCalledWith(1, 'meri.evidence_shadow', {
      conversationId: 'conversation-1', turnId: 'turn-1', claimId: 'c1', claimKind: 'fact',
      claimCategory: 'grant_award', envelopeHash: expect.any(String), eligibility: { eligible: true, reason: 'ok' },
      jev: expect.objectContaining({ kind: 'outcome', outcome: 'supported', confidence: 1, inputTokens: 20 }),
      legacy: expect.objectContaining({ kind: 'outcome', outcome: 'supported', confidence: 1, inputTokens: 20 }),
      agreement: true,
      freshness: { state: 'fresh', ageDays: null, basis: 'none' },
      exact: { result: 'match', kind: 'amount' },
      proposedAction: { jev: 'retain', legacy: 'retain' },
    });
    expect(args.logger.log).toHaveBeenNthCalledWith(2, 'meri.evidence_shadow.turn', {
      conversationId: 'conversation-1', turnId: 'turn-1', selected: 1, skipped: 0,
      budgetExhausted: false, durationMs: expect.any(Number), inputTokens: expect.any(Number),
      estimatedCostUsd: expect.any(Number), sampled: expect.any(Boolean),
    });
  });

  it('keeps paired routing byte-identical to the existing event and calls both providers', async () => {
    const jev = provider('jev');
    const legacy = provider('legacy');
    const implicit = input({ providers: { jev, legacy } });
    await assessReleasedClaims(implicit);
    const implicitEvent = (implicit.logger.log as jest.Mock).mock.calls[0];

    const explicit = input({ providers: { jev: provider('jev'), legacy: provider('legacy') }, routing: 'paired' });
    await assessReleasedClaims(explicit);
    const explicitEvent = (explicit.logger.log as jest.Mock).mock.calls[0];
    expect(explicitEvent).toEqual(implicitEvent);
    expect(explicitEvent?.[1]).not.toHaveProperty('escalationReasons');
    expect(jev.assess).toHaveBeenCalledTimes(1);
    expect(legacy.assess).toHaveBeenCalledTimes(1);
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
      escalated: true, escalationReasons: ['compound_claim'], audited: false, auditDisagreement: false,
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
        version: null, locator: null, passage: 'The award was $42.', sourceDate: null, retrievedAt: null,
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
      eligibility: { eligible: false, reason: 'no_document' },
      jev: expect.objectContaining({ state: 'document_unavailable' }),
    }));
  });

  it('prioritizes high risk and stops at claim/token budgets', async () => {
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
      selected: 1, skipped: 2, budgetExhausted: true,
    }));

    const tokenArgs = input({ budget: { maxClaims: 12, maxInputTokens: 1, deadlineMs: 6_000 } });
    await assessReleasedClaims(tokenArgs);
    expect(tokenArgs.logger.log).toHaveBeenCalledWith('meri.evidence_shadow.turn', expect.objectContaining({
      selected: 0, skipped: 1, budgetExhausted: true,
    }));
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
  });

  it('chains request abort into both in-flight provider calls', async () => {
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
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await work;
    expect(observed).toHaveLength(2);
    expect(observed.every((signal) => signal.aborted)).toBe(true);
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
        selected: 1, skipped: 1, budgetExhausted: true,
      }));
    } finally {
      jest.useRealTimers();
    }
  });
});