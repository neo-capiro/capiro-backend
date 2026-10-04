import { randomUUID } from 'node:crypto';
import {
  CASE12_SETUP_WIRES,
  CASE12_SETUP_MAX_INPUT_TOKENS,
  case12SetupBodyHash,
  case12SetupBudgetTotals,
  case12SetupCost,
  completeCase12SetupBudgetRow,
  createCase12SetupBudget,
  readCase12SetupBudget,
  reserveCase12SetupWire,
  settleCase12SetupWire,
  validateCase12SetupBudgetPlan,
  type Case12SetupBudgetPlan,
  type Case12SetupWireKind,
} from './meri-case12-setup-budget.js';
import {
  admitResearchProviderBudget,
  MAX_RESEARCH_PROVIDER_ATTEMPTS,
} from './meri-research-tool-budget.js';

const now = new Date('2026-10-04T10:00:00.000Z');
const kinds = ['openai_embeddings', 'bedrock_embeddings'] as const;
const bodies = {
  openai_embeddings: JSON.stringify({ model: 'text-embedding-3-small', input: 'Synthetic memory' }),
  bedrock_embeddings: JSON.stringify({
    inputText: 'Synthetic memory',
    dimensions: 1024,
    normalize: true,
  }),
};
export function testCase12Plan(): Case12SetupBudgetPlan {
  const plan: Case12SetupBudgetPlan = {
    version: 1,
    caseId: '12',
    fixtureNamespace: 'meri-foundation-20260928',
    fixtureInstanceId: randomUUID(),
    runId: randomUUID(),
    aggregateReservationId: randomUUID(),
    tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    proposerUserId: randomUUID(),
    reviewerUserId: randomUUID(),
    clientId: randomUUID(),
    setupPlanSha256: '1'.repeat(64),
    recipeSha256: '2'.repeat(64),
    orderedDefinitionSha256: '3'.repeat(64),
    sourceSha256: '4'.repeat(64),
    imageSha256: '5'.repeat(64),
    aggregateCheckpointSha256: '6'.repeat(64),
    rateEvidenceSha256: '7'.repeat(64),
    admittedAt: now.toISOString(),
    deadlineAt: '2026-10-04T10:15:00.000Z',
    ratesExpiresAt: '2026-10-04T11:00:00.000Z',
    // Deliberate test prices, not live rate evidence or monetary authority.
    rates: {
      openai_embeddings: { inputPerM: 0.2, outputPerM: 0 },
      bedrock_embeddings: { inputPerM: 0.3, outputPerM: 0 },
    },
    maxCostMicros: 1,
    rows: Array.from({ length: 510 }, (_, i) => ({
      candidateId: `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`,
      logicalId: i === 0 ? 'MA510' : `MA510-DISTRACTOR-${String(i).padStart(4, '0')}`,
      candidatePayloadSha256: '8'.repeat(64),
      requests: {
        openai_embeddings: {
          bodySha256: case12SetupBodyHash(bodies.openai_embeddings),
          inputBytes: Buffer.byteLength(bodies.openai_embeddings),
        },
        bedrock_embeddings: {
          bodySha256: case12SetupBodyHash(bodies.bedrock_embeddings),
          inputBytes: Buffer.byteLength(bodies.bedrock_embeddings),
        },
      },
    })),
  };
  plan.maxCostMicros = plan.rows.reduce(
    (n, r) =>
      n +
      kinds.reduce(
        (m, k) => m + case12SetupCost(plan.rates[k].inputPerM, CASE12_SETUP_MAX_INPUT_TOKENS),
        0,
      ),
    0,
  );
  return plan;
}
const wire = (kind: Case12SetupWireKind) => ({
  kind,
  ...CASE12_SETUP_WIRES[kind],
  body: bodies[kind],
});

it('accounts all 1020 one-shot attempts across 510 ordered children without expanding ordinary64', () => {
  const plan = testCase12Plan();
  let state = createCase12SetupBudget(plan);
  for (let i = 0; i < 510; i++) {
    for (const kind of kinds) {
      const reserved = reserveCase12SetupWire(state, plan, i, wire(kind), now);
      state = settleCase12SetupWire(
        reserved.state,
        plan,
        i,
        kind,
        reserved.reservationId,
        { kind: 'known', inputTokens: 5, outputTokens: 0 },
        now,
      );
    }
    state = completeCase12SetupBudgetRow(state, plan, i);
  }
  expect(case12SetupBudgetTotals(state, plan)).toEqual({
    chargedAttempts: 1020,
    chargedTokens: 5100,
    chargedCostMicros: 1530,
    pendingAttempts: 0,
    allRowsSettled: true,
    captureAuthority: false,
  });
  expect(MAX_RESEARCH_PROVIDER_ATTEMPTS).toBe(64);
  expect(() =>
    admitResearchProviderBudget(
      {},
      { maxAttempts: 65, maxTokens: 10000, maxCostMicros: 10000, deadlineAt: plan.deadlineAt },
    ),
  ).toThrow();
}, 120000);

