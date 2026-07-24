import { describe, expect, it } from '@jest/globals';
import type { Violation } from '@capiro/strategy-verifier';
import {
  FINDING_SEVERITIES,
  findingKey,
  runWatcherChecks,
  type Finding,
  type WatcherCheckInput,
  type WatcherNode,
  type WatcherStewardHealth,
} from './watcher-checks.js';

/*
 * Pure-module tests: every deterministic check fires on a crafted plan and
 * stays SILENT on a clean one; the verifier fold demotes severities
 * (error->warning, warning->info) and keeps proposedOps null; findings dedup
 * on (code + sorted nodeIds). No Nest, no DB, no clock — `today` is injected.
 */

const TODAY = '2026-07-24';

function node(overrides: Partial<WatcherNode> & { id: string }): WatcherNode {
  return {
    kind: 'action',
    subject: 'deliverable',
    title: `Step ${overrides.id}`,
    startsOn: '2026-08-01',
    endsOn: '2026-08-15',
    status: 'in_progress',
    ownerUserId: 'u-1',
    dependsOnIds: [],
    ...overrides,
  };
}

const HEALTH_OK: WatcherStewardHealth = {
  status: 'ok',
  missingRequired: [],
  openMaterialConflicts: [],
  staleDocs: [],
};

function input(overrides: Partial<WatcherCheckInput> = {}): WatcherCheckInput {
  return {
    strategy: { id: 'S1', type: 'authorization', title: 'Plan' },
    nodes: [],
    today: TODAY,
    congress: [],
    stewardHealth: HEALTH_OK,
    verifierViolations: [],
    ...overrides,
  };
}

function byCode(findings: Finding[], code: string): Finding[] {
  return findings.filter((f) => f.code === code);
}

describe('runWatcherChecks — clean plan', () => {
  it('a healthy, owned, ordered, in-window plan produces ZERO findings', () => {
    // A -> gate G -> B, all future-dated, all owned, gate has a prerequisite.
    const nodes: WatcherNode[] = [
      node({ id: 'A', startsOn: '2026-08-01', endsOn: '2026-08-15' }),
      node({
        id: 'G',
        kind: 'gate',
        subject: 'committee',
        startsOn: '2026-08-16',
        endsOn: null,
        dependsOnIds: ['A'],
      }),
      node({ id: 'B', startsOn: '2026-08-20', endsOn: '2026-08-30', dependsOnIds: ['G'] }),
    ];
    expect(runWatcherChecks(input({ nodes }))).toEqual([]);
  });

  it('exports the severity vocabulary', () => {
    expect(FINDING_SEVERITIES).toEqual(['info', 'warning', 'critical']);
  });
});

describe('(a) verifier fold', () => {
  it('demotes error->warning and warning->info, keeps proposedOps null (advisory) and preserves the verifier code', () => {
    const violations: Violation[] = [
      {
        code: 'dep-order',
        severity: 'error',
        nodeIds: ['n1', 'n2'],
        message: 'starts before its dependency',
        suggestion: 'move it later',
      },
      { code: 'window', severity: 'warning', nodeIds: ['n3'], message: 'outside the window' },
    ];
    const findings = runWatcherChecks(input({ verifierViolations: violations }));

    expect(findings).toHaveLength(2);
    const folded = byCode(findings, 'verifier:dep-order')[0]!;
    expect(folded.severity).toBe('warning'); // error DEMOTED — watcher never reads louder than the gate
    expect(folded.nodeIds).toEqual(['n1', 'n2']);
    expect(folded.message).toBe('starts before its dependency');
    expect(folded.suggestion).toBe('move it later');
    expect(folded.proposedOps).toBeNull();

    const soft = byCode(findings, 'verifier:window')[0]!;
    expect(soft.severity).toBe('info'); // warning -> info
    expect(soft.proposedOps).toBeNull();
  });
});

describe('(b) overdue', () => {
  it('a past-end non-active step warns with a concrete FUTURE retime preserving duration', () => {
    const nodes = [
      node({ id: 'N1', startsOn: '2026-07-10', endsOn: '2026-07-20', status: 'in_progress' }),
    ];
    const [f] = byCode(runWatcherChecks(input({ nodes })), 'overdue');

    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.nodeIds).toEqual(['N1']);
    // duration 10 days, restarted TOMORROW (2026-07-25): strictly not in the past.
    expect(f!.proposedOps).toEqual([
      { op: 'retime', nodeId: 'N1', startsOn: '2026-07-25', endsOn: '2026-08-04' },
    ]);
  });

  it("an 'active' step past its end stays silent (status is the exemption)", () => {
    const nodes = [
      node({ id: 'N1', startsOn: '2026-07-10', endsOn: '2026-07-20', status: 'active' }),
    ];
    expect(byCode(runWatcherChecks(input({ nodes })), 'overdue')).toEqual([]);
  });

  it('a step ending today (or later) is not overdue', () => {
    const nodes = [node({ id: 'N1', startsOn: '2026-07-10', endsOn: TODAY })];
    expect(byCode(runWatcherChecks(input({ nodes })), 'overdue')).toEqual([]);
  });
});

