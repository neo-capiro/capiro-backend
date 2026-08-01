/*
 * Phase 3 (Watch consistency backend), Step 7 — dependency-safe batch
 * ordering. PURE module (no Nest, no Prisma, no clock reads) so an Accept-all
 * batch's op order is a deterministic, unit-testable function of the CURRENT
 * live dependency graph and the ops themselves, exactly like watcher-checks.ts
 * and strategy-verifier are pure.
 *
 * Today's only op producer (watcher-checks.ts) emits single-field 'retime'
 * ops, so this module's effect is invisible on the happy path — every rule
 * below still holds, ready for the day a Watch finding proposes a structural
 * (add/remove) edit, per the plan's "if ever produced" framing for removals.
 */

import type { PlanEdit } from '../meri/meri.types.js';

export interface BatchOrderNode {
  id: string;
  dependsOnIds: string[];
}

export type BatchOrderErrorCode = 'cycle' | 'contradictory-ops' | 'invalid-op';

export interface BatchOrderError {
  code: BatchOrderErrorCode;
  message: string;
  nodeIds: string[];
}

export type BatchOrderResult =
  | { ok: true; ops: PlanEdit[] }
  | { ok: false; error: BatchOrderError };

/** Key-order-independent JSON identity (mirrors watcher.service.ts's
 *  stableJson) — a stored op and a freshly recomputed twin must not read as
 *  "different" on jsonb key-order alone. */
function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.keys(val as Record<string, unknown>)
          .sort()
          .reduce<Record<string, unknown>>((acc, key) => {
            acc[key] = (val as Record<string, unknown>)[key];
            return acc;
          }, {})
      : val,
  );
}

function groupByNodeIdStable(ops: PlanEdit[]): Map<string, PlanEdit[]> {
  const map = new Map<string, PlanEdit[]>();
  for (const op of ops) {
    const id = op.nodeId!;
    const arr = map.get(id);
    if (arr) arr.push(op);
    else map.set(id, [op]);
  }
  return map;
}

/**
 * Stable topological sort via Kahn's algorithm: among nodes tied at zero
 * in-degree, the one with the LOWEST original index goes first, so ops with
 * no ordering constraint between them keep their original relative sequence
 * ("unrelated operations retain stable proposal/order sequence") rather than
 * whatever order a DFS or Map iteration happens to visit them in. Returns
 * null on a cycle (fewer nodes emitted than given).
 */
function stableTopoSort(nodeIds: string[], edges: Array<[string, string]>): string[] | null {
  const indexOf = new Map(nodeIds.map((id, i) => [id, i]));
  const adj = new Map<string, string[]>(nodeIds.map((id) => [id, []]));
  const indegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  for (const [from, to] of edges) {
    if (!adj.has(from) || !adj.has(to) || from === to) continue;
    adj.get(from)!.push(to);
    indegree.set(to, (indegree.get(to) ?? 0) + 1);
  }

  const readySet = new Set(nodeIds.filter((id) => indegree.get(id) === 0));
  const queue = [...readySet].sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, d);
      if (d === 0 && !readySet.has(next)) {
        readySet.add(next);
        const pos = queue.findIndex((q) => indexOf.get(q)! > indexOf.get(next)!);
        if (pos === -1) queue.push(next);
        else queue.splice(pos, 0, next);
      }
    }
  }
  return out.length === nodeIds.length ? out : null;
}

/**
 * Order a combined Accept-all edit-set against the strategy's CURRENT live
 * dependency graph (caller passes only LIVE nodes — this module trusts that
 * invariant, per its "no DB access" contract).
 *
 * Rules (plan §5 Step 7):
 *  - adds first, in their original relative order;
 *  - update/retime ops follow topological dependency order (prerequisites
 *    before their dependents);
 *  - remove ops follow REVERSE dependency order (a dependent removed before
 *    the prerequisite it depended on);
 *  - identical duplicate ops collapse to one; ops that target the same node
 *    with genuinely different values, or a remove alongside any other op on
 *    the same node, reject the whole batch;
 *  - a dependency cycle among the ops being ordered rejects before any op is
 *    returned (and therefore before any write).
 */