it('allows the two branches to reserve before settlement and stops pending, uncertainty and replay', () => {
  const plan = testCase12Plan(),
    initial = createCase12SetupBudget(plan);
  const first = reserveCase12SetupWire(initial, plan, 0, wire(kinds[0]), now);
  const both = reserveCase12SetupWire(first.state, plan, 0, wire(kinds[1]), now);
  expect(() => completeCase12SetupBudgetRow(both.state, plan, 0)).toThrow('row_incomplete');
  expect(() => reserveCase12SetupWire(both.state, plan, 1, wire(kinds[0]), now)).toThrow(
    'dispatch_denied',
  );
  expect(() => reserveCase12SetupWire(both.state, plan, 0, wire(kinds[0]), now)).toThrow(
    'wire_replay_denied',
  );
  const uncertain = settleCase12SetupWire(
    both.state,
    plan,
    0,
    kinds[0],
    first.reservationId,
    { kind: 'uncertain' },
    now,
  );
  const final = settleCase12SetupWire(
    uncertain,
    plan,
    0,
    kinds[1],
    both.reservationId,
    { kind: 'known', inputTokens: 5, outputTokens: 0 },
    now,
  );
  expect(case12SetupBudgetTotals(final, plan).chargedCostMicros).toBe(
    case12SetupCost(0.2, CASE12_SETUP_MAX_INPUT_TOKENS) + case12SetupCost(0.3, 5),
  );
  expect(() => reserveCase12SetupWire(final, plan, 1, wire(kinds[0]), now)).toThrow(
    'dispatch_denied',
  );
  expect(() => completeCase12SetupBudgetRow(final, plan, 0)).toThrow('row_incomplete');
  expect(() => readCase12SetupBudget({ ...final, reconciliationRequired: false }, plan)).toThrow(
    'uncertainty_cleared',
  );
});

it.each(['body', 'model', 'provider', 'endpoint', 'kind'] as const)(
  'rejects changed %s before dispatch',
  (field) => {
    const plan = testCase12Plan();
    expect(() =>
      reserveCase12SetupWire(
        createCase12SetupBudget(plan),
        plan,
        0,
        { ...wire(kinds[0]), [field]: 'wrong' } as any,
        now,
      ),
    ).toThrow();
  },
);
it('rejects expired, early and rebound plans and mutable caller state', () => {
  const plan = testCase12Plan(),
    state = createCase12SetupBudget(plan);
  expect(() =>
    reserveCase12SetupWire(state, plan, 0, wire(kinds[0]), new Date(plan.deadlineAt)),
  ).toThrow('deadline');
  expect(() =>
    reserveCase12SetupWire(state, plan, 0, wire(kinds[0]), new Date(now.getTime() - 1)),
  ).toThrow('wire_changed');
  expect(() => readCase12SetupBudget(state, { ...plan, runId: randomUUID() })).toThrow(
    'state_invalid',
  );
  const reserved = reserveCase12SetupWire(state, plan, 0, wire(kinds[0]), now);
  expect(state.rows.every((r) => r === null)).toBe(true);
  const tampered = structuredClone(reserved.state);
  tampered.rows[0]!.chargedCostMicros--;
  expect(() => readCase12SetupBudget(tampered, plan)).toThrow();
});
it.each([
  (p: Case12SetupBudgetPlan) => {
    (p as any).fixtureInstanceId = [p.fixtureInstanceId];
  },
  (p: Case12SetupBudgetPlan) => {
    (p as any).setupPlanSha256 = [p.setupPlanSha256];
  },
  (p: Case12SetupBudgetPlan) => {
    (p.rows[0] as any).candidateId = [p.rows[0]!.candidateId];
  },
  (p: Case12SetupBudgetPlan) => {
    (p.rows[0] as any).candidatePayloadSha256 = [p.rows[0]!.candidatePayloadSha256];
  },
  (p: Case12SetupBudgetPlan) => {
    (p.rows[0]!.requests.openai_embeddings as any).bodySha256 = [
      p.rows[0]!.requests.openai_embeddings.bodySha256,
    ];
  },
  (p: Case12SetupBudgetPlan) => {
    p.rows.pop();
  },
  (p: Case12SetupBudgetPlan) => {
    p.rows[1]!.candidateId = p.rows[0]!.candidateId;
  },
  (p: Case12SetupBudgetPlan) => {
    p.rows.reverse();
  },
  (p: Case12SetupBudgetPlan) => {
    p.maxCostMicros++;
  },
  (p: Case12SetupBudgetPlan) => {
    p.ratesExpiresAt = p.admittedAt;
  },
  (p: Case12SetupBudgetPlan) => {
    p.rates.openai_embeddings.inputPerM = NaN;
  },
  (p: Case12SetupBudgetPlan) => {
    (p as any).captureAuthority = true;
  },
])('rejects malformed plan', (mutate) => {
  const plan = testCase12Plan();
  mutate(plan);
  expect(() => validateCase12SetupBudgetPlan(plan)).toThrow();
});
it('does not refund malformed usage or rewrite uncertain settlement', () => {
  const plan = testCase12Plan(),
    reserved = reserveCase12SetupWire(createCase12SetupBudget(plan), plan, 0, wire(kinds[0]), now);
  for (const tokens of [-1, 0.5, NaN, Infinity, 1_000_001]) {
    expect(() =>
      settleCase12SetupWire(
        reserved.state,
        plan,
        0,
        kinds[0],
        reserved.reservationId,
        { kind: 'known', inputTokens: tokens, outputTokens: 0 },
        now,
      ),
    ).toThrow();
  }
  expect(reserved.state.rows[0]!.attempts[0]!.status).toBe('reserved');
  const uncertain = settleCase12SetupWire(
    reserved.state,
    plan,
    0,
    kinds[0],
    reserved.reservationId,
    { kind: 'uncertain' },
    now,
  );
  expect(() =>
    settleCase12SetupWire(
      uncertain,
      plan,
      0,
      kinds[0],
      reserved.reservationId,
      { kind: 'known', inputTokens: 5, outputTokens: 0 },
      now,
    ),
  ).toThrow('outcome_changed');
});
