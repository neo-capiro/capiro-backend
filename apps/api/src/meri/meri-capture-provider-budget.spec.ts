import {
  admitCaptureProviderBudget,
  captureBudgetRequired,
  readCaptureProviderBudget,
  reserveCaptureProviderAttempt,
  settleCaptureProviderAttempt,
  captureProviderBudgetCoverage,
} from './meri-capture-provider-budget.js';
import {
  captureBudgetTestPolicy,
  captureBudgetTestQualification,
  captureBudgetTestBinding,
} from './meri-capture-provider-budget.spec-helper.js';

describe('ordinary capture durable provider budget', () => {
  test('case14 requires its own explicit qualification and accounting boundary',()=>{
    const policy={...captureBudgetTestPolicy(),caseId:'14'};
    const qualified={...captureBudgetTestQualification(policy),caseId:'14'};
    expect(captureProviderBudgetCoverage('14')).toBe('case14_memory_turn');
    expect(admitCaptureProviderBudget({},policy,qualified).state.qualification.caseId).toBe('14');
    expect(()=>admitCaptureProviderBudget({},policy,{...qualified,caseId:'01'})).toThrow('qualification_missing');
  });
  const p = captureBudgetTestPolicy(),
    q = captureBudgetTestQualification(p),
    b = captureBudgetTestBinding();
  const admitted = () => admitCaptureProviderBudget({ unrelated: 'kept' }, p, q);
  test('does not admit ordinary or unbound diagnostic turns implicitly', () => {
    expect(captureBudgetRequired(null)).toBe(false);
    expect(
      captureBudgetRequired({
        ...p,
        expectedCaptureWrites: [
          'context_packet_and_evidence',
          'conversation_user_message',
          'conversation_assistant_message',
        ],
      }),
    ).toBe(false);
    expect(captureBudgetRequired({ ...p, captureRunId: null })).toBe(true);
    const pre = admitCaptureProviderBudget({}, { ...p, turnId: null }, q);
    expect(pre.state.turnId).toBe(null);
    const bound = admitCaptureProviderBudget(pre.metadata, p, q);
    expect(bound.state.turnId).toBe(p.turnId);
    expect(() => admitCaptureProviderBudget(bound.metadata, { ...p, turnId: 'other' }, q)).toThrow(
      'turn_rebound',
    );
  });
  test('requires qualified bounds and preserves metadata and immutable admission', () => {
    expect(() => admitCaptureProviderBudget({}, p, null)).toThrow('qualification_missing');
    expect(() =>
      admitCaptureProviderBudget({}, p, {
        ...q,
        rateEvidenceExpiresAt: new Date(p.expiresAt - 1).toISOString(),
      }),
    ).toThrow('qualification_missing');
    expect(() =>
      admitCaptureProviderBudget({}, p, {
        ...q,
        rates: [
          {
            kind: 'bedrock_embeddings',
            provider: 'aws-bedrock',
            model: 'test-only',
            inputMicrosPerMillion: 0,
            outputMicrosPerMillion: 1,
          },
        ],
      }),
    ).toThrow('rate_invalid');
    expect(() => admitCaptureProviderBudget({}, p, { ...q, maxCostMicros: 15_000_001 })).toThrow(
      'qualification_missing',
    );
    expect(
      admitCaptureProviderBudget({}, p, { ...q, maxCostMicros: 3_000_000 }).state.ledger.limits
        .maxCostMicros,
    ).toBe(3_000_000);
    expect(() =>
      admitCaptureProviderBudget({}, { ...p, caseId: '02' }, { ...q, caseId: '02' }),
    ).toThrow('qualification_missing');
    const a = admitted();
    expect((a.metadata as Record<string, unknown>).unrelated).toBe('kept');
    expect(admitCaptureProviderBudget(a.metadata, p, q).state.admissionId).toBe(
      a.state.admissionId,
    );
    for (const changed of [
      { ...p, turnId: 'other-turn' },
      { ...p, actorUserId: 'other-actor' },
      { ...p, physicalMapSha256: '3'.repeat(64) },
    ]) {
      expect(() => readCaptureProviderBudget(a.metadata, changed, q)).toThrow('admission_rebound');
    }
    expect(() => readCaptureProviderBudget(a.metadata, p, { ...q, maxCostMicros: 999 })).toThrow(
      'admission_rebound',
    );
  });
  test('unknown actual model, unbounded output and expired dispatch fail closed', () => {
    const a = admitted();
    expect(() =>
      reserveCaptureProviderAttempt(a.metadata, p, q, { ...b, model: 'unknown' }),
    ).toThrow('price_unknown');
    expect(() =>
      reserveCaptureProviderAttempt(a.metadata, p, q, { ...b, maxOutputTokens: null }),
    ).toThrow('output_bound_missing');
    expect(() => reserveCaptureProviderAttempt(a.metadata, p, q, b, new Date(p.expiresAt))).toThrow(
      'deadline',
    );
  });
  test('deduplicates exact wire attempts and rejects rebound duplicate inputs', () => {
    const a = reserveCaptureProviderAttempt(admitted().metadata, p, q, b);
    expect(a.dispatchAllowed).toBe(true);
    const duplicate = reserveCaptureProviderAttempt(a.metadata, p, q, b);
    expect(duplicate.dispatchAllowed).toBe(false);
    expect(duplicate.reservationId).toBe(a.reservationId);
    expect(duplicate.state.ledger.chargedCostMicros).toBe(300);
    expect(() =>
      reserveCaptureProviderAttempt(a.metadata, p, q, { ...b, maxOutputTokens: 101 }),
    ).toThrow();
  });
  test('known settlement releases unused reservation, is replay safe, and never trusts caller pricing', () => {
    const a = reserveCaptureProviderAttempt(admitted().metadata, p, q, b);
    const input = {
      reservationId: a.reservationId,
      binding: b,
      outcome: {
        kind: 'known' as const,
        inputTokens: 10,
        outputTokens: 5,
        price: { inputPerM: 0, outputPerM: 0 },
      },
    };
    const settled = settleCaptureProviderAttempt(a.metadata, p, q, input);
    expect(settled.state.ledger).toMatchObject({
      chargedAttempts: 1,
      chargedTokens: 15,
      chargedCostMicros: 20,
    });
    expect(settleCaptureProviderAttempt(settled.metadata, p, q, input).state).toEqual(
      settled.state,
    );
    expect(() =>
      settleCaptureProviderAttempt(settled.metadata, p, q, {
        ...input,
        outcome: { kind: 'known', inputTokens: 11, outputTokens: 5 },
      }),
    ).toThrow('usage_changed');
    expect(() =>
      settleCaptureProviderAttempt(a.metadata, p, q, {
        ...input,
        outcome: { kind: 'known', inputTokens: 101, outputTokens: 5 },
      }),
    ).toThrow('usage_exceeds');
  });
  test('uncertain dispatch remains fully charged and only then admits a bound retry', () => {
    const a = reserveCaptureProviderAttempt(admitted().metadata, p, q, b);
    const retry = { ...b, attemptId: 'attempt-2', retryOfAttemptId: b.attemptId };
    expect(() => reserveCaptureProviderAttempt(a.metadata, p, q, retry)).toThrow('not_retryable');
    const uncertain = settleCaptureProviderAttempt(a.metadata, p, q, {
      reservationId: a.reservationId,
      binding: b,
      outcome: { kind: 'uncertain' },
    });
    const second = reserveCaptureProviderAttempt(uncertain.metadata, p, q, retry);
    expect(second.state.ledger).toMatchObject({
      chargedAttempts: 2,
      chargedTokens: 400,
      chargedCostMicros: 600,
    });
    expect(() =>
      reserveCaptureProviderAttempt(second.metadata, p, q, {
        ...b,
        logicalOperationId: 'other',
        attemptId: 'third',
        maxOutputTokens: 500,
      }),
    ).toThrow('cost_exhausted');
  });
  test('tampered restored aggregate, per-attempt charge and rate evidence are rejected', () => {
    const a = reserveCaptureProviderAttempt(admitted().metadata, p, q, b);
    for (const mutate of [
      (v: typeof a.state) => {
        v.ledger.chargedCostMicros = 0;
      },
      (v: typeof a.state) => {
        v.ledger.attempts[0]!.reservedCostMicros = 1;
      },
      (v: typeof a.state) => {
        v.qualification.rateEvidenceSha256 = '4'.repeat(64);
      },
    ]) {
      const changed = structuredClone(a.metadata);
      mutate(changed.serverCaptureProviderBudget);
      expect(() => readCaptureProviderBudget(changed, p, q)).toThrow();
    }
  });
  test('shared ledger charges selection, repair and shadow instead of resetting per phase', () => {
    let m = admitted().metadata;
    for (const [i, phase] of ['selection', 'repair', 'shadow'].entries()) {
      m = reserveCaptureProviderAttempt(m, p, q, {
        ...b,
        phase,
        attemptId: `attempt-${i}`,
        logicalOperationId: `op-${i}`,
      }).metadata;
    }
    expect(readCaptureProviderBudget(m, p, q)!.ledger.chargedAttempts).toBe(3);
    expect(() =>
      reserveCaptureProviderAttempt(m, p, q, {
        ...b,
        attemptId: 'fourth',
        logicalOperationId: 'fourth',
      }),
    ).toThrow('attempts_exhausted');
  });
  test('reviewed long-context ceiling permits two bounded rounds without repricing or resetting prior state', () => {
    const long = { ...q, maxTokens: 500_000, maxCostMicros: 15_000_000,
      rates: q.rates.map(rate => ({ ...rate, inputMicrosPerMillion: 25_000_000, outputMicrosPerMillion: 75_000_000 })) };
    let metadata = admitCaptureProviderBudget({}, p, long).metadata;
    for (const [i, inputTokens] of [200_000, 250_000].entries()) {
      const binding = { ...b, attemptId: `long-${i}`, logicalOperationId: `long-${i}`,
        maxInputTokens: inputTokens, maxOutputTokens: 16_384 };
      const reserved = reserveCaptureProviderAttempt(metadata, p, long, binding);
      const settled = settleCaptureProviderAttempt(reserved.metadata, p, long, {
        reservationId: reserved.reservationId, binding,
        outcome: { kind: 'known', inputTokens, outputTokens: 16_384 },
      });
      metadata = settled.metadata;
    }
    expect(readCaptureProviderBudget(metadata, p, long)!.ledger).toMatchObject({
      chargedAttempts: 2, chargedTokens: 482_768, chargedCostMicros: 13_707_600,
    });
    expect(() => reserveCaptureProviderAttempt(metadata, p, long, { ...b, attemptId: 'long-3',
      logicalOperationId: 'long-3', maxInputTokens: 20_000, maxOutputTokens: 16_384 })).toThrow('tokens_exhausted');
    expect(() => readCaptureProviderBudget(metadata, p, { ...long, maxCostMicros: 3_000_000 })).toThrow();
    const legacy = { ...q, maxTokens: 200_000, maxCostMicros: 3_000_000,
      rates: q.rates.map(rate => ({ ...rate, inputMicrosPerMillion: 12_500_000, outputMicrosPerMillion: 50_000_000 })) };
    const prior = admitCaptureProviderBudget({}, p, legacy);
    expect(() => reserveCaptureProviderAttempt(prior.metadata, p, legacy, { ...b,
      maxInputTokens: 174_465, maxOutputTokens: 16_384 })).toThrow('cost_exhausted');
    expect(prior.state.ledger.limits).toMatchObject({ maxTokens: 200_000, maxCostMicros: 3_000_000 });
  });
});
