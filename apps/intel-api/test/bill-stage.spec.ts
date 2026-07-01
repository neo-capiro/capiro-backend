import {
  billStage,
  passageProbability,
  currentCongress,
  congressFromBillId,
} from '../src/tracker/bill-stage.util.js';

describe('billStage', () => {
  it('classifies latest-action text into a board stage', () => {
    expect(billStage('Signed by President; became Public Law 119-1')).toBe('enacted');
    expect(billStage('Passed House by voice vote')).toBe('passed');
    expect(billStage('Agreed to in Senate')).toBe('passed');
    expect(billStage('Referred to the Committee on Armed Services')).toBe('committee');
    expect(billStage('Introduced in House')).toBe('introduced');
    expect(billStage(null)).toBe('introduced');
    expect(billStage(undefined)).toBe('introduced');
  });
});

describe('passageProbability', () => {
  const now = new Date('2026-07-01T00:00:00Z').getTime();

  it('orders enacted > passed > committee > introduced', () => {
    const enacted = passageProbability({ latestActionText: 'became public law', title: null, latestActionDate: null, nowMs: now });
    const passed = passageProbability({ latestActionText: 'passed senate', title: null, latestActionDate: null, nowMs: now });
    const committee = passageProbability({ latestActionText: 'referred to committee', title: null, latestActionDate: null, nowMs: now });
    const intro = passageProbability({ latestActionText: 'introduced', title: null, latestActionDate: null, nowMs: now });
    expect(enacted).toBeGreaterThan(passed);
    expect(passed).toBeGreaterThan(committee);
    expect(committee).toBeGreaterThan(intro);
  });

  it('stays within [0.02, 0.99]', () => {
    const enacted = passageProbability({ latestActionText: 'became public law', title: null, latestActionDate: null, nowMs: now });
    const intro = passageProbability({ latestActionText: 'introduced', title: null, latestActionDate: null, nowMs: now });
    expect(enacted).toBeLessThanOrEqual(0.99);
    expect(intro).toBeGreaterThanOrEqual(0.02);
  });

  it('boosts must-pass vehicles', () => {
    const ndaa = passageProbability({ latestActionText: 'referred to committee', title: 'National Defense Authorization Act for FY2027', latestActionDate: null, nowMs: now });
    const plain = passageProbability({ latestActionText: 'referred to committee', title: 'A bill to study things', latestActionDate: null, nowMs: now });
    expect(ndaa).toBeGreaterThan(plain);
  });

  it('decays stale action and bumps fresh action', () => {
    const stale = passageProbability({ latestActionText: 'passed house', title: null, latestActionDate: new Date('2025-06-01T00:00:00Z'), nowMs: now });
    const fresh = passageProbability({ latestActionText: 'passed house', title: null, latestActionDate: new Date('2026-06-20T00:00:00Z'), nowMs: now });
    expect(fresh).toBeGreaterThan(stale);
  });
});

describe('congress helpers', () => {
  it('parses the leading congress from a bill id', () => {
    expect(congressFromBillId('119-hr-7702')).toBe(119);
    expect(congressFromBillId('118-s-1932')).toBe(118);
    expect(congressFromBillId('bad')).toBeNull();
    expect(congressFromBillId('')).toBeNull();
  });

  it('computes the current congress from a date', () => {
    expect(currentCongress(new Date('2026-07-01T00:00:00Z'))).toBe(119);
    expect(currentCongress(new Date('2025-01-05T00:00:00Z'))).toBe(119);
  });
});