describe('(c) missing-owner', () => {
  it('an unowned node is an info finding naming the node; owned nodes are silent', () => {
    const nodes = [
      node({ id: 'N1', title: 'Orphan step', ownerUserId: null }),
      node({ id: 'N2', ownerUserId: 'u-2' }),
    ];
    const found = byCode(runWatcherChecks(input({ nodes })), 'missing-owner');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.nodeIds).toEqual(['N1']);
    expect(found[0]!.message).toContain('Orphan step');
    expect(found[0]!.proposedOps).toBeUndefined(); // advisory, no ops
  });
});

describe('(d) dependency-slippage', () => {
  it('a step starting before its dependency ends warns with a retime to the dependency end (duration preserved)', () => {
    const nodes = [
      node({ id: 'D', startsOn: '2026-08-20', endsOn: '2026-09-01' }),
      node({ id: 'N', startsOn: '2026-08-25', endsOn: '2026-08-30', dependsOnIds: ['D'] }),
    ];
    const [f] = byCode(runWatcherChecks(input({ nodes })), 'dependency-slippage');

    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.nodeIds).toEqual(['N', 'D']);
    // duration 5 days, restarted at D's end.
    expect(f!.proposedOps).toEqual([
      { op: 'retime', nodeId: 'N', startsOn: '2026-09-01', endsOn: '2026-09-06' },
    ]);
  });

  it('a slipped POINT event keeps no end (endsOn omitted so the apply pipeline leaves it untouched)', () => {
    const nodes = [
      node({ id: 'D', startsOn: '2026-08-20', endsOn: '2026-09-01' }),
      node({
        id: 'N',
        kind: 'milestone',
        startsOn: '2026-08-25',
        endsOn: null,
        dependsOnIds: ['D'],
      }),
    ];
    const [f] = byCode(runWatcherChecks(input({ nodes })), 'dependency-slippage');
    const op = f!.proposedOps![0] as unknown as Record<string, unknown>;
    expect(op.startsOn).toBe('2026-09-01');
    expect('endsOn' in op).toBe(false);
  });

  it('a step starting at/after every dependency end is silent', () => {
    const nodes = [
      node({ id: 'D', startsOn: '2026-08-01', endsOn: '2026-08-10' }),
      node({ id: 'N', startsOn: '2026-08-10', endsOn: '2026-08-20', dependsOnIds: ['D'] }),
    ];
    expect(byCode(runWatcherChecks(input({ nodes })), 'dependency-slippage')).toEqual([]);
  });

  it('a dependency that already ENDED clamps the retime to tomorrow — never a past window, and never contradicting the overdue proposal on the same node', () => {
    // Dep B ended 2026-06-01 (past, relative to TODAY=2026-07-24); A (5-day,
    // draft) started 2026-05-01 and depends on B. Unclamped, slippage would
    // retime A to 2026-06-01–2026-06-06 (already past) while overdue proposes
    // 2026-07-25–2026-07-30 for the SAME node in the SAME run.
    const nodes = [
      node({ id: 'B', startsOn: '2026-05-10', endsOn: '2026-06-01', status: 'active' }),
      node({
        id: 'A',
        startsOn: '2026-05-01',
        endsOn: '2026-05-06',
        status: 'draft',
        dependsOnIds: ['B'],
      }),
    ];
    const findings = runWatcherChecks(input({ nodes }));

    const [slip] = byCode(findings, 'dependency-slippage');
    expect(slip).toBeDefined();
    // Clamped to TOMORROW (duration preserved) — NOT B's past end.
    expect(slip!.proposedOps).toEqual([
      { op: 'retime', nodeId: 'A', startsOn: '2026-07-25', endsOn: '2026-07-30' },
    ]);
    // The message still reports the dependency's REAL end date.
    expect(slip!.message).toContain('2026-06-01');

    // Overdue also fires on A in the same run; both proposals must now agree.
    const [over] = byCode(findings, 'overdue');
    expect(over).toBeDefined();
    expect(over!.nodeIds).toEqual(['A']);
    expect(over!.proposedOps).toEqual(slip!.proposedOps);
  });

  it('a past-ended dependency of a slipped POINT event clamps startsOn to tomorrow and still omits endsOn', () => {
    const nodes = [
      node({ id: 'B', startsOn: '2026-05-10', endsOn: '2026-06-01', status: 'active' }),
      node({
        id: 'A',
        kind: 'milestone',
        startsOn: '2026-05-01',
        endsOn: null,
        dependsOnIds: ['B'],
      }),
    ];
    const [f] = byCode(runWatcherChecks(input({ nodes })), 'dependency-slippage');
    const op = f!.proposedOps![0] as unknown as Record<string, unknown>;
    expect(op.startsOn).toBe('2026-07-25');
    expect('endsOn' in op).toBe(false);
  });
});

