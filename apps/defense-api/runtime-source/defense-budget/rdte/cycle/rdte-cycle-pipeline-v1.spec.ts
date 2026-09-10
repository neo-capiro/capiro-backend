import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../../contracts/canonical-json.js';
import { parseParserRuntimeResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
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
import { buildProjectionPlanRecordV1 } from '../../projection-plan/projection-plan-record-v1.js';
import { rdteCycleBundleId } from '../rdte-cycle-bundle-v1.js';

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
  governedCycleId?: string;
  cycleIdIdentity?: { family: 'rdte'; fiscalYear: number; manifestContentSha256: string };
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
    governedCycleId: input?.governedCycleId ?? 'cycle-fy2027-authorization',
    cycleIdIdentity: input?.cycleIdIdentity ?? {
      family: 'rdte',
      fiscalYear: GOLDEN_CYCLE_FY,
      manifestContentSha256: MANIFEST_SHA,
    },
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

  it('does not open a spurious R-2A funding group from the real FY2024 Army R-2 front-matter page that mentions "R-2A" in prose (Phase 10B-21 Area 8 real-document finding)', () => {
    // The real document's own physical page 6 ("Introduction and
    // Explanation of Contents") explains what an R-2A exhibit IS
    // ("...comprised of R-2 ..., R-2A (Army RDT&E Budget Item
    // Justification - project level)...", "...found in the narrative
    // sections of the Program Element R-2A Exhibits.") without ever
    // printing a labeled "PE NNNNNNNL" or "Project Code:" field --
    // `groupR2aPages` (this file) used to key such a page as
    // parentPeCode/projectCode `''`/`''` and open a real funding group for
    // it, which downstream flagged a spurious blocking "R-2A unit
    // resolution missing for /" warning and pushed the real production
    // import to REJECT. Embedding the exact real page (not a hand-rolled
    // approximation) also faithfully carries that page's restructuring
    // table of ~14 distinct real PE codes, which independently triggers
    // the R-2 segmenter's conflicting-PE-headers veto -- reproducing the
    // full real shape, not a simplified one that could pass for reasons
    // that do not hold in production.
    const rawFixturePath = join(
      __dirname,
      '__fixtures__',
      'production-fy2024-army-r2-raw-parser-output-170pages.json',
    );
    const rawResult = parseParserRuntimeResultV1(
      JSON.parse(readFileSync(rawFixturePath, 'utf8')) as unknown,
    );
    const realFrontMatterPage = rawResult.pages.find((page) => page.page === 6);
    if (!realFrontMatterPage) {
      throw new Error('expected physical page 6 in the real raw-parser-output fixture');
    }
    const documents = tamperDocument('golden_r2', (document) => ({
      ...document,
      // Renumber to avoid colliding with the golden document's own page 1.
      pages: [...document.pages, { ...realFrontMatterPage, page: 90 }],
    }));
    const result = buildGolden(documents);
    const r2Artifact = result.artifacts.find((value) => value.documentKey === 'golden_r2')?.artifact;
    expect(r2Artifact).toBeDefined();
    expect(
      r2Artifact?.warnings.some((warning) => warning.code === 'r2a_unit_unresolved'),
    ).toBe(false);
    expect(r2Artifact?.omissions.filter((omission) => omission.severity === 'blocking')).toHaveLength(
      0,
    );
    expect(result.counts.r2aProjectCount).toBe(2);
    expect(result.counts.blockingFindingCount).toBe(0);
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

  it('separates governed cycle identity from deterministic bundle content identity', () => {
    const first = finalizeGolden();
    const repeated = finalizeGolden();
    const changedContent = finalizeGolden({
      verificationOverride: {
        golden_r3: { phase2Decision: 'REVIEW', status: 'REVIEW_ACCEPTED' },
      },
    });
    const differentGovernedCycle = finalizeGolden({
      governedCycleId: 'cycle-fy2027-appropriation',
    });
    const record = (result: typeof first) =>
      buildProjectionPlanRecordV1({
        family: 'rdte',
        producerVersion: 'identity-invariant-test',
        certificationId: result.bundle.bundleId,
        certificationSha256: result.bundle.contentSha256,
        planDocument: result.projectionPlan,
      });

    expect(first.bundle.bundleId).toBe(repeated.bundle.bundleId);
    const identity = {
      family: 'rdte',
      fiscalYear: GOLDEN_CYCLE_FY,
      manifestContentSha256: MANIFEST_SHA,
    };
    expect(rdteCycleBundleId(identity)).toBe(rdteCycleBundleId(identity));
    expect(record(first).projectionPlanId).toBe(record(repeated).projectionPlanId);
    expect(changedContent.bundle.bundleId).toBe(first.bundle.bundleId);
    expect(changedContent.bundle.contentSha256).not.toBe(first.bundle.contentSha256);
    expect(record(changedContent).projectionPlanId).not.toBe(record(first).projectionPlanId);
    expect(rdteCycleBundleId({ ...identity, fiscalYear: GOLDEN_CYCLE_FY + 1 })).not.toBe(
      first.bundle.bundleId,
    );
    expect(differentGovernedCycle.bundle.bundleId).toBe(first.bundle.bundleId);
    expect(differentGovernedCycle.bundle.cycleId).toBe('cycle-fy2027-appropriation');
    expect(record(differentGovernedCycle).cycleId).toBe('cycle-fy2027-appropriation');
    expect(record(differentGovernedCycle).projectionPlanId).not.toBe(record(first).projectionPlanId);
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
            cell.rowIndex === 1 && cell.columnIndex === 4 ? { ...cell, text: '99.000' } : cell,
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
    const expected = new Set([
      'identity',
      'funding',
      'narrative',
      'projects',
      'project_funding',
      'performers',
      'milestones',
    ]);
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
