import type {
  VerifierFiscal,
  VerifierNode,
  VerifierRefRow,
  VerifyPlanInput,
  VerifyPlanResult,
  Violation,
} from './types.js';

// --- date helpers ------------------------------------------------------------
// ISO calendar dates (YYYY-MM-DD) compare lexicographically === chronologically,
// so ordering checks are plain string compares — no Date parsing on the hot path.

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `s` is a real calendar date (rejects 2027-02-30, which Date rolls over). */
export function validIso(s: string | null | undefined): s is string {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  // Use setUTCFullYear (not Date.UTC) to construct the date: Date.UTC applies the
  // legacy two-digit-year rule (0-99 -> 1900-1999), which would misvalidate years 0-99.
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Federal fiscal year of an ISO date (Oct–Dec belongs to the NEXT FY). */
export function fyOfIso(s: string): number {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  return m >= 10 ? y + 1 : y;
}

/** Numeric FY from a label like 'FY28' (→ 2028) or 'FY2028'. */
function fyNum(label: string | null | undefined): number | null {
  if (!label) return null;
  const m = label.match(/(\d{2,4})/);
  if (!m) return null;
  const n = Number(m[1]);
  return n < 100 ? 2000 + n : n;
}

/** The [start, end] ISO bounds of the visible N-FY window. FY N = (N-1)-10-01 .. N-09-30. */
function axisBounds(fys: number[]): { start: string; end: string } | null {
  if (!fys || fys.length === 0) return null;
  const first = Math.min(...fys);
  const last = Math.max(...fys);
  return { start: `${first - 1}-10-01`, end: `${last}-09-30` };
}

/** A dependency's effective completion date (end, or start for a point event).
 *  Exported — repair.ts's deterministic retiming uses the identical threshold
 *  so a repaired plan can never re-trip the same check it was repairing. */
export function depEnd(d: VerifierNode): string {
  return d.endsOn && validIso(d.endsOn) ? d.endsOn : d.startsOn;
}

// --- checks ------------------------------------------------------------------

/** Re-assert date validity (defense-in-depth; the DTOs/parseDbDate are primary). */
function checkDates(nodes: VerifierNode[]): Violation[] {
  const out: Violation[] = [];
  for (const n of nodes) {
    if (!validIso(n.startsOn)) {
      out.push({
        code: 'dates',
        severity: 'error',
        nodeIds: [n.id],
        message: `"${n.title}" has an invalid start date (${String(n.startsOn)}).`,
      });
      continue;
    }
    if (n.endsOn != null) {
      if (!validIso(n.endsOn)) {
        out.push({
          code: 'dates',
          severity: 'error',
          nodeIds: [n.id],
          message: `"${n.title}" has an invalid end date (${String(n.endsOn)}).`,
        });
      } else if (n.endsOn < n.startsOn) {
        out.push({
          code: 'dates',
          severity: 'error',
          nodeIds: [n.id],
          message: `"${n.title}" ends before it starts.`,
        });
      }
    }
  }
  return out;
}

/**
 * First dependency cycle over valid intra-plan edges (self/missing edges are
 * ignored here — checkDeps reports those separately as their own violation
 * codes), or null if acyclic. DFS with a recursion path; `found` is a holder
 * object so TS control-flow analysis doesn't narrow the closure-assigned
 * result back to `null` after the loop.
 *
 * Exported — repair.ts's deterministic retiming must refuse to touch a cyclic
 * plan (Phase 5 §4.2: "detect cycles and refuse deterministic repair") rather
 * than run a second, possibly-divergent cycle check.
 */
export function findDependencyCycle(
  nodes: VerifierNode[],
  byId: Map<string, VerifierNode>,
): string[] | null {
  const ids = new Set(nodes.map((n) => n.id));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 on-path, 2 done
  const path: string[] = [];
  const found: { cycle: string[] | null } = { cycle: null };
  const visit = (id: string): void => {
    if (found.cycle) return;
    state.set(id, 1);
    path.push(id);
    for (const dep of byId.get(id)?.dependsOnIds ?? []) {
      if (found.cycle) break;
      if (dep === id || !ids.has(dep)) continue;
      const s = state.get(dep) ?? 0;
      if (s === 1) {
        found.cycle = path.slice(path.indexOf(dep));
        break;
      }
      if (s === 0) visit(dep);
    }
    path.pop();
    state.set(id, 2);
  };
  for (const n of nodes) {
    if (found.cycle) break;
    if ((state.get(n.id) ?? 0) === 0) visit(n.id);
  }
  return found.cycle;
}

/** Missing / self / cyclic dependency edges (all hard errors). */
function checkDeps(nodes: VerifierNode[], byId: Map<string, VerifierNode>): Violation[] {
  const out: Violation[] = [];
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    for (const dep of n.dependsOnIds ?? []) {
      if (dep === n.id) {
        out.push({
          code: 'dep-self',
          severity: 'error',
          nodeIds: [n.id],
          message: `"${n.title}" depends on itself.`,
        });
      } else if (!ids.has(dep)) {
        out.push({
          code: 'dep-missing',
          severity: 'error',
          nodeIds: [n.id],
          message: `"${n.title}" depends on a step that isn't in this plan.`,
        });
      }
    }
  }

  const cycle = findDependencyCycle(nodes, byId);
  if (cycle) {
    out.push({
      code: 'dep-cycle',
      severity: 'error',
      nodeIds: cycle,
      message: `These steps form a dependency cycle and can't be ordered: ${cycle
        .map((id) => `"${byId.get(id)?.title ?? id}"`)
        .join(' → ')}.`,
    });
  }
  return out;
}

