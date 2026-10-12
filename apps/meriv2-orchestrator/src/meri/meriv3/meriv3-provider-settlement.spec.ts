import { PROVIDER_SETTLEMENT_KEYS, providerSettlementBody } from './meriv3-assistant.service.js';

// Mirror of apps/api strictProviderSettlementInput's expected keys. The API adds
// nothing: the orchestrator transport appends leaseEpoch, and any other key or a
// missing one is refused with HTTP 400.
const API_SETTLEMENT_KEYS = [
  'leaseEpoch',
  'reservationId',
  'logicalOperationId',
  'attemptId',
  'retryOfAttemptId',
  'kind',
  'phase',
  'provider',
  'model',
  'outcome',
  'inputTokens',
  'outputTokens',
];

const reservation = {
  reservationId: 'reservation-1',
  deadlineAt: '2026-10-06T01:00:00.000Z',
  logicalOperationId: 'operation-1',
  attemptId: 'operation-1:1',
  retryOfAttemptId: 'operation-1:0',
  kind: 'openai_responses' as const,
  phase: 'primary' as never,
  provider: 'openai',
  model: 'gpt-6.1-sol',
  maxInputTokens: 240_000,
  maxOutputTokens: 24_576,
};

describe('research provider settlement matches the API contract', () => {
  it('sends exactly the API keys once leaseEpoch is added by the transport', () => {
    for (const outcome of [
      { kind: 'known' as const, inputTokens: 71_000, outputTokens: 1_200 },
      { kind: 'rejected' as const },
      { kind: 'uncertain' as const },
    ]) {
      const body = { ...providerSettlementBody(reservation, outcome), leaseEpoch: 2 };
      expect(Object.keys(body).sort()).toEqual([...API_SETTLEMENT_KEYS].sort());
    }
    expect([...PROVIDER_SETTLEMENT_KEYS, 'leaseEpoch'].sort()).toEqual(
      [...API_SETTLEMENT_KEYS].sort(),
    );
  });

  it('binds the settlement to the reserved operation and retry chain', () => {
    expect(
      providerSettlementBody(reservation, { kind: 'known', inputTokens: 10, outputTokens: 2 }),
    ).toMatchObject({
      logicalOperationId: 'operation-1',
      retryOfAttemptId: 'operation-1:0',
      outcome: 'known',
      inputTokens: 10,
      outputTokens: 2,
    });
    expect(providerSettlementBody(reservation, { kind: 'uncertain' })).toMatchObject({
      outcome: 'uncertain',
      inputTokens: null,
      outputTokens: null,
    });
  });
});
