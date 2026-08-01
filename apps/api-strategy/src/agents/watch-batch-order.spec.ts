import { describe, expect, it } from '@jest/globals';
import { orderBatchOps, type BatchOrderNode } from './watch-batch-order.js';
import type { PlanEdit } from '../meri/meri.types.js';

/*
 * Pure-module tests: no Nest, no Prisma, no clock — orderBatchOps is a plain
 * function of (current live nodes, combined ops). Today's only op producer
 * (watcher-checks.ts) emits single-field 'retime' ops, so most of this file
 * exercises rules that are currently invisible in production but must hold
 * the moment a structural Watch finding ships (the plan's own framing for
 * removals: "if ever produced").
 */

function n(id: string, dependsOnIds: string[] = []): BatchOrderNode {
  return { id, dependsOnIds };
}

function retime(nodeId: string, startsOn: string, endsOn?: string): PlanEdit {
  return { op: 'retime', nodeId, startsOn, ...(endsOn ? { endsOn } : {}) };
}

describe('orderBatchOps — topological ordering of patches', () => {
  it('orders retime ops so a prerequisite comes before its dependent', () => {
    const nodes = [n('A'), n('B', ['A']), n('C', ['B'])];
    // Submitted out of dependency order — C, then A, then B.
    const ops = [retime('C', '2026-09-01'), retime('A', '2026-08-01'), retime('B', '2026-08-15')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops.map((o) => o.nodeId)).toEqual(['A', 'B', 'C']);
  });

  it('unrelated ops (no edge between them) keep their ORIGINAL relative order — not an arbitrary graph-traversal order', () => {
    const nodes = [n('X'), n('Y'), n('Z')]; // no dependency edges at all
    const ops = [retime('Z', '2026-08-01'), retime('X', '2026-08-02'), retime('Y', '2026-08-03')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops.map((o) => o.nodeId)).toEqual(['Z', 'X', 'Y']);
  });

  it('a dependency edge to a node OUTSIDE this batch is ignored — only edges between ops actually being ordered matter', () => {
    const nodes = [n('A'), n('B', ['A'])]; // A is B's dependency but A has no op in this batch
    const ops = [retime('B', '2026-08-15')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toEqual(ops);
  });

  it('rejects a genuine dependency cycle among the ops being ordered, before returning any op', () => {
    const nodes = [n('A', ['B']), n('B', ['A'])];
    const ops = [retime('A', '2026-08-01'), retime('B', '2026-08-02')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cycle');
    expect(result.error.nodeIds.sort()).toEqual(['A', 'B']);
  });
});

describe('orderBatchOps — adds precede everything', () => {
  it('adds sort before every patch and every removal, in their own original relative order', () => {
    const nodes = [n('A')];
    const addOp: PlanEdit = {
      op: 'add',
      kind: 'action',
      subject: 'deliverable',
      title: 'New step',
      startsOn: '2026-08-01',
    };
    const ops = [retime('A', '2026-08-05'), addOp];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops[0]).toBe(addOp);
    expect(result.ops[1]).toEqual(retime('A', '2026-08-05'));
  });
});

describe('orderBatchOps — reverse dependency order for removals', () => {
  it('removes a dependent BEFORE the prerequisite it depended on', () => {
    const nodes = [n('A'), n('B', ['A'])];
    const removeA: PlanEdit = { op: 'remove', nodeId: 'A' };
    const removeB: PlanEdit = { op: 'remove', nodeId: 'B' };
    // Submitted in forward (prerequisite-first) order on purpose.
    const ops = [removeA, removeB];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops.map((o) => o.nodeId)).toEqual(['B', 'A']);
  });

  it('rejects a cycle among the removals themselves', () => {
    const nodes = [n('A', ['B']), n('B', ['A'])];
    const ops: PlanEdit[] = [
      { op: 'remove', nodeId: 'A' },
      { op: 'remove', nodeId: 'B' },
    ];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('cycle');
  });
});

describe('orderBatchOps — duplicate collapse and contradiction rejection', () => {
  it('collapses two BYTE-IDENTICAL ops (e.g. two proposals that happened to compute the same retime) to one', () => {
    const nodes = [n('A')];
    const ops = [retime('A', '2026-08-05', '2026-08-10'), retime('A', '2026-08-05', '2026-08-10')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
  });

  it('collapses identical ops regardless of jsonb-style key ordering (key-order-independent identity)', () => {
    const nodes = [n('A')];
    const a: PlanEdit = { op: 'retime', nodeId: 'A', startsOn: '2026-08-05', endsOn: '2026-08-10' };
    const b = {
      endsOn: '2026-08-10',
      op: 'retime',
      startsOn: '2026-08-05',
      nodeId: 'A',
    } as PlanEdit;

    const result = orderBatchOps(nodes, [a, b]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(1);
  });

  it('rejects the whole batch when two accepted proposals retime the SAME node to DIFFERENT dates', () => {
    const nodes = [n('A')];
    const ops = [retime('A', '2026-08-05'), retime('A', '2026-08-09')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('contradictory-ops');
    expect(result.error.nodeIds).toEqual(['A']);
  });

  it('rejects a removal alongside any other op on the same node', () => {
    const nodes = [n('A')];
    const ops: PlanEdit[] = [{ op: 'remove', nodeId: 'A' }, retime('A', '2026-08-05')];

    const result = orderBatchOps(nodes, ops);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('contradictory-ops');
  });

  it('does NOT reject two patches on the same node that touch DISJOINT fields — both survive', () => {
    const nodes = [n('A')];
    const statusOp: PlanEdit = { op: 'update', nodeId: 'A', status: 'active' };
    const dateOp: PlanEdit = { op: 'retime', nodeId: 'A', startsOn: '2026-08-05' };

    const result = orderBatchOps(nodes, [statusOp, dateOp]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ops).toHaveLength(2);
  });
});

describe('orderBatchOps — malformed input', () => {
  it('rejects a non-add op with no nodeId as invalid rather than crashing', () => {
    const ops = [{ op: 'retime', startsOn: '2026-08-05' } as PlanEdit];

    const result = orderBatchOps([], ops);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-op');
  });
});
