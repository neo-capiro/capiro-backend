import { describe, expect, it } from '@jest/globals';
import { sha256Hex } from '../../contracts/canonical-json.js';
import type { RdteCycleDocumentInputV1 } from './rdte-phase3-document-input-v1.js';
import {
  buildRdteCycleArtifacts,
  finalizeRdteCycle,
  type RdteCycleArtifactBuildResult,
} from './rdte-cycle-pipeline-v1.js';
import {
  GOLDEN_DOCUMENT_KEYS,
  goldenCloseoutDocuments,
  goldenCloseoutVerifications,
} from './rdte-golden-closeout-v1.js';
import { GOLDEN_CYCLE_FY, GOLDEN_PE } from './rdte-golden-cycle-v1.js';

const MANIFEST_SHA = sha256Hex('golden-phase4-closeout-manifest');

function buildGolden(documents = goldenCloseoutDocuments()): RdteCycleArtifactBuildResult {
  return buildRdteCycleArtifacts({
    fiscalYear: GOLDEN_CYCLE_FY,
    manifestContentSha256: MANIFEST_SHA,
    manifestDocuments: goldenCloseoutDocuments().map((value) => value.document),
    documents,
  });
}

function finalizeGolden(input?: {
  documents?: RdteCycleDocumentInputV1[];
  verificationOverride?: Parameters<typeof goldenCloseoutVerifications>[0]['override'];
  mutateVerifications?: (
    values: ReturnType<typeof goldenCloseoutVerifications>,
  ) => ReturnType<typeof goldenCloseoutVerifications>;
}) {
  const build = buildGolden(input?.documents);
  let verifications = goldenCloseoutVerifications({
    build,
    manifestContentSha256: MANIFEST_SHA,
    ...(input?.verificationOverride ? { override: input.verificationOverride } : {}),
  });
  if (input?.mutateVerifications) verifications = input.mutateVerifications(verifications);
  return finalizeRdteCycle({
    cycleIdIdentity: { cycle: 'golden', fy: GOLDEN_CYCLE_FY },
    build,
    verifications,
  });
}

function tamperDocument(
  key: string,
  update: (document: RdteCycleDocumentInputV1) => RdteCycleDocumentInputV1,
): RdteCycleDocumentInputV1[] {
  return goldenCloseoutDocuments().map((document) =>
    document.document.documentKey === key ? update(document) : document,
  );
}

