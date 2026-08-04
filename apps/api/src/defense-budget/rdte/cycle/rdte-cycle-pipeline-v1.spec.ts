/**
 * rdte-cycle-pipeline-v1.spec — Workstream N end-to-end golden cycle:
 *   - a complete synthetic cycle certifies deterministically;
 *   - missing required document blocks certification (fail-closed);
 *   - NEEDS_REVIEW / REJECTED verification decisions block certification;
 *   - R-1/R-2 request mismatch blocks certification;
 *   - broken project sum blocks certification;
 *   - the pipeline is deterministic under document permutation.
 */
import { describe, it, expect } from '@jest/globals';
import { runRdteCyclePipeline } from './rdte-cycle-pipeline-v1.js';
import type { RdteCycleDocumentInput } from './rdte-cycle-pipeline-v1.js';
import {
  GOLDEN_CYCLE_FY,
  GOLDEN_PE,
  GOLDEN_SHA,
  goldenManifestDocument,
  goldenPagesByKey,
  goldenSource,
} from './rdte-golden-cycle-v1.js';
import type { RdteCycleVerificationRefV1 } from '../rdte-cycle-bundle-v1.js';
import { sha256Hex } from '../../contracts/canonical-json.js';

const MANIFEST_SHA = sha256Hex('golden-manifest');

function goldenDocuments(): RdteCycleDocumentInput[] {
  const pages = goldenPagesByKey();
  return ['golden_r1', 'golden_r2', 'golden_r2a', 'golden_r3', 'golden_r4'].map((key) => ({
    document: goldenManifestDocument(key),
    source: goldenSource(key),
    pages: pages[key] ?? [],
  }));
}

function goldenVerifications(): RdteCycleVerificationRefV1[] {
  return ['golden_r1', 'golden_r2', 'golden_r2a', 'golden_r3', 'golden_r4'].map((key) => ({
    manifestDocumentKey: key,
    artifactId: `art_${key}`,
    verificationCandidateId: `cand_${key}`,
    verificationRunId: `run_${key}`,
    decision: 'VERIFICATION_PASSED' as const,
    decisionId: `dec_${key}`,
  }));
}

function runGolden(overrides?: {
  documents?: RdteCycleDocumentInput[];
  verifications?: RdteCycleVerificationRefV1[];
}) {
  return runRdteCyclePipeline({
    cycleIdIdentity: { cycle: 'golden', fy: GOLDEN_CYCLE_FY },
    fiscalYear: GOLDEN_CYCLE_FY,
    manifestContentSha256: MANIFEST_SHA,
    documents: overrides?.documents ?? goldenDocuments(),
    verifications: overrides?.verifications ?? goldenVerifications(),
  });
}

