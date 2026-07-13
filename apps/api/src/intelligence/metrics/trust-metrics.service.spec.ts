import {
  foldAuditor,
  foldContextParity,
  foldMemoryPromotion,
  foldOutcomes,
  resolveRange,
} from './trust-metrics.service.js';

/**
 * P3 trust-metrics rollup — pure folders over already-fetched rows (DB-free,
 * mirroring product-metrics' summarizeCards test style).
 */
describe('foldAuditor (§12.6 validator pass-rate + severity)', () => {
  it('computes per-surface pass-rate, decision + severity histograms, and mode coverage', () => {
    const r = foldAuditor([
      { surface: 'chat', mode: 'enforce', decision: 'deliver', topSeverity: null },
      { surface: 'chat', mode: 'enforce', decision: 'hold', topSeverity: 'critical' },
      { surface: 'memo', mode: 'shadow', decision: 'deliver_with_flags', topSeverity: 'medium' },
    ]);
    expect(r.total).toBe(3);
    const chat = r.bySurface.find((s) => s.surface === 'chat')!;
    expect(chat.total).toBe(2);
    expect(chat.passRate).toBe(0.5); // 1 clean deliver of 2
    expect(chat.decisions).toEqual({ deliver: 1, deliver_with_flags: 0, repair: 0, hold: 1 });
    expect(chat.severity).toEqual({ critical: 1, high: 0, medium: 0, low: 0, clean: 1 });
    // byMode counts every verdict; sorted.
    expect(r.byMode).toEqual([
      { mode: 'enforce', total: 2 },
      { mode: 'shadow', total: 1 },
    ]);
    // surfaces sorted alphabetically
    expect(r.bySurface.map((s) => s.surface)).toEqual(['chat', 'memo']);
  });

  it('empty input → zeroed totals, no NaN pass-rate', () => {
    const r = foldAuditor([]);
    expect(r.total).toBe(0);
    expect(r.bySurface).toEqual([]);
  });
});

describe('foldContextParity (§12.6 surface parity + exclusions)', () => {
  it('counts distinct emitting surfaces + unrolls exclusion reasons descending', () => {
    const r = foldContextParity([
      { surface: 'chat', exclusions: [{ reason: 'revoked' }, { reason: 'expired' }] },
      { surface: 'chat', exclusions: [{ reason: 'revoked' }] },
      { surface: 'workspace-gen', exclusions: [] },
      { surface: 'memo', exclusions: null }, // defensive: non-array
    ]);
    expect(r.surfaceCount).toBe(3);
    expect(r.surfacesEmitting).toEqual(['chat', 'memo', 'workspace-gen']);
    expect(r.totalPackets).toBe(4);
    expect(r.exclusionReasons).toEqual([
      { reason: 'revoked', count: 2 },
      { reason: 'expired', count: 1 },
    ]);
  });
});

describe('foldOutcomes', () => {
  it('counts by kind, descending', () => {
    const r = foldOutcomes([
      { kind: 'response_received' },
      { kind: 'response_received' },
      { kind: 'funding_changed' },
    ]);
    expect(r.total).toBe(3);
    expect(r.byKind).toEqual([
      { kind: 'response_received', count: 2 },
      { kind: 'funding_changed', count: 1 },
    ]);
  });
});

describe('foldMemoryPromotion (§12.6 promotion quality)', () => {
  it('buckets by status + sourceKind and medians human-decision latency (approved/rejected only)', () => {
    const base = new Date('2026-07-01T00:00:00.000Z');
    const plus = (min: number) => new Date(base.getTime() + min * 60_000);
    const r = foldMemoryPromotion([
      { status: 'auto_committed', sourceKind: 'explicit_user', createdAt: base, decidedAt: base },
      { status: 'approved', sourceKind: 'artifact_approval', createdAt: base, decidedAt: plus(10) },
      { status: 'rejected', sourceKind: 'artifact_approval', createdAt: base, decidedAt: plus(30) },
      { status: 'pending', sourceKind: 'explicit_user', createdAt: base, decidedAt: null },
    ]);
    expect(r.byStatus).toEqual({ auto_committed: 1, approved: 1, rejected: 1, pending: 1 });
    // auto_committed's decidedAt is NOT counted (no human review delay); only 10 + 30.
    expect(r.decisionSampleSize).toBe(2);
    expect(r.medianDecisionMinutes).toBe(20); // median of [10,30]
    expect(r.bySourceKind).toEqual([
      { sourceKind: 'artifact_approval', count: 2 },
      { sourceKind: 'explicit_user', count: 2 },
    ]);
  });

  it('no decided rows → null median, zero sample', () => {
    const r = foldMemoryPromotion([
      { status: 'pending', sourceKind: 'explicit_user', createdAt: new Date(), decidedAt: null },
    ]);
    expect(r.medianDecisionMinutes).toBeNull();
    expect(r.decisionSampleSize).toBe(0);
  });
});

describe('resolveRange', () => {
  it('defaults to a trailing 90-day window', () => {
    const { from, to } = resolveRange();
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(90);
  });

  it('clamps an over-long span to 366 days', () => {
    const { from, to } = resolveRange({
      from: '2020-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    const days = (to.getTime() - from.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(366);
  });

  it('honors an explicit in-bounds range', () => {
    const { from, to } = resolveRange({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-15T00:00:00.000Z',
    });
    expect(from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});
