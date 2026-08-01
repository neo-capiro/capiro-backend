import { describe, expect, it } from '@jest/globals';
import { classifyRisk, type WatcherFinding } from './risk-router.js';

/*
 * Exhaustive ladder tests for the PURE RiskRouter (plan §F2). The ladder is a
 * security/permission boundary — autoApplyEligible=true means an agent writes
 * a tenant's plan with NO human in the loop — so every rung and every
 * precedence pair is pinned here, and the firm-level-never-auto-applies hard
 * rule is tested against every softer combination that could erode it.
 */

const info = (over: Partial<WatcherFinding> = {}): WatcherFinding => ({
  code: 'fyi',
  severity: 'info',
  message: 'informational',
  ...over,
});
const retimeWarning = (over: Partial<WatcherFinding> = {}): WatcherFinding => ({
  code: 'markup-moved',
  severity: 'warning',
  message: 'markup slipped two weeks',
  structural: false,
  ...over,
});
const structuralWarning = (over: Partial<WatcherFinding> = {}): WatcherFinding => ({
  code: 'missing-gate',
  severity: 'warning',
  message: 'plan needs a submission gate added',
  structural: true,
  ...over,
});
const critical = (over: Partial<WatcherFinding> = {}): WatcherFinding => ({
  code: 'deadline-passed',
  severity: 'critical',
  message: 'submission deadline already passed',
  ...over,
});

describe('classifyRisk — ladder rungs', () => {
  it('no findings at all => low, auto-apply eligible (opCount > 0)', () => {
    expect(classifyRisk({ findings: [], firmLevel: false, opCount: 1 })).toEqual({
      risk: 'low',
      autoApplyEligible: true,
      requiresImpactSummary: false,
    });
  });

  it('info-only => low, auto-apply eligible', () => {
    expect(
      classifyRisk({ findings: [info(), info({ code: 'fyi-2' })], firmLevel: false, opCount: 3 }),
    ).toEqual({ risk: 'low', autoApplyEligible: true, requiresImpactSummary: false });
  });

  it('retime-only warning => medium, NOT auto-apply eligible', () => {
    expect(classifyRisk({ findings: [retimeWarning()], firmLevel: false, opCount: 2 })).toEqual({
      risk: 'medium',
      autoApplyEligible: false,
      requiresImpactSummary: false,
    });
  });

  it('warning with structural flag ABSENT is treated as retime-only => medium', () => {
    // structural is optional; an F1 finding that omits it must not silently
    // rank as high (the flag asserts structure, absence does not).
    const w: WatcherFinding = { code: 'w', severity: 'warning', message: 'warn' };
    expect(classifyRisk({ findings: [w], firmLevel: false, opCount: 1 }).risk).toBe('medium');
  });

  it('warning with a structural op (add/remove) => high, NOT auto-apply eligible', () => {
    expect(classifyRisk({ findings: [structuralWarning()], firmLevel: false, opCount: 2 })).toEqual(
      { risk: 'high', autoApplyEligible: false, requiresImpactSummary: false },
    );
  });

  it('any critical finding => critical, NOT auto-apply eligible, no impact summary (strategy-scoped)', () => {
    expect(classifyRisk({ findings: [critical()], firmLevel: false, opCount: 1 })).toEqual({
      risk: 'critical',
      autoApplyEligible: false,
      requiresImpactSummary: false,
    });
  });
});

