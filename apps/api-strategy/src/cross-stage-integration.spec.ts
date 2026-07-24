import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPlan, type VerifierFiscal, type VerifierNode, type VerifierRefRow } from '@capiro/strategy-verifier';
import { assertTransition, assertMissionTransition } from './agents/run-state.js';
import { runWatcherChecks, type WatcherNode, type WatcherStewardHealth } from './agents/watcher-checks.js';
import { classifyRisk, type WatcherFinding } from './agents/risk-router.js';
import { evaluateEligibility } from './agents/execution-eligibility.js';
import { parseFrontmatter, validateFrontmatter } from './context/frontmatter.js';
import { locateAll, locate } from './context/markdown-locate.js';

/**
 * Cross-stage integration walk: ONE strategy's real data flowing through the
 * REAL pure functions of stages A, C, D, F and G in the same shapes and same
 * order the running services chain them — as opposed to every per-stage spec
 * (missions.service.spec.ts, watcher-checks.spec.ts, etc.), which each
 * fabricate whatever input shape THAT spec's author guessed rather than the
 * shape a real upstream stage actually emits. No Nest, no Prisma, no fakes of
 * either — every value below is produced by calling the same exported
 * function production code calls, so a shape/contract drift between stages
 * (e.g. Watcher's WatcherNode vs the verifier's VerifierNode, or a Steward
 * conflict count meaning something different to the Watcher than to
 * Execution-eligibility) fails HERE instead of only at runtime.
 */