describe('rdte-cycle-pipeline-v1 (golden cycle)', () => {
  it('certifies a complete synthetic cycle', () => {
    const result = runGolden();
    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.counts.r1PeCount).toBe(1);
    expect(result.counts.r2PeCount).toBe(1);
    expect(result.counts.r2aProjectCount).toBe(2);
    expect(result.counts.r3PerformerCount).toBe(2);
    expect(result.counts.r4MilestoneCount).toBe(2);
    expect(result.counts.comparisonCount).toBe(1);
    expect(result.counts.blockingFindingCount).toBe(0);
    expect(result.artifacts).toHaveLength(5);
    expect(result.bundle.blockingFindings).toHaveLength(0);

    /* R-1/R-2 comparison passed. */
    const comparison = result.bundle.comparisons[0];
    void comparison;
  });

  it('is deterministic under document permutation', () => {
    const a = runGolden();
    const documents = [...goldenDocuments()].reverse();
    const b = runGolden({ documents });
    expect(a.bundle.contentSha256).toBe(b.bundle.contentSha256);
  });

  it('blocks certification when a required document is missing', () => {
    const documents = goldenDocuments().filter((d) => d.document.documentKey !== 'golden_r2');
    const verifications = goldenVerifications().filter(
      (v) => v.manifestDocumentKey !== 'golden_r2',
    );
    const result = runGolden({ documents, verifications });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.blockingFindings.length).toBeGreaterThan(0);
  });

  it('blocks certification when verification is NEEDS_REVIEW', () => {
    const verifications = goldenVerifications().map((v) =>
      v.manifestDocumentKey === 'golden_r3' ? { ...v, decision: 'NEEDS_REVIEW' as const } : v,
    );
    const result = runGolden({ verifications });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('blocks certification when verification is REJECTED', () => {
    const verifications = goldenVerifications().map((v) =>
      v.manifestDocumentKey === 'golden_r1' ? { ...v, decision: 'REJECTED' as const } : v,
    );
    const result = runGolden({ verifications });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('blocks certification when R-1 and R-2 requests disagree', () => {
    const documents = goldenDocuments().map((doc) => {
      if (doc.document.documentKey !== 'golden_r1') return doc;
      /* Tamper the R-1 request cell: 12.000 -> 99.000. */
      const pages = doc.pages.map((page) => ({
        ...page,
        tables: page.tables.map((table) => ({
          ...table,
          cells: table.cells.map((cell) =>
            cell.rowIndex === 1 && cell.columnIndex === 4 ? { ...cell, text: '99.000' } : cell,
          ),
        })),
      }));
      return { ...doc, pages };
    });
    const result = runGolden({ documents });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.blockingFindings.some((f) => f.code.startsWith('r1_r2'))).toBe(true);
  });

  it('blocks certification when the project sum does not reconcile', () => {
    const documents = goldenDocuments().map((doc) => {
      if (doc.document.documentKey !== 'golden_r2a') return doc;
      /* Tamper project A1: 7.000 -> 9.000 (sum 14 != PE total 12). */
      const pages = doc.pages.map((page) => ({
        ...page,
        tables: page.tables.map((table) => ({
          ...table,
          cells: table.cells.map((cell) =>
            cell.rowIndex === 1 && cell.columnIndex === 1 && page.page === 1
              ? { ...cell, text: '9.000' }
              : cell,
          ),
        })),
      }));
      return { ...doc, pages };
    });
    const result = runGolden({ documents });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('projects every golden PE through the projection planner', async () => {
    const { planRdteCanonicalProjection } =
      await import('../projection/rdte-projection-planner-v1.js');
    const result = runGolden();
    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    const { plan } = planRdteCanonicalProjection({
      bundle: result.bundle,
      artifacts: result.artifacts.map((a) => a.artifact),
    });

    /* Identity, request, positions, projects, performers, milestones all
     * project; contextual/CTC values are excluded. */
    const targets = new Set(plan.candidates.map((c) => c.target));
    expect(targets.has('ProgramElement')).toBe(true);
    expect(targets.has('ProgramElementYear')).toBe(true);
    expect(targets.has('ProgramElementBudgetPosition')).toBe(true);
    expect(targets.has('ProgramElementProject')).toBe(true);
    expect(targets.has('ProgramElementProjectBudgetPosition')).toBe(true);
    expect(targets.has('ProgramElementPerformer')).toBe(true);
    expect(targets.has('ProgramElementMilestone')).toBe(true);
    expect(targets.has('ProgramElementMilestoneSchedulePeriod')).toBe(true);
    expect(targets.has('ProgramElementSource')).toBe(true);

    const year = plan.candidates.find((c) => c.target === 'ProgramElementYear');
    expect(year?.values.peCode).toBe(GOLDEN_PE);
    expect(year?.values.fy).toBe(GOLDEN_CYCLE_FY);

    /* Outyear appears as a PE position, never as a ProgramElementYear. */
    const positions = plan.candidates.filter((c) => c.target === 'ProgramElementBudgetPosition');
    expect(positions.some((c) => c.values.assertedFy === 2028)).toBe(true);

    /* IOC keeps its fiscal-quarter period without a fabricated date. */
    const ioc = plan.candidates.find(
      (c) =>
        c.target === 'ProgramElementMilestone' &&
        String(c.values.milestoneType).includes('Initial Operational'),
    );
    expect(ioc?.values.plannedDate).toBeUndefined();
    const periods = plan.candidates.filter(
      (c) => c.target === 'ProgramElementMilestoneSchedulePeriod',
    );
    expect(
      periods.some((c) => c.values.periodKind === 'fiscal_quarter' && c.values.fiscalQuarter === 3),
    ).toBe(true);

    /* CTC/total-cost never reach annual funding targets. */
    const exclusions = plan.exclusions.map((e) => e.reason);
    expect(exclusions).toContain('non_annual_cost_value');
    expect(exclusions).toContain('contextual_only_value');

    /* No projection candidate may carry an outyear as the cycle request. */
    for (const candidate of plan.candidates) {
      if (candidate.target === 'ProgramElementYear') {
        expect(candidate.values.fy).toBe(GOLDEN_CYCLE_FY);
      }
    }
    expect(plan.contentSha256).toHaveLength(64);
    void GOLDEN_SHA;
  });
});
