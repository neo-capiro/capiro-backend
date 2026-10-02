import { randomUUID } from 'node:crypto';
import {
  admitCase46ProviderBudget,
  readCase46ProviderBudget,
  reserveCase46ProviderAttempt,
  settleCase46ProviderAttempt,
  settledCase46ProviderReceipt,
  case46BudgetHash,
} from './meri-case46-provider-budget.js';
import { case46BudgetTestFixture } from './meri-case46-provider-budget.spec-helper.js';

describe('separate governed-artifact provider accounting', () => {
  test('admits only exact46 qualification; preserves other conversation metadata and readonly ledger', () => {
    const { p, q } = case46BudgetTestFixture();
    const a = admitCase46ProviderBudget(
      { unrelated: { keep: true }, serverCaptureProviderBudget: 'untouched' },
      p,
      q,
    );
    expect((a.metadata as Record<string, unknown>).unrelated).toEqual({ keep: true });
    expect((a.metadata as Record<string, unknown>).serverCaptureProviderBudget).toBe('untouched');
    expect(admitCase46ProviderBudget(a.metadata, p, q).state.admissionId).toBe(a.state.admissionId);
    for (const bad of [
      null,
      { ...q, caseId: '01' },
      { ...q, maxCostMicros: 3_000_001 },
      { ...q, currentVerifySha256: 'd'.repeat(64) },
      { ...q, rateEvidenceExpiresAt: new Date(p.expiresAt - 1).toISOString() },
      { ...q, rates: [q.rates[0], q.rates[0]] },
    ])
      expect(() => admitCase46ProviderBudget({}, p, bad)).toThrow();
    expect(() =>
      admitCase46ProviderBudget(
        {},
        { ...p, kind: 'server_readonly_acceptance_capture' } as never,
        q,
      ),
    ).toThrow();
  });
  test('policy/source/current rates cannot rebind after admission and only one turn binds', () => {
    const { p, q } = case46BudgetTestFixture();
    const pre = admitCase46ProviderBudget({}, { ...p, turnId: null }, q);
    const a = admitCase46ProviderBudget(pre.metadata, p, q);
    expect(a.state.turnId).toBe(p.turnId);
    for (const changed of [
      { ...p, turnId: randomUUID() },
      { ...p, conversationId: randomUUID() },
      { ...p, source: { ...p.source, rowVersion: '43' } },
      { ...p, currentVerifySha256: 'c'.repeat(64) },
    ])
      expect(() => readCase46ProviderBudget(a.metadata, changed, q)).toThrow();
    expect(() => admitCase46ProviderBudget(a.metadata, { ...p, turnId: randomUUID() }, q)).toThrow(
      'turn_rebound',
    );
    expect(() => readCase46ProviderBudget(a.metadata, p, { ...q, maxTokens: 999 })).toThrow(
      'qualification_rebound',
    );
  });
  test('same attempt reserves once; rebound, unknown price, missing output bound and expiry deny dispatch', () => {
    const { p, q, b } = case46BudgetTestFixture();
    const a = admitCase46ProviderBudget({}, p, q);
    const r = reserveCase46ProviderAttempt(a.metadata, p, q, b);
    expect(r.dispatchAllowed).toBe(true);
    expect(r.state.ledger.chargedCostMicros).toBe(300);
    const duplicate = reserveCase46ProviderAttempt(r.metadata, p, q, b);
    expect(duplicate.dispatchAllowed).toBe(false);
    expect(duplicate.reservationId).toBe(r.reservationId);
    expect(() =>
      reserveCase46ProviderAttempt(r.metadata, p, q, { ...b, maxOutputTokens: 101 }),
    ).toThrow();
    expect(() =>
      reserveCase46ProviderAttempt(a.metadata, p, q, { ...b, model: 'unpriced' }),
    ).toThrow('price_unknown');
    expect(() =>
      reserveCase46ProviderAttempt(a.metadata, p, q, { ...b, maxOutputTokens: null }),
    ).toThrow('output_bound');
    expect(() => reserveCase46ProviderAttempt(a.metadata, p, q, b, new Date(p.expiresAt))).toThrow(
      'deadline',
    );
  });
  test('known usage is exact, idempotent and ignores caller-supplied price; tampered aggregates deny receipt', () => {
    const { p, q, b } = case46BudgetTestFixture();
    const r = reserveCase46ProviderAttempt(admitCase46ProviderBudget({}, p, q).metadata, p, q, b);
    const input = {
      reservationId: r.reservationId,
      binding: b,
      outcome: {
        kind: 'known' as const,
        inputTokens: 10,
        outputTokens: 5,
        price: { inputPerM: 0, outputPerM: 0 },
      },
    };
    const a = settleCase46ProviderAttempt(r.metadata, p, q, input);
    expect(a.state.ledger.chargedCostMicros).toBe(20);
    expect(a.state.ledger.chargedTokens).toBe(15);
    expect(settleCase46ProviderAttempt(a.metadata, p, q, input).state).toEqual(a.state);
    const receipt = settledCase46ProviderReceipt(a.metadata, p, q);
    expect(receipt).toMatchObject({
      caseId: '46',
      costMicros: 20,
      tokens: 15,
      allAttemptsSettled: true,
    });
    expect(receipt.ledgerSha256).toBe(case46BudgetHash(a.state.ledger));
    expect(() =>
      settleCase46ProviderAttempt(a.metadata, p, q, {
        ...input,
        outcome: { kind: 'known', inputTokens: 11, outputTokens: 5 },
      }),
    ).toThrow();
    const corrupt = structuredClone(a.metadata) as any;
    corrupt.governedArtifactProviderBudget.ledger.chargedCostMicros = 0;
    expect(() => settledCase46ProviderReceipt(corrupt, p, q)).toThrow('aggregate_charge_changed');
  });
  test.each(['reserved', 'uncertain', 'rejected'])(
    '%s outcome cannot produce successful usage evidence',
    (status) => {
      const { p, q, b } = case46BudgetTestFixture();
      const r = reserveCase46ProviderAttempt(admitCase46ProviderBudget({}, p, q).metadata, p, q, b);
      const a =
        status === 'reserved'
          ? r
          : settleCase46ProviderAttempt(r.metadata, p, q, {
              reservationId: r.reservationId,
              binding: b,
              outcome: { kind: status as 'uncertain' | 'rejected' },
            });
      expect(() => settledCase46ProviderReceipt(a.metadata, p, q)).toThrow(
        'settled_usage_required',
      );
      expect(a.state.ledger.chargedCostMicros).toBe(status === 'rejected' ? 0 : 300);
    },
  );
  test('retry is separately charged and a prior uncertain attempt keeps final receipt blocked', () => {
    const { p, q, b } = case46BudgetTestFixture();
    const r = reserveCase46ProviderAttempt(admitCase46ProviderBudget({}, p, q).metadata, p, q, b);
    const u = settleCase46ProviderAttempt(r.metadata, p, q, {
      reservationId: r.reservationId,
      binding: b,
      outcome: { kind: 'uncertain' },
    });
    const retry = { ...b, attemptId: 'attempt-2', retryOfAttemptId: b.attemptId };
    const r2 = reserveCase46ProviderAttempt(u.metadata, p, q, retry);
    expect(r2.state.ledger.chargedAttempts).toBe(2);
    expect(r2.state.ledger.chargedCostMicros).toBe(600);
    const s = settleCase46ProviderAttempt(r2.metadata, p, q, {
      reservationId: r2.reservationId,
      binding: retry,
      outcome: { kind: 'known', inputTokens: 10, outputTokens: 5 },
    });
    expect(() => settledCase46ProviderReceipt(s.metadata, p, q)).toThrow('settled_usage_required');
  });
  test('individual and aggregate actual charge tampering, over-budget attempts and oversettlement fail closed', () => {
    const { p, q, b } = case46BudgetTestFixture();
    const q2 = { ...q, maxAttempts: 1 };
    const p2 = { ...p, qualificationSha256: case46BudgetHash(q2) };
    const r = reserveCase46ProviderAttempt(
      admitCase46ProviderBudget({}, p2, q2).metadata,
      p2,
      q2,
      b,
    );
    expect(() =>
      reserveCase46ProviderAttempt(r.metadata, p2, q2, {
        ...b,
        logicalOperationId: 'op2',
        attemptId: 'attempt2',
      }),
    ).toThrow('attempts_exhausted');
    expect(() =>
      settleCase46ProviderAttempt(r.metadata, p2, q2, {
        reservationId: r.reservationId,
        binding: b,
        outcome: { kind: 'known', inputTokens: 101, outputTokens: 1 },
      }),
    ).toThrow('usage_exceeds');
    const corrupt = structuredClone(r.metadata) as any;
    corrupt.governedArtifactProviderBudget.ledger.attempts[0].reservedCostMicros = 299;
    expect(() => readCase46ProviderBudget(corrupt, p2, q2)).toThrow('reservation_charge_changed');
  });
});