describe('classifyRisk — precedence (worst finding wins)', () => {
  it('critical beats structural warning beats retime warning beats info', () => {
    const all = [info(), retimeWarning(), structuralWarning(), critical()];
    expect(classifyRisk({ findings: all, firmLevel: false, opCount: 1 }).risk).toBe('critical');
    expect(
      classifyRisk({
        findings: [info(), retimeWarning(), structuralWarning()],
        firmLevel: false,
        opCount: 1,
      }).risk,
    ).toBe('high');
    expect(
      classifyRisk({ findings: [info(), retimeWarning()], firmLevel: false, opCount: 1 }).risk,
    ).toBe('medium');
    expect(classifyRisk({ findings: [info()], firmLevel: false, opCount: 1 }).risk).toBe('low');
  });

  it('a critical INFO-structural mix cannot be softened by ordering', () => {
    // Order of findings must not matter.
    const shuffled = [structuralWarning(), critical(), info(), retimeWarning()];
    expect(classifyRisk({ findings: shuffled, firmLevel: false, opCount: 1 }).risk).toBe(
      'critical',
    );
  });

  it('a structural CRITICAL is critical (severity outranks the structural flag)', () => {
    expect(
      classifyRisk({ findings: [critical({ structural: true })], firmLevel: false, opCount: 1 })
        .risk,
    ).toBe('critical');
  });

  it('structural info does NOT escalate (structural only matters on warnings)', () => {
    expect(
      classifyRisk({ findings: [info({ structural: true })], firmLevel: false, opCount: 1 }).risk,
    ).toBe('low');
  });
});

describe('classifyRisk — firm-level hard rule', () => {
  // Every combination that is soft when strategy-scoped must still come out
  // critical + impact-summary + no-auto-apply when firm-level.
  const combos: Array<[string, WatcherFinding[]]> = [
    ['no findings', []],
    ['info-only', [info()]],
    ['retime warning', [retimeWarning()]],
    ['structural warning', [structuralWarning()]],
    ['critical', [critical()]],
  ];

  it.each(combos)('firm-level with %s => ALWAYS critical + impact summary', (_label, findings) => {
    expect(classifyRisk({ findings, firmLevel: true, opCount: 1 })).toEqual({
      risk: 'critical',
      autoApplyEligible: false,
      requiresImpactSummary: true,
    });
  });

  it('firm-level NEVER auto-applies, even with zero findings and zero ops', () => {
    expect(classifyRisk({ findings: [], firmLevel: true, opCount: 0 }).autoApplyEligible).toBe(
      false,
    );
    expect(classifyRisk({ findings: [], firmLevel: true, opCount: 5 }).autoApplyEligible).toBe(
      false,
    );
  });

  it('impact summary is REQUIRED for firm-level and only firm-level', () => {
    expect(classifyRisk({ findings: [], firmLevel: true, opCount: 0 }).requiresImpactSummary).toBe(
      true,
    );
    for (const findings of [[], [info()], [retimeWarning()], [structuralWarning()], [critical()]]) {
      expect(classifyRisk({ findings, firmLevel: false, opCount: 1 }).requiresImpactSummary).toBe(
        false,
      );
    }
  });
});

describe('classifyRisk — autoApplyEligible is low-risk ONLY', () => {
  it('is false for every risk above low', () => {
    expect(
      classifyRisk({ findings: [retimeWarning()], firmLevel: false, opCount: 1 }).autoApplyEligible,
    ).toBe(false); // medium
    expect(
      classifyRisk({ findings: [structuralWarning()], firmLevel: false, opCount: 1 })
        .autoApplyEligible,
    ).toBe(false); // high
    expect(
      classifyRisk({ findings: [critical()], firmLevel: false, opCount: 1 }).autoApplyEligible,
    ).toBe(false); // critical
  });

  it('requires at least one op — an empty edit-set has nothing to auto-apply', () => {
    expect(classifyRisk({ findings: [], firmLevel: false, opCount: 0 }).autoApplyEligible).toBe(
      false,
    );
    // risk stays low; only eligibility is gated on opCount.
    expect(classifyRisk({ findings: [], firmLevel: false, opCount: 0 }).risk).toBe('low');
  });

  it('is true ONLY for the exact (low risk, ops present, not firm) combination', () => {
    expect(
      classifyRisk({ findings: [info()], firmLevel: false, opCount: 1 }).autoApplyEligible,
    ).toBe(true);
  });
});
