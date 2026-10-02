import { createHash } from 'node:crypto';
import { createMemoryReadHttp } from './memory-read-http.mjs';
import { sha256Stable } from './lib/stable.mjs';
const receipts = new WeakMap();
const need = (v) => {
  if (!v) throw new Error('MEMORY_READ_SERVER_BUDGET_UNVERIFIED');
};
const hash = (v) => createHash('sha256').update(v).digest('hex');

/** Pure inspection is not settlement authority. Tests may supply UNIT objects;
 * only the fixed authenticated reader below creates the in-process capability. */
export function inspectMemoryReadServerBudget(
  conversation,
  messages,
  plan,
  reservation,
  { terminal },
) {
  need(
    conversation?.id === plan.conversationId &&
      conversation.tenantId === plan.tenantId &&
      conversation.userId === plan.actorUserId &&
      conversation.clientId === plan.clientId &&
      !conversation.archivedAt,
  );
  const m = conversation.metadata,
    q = m?.syntheticReadBudgetQualification,
    b = m?.syntheticReadProviderBudget;
  need(
    q?.kind === 'synthetic_read_budget_only' &&
      q.version === 1 &&
      q.caseId === plan.caseId &&
      q.captureRunId === plan.captureRunId &&
      q.aggregateReservationId === reservation.reservationId &&
      q.tenantId === plan.tenantId &&
      q.actorUserId === plan.actorUserId &&
      q.clientId === plan.clientId &&
      q.conversationId === plan.conversationId &&
      q.promptSha256 === plan.promptSha256 &&
      q.maxCostMicros === reservation.ceilingMicros &&
      q.maxCostMicros === plan.maxCostMicros &&
      Number.isFinite(Date.parse(q.deadlineAt)) &&
      Array.isArray(messages),
  );
  if (!terminal) {
    need(
      Date.parse(q.deadlineAt) > Date.now() &&
        !b &&
        !m.syntheticReadBudgetTerminal &&
        messages.length === 0,
    );
    return { qualificationSha256: sha256Stable(q) };
  }
  const end = m.syntheticReadBudgetTerminal,
    l = b?.ledger;
  need(
    end?.kind === 'synthetic_read_budget_terminal' &&
      end.version === 1 &&
      end.allAttemptsSettled === true &&
      end.captureAuthority === false &&
      end.policySha256 === b?.policySha256 &&
      end.turnId === b?.turnId &&
      b.version === 1 &&
      b.qualificationSha256 === sha256Stable(q) &&
      sha256Stable(b.qualification) === sha256Stable(q) &&
      l?.version === 1 &&
      l.activation === 'enforced' &&
      l.attempts.length > 0 &&
      l.chargedAttempts === l.attempts.length &&
      l.limits.maxCostMicros === q.maxCostMicros &&
      l.limits.maxAttempts === q.maxAttempts &&
      l.limits.maxTokens === q.maxTokens &&
      l.limits.deadlineAt === q.deadlineAt &&
      end.ledgerSha256 === sha256Stable(l),
  );
  let cost = 0,
    tokens = 0;
  const ids = new Set();
  for (const a of l.attempts) {
    need(
      a.runId === b.admissionId &&
        a.leaseEpoch === 1 &&
        a.priceKnown === true &&
        !ids.has(a.attemptId),
    );
    ids.add(a.attemptId);
    need(a.status === 'settled' || a.status === 'rejected');
    need(
      [a.actualInputTokens, a.actualOutputTokens, a.actualCostMicros].every(
        (v) => Number.isSafeInteger(v) && v >= 0,
      ),
    );
    const rate = q.rates.filter(
      (r) => r.kind === a.kind && r.provider === a.provider && r.model === a.model,
    );
    need(rate.length === 1);
    const expected =
      a.status === 'rejected'
        ? 0
        : Math.max(
            1,
            Math.ceil(
              (rate[0].inputMicrosPerMillion * a.actualInputTokens +
                rate[0].outputMicrosPerMillion * a.actualOutputTokens) /
                1000000,
            ),
          );
    need(
      a.actualCostMicros === expected &&
        a.actualInputTokens <= a.reservedInputTokens &&
        a.actualOutputTokens <= a.reservedOutputTokens,
    );
    if (a.status === 'rejected') need(a.actualInputTokens === 0 && a.actualOutputTokens === 0);
    cost += a.actualCostMicros;
    tokens += a.actualInputTokens + a.actualOutputTokens;
  }
  need(
    cost === l.chargedCostMicros &&
      cost === end.chargedCostMicros &&
      cost <= q.maxCostMicros &&
      tokens === l.chargedTokens &&
      tokens <= q.maxTokens &&
      l.attempts.length <= q.maxAttempts &&
      messages.length === 2,
  );
  const user = messages.find((v) => v.role === 'user' && v.id === b.turnId),
    assistant = messages.find((v) => v.role === 'assistant' && v.id === end.assistantMessageId);
  need(
    user &&
      assistant &&
      hash(user.body) === plan.promptSha256 &&
      typeof assistant.body === 'string' &&
      assistant.body.length > 0,
  );
  for (const v of messages)
    need(
      v.conversationId === plan.conversationId &&
        v.tenantId === plan.tenantId &&
        v.userId === plan.actorUserId &&
        v.clientId === plan.clientId,
    );
  return {
    caseId: plan.caseId,
    captureRunId: plan.captureRunId,
    reservationId: reservation.reservationId,
    conversationId: plan.conversationId,
    chargedCostMicros: cost,
    ledgerSha256: sha256Stable(l),
    envelopeSha256: sha256Stable({
      terminal: end,
      qualification: q,
      messages: messages.map((v) => ({ id: v.id, role: v.role, bodySha256: hash(v.body) })),
    }),
    expectedSha256: sha256Stable({
      caseId: plan.caseId,
      captureRunId: plan.captureRunId,
      maxSpendMicros: plan.maxCostMicros,
      conversationId: plan.conversationId,
      actorUserId: plan.actorUserId,
      clientId: plan.clientId,
      promptSha256: plan.promptSha256,
    }),
    captureAuthority: false,
  };
}