describe('Phase 4 exact RDT&E cycle pipeline', () => {
  it('certifies only after exact verification and projection planning', () => {
    const result = finalizeGolden();
    expect(result.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(result.bundle.blockingFindings).toHaveLength(0);
    expect(result.bundle.projectionPlanContentSha256).toBe(result.projectionPlan?.contentSha256);
    expect(result.projectionPlan).not.toBeNull();
    expect(result.counts).toEqual(
      expect.objectContaining({
        r1PeCount: 1,
        r2PeCount: 1,
        r2aProjectCount: 2,
        r3PerformerCount: 2,
        r4MilestoneCount: 2,
        comparisonCount: 1,
        blockingFindingCount: 0,
      }),
    );

    for (const source of result.bundle.sourceDocuments) {
      expect(source.sourceDocumentId).toContain(source.manifestDocumentKey);
      expect(source.parserRunIds.length).toBeGreaterThan(0);
      expect(source.unresolvedPages).toEqual([]);
    }
    for (const verification of result.bundle.verifications) {
      const artifact = result.bundle.artifacts.find(
        (candidate) => candidate.manifestDocumentKey === verification.manifestDocumentKey,
      );
      expect(verification.phase2Decision).toBe('PASS');
      expect(verification.status).toBe('VERIFICATION_PASSED');
      expect(verification.artifactId).toBe(artifact?.artifactId);
      expect(verification.artifactContentSha256).toBe(artifact?.artifactContentSha256);
      expect(verification.artifactByteSha256).toBe(artifact?.artifactByteSha256);
    }
  });

  it('emits R-2 identity and narrative in the verified R-2 artifact', () => {
    const result = finalizeGolden();
    const r2 = result.artifacts.find((value) => value.documentKey === 'golden_r2')?.artifact;
    expect(r2).toBeDefined();
    expect(
      r2?.assertions.some(
        (assertion) =>
          assertion.assertionKind === 'program_element_identity' &&
          assertion.identity.peCode === GOLDEN_PE,
      ),
    ).toBe(true);
    expect(
      r2?.assertions.some(
        (assertion) =>
          assertion.assertionKind === 'narrative' && assertion.narrativeType === 'mission',
      ),
    ).toBe(true);
    expect(r2?.parserRuns[0]?.method).toBe('native_structured');
  });

  it('retains evidence-linked unit-tolerant R-1/R-2 comparison records', () => {
    const result = finalizeGolden();
    expect(result.bundle.comparisons).toHaveLength(1);
    expect(result.bundle.comparisons[0]).toEqual(
      expect.objectContaining({
        comparisonKind: 'r1_r2_budget_year_request',
        peCode: GOLDEN_PE,
        fiscalYear: GOLDEN_CYCLE_FY,
        result: 'pass',
        toleranceMillions: '1',
      }),
    );
    expect(result.bundle.comparisons[0]?.leftAssertionIds.length).toBe(1);
    expect(result.bundle.comparisons[0]?.rightAssertionIds.length).toBe(1);
    expect(result.bundle.comparisons[0]?.evidenceIds.length).toBeGreaterThan(0);
  });

  it('is deterministic under supplied-document permutation', () => {
    const forward = finalizeGolden();
    const reverse = finalizeGolden({ documents: [...goldenCloseoutDocuments()].reverse() });
    expect(reverse.bundle.contentSha256).toBe(forward.bundle.contentSha256);
    expect(reverse.projectionPlan?.contentSha256).toBe(forward.projectionPlan?.contentSha256);
    expect(reverse.artifacts.map((value) => value.artifact.artifactId)).toEqual(
      forward.artifacts.map((value) => value.artifact.artifactId),
    );
  });

  it('reports a missing required manifest document as incomplete', () => {
    const documents = goldenCloseoutDocuments().filter(
      (value) => value.document.documentKey !== 'golden_r2',
    );
    const result = finalizeGolden({ documents });
    expect(result.certification).toBe('INCOMPLETE');
    expect(
      result.bundle.blockingFindings.some(
        (finding) =>
          finding.code === 'required_document_missing' ||
          finding.code === 'required_artifact_missing',
      ),
    ).toBe(true);
    expect(result.projectionPlan).toBeNull();
  });

  it('blocks review-pending and rejected Phase 2 results', () => {
    const review = finalizeGolden({
      verificationOverride: {
        golden_r3: { phase2Decision: 'REVIEW', status: 'NEEDS_REVIEW' },
      },
    });
    expect(review.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(review.projectionPlan).toBeNull();

    const rejected = finalizeGolden({
      verificationOverride: {
        golden_r1: { phase2Decision: 'REJECT', status: 'REJECTED' },
      },
    });
    expect(rejected.certification).toBe('REJECTED');
  });

  it('accepts only an immutable reviewed acceptance status', () => {
    const reviewed = finalizeGolden({
      verificationOverride: {
        golden_r3: { phase2Decision: 'REVIEW', status: 'REVIEW_ACCEPTED' },
      },
    });
    expect(reviewed.certification).toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
  });

  it('rejects a verification result bound to different artifact bytes', () => {
    const result = finalizeGolden({
      mutateVerifications: (values) =>
        values.map((value) =>
          value.manifestDocumentKey === 'golden_r1'
            ? { ...value, artifactByteSha256: '0'.repeat(64) }
            : value,
        ),
    });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(
      result.bundle.blockingFindings.some(
        (finding) => finding.code === 'verification_identity_mismatch',
      ),
    ).toBe(true);
  });

  it('blocks R-1/R-2 disagreement with exact evidence', () => {
    const documents = tamperDocument('golden_r1', (document) => ({
      ...document,
      pages: document.pages.map((page) => ({
        ...page,
        tables: page.tables.map((table) => ({
          ...table,
          cells: table.cells.map((cell) =>
            cell.rowIndex === 1 && cell.columnIndex === 4
              ? { ...cell, text: '99.000' }
              : cell,
          ),
        })),
      })),
    }));
    const result = finalizeGolden({ documents });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(
      result.bundle.blockingFindings.some(
        (finding) => finding.code === 'cross_exhibit_comparison_failed',
      ),
    ).toBe(true);
  });

  it('blocks materially incomplete project sums', () => {
    const documents = tamperDocument('golden_r2a', (document) => ({
      ...document,
      pages: document.pages.map((page) => ({
        ...page,
        tables: page.tables.map((table) => ({
          ...table,
          cells: table.cells.map((cell) =>
            page.page === 1 && cell.rowIndex === 1 && cell.columnIndex === 1
              ? { ...cell, text: '9.000' }
              : cell,
          ),
        })),
      })),
    }));
    const result = finalizeGolden({ documents });
    expect(result.certification).not.toBe('CERTIFIED_RDTE_READY_FOR_PROJECTION');
    expect(
      result.bundle.blockingFindings.some(
        (finding) => finding.code === 'r2a_project_sum_unreconciled',
      ),
    ).toBe(true);
  });

  it('keeps all manifest-required coverage categories explicit', () => {
    const result = finalizeGolden();
    const expected = new Set(['identity', 'funding', 'narrative', 'projects', 'project_funding', 'performers', 'milestones']);
    expect(new Set(result.bundle.coverage.map((entry) => entry.category))).toEqual(expected);
    for (const entry of result.bundle.coverage) {
      expect(entry.status).toBe('verified');
      expect(entry.numerator).toBe(entry.denominator);
      expect(entry.denominator).toBeGreaterThan(0);
      expect(entry.missingKeys).toEqual([]);
    }
    expect(GOLDEN_DOCUMENT_KEYS).toHaveLength(5);
  });
});
