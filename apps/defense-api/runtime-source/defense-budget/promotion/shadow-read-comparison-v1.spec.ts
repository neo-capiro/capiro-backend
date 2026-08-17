/**
 * Phase 7 Workstream M — shadow comparison.
 *
 * Two properties carry the weight: the classification has to be right, because
 * plan §M.10 gates the canary on it, and the result must contain no data,
 * because shadow mode runs on production traffic and its output goes to a log
 * aggregator.
 */
import {
  blocksCanaryV1,
  compareShadowReadV1,
  normalizeForComparisonV1,
  READ_MISMATCH_CLASS_V1_VALUES,
  shadowDigestV1,
  worstSeverityV1,
} from './shadow-read-comparison-v1.js';

describe('Phase 7 WS M — normalization', () => {
  it('drops volatile keys at every depth', () => {
    const legacy = { peCode: '0601101A', nested: { title: 'x', generatedAt: 'A' } };
    const snapshot = {
      peCode: '0601101A',
      nested: { title: 'x', generatedAt: 'B' },
      provenance: { activeSnapshotId: 'snap-1' },
    };
    expect(shadowDigestV1(legacy)).toBe(shadowDigestV1(snapshot));
  });

  it('treats an omitted key and an undefined key as the same response', () => {
    expect(shadowDigestV1({ a: 1 })).toBe(shadowDigestV1({ a: 1, b: undefined }));
  });

  it('is insensitive to object key order and sensitive to array order', () => {
    expect(shadowDigestV1({ a: 1, b: 2 })).toBe(shadowDigestV1({ b: 2, a: 1 }));
    // A funding timeline, a milestone schedule, and a stage ladder are ordered.
    // A reordered one is a real contract change a client would notice.
    expect(shadowDigestV1({ years: [2027, 2028] })).not.toBe(
      shadowDigestV1({ years: [2028, 2027] }),
    );
  });

  it('can be told an array is an unordered collection', () => {
    expect(shadowDigestV1({ tags: ['a', 'b'] }, { sortArrays: true })).toBe(
      shadowDigestV1({ tags: ['b', 'a'] }, { sortArrays: true }),
    );
  });

  it('normalizes a Date to its instant rather than to an opaque object', () => {
    expect(shadowDigestV1({ at: new Date('2026-08-07T00:00:00.000Z') })).toBe(
      shadowDigestV1({ at: '2026-08-07T00:00:00.000Z' }),
    );
  });
});

