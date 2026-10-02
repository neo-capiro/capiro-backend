import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { sha256Stable } from '../lib/stable.mjs';
import {
  inspectMemoryReadServerBudget,
  currentMemoryReadUsageAuthority,
} from '../memory-read-budget-authority.mjs';
function fixture() {
  const h = (t) => createHash('sha256').update(t).digest('hex');
  const plan = {
    caseId: '02',
    captureRunId: randomUUID(),
    conversationId: randomUUID(),
    actorUserId: randomUUID(),
    tenantId: randomUUID(),
    clientId: randomUUID(),
    promptSha256: h('unit prompt'),
    maxCostMicros: 3000000,
  };
  const reservation = { reservationId: randomUUID(), ceilingMicros: 3000000 };
  const q = {
    kind: 'synthetic_read_budget_only',
    version: 1,
    ...plan,
    aggregateReservationId: reservation.reservationId,
    actorUserId: plan.actorUserId,
    maxTokens: 1000,
    maxAttempts: 2,
    deadlineAt: new Date(Date.now() + 600000).toISOString(),
    rates: [
      {
        kind: 'openai_responses',
        provider: 'openai',
        model: 'unit',
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 2000000,
      },
    ],
  };
  const admissionId = randomUUID(),
    turnId = randomUUID(),
    assistantId = randomUUID();
  const ledger = {
    version: 1,
    activation: 'enforced',
    limits: {
      maxCostMicros: q.maxCostMicros,
      maxTokens: q.maxTokens,
      maxAttempts: q.maxAttempts,
      deadlineAt: q.deadlineAt,
    },
    chargedAttempts: 1,
    chargedTokens: 15,
    chargedCostMicros: 20,
    attempts: [
      {
        runId: admissionId,
        leaseEpoch: 1,
        priceKnown: true,
        attemptId: 'one',
        status: 'settled',
        kind: 'openai_responses',
        provider: 'openai',
        model: 'unit',
        actualInputTokens: 10,
        actualOutputTokens: 5,
        actualCostMicros: 20,
        reservedInputTokens: 100,
        reservedOutputTokens: 100,
      },
    ],
  };
  const state = {
    version: 1,
    policySha256: 'a'.repeat(64),
    admissionId,
    turnId,
    qualification: q,
    qualificationSha256: sha256Stable(q),
    ledger,
  };
  const terminal = {
    kind: 'synthetic_read_budget_terminal',
    version: 1,
    policySha256: state.policySha256,
    turnId,
    assistantMessageId: assistantId,
    allAttemptsSettled: true,
    captureAuthority: false,
    chargedCostMicros: 20,
    ledgerSha256: sha256Stable(ledger),
  };
  const conversation = {
    id: plan.conversationId,
    tenantId: plan.tenantId,
    userId: plan.actorUserId,
    clientId: plan.clientId,
    archivedAt: null,
    metadata: {
      syntheticReadBudgetQualification: q,
      syntheticReadProviderBudget: state,
      syntheticReadBudgetTerminal: terminal,
    },
  };
  const messages = [
    { id: turnId, role: 'user', body: 'unit prompt' },
    { id: assistantId, role: 'assistant', body: 'unit reply' },
  ].map((v) => ({
    ...v,
    conversationId: plan.conversationId,
    tenantId: plan.tenantId,
    userId: plan.actorUserId,
    clientId: plan.clientId,
  }));
  return { plan, reservation, conversation, messages };
}
const inspect = (x) =>
  inspectMemoryReadServerBudget(x.conversation, x.messages, x.plan, x.reservation, {
    terminal: true,
  });
test('settled server arithmetic and actual message joins produce cost observation, never local authority', () => {
  const x = fixture(),
    p = inspect(x);
  assert.equal(p.chargedCostMicros, 20);
  assert.equal(p.captureAuthority, false);
  assert.throws(() => currentMemoryReadUsageAuthority(p));
});
test('wrong owner/conversation/client/reservation, forged source authority, inflight or uncertain attempts refuse', () => {
  for (const mutate of [
    (x) => (x.conversation.id = randomUUID()),
    (x) => (x.conversation.userId = randomUUID()),
    (x) => (x.conversation.clientId = randomUUID()),
    (x) => (x.reservation.reservationId = randomUUID()),
    (x) => (x.conversation.metadata.syntheticReadBudgetTerminal.captureAuthority = true),
    (x) => (x.conversation.metadata.syntheticReadBudgetTerminal.allAttemptsSettled = false),
    (x) => x.messages.pop(),
    (x) => (x.messages[0].body = 'different'),
    (x) => (x.messages[1].userId = randomUUID()),
    (x) =>
      (x.conversation.metadata.syntheticReadProviderBudget.ledger.attempts[0].status = 'reserved'),
    (x) =>
      (x.conversation.metadata.syntheticReadProviderBudget.ledger.attempts[0].status = 'uncertain'),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspect(x));
  }
});
test('caller cost/price tampering and no-attempt pseudo-success cannot release budget', () => {
  for (const mutate of [
    (x) => (x.conversation.metadata.syntheticReadProviderBudget.ledger.chargedCostMicros = 0),
    (x) =>
      (x.conversation.metadata.syntheticReadProviderBudget.ledger.attempts[0].actualCostMicros = 0),
    (x) =>
      (x.conversation.metadata.syntheticReadBudgetQualification.rates[0].inputMicrosPerMillion = 0),
    (x) => (x.conversation.metadata.syntheticReadProviderBudget.ledger.attempts = []),
    (x) => (x.conversation.metadata.syntheticReadProviderBudget.qualification.maxCostMicros = 999),
  ]) {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspect(x));
  }
});
test('before-send readback requires empty message list, absent prior admission and unexpired deadline', () => {
  const x = fixture();
  delete x.conversation.metadata.syntheticReadProviderBudget;
  delete x.conversation.metadata.syntheticReadBudgetTerminal;
  assert.doesNotThrow(() =>
    inspectMemoryReadServerBudget(x.conversation, [], x.plan, x.reservation, { terminal: false }),
  );
  assert.throws(() =>
    inspectMemoryReadServerBudget(x.conversation, x.messages, x.plan, x.reservation, {
      terminal: false,
    }),
  );
  x.conversation.metadata.syntheticReadBudgetQualification.deadlineAt = new Date(
    Date.now() - 1,
  ).toISOString();
  assert.throws(() =>
    inspectMemoryReadServerBudget(x.conversation, [], x.plan, x.reservation, { terminal: false }),
  );
});