describe('(e) gate-prereq', () => {
  it('a gate other steps depend on that has NO prerequisites is info', () => {
    const nodes = [
      node({ id: 'G', kind: 'gate', startsOn: '2026-08-10', endsOn: null, dependsOnIds: [] }),
      node({ id: 'B', startsOn: '2026-08-15', dependsOnIds: ['G'] }),
    ];
    const found = byCode(runWatcherChecks(input({ nodes })), 'gate-prereq');
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe('info');
    expect(found[0]!.nodeIds).toEqual(['G']);
  });

  it('silent when the gate has prerequisites, and when nothing depends on it', () => {
    const withPrereq = [
      node({ id: 'A', startsOn: '2026-08-01', endsOn: '2026-08-05' }),
      node({ id: 'G', kind: 'decision', startsOn: '2026-08-10', endsOn: null, dependsOnIds: ['A'] }),
      node({ id: 'B', startsOn: '2026-08-15', dependsOnIds: ['G'] }),
    ];
    expect(byCode(runWatcherChecks(input({ nodes: withPrereq })), 'gate-prereq')).toEqual([]);

    const noDependents = [
      node({ id: 'G', kind: 'gate', startsOn: '2026-08-10', endsOn: null, dependsOnIds: [] }),
    ];
    expect(byCode(runWatcherChecks(input({ nodes: noDependents })), 'gate-prereq')).toEqual([]);
  });
});

describe('(f) hard-deadline-risk', () => {
  const MARKUP = { label: 'HAC-D subcommittee markup', fy: 2027, startsOn: '2027-06-05', endsOn: null };

  it('a submission starting within 14 days of a same-FY markup warns', () => {
    const nodes = [
      node({ id: 'N', subject: 'submission', startsOn: '2027-05-25', endsOn: null }),
    ];
    const [f] = byCode(
      runWatcherChecks(input({ nodes, congress: [MARKUP] })),
      'hard-deadline-risk',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.message).toContain('11 days before');
    expect(f!.message).toContain('HAC-D subcommittee markup');
  });

  it('an ask starting ON the markup day (0 days of runway) still warns', () => {
    const nodes = [node({ id: 'N', subject: 'ask', startsOn: '2027-06-05', endsOn: null })];
    const [f] = byCode(
      runWatcherChecks(input({ nodes, congress: [MARKUP] })),
      'hard-deadline-risk',
    );
    expect(f).toBeDefined();
    expect(f!.message).toContain('0 days before');
  });

  it('an ask starting AFTER a same-FY markup is SILENT (post-markup asks are normal; no recurring noise on clean plans)', () => {
    // The shipped default baseline has a 'Committee markups' band starting late
    // April — a clean FY27 floor ask months later must not warn on every run.
    const band = { label: 'Committee markups', fy: 2027, startsOn: '2027-04-28', endsOn: '2027-06-30' };
    const nodes = [
      node({
        id: 'N',
        subject: 'ask',
        title: 'Request floor amendment support',
        startsOn: '2027-07-10',
        endsOn: null,
      }),
    ];
    expect(
      byCode(runWatcherChecks(input({ nodes, congress: [band] })), 'hard-deadline-risk'),
    ).toEqual([]);
  });

  it('attributes the warning to the nearest UPCOMING markup, not an earlier same-FY one', () => {
    const earlier = { label: 'Subcommittee markup', fy: 2027, startsOn: '2027-04-28', endsOn: null };
    const later = { label: 'Full committee markup', fy: 2027, startsOn: '2027-07-15', endsOn: null };
    const nodes = [
      node({ id: 'N', subject: 'submission', startsOn: '2027-07-10', endsOn: null }),
    ];
    const [f] = byCode(
      runWatcherChecks(input({ nodes, congress: [earlier, later] })),
      'hard-deadline-risk',
    );
    expect(f).toBeDefined();
    expect(f!.message).toContain('Full committee markup');
    expect(f!.message).toContain('5 days before');
    expect(f!.message).not.toContain('AFTER');
  });

  it('silent with >14 days of runway, for non-submission subjects, and for FY-only markup rows', () => {
    const early = [node({ id: 'N', subject: 'submission', startsOn: '2027-04-01', endsOn: null })];
    expect(
      byCode(runWatcherChecks(input({ nodes: early, congress: [MARKUP] })), 'hard-deadline-risk'),
    ).toEqual([]);

    const nonSubmission = [
      node({ id: 'N', subject: 'member', startsOn: '2027-06-01', endsOn: null }),
    ];
    expect(
      byCode(
        runWatcherChecks(input({ nodes: nonSubmission, congress: [MARKUP] })),
        'hard-deadline-risk',
      ),
    ).toEqual([]);

    // FY-only rows carry no concrete date — proximity needs one (documented skip).
    const fyOnly = [{ label: 'Full committee markup', fy: 2027, startsOn: null, endsOn: null }];
    const near = [node({ id: 'N', subject: 'submission', startsOn: '2027-06-01', endsOn: null })];
    expect(
      byCode(runWatcherChecks(input({ nodes: near, congress: fyOnly })), 'hard-deadline-risk'),
    ).toEqual([]);
  });
});

