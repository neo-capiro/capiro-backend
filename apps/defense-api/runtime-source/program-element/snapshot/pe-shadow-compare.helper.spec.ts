import {
  recordPeShadowComparisonV1,
  schedulePeShadowComparisonV1,
} from './pe-shadow-compare.helper.js';

describe('recordPeShadowComparisonV1', () => {
  it('reports matched when both sides are identical', () => {
    const result = recordPeShadowComparisonV1({
      method: 'getBudgetPositions',
      legacy: { peCode: 'PE0601', amount: '5.0' },
      snapshot: { peCode: 'PE0601', amount: '5.0' },
    });
    expect(result?.matched).toBe(true);
  });

  it('reports a mismatch without throwing when the sides differ', () => {
    const result = recordPeShadowComparisonV1({
      method: 'getBudgetPositions',
      legacy: { peCode: 'PE0601', amount: '5.0' },
      snapshot: { peCode: 'PE0601', amount: '6.0' },
    });
    expect(result?.matched).toBe(false);
    expect(result?.severity).not.toBe('none');
  });

  it('never throws, even given inputs that would break a naive comparator', () => {
    const circular: Record<string, unknown> = { peCode: 'PE0601' };
    circular.self = circular;
    expect(() =>
      recordPeShadowComparisonV1({ method: 'getBudgetPositions', legacy: circular, snapshot: {} }),
    ).not.toThrow();
  });
});

describe('schedulePeShadowComparisonV1', () => {
  it('does not reject or throw when the compute thunk rejects', async () => {
    expect(() =>
      schedulePeShadowComparisonV1({
        method: 'getProgramElement',
        compute: () => Promise.reject(new Error('snapshot path failed')),
      }),
    ).not.toThrow();
    // Let the detached promise chain settle before the test process exits.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('runs the compute thunk and records a matched comparison without throwing', async () => {
    expect(() =>
      schedulePeShadowComparisonV1({
        method: 'getProgramElement',
        compute: async () => ({
          legacy: { peCode: 'PE0601' },
          snapshot: { peCode: 'PE0601' },
          timing: { legacyMs: 10, snapshotMs: 12 },
        }),
      }),
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
