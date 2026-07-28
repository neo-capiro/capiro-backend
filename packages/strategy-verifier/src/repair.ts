/*
 * Phase 5 §4.2 — deterministic dependency-order repair. Pure, DB-free (same
 * boundary as verify.ts): "calculate each step's minimum start as the maximum
 * effective completion date of dependencies" (the plan's own formula, applied
 * uniformly regardless of dependency kind), before ever spending a model
 * repair attempt on it. Cycles refuse deterministic repair outright (plan's
 * own instruction) — a cycle has no valid topological order to retime along,
 * so the model repair loop (or the final 422) owns it.
 *
 * This is more conservative than the verifier's OWN per-kind error thresholds
 * (checkOrdering only hard-blocks starting before a plain dependency STARTS,
 * or before a gate/decision CLEARS — starting before a plain dependency
 * FINISHES is merely the soft `dep-overlap` warning). Using the uniform
 * "effective completion" threshold here means this repair also clears
 * dep-overlap along the way, which is intended: a mechanical retime is a
 * reasonable, deterministic way to also tidy up a soft overlap once a step is
 * already being pushed, not just the narrowest fix for the hard error alone.
 * Deliberately does NOT touch `dep-missing`/`dep-self` — a broken edge, not a
 * timing problem; retiming can't fix a reference to a step that doesn't exist.
 */
import { findDependencyCycle, depEnd, validIso } from './verify.js';
import type { VerifierNode } from './types.js';

export interface DependencyRepairResult {
  /** The plan, topologically reordered — retimed nodes get new dates, every
   *  other field is untouched. Identical to the input (same array contents,
   *  original order) when `refused` or when nothing needed to move. */
  nodes: VerifierNode[];
  /** Ids of nodes whose startsOn/endsOn were adjusted. */
  changedIds: string[];
  /** True when a cycle (or an unresolvable structural edge) means no
   *  deterministic repair was attempted — `nodes` is returned unchanged. */
  refused: boolean;
}

const MS_PER_DAY = 86_400_000;

/** Parse an ISO calendar date as a UTC midnight instant — mirrors validIso's
 *  own setUTCFullYear construction so the two never disagree on a date. */
function toUtcDate(iso: string): Date {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt;
}

function diffDays(startIso: string, endIso: string): number {
  return Math.round((toUtcDate(endIso).getTime() - toUtcDate(startIso).getTime()) / MS_PER_DAY);
}

function addDaysIso(iso: string, days: number): string {
  const dt = toUtcDate(iso);
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Deterministically correct dependency-order violations: each step's minimum
 * start is the maximum, over its dependencies, of that dependency's effective
 * completion date (its end, or its start for a point event) — the plan's own
 * formula, uniform across every dependency kind. Duration is preserved for a
 * ranged step; a point event (endsOn=null) stays a point event. Propagates
 * through the DAG in topological order so a transitive push (A delays B
 * delays C) lands correctly in one pass, without ever re-deriving an
 * already-final date.
 *
 * Refuses (nodes returned unchanged, `refused: true`) when the dependency
 * graph has a cycle, since a cycle has no topological order to retime along —
 * per the plan, that case is never auto-repaired.
 */
export function repairDependencyOrder(nodes: VerifierNode[]): DependencyRepairResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (findDependencyCycle(nodes, byId)) {
    return { nodes, changedIds: [], refused: true };
  }

  // Kahn's algorithm — also a defensive second cycle check: if it cannot
  // order every node, something the DFS above missed (it shouldn't) means
  // refuse rather than guess.
  const ids = new Set(nodes.map((n) => n.id));
  const indegree = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const dep of n.dependsOnIds ?? []) {
      if (dep === n.id || !ids.has(dep)) continue; // dep-self/dep-missing: not this function's problem
      indegree.set(n.id, (indegree.get(n.id) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(n.id);
      dependents.set(dep, list);
    }
  }
  const queue = nodes.filter((n) => (indegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) queue.push(dependent);
    }
  }
  if (order.length < nodes.length) {
    return { nodes, changedIds: [], refused: true };
  }

  const patched = new Map(nodes.map((n) => [n.id, { ...n }]));
  const changedIds: string[] = [];
  for (const id of order) {
    const n = patched.get(id)!;
    if (!validIso(n.startsOn)) continue; // checkDates owns invalid dates, not this pass

    let minStart: string | null = null;
    for (const depId of n.dependsOnIds ?? []) {
      const d = patched.get(depId);
      if (!d || d.id === n.id || !validIso(d.startsOn)) continue;
      const threshold = depEnd(d);
      if (minStart === null || threshold > minStart) minStart = threshold;
    }
    if (minStart !== null && n.startsOn < minStart) {
      const hasEnd = n.endsOn != null && validIso(n.endsOn);
      const durationDays = hasEnd ? diffDays(n.startsOn, n.endsOn as string) : null;
      n.startsOn = minStart;
      n.endsOn = durationDays !== null ? addDaysIso(minStart, durationDays) : null;
      changedIds.push(id);
    }
  }

  return { nodes: order.map((id) => patched.get(id)!), changedIds, refused: false };
}
