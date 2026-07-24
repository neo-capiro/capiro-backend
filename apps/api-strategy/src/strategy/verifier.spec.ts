import { describe, it, expect } from '@jest/globals';
import {
  verifyPlan,
  type VerifierNode,
  type VerifierRefRow,
  type VerifyPlanInput,
} from '@capiro/strategy-verifier';

/**
 * A2/A4 verifier coverage. Lives in api-strategy's jest suite (not the pure
 * package) so it runs against the BUILT @capiro/strategy-verifier exactly as the
 * services consume it — same reason @capiro/shared has no in-package tests.
 */

const fiscal = {
  today: '2026-11-01',
  fys: [2027, 2028, 2029],
  fyLabels: ['FY27', 'FY28', 'FY29'],
  focalFy: 'FY28',
};

const N = (over: Partial<VerifierNode> & { id: string }): VerifierNode => ({
  kind: 'action',
  subject: 'deliverable',
  title: over.id,
  startsOn: '2027-06-01',
  endsOn: null,
  dependsOnIds: [],
  ...over,
});

const input = (nodes: VerifierNode[], extra?: Partial<VerifyPlanInput>): VerifyPlanInput => ({
  strategyType: 'authorization',
  nodes,
  fiscal,
  ...extra,
});

const codes = (i: VerifyPlanInput) => verifyPlan(i).violations.map((v) => v.code);

