import {
  admitResearchProviderBudget,
  readResearchProviderBudget,
  reserveResearchProviderAttempt,
  settleResearchProviderAttempt,
} from './meri-research-tool-budget.js';

const now = new Date('2026-10-05T10:00:00.000Z');
const limits = {
  maxAttempts: 1,
  maxTokens: 150,
  maxCostMicros: 100,
  deadlineAt: '2026-10-05T10:30:00.000Z',
};
const run = { id: 'capture-admission', leaseEpoch: 1 };
// The shared ledger prices in micros per token (owners divide their
// per-million rates first): 1 micro per input token, 2 per output token.
const price = { inputPerM: 1, outputPerM: 2 };
const binding = (attemptId: string) => ({
  logicalOperationId: attemptId,
  attemptId,
  retryOfAttemptId: null,
  kind: 'openai_responses' as const,
  phase: 'synthesis',
  provider: 'openai',
  model: 'gpt-6-astra',
  maxInputTokens: 100,
  maxOutputTokens: 100,
});

describe('ledger-only provider budget', () => {
  test('records reservations and settlements beyond every declared ceiling without blocking dispatch', () => {
    const admitted = admitResearchProviderBudget({}, limits, 'ledger_only');
    expect(admitted.budget.activation).toBe('ledger_only');
    // 100 in + 100 out costs 300 micros: over the declared 100-micro cost and
    // 150-token ceilings on the very first attempt.
    const first = reserveResearchProviderAttempt({
      metadata: admitted.metadata,
      run,
      limits,
      binding: binding('a1'),
      price,
      now,
    });
    expect(first.dispatchAllowed).toBe(true);
    expect(first.budget).toMatchObject({
      chargedAttempts: 1,
      chargedTokens: 200,
      chargedCostMicros: 300,
    });
    // A second operation exceeds the declared single attempt and is still recorded.
    const second = reserveResearchProviderAttempt({
      metadata: first.metadata,
      run,
      limits,
      binding: binding('a2'),
      price,
      now,
    });
    expect(second.dispatchAllowed).toBe(true);
    expect(second.budget).toMatchObject({
      chargedAttempts: 2,
      chargedTokens: 400,
      chargedCostMicros: 600,
    });
    // The over-ceiling ledger stays readable and settles down to actual usage.
    const settled = settleResearchProviderAttempt({
      metadata: second.metadata,
      run,
      reservationId: first.reservation.reservationId,
      binding: binding('a1'),
      outcome: { kind: 'known', inputTokens: 90, outputTokens: 80, price },
      now,
    });
    expect(readResearchProviderBudget(settled.metadata)).toMatchObject({
      activation: 'ledger_only',
      chargedAttempts: 2,
      chargedTokens: 370,
      chargedCostMicros: 550,
    });
  });

  test('keeps enforced budgets unchanged and bounds a ledger-only budget only structurally', () => {
    const enforced = admitResearchProviderBudget({}, limits);
    expect(enforced.budget.activation).toBe('enforced');
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: enforced.metadata,
        run,
        limits,
        binding: binding('a1'),
        price,
        now,
      }),
    ).toThrow('research_provider_budget_tokens_exhausted');

    const ledgerOnly = admitResearchProviderBudget({}, limits, 'ledger_only');
    expect(() => admitResearchProviderBudget(ledgerOnly.metadata, limits, 'enforced')).toThrow(
      'research_provider_budget_activation_changed',
    );
    // Re-admission without naming an activation keeps the admitted one.
    expect(admitResearchProviderBudget(ledgerOnly.metadata, limits).budget.activation).toBe(
      'ledger_only',
    );
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: ledgerOnly.metadata,
        run,
        limits,
        binding: binding('a1'),
        price: null,
        now,
      }),
    ).toThrow('research_provider_budget_price_required');
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: ledgerOnly.metadata,
        run,
        limits,
        binding: binding('a1'),
        price,
        now: new Date(limits.deadlineAt),
      }),
    ).toThrow('research_provider_budget_deadline');
    // The stored attempt array stays within the parser's structural bound.
    let metadata = ledgerOnly.metadata;
    for (let index = 0; index < 64; index += 1) {
      metadata = reserveResearchProviderAttempt({
        metadata,
        run,
        limits,
        binding: binding(`b${index}`),
        price,
        now,
      }).metadata;
    }
    expect(readResearchProviderBudget(metadata)!.chargedAttempts).toBe(64);
    expect(() =>
      reserveResearchProviderAttempt({
        metadata,
        run,
        limits,
        binding: binding('b64'),
        price,
        now,
      }),
    ).toThrow('research_provider_budget_attempts_exhausted');
  });
});