export function orderBatchOps(nodes: BatchOrderNode[], ops: PlanEdit[]): BatchOrderResult {
  // 1. Collapse EXACT duplicates, keeping the first occurrence's position.
  const seenOps = new Set<string>();
  const deduped: PlanEdit[] = [];
  for (const op of ops) {
    const key = stableStringify(op);
    if (seenOps.has(key)) continue;
    seenOps.add(key);
    deduped.push(op);
  }

  // 2. Every non-add op must carry a nodeId (the existing apply pipeline's own
  // invariant — see MeriService.applyEdit) — a pure validation error, not a
  // crash, if a caller ever violates it.
  for (const op of deduped) {
    if (op.op !== 'add' && !op.nodeId) {
      return {
        ok: false,
        error: { code: 'invalid-op', nodeIds: [], message: `A '${op.op}' op is missing nodeId.` },
      };
    }
  }

  // 3. Contradiction check: a remove alongside any other op on the same node,
  // or two non-remove ops that set the same field to different values.
  const byNode = new Map<string, PlanEdit[]>();
  for (const op of deduped) {
    if (op.op === 'add') continue;
    const id = op.nodeId!;
    const arr = byNode.get(id);
    if (arr) arr.push(op);
    else byNode.set(id, [op]);
  }
  for (const [nodeId, group] of byNode) {
    if (group.length < 2) continue;
    const hasRemove = group.some((o) => o.op === 'remove');
    const hasOther = group.some((o) => o.op !== 'remove');
    if (hasRemove && hasOther) {
      return {
        ok: false,
        error: {
          code: 'contradictory-ops',
          nodeIds: [nodeId],
          message: `Conflicting ops target the same step: a removal alongside another change.`,
        },
      };
    }
    const patches = group.filter((o) => o.op !== 'remove') as unknown as Array<
      Record<string, unknown>
    >;
    for (let i = 0; i < patches.length; i++) {
      for (let j = i + 1; j < patches.length; j++) {
        const a = patches[i]!;
        const b = patches[j]!;
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        keys.delete('op');
        keys.delete('nodeId');
        for (const k of keys) {
          if (k in a && k in b && stableStringify(a[k]) !== stableStringify(b[k])) {
            return {
              ok: false,
              error: {
                code: 'contradictory-ops',
                nodeIds: [nodeId],
                message: `Conflicting ops target the same step: both set '${k}' to different values.`,
              },
            };
          }
        }
      }
    }
  }

  // 4. Partition, then topo-sort patches (forward) and removes (reverse)
  // against the CURRENT live dependency graph, restricted to edges between
  // nodes that both appear in this batch (a dependency this batch doesn't
  // touch needs no ordering here).
  const adds = deduped.filter((o) => o.op === 'add');
  const removes = deduped.filter((o) => o.op === 'remove');
  const patches = deduped.filter((o) => o.op !== 'add' && o.op !== 'remove');

  const depsOf = new Map(nodes.map((n) => [n.id, n.dependsOnIds ?? []]));
  const dedupeIds = (ids: string[]) => ids.filter((id, i) => ids.indexOf(id) === i);

  const patchNodeIds = dedupeIds(patches.map((o) => o.nodeId!));
  const forwardEdges: Array<[string, string]> = [];
  for (const id of patchNodeIds) {
    for (const dep of depsOf.get(id) ?? []) {
      if (patchNodeIds.includes(dep)) forwardEdges.push([dep, id]); // prerequisite before dependent
    }
  }
  const patchOrder = stableTopoSort(patchNodeIds, forwardEdges);
  if (!patchOrder) {
    return {
      ok: false,
      error: {
        code: 'cycle',
        nodeIds: patchNodeIds,
        message: 'These steps form a dependency cycle and cannot be batch-ordered.',
      },
    };
  }

  const removeNodeIds = dedupeIds(removes.map((o) => o.nodeId!));
  const reverseEdges: Array<[string, string]> = [];
  for (const id of removeNodeIds) {
    for (const dep of depsOf.get(id) ?? []) {
      if (removeNodeIds.includes(dep)) reverseEdges.push([id, dep]); // dependent removed before its prerequisite
    }
  }
  const removeOrder = stableTopoSort(removeNodeIds, reverseEdges);
  if (!removeOrder) {
    return {
      ok: false,
      error: {
        code: 'cycle',
        nodeIds: removeNodeIds,
        message: 'These removals form a dependency cycle and cannot be batch-ordered.',
      },
    };
  }

  const patchesByNode = groupByNodeIdStable(patches);
  const removesByNode = groupByNodeIdStable(removes);

  return {
    ok: true,
    ops: [
      ...adds,
      ...patchOrder.flatMap((id) => patchesByNode.get(id) ?? []),
      ...removeOrder.flatMap((id) => removesByNode.get(id) ?? []),
    ],
  };
}
