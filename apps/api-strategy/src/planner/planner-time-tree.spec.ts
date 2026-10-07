import {
  plannerTimeRollups,
  plannerTimeTotal,
  plannerTimeLabel,
  type PlannerTimeTreeNode,
} from '@capiro/strategy-verifier';
const node = (
  id: string,
  parentId: string | null,
  estimateMinutes = 30,
  actualMinutes = 15,
): PlannerTimeTreeNode => ({
  id,
  parentId,
  estimateMinutes,
  actualMinutes,
  version: 1,
  scoped: true,
});
describe('Authorized time tree accumulation', () => {
  it('keeps own contributions separate while rolling up all descendant levels', () => {
    const nodes = [
      node('parent', null, 60, 60),
      node('child', 'parent', 30, 45),
      node('leaf', 'child', 15, 30),
    ];
    const { values } = plannerTimeRollups(nodes);
    expect(values.get('parent')).toEqual({
      estimateMinutes: 105,
      actualMinutes: 135,
      childCount: 1,
      descendantCount: 2,
    });
    expect(values.get('child')?.actualMinutes).toBe(75);
    expect(nodes[0]?.actualMinutes).toBe(60);
    expect(plannerTimeLabel(135)).toBe('2:15');
  });
  it('counts overlapping parent/child roots once, including multiple shared descendants', () => {
    const nodes = [node('p', null), node('a', 'p'), node('b', 'p'), node('c', 'a')];
    expect(plannerTimeTotal(nodes, ['p', 'a', 'c', 'p', 'missing'])).toEqual({
      estimateMinutes: 120,
      actualMinutes: 60,
      tasks: 4,
    });
  });
  it('handles a deep tree without a JavaScript recursion limit', () => {
    const nodes = Array.from({ length: 12000 }, (_, i) =>
      node(String(i), i ? String(i - 1) : null, 1, 1),
    );
    expect(plannerTimeRollups(nodes).values.get('0')?.actualMinutes).toBe(12000);
    expect(plannerTimeTotal(nodes, ['0']).tasks).toBe(12000);
  });
  it('rejects cyclic, duplicate and invalid data instead of returning plausible totals', () => {
    expect(() => plannerTimeRollups([node('a', 'b'), node('b', 'a')])).toThrow(/cycle/);
    expect(() => plannerTimeRollups([node('a', null), node('a', null)])).toThrow(/Duplicate/);
    expect(() => plannerTimeRollups([node('a', null, -1)])).toThrow(/Invalid/);
    expect(() =>
      plannerTimeRollups([node('a', null, Number.MAX_SAFE_INTEGER), node('b', 'a', 1)]),
    ).toThrow(/total/);
  });
});
