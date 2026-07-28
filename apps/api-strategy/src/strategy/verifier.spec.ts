import { describe, it, expect } from '@jest/globals';
import {
  repairDependencyOrder,
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

/*
 * Phase 5 §4.2 — repairDependencyOrder. Same N()/input() fixtures as verifyPlan
 * above; each case re-verifies the repaired output to prove the fix actually
 * clears the violation it was repairing, not just that dates moved.
 */
describe('repairDependencyOrder', () => {
  it('retimes a step that starts before the step it depends on starts (§9.5)', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-06-01' }),
      N({ id: 'b', startsOn: '2027-05-01', dependsOnIds: ['a'] }),
    ];
    expect(codes(input(nodes))).toContain('dep-order');

    const repair = repairDependencyOrder(nodes);
    expect(repair.refused).toBe(false);
    expect(repair.changedIds).toEqual(['b']);
    const b = repair.nodes.find((n) => n.id === 'b')!;
    expect(b.startsOn).toBe('2027-06-01');
    expect(codes(input(repair.nodes))).not.toContain('dep-order');
  });

  it('retimes a step that begins before a gate it depends on clears', () => {
    const nodes = [
      N({ id: 'g', kind: 'gate', startsOn: '2027-06-01', endsOn: '2027-07-01' }),
      N({ id: 'b', startsOn: '2027-06-15', dependsOnIds: ['g'] }),
    ];
    expect(codes(input(nodes))).toContain('gate-before-dependents');

    const repair = repairDependencyOrder(nodes);
    expect(repair.changedIds).toEqual(['b']);
    expect(repair.nodes.find((n) => n.id === 'b')!.startsOn).toBe('2027-07-01');
    expect(codes(input(repair.nodes))).not.toContain('gate-before-dependents');
  });

  it('preserves duration for a ranged step it retimes (§9.7)', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-06-01' }), // 0-day point event dependency
      N({ id: 'b', startsOn: '2027-05-01', endsOn: '2027-05-11', dependsOnIds: ['a'] }), // 10-day range
    ];
    const repair = repairDependencyOrder(nodes);
    const b = repair.nodes.find((n) => n.id === 'b')!;
    expect(b.startsOn).toBe('2027-06-01');
    expect(b.endsOn).toBe('2027-06-11'); // same 10-day span, shifted forward
  });

  it('a retimed point event (no endsOn) stays a point event (§9.7)', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-06-01', endsOn: '2027-06-30' }),
      N({ id: 'b', kind: 'milestone', startsOn: '2027-05-01', endsOn: null, dependsOnIds: ['a'] }),
    ];
    const repair = repairDependencyOrder(nodes);
    const b = repair.nodes.find((n) => n.id === 'b')!;
    expect(b.startsOn).toBe('2027-06-30'); // a's effective completion is its END, since a is ranged
    expect(b.endsOn).toBeNull();
  });

  it('propagates a transitive push through the DAG in one pass (A delays B delays C) (§9.6)', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-08-01', endsOn: '2027-08-15' }),
      N({ id: 'b', startsOn: '2027-06-01', endsOn: '2027-06-11', dependsOnIds: ['a'] }),
      N({ id: 'c', startsOn: '2027-06-20', dependsOnIds: ['b'] }),
    ];
    const repair = repairDependencyOrder(nodes);
    expect(new Set(repair.changedIds)).toEqual(new Set(['b', 'c']));
    const byId = new Map(repair.nodes.map((n) => [n.id, n]));
    expect(byId.get('b')!.startsOn).toBe('2027-08-15'); // pushed to a's end
    expect(byId.get('b')!.endsOn).toBe('2027-08-25'); // 10-day duration preserved
    expect(byId.get('c')!.startsOn).toBe('2027-08-25'); // pushed to b's NEW end
    expect(codes(input(repair.nodes))).not.toContain('dep-order');
  });

  it('refuses a cyclic plan — nodes come back unchanged (§9.8)', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-05-01', dependsOnIds: ['b'] }),
      N({ id: 'b', startsOn: '2027-05-01', dependsOnIds: ['a'] }),
    ];
    const repair = repairDependencyOrder(nodes);
    expect(repair.refused).toBe(true);
    expect(repair.changedIds).toEqual([]);
    expect(repair.nodes).toEqual(nodes);
  });

  it('never touches a node with no dependency-order problem', () => {
    const nodes = [
      N({ id: 'a', startsOn: '2027-06-01', endsOn: '2027-06-10' }),
      N({ id: 'b', startsOn: '2027-07-01', dependsOnIds: ['a'] }), // already clear
    ];
    const repair = repairDependencyOrder(nodes);
    expect(repair.changedIds).toEqual([]);
    expect(repair.nodes).toEqual(nodes);
  });

  it('also clears a soft dep-overlap warning along the way (the plan\'s formula is uniform, not error-only)', () => {
    const nodes = [
      N({ id: 'a', kind: 'action', startsOn: '2027-06-01', endsOn: '2027-08-01' }),
      N({ id: 'b', startsOn: '2027-07-01', dependsOnIds: ['a'] }), // starts before a FINISHES, but after a STARTS
    ];
    expect(codes(input(nodes))).toEqual(['dep-overlap']); // warning only, no hard error today
    const repair = repairDependencyOrder(nodes);
    expect(repair.changedIds).toEqual(['b']);
    expect(repair.nodes.find((n) => n.id === 'b')!.startsOn).toBe('2027-08-01');
    expect(codes(input(repair.nodes))).not.toContain('dep-overlap');
  });

  it('ignores a dep-missing/dep-self edge rather than crashing on it', () => {
    const nodes = [N({ id: 'a', startsOn: '2027-06-01', dependsOnIds: ['a', 'ghost'] })];
    expect(() => repairDependencyOrder(nodes)).not.toThrow();
    const repair = repairDependencyOrder(nodes);
    expect(repair.refused).toBe(false);
    expect(repair.changedIds).toEqual([]);
  });
});