/** Exact same-origin TLS/ordinary bearer readback. No auth creation, mutation,
 * redirect, caller-supplied receipt or custom transport is accepted. */
export function createMemoryReadServerBudgetReader({ plan, reservation, bearer }) {
  const fixedPlan = structuredClone(plan),
    fixedReservation = structuredClone(reservation);
  const http = createMemoryReadHttp({
    bearer,
    conversationId: plan.conversationId,
    timeoutMs: plan.timeoutMs,
  });
  let preflight = false,
    finished = false;
  async function read(terminal) {
    const base = `/api/clio/conversations/${fixedPlan.conversationId}`;
    const a = await http.request(base),
      b = await http.request(base + '/messages');
    need(
      a.status === 200 &&
        b.status === 200 &&
        a.releaseSha === fixedPlan.apiSha &&
        b.releaseSha === fixedPlan.apiSha,
    );
    const proof = inspectMemoryReadServerBudget(
      JSON.parse(a.text),
      JSON.parse(b.text),
      fixedPlan,
      fixedReservation,
      { terminal },
    );
    return proof;
  }
  return Object.freeze({
    async before() {
      need(!preflight && !finished);
      await read(false);
      preflight = true;
    },
    async terminal() {
      need(preflight && !finished);
      finished = true;
      const proof = await read(true);
      const authority = Object.freeze({ kind: 'authenticated_memory_read_usage' });
      receipts.set(authority, proof);
      return authority;
    },
  });
}
export function currentMemoryReadUsageAuthority(value) {
  const proof = receipts.get(value);
  need(proof);
  return structuredClone(proof);
}
