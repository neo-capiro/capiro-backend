import { describe, expect, it } from '@jest/globals';
import { loadGoldens, runOne, checkShape, type GoldenFile } from './run-l1.js';
import type { VerifierNode } from '@capiro/strategy-verifier';

/*
 * Stage B / Step B2 — runs as part of the normal `jest` suite (wired into
 * jest.config.cjs's testMatch), so a broken golden or a verifyPlan/shape
 * regression fails CI like any other spec. `eval:l1` (package.json) runs just
 * this file for fast local iteration; the standalone `run-l1.ts` CLI entry
 * gives a human-readable report outside jest.
 */
describe('Stage B — L1 deterministic eval (goldens self-test)', () => {
  const goldens = loadGoldens();

  it('finds at least 12 goldens across all 6 strategy types', () => {
    expect(goldens.length).toBeGreaterThanOrEqual(12);
    const types = new Set(goldens.map((g) => g.strategyType));
    expect(types).toEqual(
      new Set(['appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark']),
    );
  });

  it.each(goldens.map((g): [string, GoldenFile] => [`${g.strategyType}/${g.slug}`, g]))(
    '%s — verifyPlan zero errors + satisfies its own expectedPlanShape',
    (_label, gf) => {
      const result = runOne(gf);
      if (!result.ok) {
        throw new Error(
          [
            `verifyPlan errors: ${result.verifyErrors.join('; ') || '(none)'}`,
            `shape failures: ${result.shapeFailures.join('; ') || '(none)'}`,
          ].join('\n'),
        );
      }
      expect(result.ok).toBe(true);
    },
  );
});

/*
 * All 12 real goldens are well-formed, so the 13 tests above never prove
 * checkShape actually CATCHES a violation — only that it stays quiet on clean
 * input. These construct deliberately broken node lists to close that gap.
 */
describe('checkShape (edge cases the real goldens never exercise)', () => {
  const node = (overrides: Partial<VerifierNode> = {}): VerifierNode => ({
    id: 'n1',
    kind: 'action',
    subject: 'deliverable',
    title: 'A step',
    startsOn: '2027-01-01',
    endsOn: null,
    dependsOnIds: [],
    ...overrides,
  });

  it('passes a minimal well-formed plan against a matching shape', () => {
    const result = checkShape([node()], {
      nodeCountRange: [1, 1],
      requiredKinds: ['action'],
      requiredSubjects: ['deliverable'],
      orderingAssertions: [],
    });
    expect(result).toEqual({ ok: true, failures: [] });
  });

  it('flags a node count below the range', () => {
    const result = checkShape([node()], {
      nodeCountRange: [2, 5],
      requiredKinds: [],
      requiredSubjects: [],
      orderingAssertions: [],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['node count 1 outside expected range [2, 5]']);
  });

  it('flags a node count above the range', () => {
    const result = checkShape([node(), node({ id: 'n2' })], {
      nodeCountRange: [1, 1],
      requiredKinds: [],
      requiredSubjects: [],
      orderingAssertions: [],
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['node count 2 outside expected range [1, 1]']);
  });

  it('flags a missing required kind', () => {
    const result = checkShape([node({ kind: 'action' })], {
      nodeCountRange: [1, 1],
      requiredKinds: ['action', 'gate'],
      requiredSubjects: [],
      orderingAssertions: [],
    });
    expect(result.failures).toContain('missing required kind "gate"');
  });

  it('flags a missing required subject', () => {
    const result = checkShape([node({ subject: 'deliverable' })], {
      nodeCountRange: [1, 1],
      requiredKinds: [],
      requiredSubjects: ['deliverable', 'submission'],
      orderingAssertions: [],
    });
    expect(result.failures).toContain('missing required subject "submission"');
  });

  it('flags an ordering assertion that references an unknown node id', () => {
    const result = checkShape([node({ id: 'n1' })], {
      nodeCountRange: [1, 1],
      requiredKinds: [],
      requiredSubjects: [],
      orderingAssertions: [{ description: 'x before y', beforeNodeId: 'n1', afterNodeId: 'ghost' }],
    });
    expect(result.failures).toEqual([
      'orderingAssertion "x before y" references an unknown node id',
    ]);
  });

  it('flags a violated ordering assertion (before starts AFTER after)', () => {
    const result = checkShape(
      [node({ id: 'n1', startsOn: '2027-06-01' }), node({ id: 'n2', startsOn: '2027-01-01' })],
      {
        nodeCountRange: [2, 2],
        requiredKinds: [],
        requiredSubjects: [],
        orderingAssertions: [{ description: 'n1 before n2', beforeNodeId: 'n1', afterNodeId: 'n2' }],
      },
    );
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/orderingAssertion violated: n1 before n2/);
  });

  it('accepts an ordering assertion where before and after fall on the same date (<=, not <)', () => {
    const result = checkShape(
      [node({ id: 'n1', startsOn: '2027-01-01' }), node({ id: 'n2', startsOn: '2027-01-01' })],
      {
        nodeCountRange: [2, 2],
        requiredKinds: [],
        requiredSubjects: [],
        orderingAssertions: [{ description: 'same day ok', beforeNodeId: 'n1', afterNodeId: 'n2' }],
      },
    );
    expect(result.ok).toBe(true);
  });

  it('accumulates multiple simultaneous failures rather than short-circuiting on the first', () => {
    const result = checkShape([node({ kind: 'action', subject: 'deliverable' })], {
      nodeCountRange: [5, 10],
      requiredKinds: ['action', 'gate'],
      requiredSubjects: ['deliverable', 'submission'],
      orderingAssertions: [],
    });
    expect(result.failures).toHaveLength(3);
  });
});