describe('cross-stage integration walk (A -> C -> D -> F -> G)', () => {
  const fiscal: VerifierFiscal = {
    today: '2027-11-01',
    fys: [2027, 2028, 2029],
    fyLabels: ['FY27', 'FY28', 'FY29'],
    focalFy: 'FY28',
  };
  const congress: VerifierRefRow[] = [
    { label: 'Full Committee Markup', fy: null, startsOn: '2027-12-12', endsOn: null },
  ];

  const baseNodes: VerifierNode[] = [
    {
      id: 'n1',
      kind: 'action',
      subject: 'deliverable',
      title: 'Draft testimony',
      startsOn: '2027-11-15',
      endsOn: '2027-11-30',
      dependsOnIds: [],
    },
    {
      id: 'n2',
      kind: 'action',
      subject: 'submission',
      title: 'Submit testimony',
      startsOn: '2027-12-05',
      endsOn: null,
      dependsOnIds: ['n1'],
    },
    {
      id: 'n3',
      kind: 'gate',
      subject: 'outcome',
      title: 'Committee markup gate',
      startsOn: '2027-12-10',
      endsOn: null,
      dependsOnIds: ['n2'],
    },
    {
      id: 'n4',
      kind: 'action',
      subject: 'deliverable',
      title: 'Post-markup follow-up',
      startsOn: '2027-12-15',
      endsOn: '2027-12-20',
      dependsOnIds: ['n3'],
    },
  ];

  // ---- Stage A: verifyPlan is the write-time gate every plan must clear ----
  it('Stage A: a correctly-ordered appropriations plan clears verifyPlan with zero violations', () => {
    const result = verifyPlan({ strategyType: 'appropriations', nodes: baseNodes, fiscal, congress });
    expect(result.violations).toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  });

  // A plan that regresses n4 to start before its gate (n3) CLEARS — an error
  // the write-gate would block. n3 gets a one-day resolution window
  // (endsOn set) so n4 can start on-or-after the gate opens but still before
  // it closes, which is precisely what trips 'gate-before-dependents' (a
  // point-event gate, start===end, can never trip that check — only
  // 'dep-order'). Used below to drive Stage F with a REAL verifier error
  // instead of a hand-fabricated Violation.
  const brokenNodes: VerifierNode[] = baseNodes.map((n) => {
    if (n.id === 'n3') return { ...n, endsOn: '2027-12-11' };
    if (n.id === 'n4') return { ...n, startsOn: '2027-12-10' };
    return n;
  });
  // n1 deliberately carries no owner into Stage F below (checkMissingOwner).
  const ownerByNode: Record<string, string | null> = { n1: null, n2: 'user_1', n3: null, n4: 'user_2' };

  it('Stage A -> F seam: verifyPlan output on the broken plan folds into Watcher findings with demoted severity', () => {
    const verified = verifyPlan({ strategyType: 'appropriations', nodes: brokenNodes, fiscal, congress });
    expect(verified.errorCount).toBeGreaterThan(0);
    const gateViolation = verified.violations.find((v) => v.code === 'gate-before-dependents');
    expect(gateViolation?.severity).toBe('error');

    // The exact WatcherNode adaptation WatcherService performs on a plan's
    // real nodes (dates already ISO strings, ownerUserId/status/provenance
    // added) — fed the SAME broken node set verifyPlan just ran over.
    const watcherNodes: WatcherNode[] = brokenNodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      subject: n.subject,
      title: n.title,
      startsOn: n.startsOn,
      endsOn: n.endsOn,
      status: 'planned',
      ownerUserId: ownerByNode[n.id] ?? null,
      dependsOnIds: n.dependsOnIds,
    }));

    const findings = runWatcherChecks({
      strategy: { id: 'S1', type: 'appropriations' },
      nodes: watcherNodes,
      today: fiscal.today!,
      congress,
      stewardHealth: { status: 'ok' },
      verifierViolations: verified.violations,
    });

    // (a) foldVerifier: the real 'error' violation is folded in DEMOTED to
    // 'warning' — a Watcher check must never read louder than the write-gate
    // that already would have blocked this plan outright.
    const folded = findings.find((f) => f.code === 'verifier:gate-before-dependents');
    expect(folded).toBeDefined();
    expect(folded!.severity).toBe('warning');
    expect(folded!.proposedOps).toBeNull();

    // (b) dependency-slippage: recomputed independently from dependsOnIds —
    // n4 (2027-12-08) now starts before n3's effective end (2027-12-10).
    const slippage = findings.find((f) => f.code === 'dependency-slippage');
    expect(slippage).toBeDefined();
    expect(slippage!.nodeIds).toContain('n4');
    expect(slippage!.proposedOps?.[0]?.op).toBe('retime');

    // (c) hard-deadline-risk: n2 (submission) starts 2027-12-05, 7 days before
    // the same-FY 'Full Committee Markup' congress row (2027-12-12).
    const deadline = findings.find((f) => f.code === 'hard-deadline-risk');
    expect(deadline).toBeDefined();
    expect(deadline!.nodeIds).toEqual(['n2']);

    // (d) missing-owner: n1 and n3 carry no owner.
    const missingOwner = findings.filter((f) => f.code === 'missing-owner');
    expect(missingOwner.map((f) => f.nodeIds[0]).sort()).toEqual(['n1', 'n3']);

    // ---- Stage F risk router: classify the SAME findings this Watcher run produced ----
    const asRouterFindings: WatcherFinding[] = findings.map((f) => ({
      code: f.code,
      severity: f.severity,
      message: f.message,
      structural: (f.proposedOps ?? []).some((op) => op.op === 'add' || op.op === 'remove'),
      nodeIds: f.nodeIds,
    }));
    const opCount = findings.reduce((n, f) => n + (f.proposedOps?.length ?? 0), 0);
    const classification = classifyRisk({ findings: asRouterFindings, firmLevel: false, opCount });

    // No critical finding, no structural (add/remove) op — only retime — so
    // several real warnings land at 'medium', never auto-applied.
    expect(classification.risk).toBe('medium');
    expect(classification.autoApplyEligible).toBe(false);
    expect(classification.requiresImpactSummary).toBe(false);
  });

  // ---- Stage C: the SAME mission/run lifecycle RunsService/MissionsService guard ----
  it('Stage C: mission must reach active before a run exists, and a check-run cannot skip human review', () => {
    // draft -> active is legal; draft -> completed is not (must go through active).
    expect(() => assertMissionTransition('draft', 'active')).not.toThrow();
    expect(() => assertMissionTransition('draft', 'completed')).toThrow();

    // The check-run shape (F1): queued -> planning -> ready_for_review -> completed.
    // No 'executing' hop — a suggest-only Watcher run never stages anything.
    expect(() => assertTransition('queued', 'planning')).not.toThrow();
    expect(() => assertTransition('planning', 'ready_for_review')).not.toThrow();
    expect(() => assertTransition('ready_for_review', 'completed')).not.toThrow();

    // Illegal shortcuts a buggy caller might attempt:
    expect(() => assertTransition('queued', 'ready_for_review')).toThrow();
    expect(() => assertTransition('planning', 'completed')).toThrow(); // must pass through ready_for_review
  });

  // ---- Stage D: the REAL shipped 07_current_plan.md template, not a hand-rolled fixture ----
  const templatePath = join(__dirname, 'context', 'templates', '07_current_plan.md');
  const rawTemplate = readFileSync(templatePath, 'utf8');

  it('Stage D: the blank shipped template fails validation on exactly its placeholder fields', () => {
    const parsed = parseFrontmatter(rawTemplate);
    expect(parsed.errors).toEqual([]); // structurally well-formed
    expect(parsed.frontmatter).not.toBeNull();
    const errors = validateFrontmatter(parsed.frontmatter!);
    expect(errors.map((e) => e.field).sort()).toEqual(['as_of', 'client_id', 'strategy_id']);
  });

  it('Stage D -> E seam: a realistically-filled copy of the same template validates clean, and its provenance refs round-trip', () => {
    const filled = rawTemplate
      .replace('client_id: "client_123"', 'client_id: "c-real-001"')
      .replace('strategy_id: "strategy_456"', 'strategy_id: "S1"')
      .replace('as_of: "YYYY-MM-DD"', 'as_of: "2027-11-01"');
    const parsed = parseFrontmatter(filled);
    expect(validateFrontmatter(parsed.frontmatter!)).toEqual([]);

    const { sections, tables } = locateAll(parsed.body);
    const planSection = sections.find((s) => s.heading === 'Current plan');
    expect(planSection?.ref).toBe('heading:Current plan');
    const planTable = tables.find((t) => t.sectionRef === 'heading:Current plan');
    expect(planTable?.rowCount).toBe(1);

    // The exact ref shape Stage E stores on sp_context_fact.ref — resolved
    // back against THIS document's real body, proving the D->E provenance
    // contract round-trips on the actual shipped pack content, not a fixture
    // shaped to make the resolver happy.
    const headingHit = locate(parsed.body, 'heading:Current plan');
    expect(headingHit?.content).toContain('NODE-001');
    const rowHit = locate(parsed.body, 'row:Current plan:1');
    expect(rowHit?.content).toContain('NODE-001');
  });

  // ---- Stage E health -> F (advisory) vs G (blocking): the SAME conflict count ----
  it('Stage E/F/G seam: an open material conflict only ANNOTATES the Watcher but BLOCKS Execution eligibility', () => {
    const conflictedHealth: WatcherStewardHealth = {
      status: 'conflicted',
      openMaterialConflicts: [{ factA: 'fact-1', factB: 'fact-2' }],
    };

    const findings = runWatcherChecks({
      strategy: { id: 'S1', type: 'appropriations' },
      nodes: [],
      today: fiscal.today!,
      congress: [],
      stewardHealth: conflictedHealth,
      verifierViolations: [],
    });
    const staleContext = findings.find((f) => f.code === 'stale-context');
    expect(staleContext).toBeDefined();
    // Annotate-only for drafts: the Watcher's own severity ladder tops out at
    // 'warning' for stale context — it is advisory, never 'critical'.
    expect(staleContext!.severity).toBe('warning');

    // The SAME conflict count (1), fed to Stage G's eligibility gate for a
    // node that is otherwise fully eligible, BLOCKS execution outright.
    const executionNode = {
      kind: 'action',
      subject: 'submission',
      ownerUserId: 'user_1',
      startsOn: '2027-12-05',
      endsOn: null,
    };
    const blocked = evaluateEligibility({
      node: executionNode,
      strategyHealth: { openMaterialConflicts: conflictedHealth.openMaterialConflicts!.length },
      hasWorkspaceAccess: true,
      kind: 'workspace',
    });
    expect(blocked.eligible).toBe(false);
    expect(blocked.reasons).toEqual([
      'strategy has 1 open material conflict (blocks execution)',
    ]);

    // Once the conflict clears (same node, same everything else), Execution
    // unblocks — proving the gate is driven precisely by the conflict count,
    // not some other hidden state this test would otherwise miss.
    const clear = evaluateEligibility({
      node: executionNode,
      strategyHealth: { openMaterialConflicts: 0 },
      hasWorkspaceAccess: true,
      kind: 'workspace',
    });
    expect(clear).toEqual({ eligible: true, reasons: [] });
  });
});