describe('Phase 7 WS M — classification', () => {
  it('reports a match with no classes when both sides agree', () => {
    const result = compareShadowReadV1({ legacy: { a: 1 }, snapshot: { a: 1 } });
    expect(result.matched).toBe(true);
    expect(result.classes).toEqual([]);
    expect(result.severity).toBe('none');
    expect(result.blocksCanary).toBe(false);
  });

  it('calls a differing identity field an identity mismatch, not a value conflict', () => {
    // Attributing money to the wrong line is categorically worse than
    // disagreeing about the amount on the right one.
    const result = compareShadowReadV1({
      legacy: { peCode: '0601101A', amount: '5' },
      snapshot: { peCode: '0601102A', amount: '5' },
    });
    expect(result.classes).toContain('identity_mismatch');
    expect(result.severity).toBe('p0');
    expect(result.blocksCanary).toBe(true);
  });

  it('calls a differing ordinary field a value conflict', () => {
    const result = compareShadowReadV1({
      legacy: { peCode: '0601101A', amount: '5' },
      snapshot: { peCode: '0601101A', amount: '6' },
    });
    expect(result.classes).toEqual(['value_conflict']);
    expect(result.severity).toBe('p1');
  });

  it('calls a longer array a possible double count', () => {
    const result = compareShadowReadV1({
      legacy: { rows: [{ amount: '1' }] },
      snapshot: { rows: [{ amount: '1' }, { amount: '1' }] },
    });
    expect(result.classes).toContain('duplicate_or_double_count');
    expect(result.severity).toBe('p0');
  });

  it('calls an absent key missing data and an extra key an improvement', () => {
    expect(compareShadowReadV1({ legacy: { a: 1, b: 2 }, snapshot: { a: 1 } }).classes).toEqual([
      'missing_data',
    ]);
    expect(compareShadowReadV1({ legacy: { a: 1 }, snapshot: { a: 1, b: 2 } }).classes).toEqual([
      'expected_improvement',
    ]);
  });

  it('treats null-to-value as presence rather than a shape change', () => {
    // The snapshot filling in a field the legacy tables never populated is the
    // point of the migration, not a contract break.
    expect(
      compareShadowReadV1({ legacy: { note: null }, snapshot: { note: 'a' } }).classes,
    ).toEqual(['expected_improvement']);
    expect(
      compareShadowReadV1({ legacy: { note: 'a' }, snapshot: { note: null } }).classes,
    ).toEqual(['missing_data']);
  });

  it('calls a changed type a contract shape mismatch', () => {
    const result = compareShadowReadV1({ legacy: { amount: '5' }, snapshot: { amount: 5 } });
    expect(result.classes).toEqual(['contract_shape_mismatch']);
  });

  it('flags a latency regression on identical bodies', () => {
    const result = compareShadowReadV1({
      legacy: { a: 1 },
      snapshot: { a: 1 },
      timing: { legacyMs: 100, snapshotMs: 500 },
    });
    expect(result.classes).toEqual(['performance_regression']);
    expect(result.matched).toBe(false);
    // P2: visible and worth looking at, but it does not block the canary.
    expect(result.blocksCanary).toBe(false);
  });

  it('does not report a regression against a zero-millisecond legacy read', () => {
    const result = compareShadowReadV1({
      legacy: { a: 1 },
      snapshot: { a: 1 },
      timing: { legacyMs: 0, snapshotMs: 3 },
    });
    expect(result.classes).toEqual([]);
  });

  it('ranks severity by the worst class present', () => {
    expect(worstSeverityV1(['expected_improvement', 'identity_mismatch'])).toBe('p0');
    expect(worstSeverityV1(['expected_improvement', 'value_conflict'])).toBe('p1');
    expect(worstSeverityV1(['expected_improvement'])).toBe('p2');
    expect(worstSeverityV1([])).toBe('none');
  });

  it('gates the canary on P0 and P1 only', () => {
    expect(blocksCanaryV1('p0')).toBe(true);
    expect(blocksCanaryV1('p1')).toBe(true);
    expect(blocksCanaryV1('p2')).toBe(false);
    expect(blocksCanaryV1('none')).toBe(false);
  });

  it('has a severity for every class in the vocabulary', () => {
    for (const item of READ_MISMATCH_CLASS_V1_VALUES) {
      expect(worstSeverityV1([item])).not.toBe('none');
    }
  });
});

describe('Phase 7 WS M — the result carries no data', () => {
  it('never quotes a value from either side', () => {
    // Shadow mode runs on production traffic. A mismatch log that quoted the
    // bodies would be a continuous export of budget data into a log aggregator.
    // There is nowhere in ShadowComparisonV1 to put a value, and this asserts it.
    const legacy = {
      peCode: 'SECRET-PE-CODE',
      title: 'Distinctive Program Title',
      amount: '123456.789',
      rows: [{ note: 'unmistakable-legacy-string' }],
    };
    const snapshot = {
      peCode: 'OTHER-PE-CODE',
      title: 'Different Distinctive Title',
      amount: '987654.321',
      rows: [{ note: 'unmistakable-snapshot-string' }, { note: 'extra' }],
    };
    const result = compareShadowReadV1({ legacy, snapshot });
    expect(result.matched).toBe(false);

    const serialized = JSON.stringify(result);
    for (const secret of [
      'SECRET-PE-CODE',
      'OTHER-PE-CODE',
      'Distinctive Program Title',
      'Different Distinctive Title',
      '123456.789',
      '987654.321',
      'unmistakable-legacy-string',
      'unmistakable-snapshot-string',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // It still located the differences.
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details.map((detail) => detail.path)).toContain('peCode');
  });

  it('bounds the detail list so one pathological response cannot fill a log', () => {
    const legacy: Record<string, number> = {};
    const snapshot: Record<string, number> = {};
    for (let index = 0; index < 500; index += 1) {
      legacy[`k${index}`] = index;
      snapshot[`k${index}`] = index + 1;
    }
    const result = compareShadowReadV1({ legacy, snapshot });
    expect(result.details.length).toBeLessThanOrEqual(50);
    expect(result.classes).toContain('value_conflict');
  });

  it('normalizes to a plain JSON tree with no prototypes carried through', () => {
    const normalized = normalizeForComparisonV1({ a: new Date(0), b: [1, undefined, null] });
    expect(normalized).toEqual({ a: '1970-01-01T00:00:00.000Z', b: [1, null, null] });
  });
});
