import {
  computeParity,
  gateVerdict,
  parityKey,
  KNOWN_CHANGE_TYPES,
  CRITICAL_CHANGE_TYPES,
  type ParityDecision,
} from '../src/tracker/parity.util.js';

const d = (clientId: string, billId: string, changeType: string, severity: string): ParityDecision => ({
  clientId,
  billId,
  changeType,
  severity,
});

describe('parityKey', () => {
  it('is client:bill:changeType', () => {
    expect(parityKey(d('c1', '119-hr-1', 'bill_reported', 'notable'))).toBe('c1:119-hr-1:bill_reported');
  });
});

describe('computeParity + gateVerdict', () => {
  it('passes on perfect overlap', () => {
    const rows = [d('c1', 'b1', 'bill_reported', 'notable'), d('c1', 'b2', 'bill_enacted', 'critical')];
    const m = computeParity(rows, [...rows]);
    expect(m.overlap).toBe(1);
    expect(m.recall).toBe(1);
    expect(m.precision).toBe(1);
    expect(gateVerdict(m).passed).toBe(true);
  });

  it('hard-fails on a missed critical even at 0.95 overlap/recall', () => {
    const L: ParityDecision[] = [];
    const I: ParityDecision[] = [];
    for (let i = 0; i < 19; i++) {
      L.push(d('c1', `b${i}`, 'bill_reported', 'notable'));
      I.push(d('c1', `b${i}`, 'bill_reported', 'notable'));
    }
    L.push(d('c1', 'bx', 'bill_enacted', 'critical'));
    const m = computeParity(L, I);
    expect(m.missedCriticals).toHaveLength(1);
    const g = gateVerdict(m);
    expect(g.passed).toBe(false);
    expect(g.reason).toMatch(/^GATE_RED:missed_criticals/);
  });

  it('fails when recall < floor', () => {
    const L = [
      d('c1', 'b1', 'bill_reported', 'notable'),
      d('c1', 'b2', 'bill_markup', 'notable'),
      d('c1', 'b3', 'bill_hearing', 'info'),
    ];
    const m = computeParity(L, [d('c1', 'b1', 'bill_reported', 'notable')]);
    expect(m.recall).toBeCloseTo(1 / 3, 9);
    expect(gateVerdict(m).passed).toBe(false);
  });

  it('reports NO_DATA when both sides empty', () => {
    const m = computeParity([], []);
    expect(m.reason).toBe('NO_DATA');
    expect(gateVerdict(m).reason).toBe('NO_DATA');
    expect(gateVerdict(m).passed).toBe(false);
  });

  it('buckets over-fire as intel_only and keeps recall=1', () => {
    const m = computeParity(
      [d('c1', 'b1', 'bill_reported', 'notable')],
      [d('c1', 'b1', 'bill_reported', 'notable'), d('c2', 'b9', 'bill_amendment', 'notable')],
    );
    expect(m.recall).toBe(1);
    expect(m.precision).toBeLessThan(1);
    expect(m.triage.find((t) => t.key === 'c2:b9:bill_amendment')?.bucket).toBe('intel_only');
  });

  it('buckets same client+bill different changeType as classifier drift', () => {
    const m = computeParity([d('c1', 'b1', 'bill_reported', 'notable')], [d('c1', 'b1', 'bill_markup', 'notable')]);
    expect(m.triage.find((t) => t.key === 'c1:b1:bill_reported')?.bucket).toBe('classifier');
    expect(m.triage.find((t) => t.key === 'c1:b1:bill_markup')?.bucket).toBe('classifier');
  });

  it('flags a severity mismatch involving critical on a matched key', () => {
    const m = computeParity([d('c1', 'b1', 'bill_failed', 'critical')], [d('c1', 'b1', 'bill_failed', 'notable')]);
    expect(m.severityCriticalMismatches).toHaveLength(1);
    expect(gateVerdict(m).passed).toBe(false);
  });

  it('dedupes duplicate keys within a side', () => {
    const m = computeParity(
      [d('c1', 'b1', 'bill_reported', 'notable'), d('c1', 'b1', 'bill_reported', 'notable')],
      [d('c1', 'b1', 'bill_reported', 'notable')],
    );
    expect(m.legacyCount).toBe(1);
    expect(m.overlap).toBe(1);
  });
});

describe('changeType constants', () => {
  it('cover the classifyChange cascade', () => {
    expect(KNOWN_CHANGE_TYPES).toHaveLength(10);
    expect(CRITICAL_CHANGE_TYPES).toEqual(['bill_enacted', 'bill_to_president', 'bill_failed']);
  });
});