describe('(g) stale-context', () => {
  it("'degraded' warns and NAMES what is missing/stale", () => {
    const health: WatcherStewardHealth = {
      status: 'degraded',
      missingRequired: ['strategy_brief'],
      staleDocs: [{ title: 'FY27 constraints' }],
    };
    const [f] = byCode(runWatcherChecks(input({ stewardHealth: health })), 'stale-context');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('warning');
    expect(f!.nodeIds).toEqual([]);
    expect(f!.message).toContain('degraded');
    expect(f!.message).toContain('strategy_brief');
    expect(f!.message).toContain('FY27 constraints');
  });

  it("'conflicted' warns and names the colliding facts", () => {
    const health: WatcherStewardHealth = {
      status: 'conflicted',
      openMaterialConflicts: [{ factA: 'Ceiling is $5M', factB: 'Ceiling is $8M' }],
    };
    const [f] = byCode(runWatcherChecks(input({ stewardHealth: health })), 'stale-context');
    expect(f!.message).toContain('Ceiling is $5M');
    expect(f!.message).toContain('Ceiling is $8M');
  });

  it("'ok' is silent", () => {
    expect(byCode(runWatcherChecks(input()), 'stale-context')).toEqual([]);
  });
});

describe('(h) linked-artifact-mismatch (precomputed seam input)', () => {
  it('folds each mismatched node id to an info finding (named when the node resolves, generic when gone)', () => {
    const nodes = [node({ id: 'N1', title: 'Draft one-pager', status: 'draft' })];
    const findings = byCode(
      runWatcherChecks(input({ nodes, artifactMismatches: ['N1', 'ghost'] })),
      'linked-artifact-mismatch',
    );
    expect(findings).toHaveLength(2);
    const named = findings.find((f) => f.nodeIds[0] === 'N1')!;
    expect(named.severity).toBe('info');
    expect(named.message).toContain('Draft one-pager');
    const gone = findings.find((f) => f.nodeIds[0] === 'ghost')!;
    expect(gone.message).toContain('no longer in this plan');
  });
});

describe('dedup on (code + sorted nodeIds)', () => {
  it('identical (code, nodeIds) findings collapse to one — nodeId order does not matter', () => {
    const violations: Violation[] = [
      { code: 'dep-order', severity: 'error', nodeIds: ['n1', 'n2'], message: 'first' },
      { code: 'dep-order', severity: 'error', nodeIds: ['n2', 'n1'], message: 'second (dup)' },
    ];
    const findings = runWatcherChecks(input({ verifierViolations: violations }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe('first'); // first occurrence wins
  });

  it('same code on DIFFERENT nodes stays distinct', () => {
    const violations: Violation[] = [
      { code: 'window', severity: 'warning', nodeIds: ['n1'], message: 'a' },
      { code: 'window', severity: 'warning', nodeIds: ['n2'], message: 'b' },
    ];
    expect(runWatcherChecks(input({ verifierViolations: violations }))).toHaveLength(2);
  });

  it('findingKey is stable under nodeId reordering', () => {
    expect(findingKey({ code: 'overdue', nodeIds: ['b', 'a'] })).toBe(
      findingKey({ code: 'overdue', nodeIds: ['a', 'b'] }),
    );
  });
});
