import type { ResearchPlanV1 } from './meri-research-plan.js';
import {
  MAX_RESEARCH_PROVIDER_ATTEMPTS,
  admitResearchProviderBudget,
  extendResearchProviderAttemptsForGoalRevision,
  readResearchProviderBudget,
  researchProviderAttemptCeiling,
  reserveResearchProviderAttempt,
  reserveResearchToolAttempt,
  settleResearchProviderAttempt,
  type ResearchProviderBudgetLimitsV1,
} from './meri-research-tool-budget.js';

const now = new Date('2026-09-28T10:00:00.000Z');
const limits = (overrides: Partial<ResearchProviderBudgetLimitsV1> = {}) => ({
  maxAttempts: 3,
  maxTokens: 1_000,
  maxCostMicros: 100_000,
  deadlineAt: '2026-09-28T10:30:00.000Z',
  ...overrides,
});
const run = (id = 'run-1', leaseEpoch = 1) => ({ id, leaseEpoch });
const binding = (
  attemptId: string,
  kind: 'openai_responses' | 'anthropic_messages' | 'jev' = 'openai_responses',
  logicalOperationId = attemptId,
  retryOfAttemptId: string | null = null,
) => ({
  logicalOperationId,
  attemptId,
  retryOfAttemptId,
  kind,
  phase: 'acquisition',
  provider: kind === 'jev' ? 'jev' : 'openai',
  model: kind === 'jev' ? 'jev' : 'gpt-4.1',
  maxInputTokens: 100,
  maxOutputTokens: 200,
});
const price = { inputPerM: 2, outputPerM: 8 };