/**
 * Dependency ordering: a step must not start before the step it depends on
 * starts (error); a gate/decision it depends on must be fully cleared first
 * (error, gate-before-dependents); otherwise starting before the dependency
 * finishes is a soft overlap (warning).
 */
function checkOrdering(nodes: VerifierNode[], byId: Map<string, VerifierNode>): Violation[] {
  const out: Violation[] = [];
  for (const n of nodes) {
    if (!validIso(n.startsOn)) continue;
    for (const dep of n.dependsOnIds ?? []) {
      const d = byId.get(dep);
      if (!d || d.id === n.id || !validIso(d.startsOn)) continue;
      if (n.startsOn < d.startsOn) {
        out.push({
          code: 'dep-order',
          severity: 'error',
          nodeIds: [n.id, d.id],
          message: `"${n.title}" starts before the step it depends on ("${d.title}").`,
          suggestion: `Move "${n.title}" to on or after ${d.startsOn}.`,
        });
      } else if (d.kind === 'gate' || d.kind === 'decision') {
        if (n.startsOn < depEnd(d)) {
          out.push({
            code: 'gate-before-dependents',
            severity: 'error',
            nodeIds: [n.id, d.id],
            message: `"${n.title}" begins before its ${d.kind} "${d.title}" is cleared.`,
            suggestion: `A ${d.kind} must resolve before dependent steps start — move "${n.title}" to on or after ${depEnd(d)}.`,
          });
        }
      } else if (n.startsOn < depEnd(d)) {
        out.push({
          code: 'dep-overlap',
          severity: 'warning',
          nodeIds: [n.id, d.id],
          message: `"${n.title}" starts before its dependency "${d.title}" finishes.`,
        });
      }
    }
  }
  return out;
}

/** A submission must precede the markup that acts on it, within its FY. */
function checkSubmissionMarkup(nodes: VerifierNode[], congress: VerifierRefRow[]): Violation[] {
  const markups = congress.filter(
    (r) => /markup/i.test(r.label) && (validIso(r.startsOn) || r.fy != null),
  );
  if (markups.length === 0) return []; // data-gap guard
  const out: Violation[] = [];
  for (const n of nodes) {
    if (n.subject !== 'submission' || !validIso(n.startsOn)) continue;
    const nodeFy = fyOfIso(n.startsOn);
    const inFy = markups.filter((r) =>
      r.startsOn ? fyOfIso(r.startsOn) === nodeFy : r.fy === nodeFy,
    );
    if (inFy.length === 0) continue;
    // FY-only rows (no hard startsOn) anchor to the FY's calendar start, matching
    // the FY-window convention in axisBounds() — the earliest date that FY could
    // plausibly begin, so an in-FY submission still trips the check.
    const earliest = inFy
      .map((r) => (validIso(r.startsOn) ? r.startsOn : `${(r.fy as number) - 1}-10-01`))
      .sort()[0]!;
    if (n.startsOn >= earliest) {
      out.push({
        code: 'submission-before-markup',
        severity: 'error',
        nodeIds: [n.id],
        message: `Submission "${n.title}" is on/after the markup it should precede (${earliest}).`,
        suggestion: `File "${n.title}" before ${earliest}.`,
      });
    }
  }
  return out;
}

