import type { ResearchPlanV1 } from './meri-research-plan.js';
import {
  admitResearchToolBudget,
  completeResearchToolAttempt,
  readResearchToolBudget,
  reserveResearchToolAttempt,
  ResearchToolBudgetError,
} from './meri-research-tool-budget.js';

const toolVersion = `sha256:${'a'.repeat(64)}`;
const run = (id: string, leaseEpoch: number) => ({ id, leaseEpoch });

function plan(toolCalls: number): ResearchPlanV1 {
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
    budget: { toolCalls, tokens: 1_000 },
    steps: [
      {
        id: 'read',
        objective: 'Read approved sources',
        dependsOn: [],
        requiredEvidenceDomains: ['institutional_memory'],
        allowedCapabilities: ['search_memory'],
        effect: 'read',
        completionCondition: 'Evidence captured',
        budget: { toolCalls, tokens: 1_000 },
      },
    ],
    clarifyingQuestions: [],
  };
}

function binding(providerCallId: string, query = 'radar') {
  return {
    providerCallId,
    kind: 'dispatch' as const,
    tool: 'search_memory',
    toolVersion,
    input: { query },
  };
}

describe('persisted research tool attempt budget', () => {
  test('keeps spent totals across lease replacement and cannot expand or reset them by replanning', () => {
    const first = reserveResearchToolAttempt({
      metadata: {},
      run: run('run-1', 1),
      plan: plan(3),
      binding: binding('call-1'),
      reservationId: 'reservation-1',
    });
    const second = reserveResearchToolAttempt({
      metadata: { ...first.metadata, run: run('run-2', 2) },
      run: run('run-2', 2),
      plan: plan(3),
      binding: binding('call-2'),
      reservationId: 'reservation-2',
    });

    expect(second.budget).toMatchObject({ limit: 3, spent: 2 });
    expect(second.budget.attempts.map((attempt) => attempt.runId)).toEqual(['run-1', 'run-2']);
    expect(() => admitResearchToolBudget(second.metadata, 4)).toThrow(
      'research_tool_budget_replan_expansion_denied',
    );
    expect(admitResearchToolBudget(second.metadata, 2).budget).toMatchObject({
      limit: 2,
      spent: 2,
    });
  });

  test('claims a trusted identity once, retains a lost-response reservation, and rejects changed input', () => {
    const first = reserveResearchToolAttempt({
      metadata: {},
      run: run('run-1', 1),
      plan: plan(2),
      binding: binding('provider-call-1'),
      reservationId: 'reservation-1',
    });
    const duplicate = reserveResearchToolAttempt({
      metadata: first.metadata,
      run: run('run-1', 1),
      plan: plan(2),
      binding: binding('provider-call-1'),
    });

    expect(duplicate.dispatchAllowed).toBe(false);
    expect(duplicate.reservation).toMatchObject({
      reservationId: 'reservation-1',
      status: 'reserved',
      outcome: null,
    });
    expect(duplicate.budget.spent).toBe(1);
    expect(() =>
      reserveResearchToolAttempt({
        metadata: first.metadata,
        run: run('run-1', 1),
        plan: plan(2),
        binding: binding('provider-call-1', 'changed'),
      }),
    ).toThrow('research_tool_budget_attempt_identity_reused');
  });

  test('spends the last slot before dispatch and rejects every new identity after exhaustion', () => {
    const last = reserveResearchToolAttempt({
      metadata: admitResearchToolBudget({}, 1).metadata,
      run: run('run-1', 1),
      plan: plan(1),
      binding: binding('last-slot'),
      reservationId: 'last-reservation',
    });

    expect(last).toMatchObject({ dispatchAllowed: true, budget: { spent: 1, limit: 1 } });
    expect(() =>
      reserveResearchToolAttempt({
        metadata: last.metadata,
        run: run('run-1', 1),
        plan: plan(1),
        binding: binding('one-too-many'),
      }),
    ).toThrow('research_tool_budget_exhausted');
  });

  test('pairs a qualified result with the immutable reservation without refunding spend', () => {
    const reserved = reserveResearchToolAttempt({
      metadata: {},
      run: run('run-1', 1),
      plan: plan(1),
      binding: binding('provider-call-1'),
      reservationId: 'reservation-1',
    });
    const completed = completeResearchToolAttempt({
      metadata: reserved.metadata,
      run: run('run-1', 1),
      reservationId: 'reservation-1',
      binding: {
        kind: 'dispatch',
        tool: 'search_memory',
        toolVersion,
        input: { query: 'radar' },
      },
      outcome: 'result_committed',
    });

    expect(completed.budget).toMatchObject({ spent: 1, limit: 1 });
    expect(completed.reservation).toMatchObject({
      status: 'completed',
      outcome: 'result_committed',
    });
  });

  test('fails closed on malformed or overflowed persisted state', () => {
    expect(() =>
      readResearchToolBudget({
        researchToolBudget: { version: 1, limit: 1, spent: 2, attempts: [] },
      }),
    ).toThrow(ResearchToolBudgetError);
    expect(() =>
      readResearchToolBudget({
        researchToolBudget: {
          version: 1,
          limit: 1,
          spent: 0,
          attempts: [],
          callerSuppliedQuota: 48,
        },
      }),
    ).toThrow('research_tool_budget_malformed');
  });
});