describe('verifyPlan', () => {
  it('passes a well-formed plan with a satisfied dependency', () => {
    const r = verifyPlan(
      input([
        N({ id: 'a', startsOn: '2027-06-01', endsOn: '2027-06-30' }),
        N({ id: 'b', startsOn: '2027-07-01', dependsOnIds: ['a'] }),
      ]),
    );
    expect(r.errorCount).toBe(0);
    expect(r.warningCount).toBe(0);
    expect(r.violations).toHaveLength(0);
  });

  it('flags a dependency on a step not in the plan', () => {
    expect(codes(input([N({ id: 'a', dependsOnIds: ['ghost'] })]))).toContain('dep-missing');
  });

  it('flags a self-dependency', () => {
    expect(codes(input([N({ id: 'a', dependsOnIds: ['a'] })]))).toContain('dep-self');
  });

  it('does not throw when a node is missing dependsOnIds (LLM-drafted step)', () => {
    const missingDeps = {
      ...N({ id: 'a' }),
      dependsOnIds: undefined,
    } as unknown as VerifierNode;
    const withMissing = input([missingDeps, N({ id: 'b', dependsOnIds: ['a'] })]);
    expect(() => verifyPlan(withMissing)).not.toThrow();
    expect(codes(withMissing)).toHaveLength(0);
  });

  it('detects a dependency cycle', () => {
    const r = verifyPlan(
      input([
        N({ id: 'a', dependsOnIds: ['b'] }),
        N({ id: 'b', dependsOnIds: ['a'] }),
      ]),
    );
    expect(r.violations.some((v) => v.code === 'dep-cycle' && v.severity === 'error')).toBe(true);
  });

  it('errors when a step starts before the step it depends on starts', () => {
    const r = verifyPlan(
      input([
        N({ id: 'a', startsOn: '2027-06-01' }),
        N({ id: 'b', startsOn: '2027-05-01', dependsOnIds: ['a'] }),
      ]),
    );
    expect(r.violations.some((v) => v.code === 'dep-order' && v.severity === 'error')).toBe(true);
  });

  it('errors when a step begins before a gate it depends on is cleared', () => {
    const r = verifyPlan(
      input([
        N({ id: 'g', kind: 'gate', startsOn: '2027-06-01', endsOn: '2027-07-01' }),
        N({ id: 'b', startsOn: '2027-06-15', dependsOnIds: ['g'] }),
      ]),
    );
    expect(codes(input([]))).toEqual([]); // sanity
    expect(r.violations.some((v) => v.code === 'gate-before-dependents')).toBe(true);
    expect(r.errorCount).toBeGreaterThan(0);
  });

  it('warns (not errors) on a soft overlap with a non-gate dependency', () => {
    const r = verifyPlan(
      input([
        N({ id: 'a', kind: 'action', startsOn: '2027-06-01', endsOn: '2027-08-01' }),
        N({ id: 'b', startsOn: '2027-07-01', dependsOnIds: ['a'] }),
      ]),
    );
    expect(r.errorCount).toBe(0);
    expect(r.violations.some((v) => v.code === 'dep-overlap' && v.severity === 'warning')).toBe(true);
  });

  it('errors when a submission lands on/after its FY markup — and skips with no markup rows', () => {
    const congress: VerifierRefRow[] = [
      { label: 'HAC-D subcommittee markup', fy: 2027, startsOn: '2027-05-01', endsOn: '2027-05-01' },
    ];
    const late = input([N({ id: 's', subject: 'submission', startsOn: '2027-06-01' })], { congress });
    expect(codes(late)).toContain('submission-before-markup');

    const early = input([N({ id: 's', subject: 'submission', startsOn: '2027-04-01' })], { congress });
    expect(codes(early)).not.toContain('submission-before-markup');

    // data-gap guard: no markup rows → check no-ops
    const noRows = input([N({ id: 's', subject: 'submission', startsOn: '2027-06-01' })]);
    expect(codes(noRows)).not.toContain('submission-before-markup');
  });

  it('falls back to fy-matching when a markup row has no hard startsOn (fy-only row)', () => {
    const fyOnlyCongress: VerifierRefRow[] = [
      { label: 'HAC-D subcommittee markup', fy: 2027, startsOn: null, endsOn: null },
    ];
    const inFy = input(
      [N({ id: 's', subject: 'submission', startsOn: '2027-06-01' })],
      { congress: fyOnlyCongress },
    );
    expect(codes(inFy)).toContain('submission-before-markup');

    // a submission in a different FY than the fy-only markup must not match.
    const outOfFy = input(
      [N({ id: 's', subject: 'submission', startsOn: '2028-06-01' })],
      { congress: fyOnlyCongress },
    );
    expect(codes(outOfFy)).not.toContain('submission-before-markup');
  });

  it('errors on an action scheduled wholly inside a recess — and skips with no recess rows', () => {
    const congress: VerifierRefRow[] = [
      { label: 'August recess', fy: 2027, startsOn: '2027-08-01', endsOn: '2027-08-31' },
    ];
    const inRecess = input(
      [N({ id: 'a', kind: 'action', startsOn: '2027-08-10', endsOn: '2027-08-20' })],
      { congress },
    );
    expect(codes(inRecess)).toContain('recess');

    // straddling the recess edge is fine
    const straddle = input(
      [N({ id: 'a', kind: 'action', startsOn: '2027-07-25', endsOn: '2027-08-10' })],
      { congress },
    );
    expect(codes(straddle)).not.toContain('recess');

    // data-gap guard
    expect(codes(input([N({ id: 'a', startsOn: '2027-08-10', endsOn: '2027-08-20' })]))).not.toContain(
      'recess',
    );
  });

  it('warns on a step outside the visible FY window', () => {
    expect(codes(input([N({ id: 'a', startsOn: '2030-01-01' })]))).toContain('window');
    expect(codes(input([N({ id: 'a', startsOn: '2027-06-01' })]))).not.toContain('window');
  });

  it('warns when an appropriations plan misses the focal FY, and passes when it hits it', () => {
    const miss = input([N({ id: 'a', subject: 'deliverable', startsOn: '2027-06-01' })], {
      strategyType: 'appropriations',
    });
    expect(codes(miss)).toContain('focal-fy-appropriations');

    const hit = input([N({ id: 'a', subject: 'ask', startsOn: '2028-06-01' })], {
      strategyType: 'appropriations',
    });
    expect(codes(hit)).not.toContain('focal-fy-appropriations');
  });

  it('re-asserts date validity (end-before-start and impossible calendar dates)', () => {
    expect(codes(input([N({ id: 'a', startsOn: '2027-06-10', endsOn: '2027-06-01' })]))).toContain(
      'dates',
    );
    expect(codes(input([N({ id: 'a', startsOn: '2027-06-01', endsOn: '2027-02-30' })]))).toContain(
      'dates',
    );
    expect(codes(input([N({ id: 'a', startsOn: '2027-02-30' })]))).toContain('dates');
  });

  it('does not throw when fiscal is missing — window/focal-fy checks just no-op', () => {
    const missingFiscal = {
      strategyType: 'authorization',
      nodes: [N({ id: 'a', startsOn: '2027-06-01' })],
      fiscal: undefined,
    } as unknown as VerifyPlanInput;
    expect(() => verifyPlan(missingFiscal)).not.toThrow();
    expect(codes(missingFiscal)).not.toContain('window');

    const missingFiscalAppropriations = {
      strategyType: 'appropriations',
      nodes: [N({ id: 'a', subject: 'ask', startsOn: '2027-06-01' })],
      fiscal: undefined,
    } as unknown as VerifyPlanInput;
    expect(() => verifyPlan(missingFiscalAppropriations)).not.toThrow();
    expect(codes(missingFiscalAppropriations)).not.toContain('focal-fy-appropriations');
  });

  it('orders errors before warnings', () => {
    const r = verifyPlan(
      input([N({ id: 'a', startsOn: '2030-01-01', endsOn: '2029-01-01' })]), // window(warn) + dates(err)
    );
    expect(r.violations[0]?.severity).toBe('error');
  });
});