/** An Action scheduled wholly inside a congressional recess (data-gap-guarded). */
function checkRecess(nodes: VerifierNode[], congress: VerifierRefRow[]): Violation[] {
  const recesses = congress.filter(
    (r) =>
      /recess|state work period|district work/i.test(r.label) &&
      validIso(r.startsOn) &&
      validIso(r.endsOn),
  );
  if (recesses.length === 0) return []; // data-gap guard (baseline lacks recess rows today)
  const out: Violation[] = [];
  for (const n of nodes) {
    if (n.kind !== 'action' || !validIso(n.startsOn)) continue;
    const nEnd = n.endsOn && validIso(n.endsOn) ? n.endsOn : n.startsOn;
    for (const r of recesses) {
      if (n.startsOn >= (r.startsOn as string) && nEnd <= (r.endsOn as string)) {
        out.push({
          code: 'recess',
          severity: 'error',
          nodeIds: [n.id],
          message: `Action "${n.title}" is scheduled entirely within a congressional recess (${r.label}).`,
          suggestion: `Move "${n.title}" outside ${r.startsOn}–${r.endsOn}.`,
        });
        break;
      }
    }
  }
  return out;
}

/** Steps placed outside the visible N-FY planning window (soft). */
function checkWindow(nodes: VerifierNode[], fiscal: VerifierFiscal): Violation[] {
  const b = axisBounds(fiscal.fys ?? []);
  if (!b) return [];
  const out: Violation[] = [];
  for (const n of nodes) {
    if (!validIso(n.startsOn)) continue;
    if (n.startsOn < b.start || n.startsOn > b.end) {
      out.push({
        code: 'window',
        severity: 'warning',
        nodeIds: [n.id],
        message: `"${n.title}" (${n.startsOn}) falls outside the ${fiscal.fyLabels.join('–')} planning window.`,
      });
    }
  }
  return out;
}

/** An in-cycle appropriations plan should target the focal FY (soft). */
function checkFocalFy(input: VerifyPlanInput): Violation[] {
  if (input.strategyType !== 'appropriations') return [];
  const focal = fyNum(input.fiscal.focalFy);
  if (focal == null) return [];
  const hit = input.nodes.some(
    (n) =>
      (n.subject === 'submission' || n.subject === 'ask') &&
      validIso(n.startsOn) &&
      fyOfIso(n.startsOn) === focal,
  );
  if (hit) return [];
  return [
    {
      code: 'focal-fy-appropriations',
      severity: 'warning',
      nodeIds: [],
      message: `This appropriations plan has no submission or ask in the focal fiscal year (${input.fiscal.focalFy}).`,
      suggestion: `Add the in-cycle ask/submission targeting ${input.fiscal.focalFy}.`,
    },
  ];
}

/**
 * Run every realism check over a proposed/persisted plan and return the
 * violations, errors first. Pure — safe to call pre-persist (drafts) or
 * post-persist (assistant edits, Watcher).
 */
export function verifyPlan(input: VerifyPlanInput): VerifyPlanResult {
  const nodes = input.nodes ?? [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const congress = input.congress ?? [];
  const fiscal: VerifierFiscal = input.fiscal ?? {
    today: null,
    fys: [],
    fyLabels: [],
    focalFy: '',
  };
  const violations: Violation[] = [
    ...checkDates(nodes),
    ...checkDeps(nodes, byId),
    ...checkOrdering(nodes, byId),
    ...checkSubmissionMarkup(nodes, congress),
    ...checkRecess(nodes, congress),
    ...checkWindow(nodes, fiscal),
    ...checkFocalFy({ ...input, fiscal }),
  ];
  violations.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const errorCount = violations.filter((v) => v.severity === 'error').length;
  return { violations, errorCount, warningCount: violations.length - errorCount };
}