function plan(): ResearchPlanV1 {
  return {
    version: 1,
    title: 'Bounded research',
    scope: {
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      actorId: 'user-1',
      clientId: null,
      conversationId: null,
    },
    budget: { toolCalls: 2, tokens: 1_000 },
    steps: [
      {
        id: 'read',
        objective: 'Read',
        dependsOn: [],
        requiredEvidenceDomains: ['institutional_memory'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'Captured',
        budget: { toolCalls: 2, tokens: 1_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

describe('persisted aggregate research provider budget', () => {
  test('reserves before dispatch, denies same-ID replay, and strictly binds identity', () => {
    const first = reserveResearchProviderAttempt({
      metadata: {},
      run: run(),
      limits: limits(),
      binding: binding('attempt-1'),
      price,
      now,
      reservationId: 'reservation-1',
    });
    const duplicate = reserveResearchProviderAttempt({
      metadata: first.metadata,
      run: run(),
      limits: limits(),
      binding: binding('attempt-1'),
      price,
      now,
    });
    expect(first.dispatchAllowed).toBe(true);
    expect(duplicate.dispatchAllowed).toBe(false);
    expect(duplicate.budget).toMatchObject({ chargedAttempts: 1, chargedTokens: 300 });
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: first.metadata,
        run: run(),
        limits: limits(),
        binding: { ...binding('attempt-1'), model: 'changed-model' },
        price,
        now,
      }),
    ).toThrow('research_provider_budget_attempt_identity_reused');
  });

  test('atomically spends the last aggregate attempt/token slot and rejects overdraw', () => {
    const first = reserveResearchProviderAttempt({
      metadata: {},
      run: run(),
      limits: limits({ maxAttempts: 1, maxTokens: 300 }),
      binding: binding('last'),
      price,
      now,
    });
    expect(first.budget).toMatchObject({ chargedAttempts: 1, chargedTokens: 300 });
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: first.metadata,
        run: run(),
        limits: limits({ maxAttempts: 1, maxTokens: 300 }),
        binding: binding('extra'),
        price,
        now,
      }),
    ).toThrow('research_provider_budget_attempts_exhausted');
  });

  test('settles known usage once and never refunds an uncertain/lost response', () => {
    const known = reserveResearchProviderAttempt({
      metadata: {},
      run: run(),
      limits: limits(),
      binding: binding('known'),
      price,
      now,
      reservationId: 'known-reservation',
    });
    const settled = settleResearchProviderAttempt({
      metadata: known.metadata,
      run: run(),
      reservationId: 'known-reservation',
      binding: binding('known'),
      outcome: { kind: 'known', inputTokens: 40, outputTokens: 60, price },
      now,
    });
    const again = settleResearchProviderAttempt({
      metadata: settled.metadata,
      run: run(),
      reservationId: 'known-reservation',
      binding: binding('known'),
      outcome: { kind: 'known', inputTokens: 40, outputTokens: 60, price },
      now,
    });
    expect(again.budget).toMatchObject({ chargedAttempts: 1, chargedTokens: 100 });

    const uncertainReserved = reserveResearchProviderAttempt({
      metadata: settled.metadata,
      run: run(),
      limits: limits(),
      binding: binding('lost'),
      price,
      now,
      reservationId: 'lost-reservation',
    });
    const uncertain = settleResearchProviderAttempt({
      metadata: uncertainReserved.metadata,
      run: run(),
      reservationId: 'lost-reservation',
      binding: binding('lost'),
      outcome: { kind: 'uncertain' },
      now,
    });
    expect(uncertain.reservation).toMatchObject({ status: 'uncertain', actualCostMicros: null });
    expect(uncertain.budget.chargedTokens).toBe(400);
  });

  test('blocks blind recovery redispatch but admits a linked retry after an explicit ambiguous outcome', () => {
    const firstBinding = binding('operation-a:0', 'openai_responses', 'operation-a');
    const first = reserveResearchProviderAttempt({
      metadata: {},
      run: run(),
      limits: limits(),
      binding: firstBinding,
      price,
      now,
      reservationId: 'operation-a-reservation-0',
    });
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: first.metadata,
        run: run(),
        limits: limits(),
        binding: binding('operation-a:1', 'openai_responses', 'operation-a'),
        price,
        now,
      }),
    ).toThrow('research_provider_budget_operation_recovery_required');

    const ambiguous = settleResearchProviderAttempt({
      metadata: first.metadata,
      run: run(),
      reservationId: 'operation-a-reservation-0',
      binding: firstBinding,
      outcome: { kind: 'uncertain' },
      now,
    });
    const retry = reserveResearchProviderAttempt({
      metadata: ambiguous.metadata,
      run: run(),
      limits: limits(),
      binding: binding('operation-a:1', 'openai_responses', 'operation-a', 'operation-a:0'),
      price,
      now,
    });
    expect(retry.dispatchAllowed).toBe(true);
    expect(retry.budget).toMatchObject({ chargedAttempts: 2, chargedTokens: 600 });
  });

  test('preserves the first absolute deadline and spend across replan, restart, and lease replacement', () => {
    const first = reserveResearchProviderAttempt({
      metadata: {},
      run: run('run-1', 1),
      limits: limits(),
      binding: binding('first'),
      price,
      now,
    });
    const replanned = admitResearchProviderBudget(first.metadata, {
      ...limits({ maxAttempts: 4, maxTokens: 2_000, maxCostMicros: 200_000 }),
      deadlineAt: '2026-09-28T11:00:00.000Z',
    });
    expect(replanned.budget.limits).toEqual(limits());
    const resumed = reserveResearchProviderAttempt({
      metadata: replanned.metadata,
      run: run('run-2', 2),
      limits: limits(),
      binding: binding('second'),
      price,
      now: new Date('2026-09-28T10:10:00.000Z'),
    });
    expect(resumed.budget.chargedAttempts).toBe(2);
    expect(() =>
      reserveResearchProviderAttempt({
        metadata: resumed.metadata,
        run: run('run-3', 3),
        limits: limits(),
        binding: binding('after-deadline'),
        price,
        now: new Date('2026-09-28T10:30:00.000Z'),
      }),
    ).toThrow('research_provider_budget_deadline');
  });

  test('keeps tool, provider, and JEV reservations on the same parent metadata', () => {
    const tool = reserveResearchToolAttempt({
      metadata: {},
      run: run(),
      plan: plan(),
      binding: {
        providerCallId: 'tool-call',
        kind: 'dispatch',
        tool: 'search_memory',
        toolVersion: `sha256:${'a'.repeat(64)}`,
        input: { query: 'q' },
      },
    });
    const provider = reserveResearchProviderAttempt({
      metadata: tool.metadata,
      run: run(),
      limits: limits(),
      binding: binding('provider'),
      price,
      now,
    });
    const jev = reserveResearchProviderAttempt({
      metadata: provider.metadata,
      run: run(),
      limits: limits(),
      binding: { ...binding('jev', 'jev'), maxOutputTokens: null },
      price: null,
      now,
    });
    expect(jev.metadata).toHaveProperty('researchToolBudget');
    expect(readResearchProviderBudget(jev.metadata)).toMatchObject({
      chargedAttempts: 2,
      chargedTokens: 1_000,
    });
    expect(jev.budget.attempts.map((attempt) => attempt.kind)).toEqual(['openai_responses', 'jev']);
  });

  test('a steering re-plan gives the revised goal its own attempt allowance, never more tokens or cost', () => {
    // Session 0b61fbff (2026-10-07): a steer at 64 s ended partial because the
    // revised run inherited the first run's spent attempts, with tokens and
    // cost far from their ceilings.
    const wide = limits({ maxTokens: 10_000, maxCostMicros: 1_000_000 });
    let metadata: unknown = {};
    for (const id of ['attempt-1', 'attempt-2', 'attempt-3']) {
      metadata = reserveResearchProviderAttempt({
        metadata,
        run: run(),
        limits: wide,
        binding: binding(id),
        price,
        now,
        reservationId: `reservation-${id}`,
      }).metadata;
    }
    expect(() =>
      reserveResearchProviderAttempt({
        metadata,
        run: run(),
        limits: wide,
        binding: binding('attempt-4'),
        price,
        now,
      }),
    ).toThrow('research_provider_budget_attempts_exhausted');

    const extended = extendResearchProviderAttemptsForGoalRevision(metadata, 3);
    expect(extended.budget?.limits).toEqual({ ...wide, maxAttempts: 6 });
    // A reservation asks for at least the stored ceiling, so it does not
    // narrow the revised allowance back to the configured value.
    const ceiling = researchProviderAttemptCeiling(wide.maxAttempts, extended.metadata);
    expect(ceiling).toBe(6);
    const next = reserveResearchProviderAttempt({
      metadata: extended.metadata,
      run: run(),
      limits: { ...wide, maxAttempts: ceiling },
      binding: binding('attempt-4'),
      price,
      now,
    });
    expect(next.budget).toMatchObject({ chargedAttempts: 4, limits: { maxAttempts: 6 } });

    expect(
      extendResearchProviderAttemptsForGoalRevision(metadata, 500).budget?.limits.maxAttempts,
    ).toBe(MAX_RESEARCH_PROVIDER_ATTEMPTS);
    expect(extendResearchProviderAttemptsForGoalRevision({}, 3)).toEqual({
      metadata: {},
      budget: null,
    });
    expect(researchProviderAttemptCeiling(23, {})).toBe(23);
  });
});
