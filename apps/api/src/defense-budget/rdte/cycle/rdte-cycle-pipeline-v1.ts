/**
 * Pure Phase 4 RDT&E cycle pipeline.
 *
 * Stage 1 builds semantic artifacts and reconciliation inputs from exact Phase
 * 3 selected pages and parser lineage. Stage 2 consumes exact Phase 2 results,
 * performs guarded projection planning, and emits the final certified bundle.
 */
import { sha256Bytes, type JsonValue } from '../../contracts/canonical-json.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import { extractR1FromPages } from '../r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import {
  buildR2R1ComparisonRequests,
  extractR2PeFunding,
  type R2FundingValue,
} from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { buildCompleteR2Artifact } from '../r2/r2-complete-artifact-builder-v1.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import { extractR2aProjectFunding } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R2aProjectFundingValue } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R2aProjectPageGroup } from '../r2a/r2a-project-extractor-v1.js';
import { buildR2aProjectArtifact } from '../r2a/r2a-artifact-builder-v1.js';
import {
  reconcileR2aProjectColumn,
  type R2PeTotalCell,
  type ReconcileR2aColumnInput,
} from '../r2a/r2a-project-reconciler.js';
import { extractR3PerformersFromPages } from '../r3/r3-table-extractor-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import { extractR4MilestonesFromPages } from '../r4/r4-extractor-v1.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import {
  reconcileRdteCycle,
  type RdteProjectRelationshipV1,
} from '../reconciliation/rdte-cycle-reconciler-v1.js';
import { certifyRdteCycle } from '../reconciliation/rdte-cycle-certifier-v1.js';
import type {
  CycleCertificationV1,
  RdteCycleArtifactRefV1,
  RdteCycleBundleV1,
  RdteCycleComparisonV1,
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import type { RdteCanonicalProjectionPlanV1 } from '../projection/rdte-canonical-projection-plan-v1.js';
import type { RdteCanonicalRowSnapshotV1 } from '../projection/rdte-projection-planner-v1.js';
import { planRdteProjectionForCertification } from '../projection/rdte-projection-certification-preflight-v1.js';
import type { RdteCycleReconciliationResult } from '../reconciliation/rdte-cycle-reconciler-v1.js';
import type { RdteCycleDocumentInputV1 } from './rdte-phase3-document-input-v1.js';
import { mergeRdteArtifactsV1 } from './merge-rdte-artifacts-v1.js';
import {
  buildManifestCoverageInputs,
  buildR1R2CycleComparisons,
  collectBlockingOmissionPeCodes,
  collectDuplicateNaturalKeys,
} from './rdte-cycle-integrity-v1.js';

export interface RdteCycleArtifactBuildInput {
  fiscalYear: number;
  manifestContentSha256: string;
  /** Full annual manifest inventory, including missing/optional documents. */
  manifestDocuments?: readonly BudgetCycleManifestDocumentV1[];
  /** Supplied documents that completed the Phase 3 parser boundary. */
  documents: readonly RdteCycleDocumentInputV1[];
  reviewedNewPeExceptions?: readonly string[];
}

export interface BuiltRdteArtifactV1 {
  documentKey: string;
  artifact: DefenseBudgetExtractionArtifactV1;
  serializedArtifact: string;
  artifactRef: RdteCycleArtifactRefV1;
}

export interface RdteCycleArtifactBuildResult {
  fiscalYear: number;
  manifestContentSha256: string;
  manifestDocuments: readonly BudgetCycleManifestDocumentV1[];
  documents: readonly RdteCycleDocumentInputV1[];
  sourceDocuments: readonly RdteCycleSourceDocumentV1[];
  artifacts: readonly BuiltRdteArtifactV1[];
  comparisons: readonly RdteCycleComparisonV1[];
  reconciliation: RdteCycleReconciliationResult;
  reviewedNewPeExceptions?: readonly string[];
  counts: {
    r1PeCount: number;
    r2PeCount: number;
    r2NarrativeSectionCount: number;
    r2aProjectCount: number;
    r3PerformerCount: number;
    r4MilestoneCount: number;
    comparisonCount: number;
    blockingFindingCount: number;
  };
}

export interface RdteCycleFinalizeInput {
  cycleIdIdentity: JsonValue;
  build: RdteCycleArtifactBuildResult;
  verifications: readonly RdteCycleVerificationRefV1[];
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}

export interface RdteCyclePipelineResult {
  artifacts: readonly BuiltRdteArtifactV1[];
  certification: CycleCertificationV1;
  bundle: RdteCycleBundleV1;
  projectionPlan: RdteCanonicalProjectionPlanV1 | null;
  reason: string;
  counts: RdteCycleArtifactBuildResult['counts'];
}

export interface RdteCyclePipelineInput extends RdteCycleArtifactBuildInput {
  cycleIdIdentity: JsonValue;
  verifications: readonly RdteCycleVerificationRefV1[];
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}

const EXHIBIT_ORDER: Record<string, number> = {
  'R-1': 0,
  'R-2': 1,
  'R-2A': 2,
  'R-3': 3,
  'R-4': 4,
  'R-4A': 5,
};

function orderedDocuments(
  documents: readonly RdteCycleDocumentInputV1[],
): RdteCycleDocumentInputV1[] {
  return [...documents].sort((left, right) => {
    const exhibit =
      (EXHIBIT_ORDER[left.document.exhibit] ?? 99) - (EXHIBIT_ORDER[right.document.exhibit] ?? 99);
    return exhibit || left.document.documentKey.localeCompare(right.document.documentKey);
  });
}

function orderedManifestDocuments(
  documents: readonly BudgetCycleManifestDocumentV1[],
): BudgetCycleManifestDocumentV1[] {
  return [...documents].sort((left, right) => {
    const exhibit = (EXHIBIT_ORDER[left.exhibit] ?? 99) - (EXHIBIT_ORDER[right.exhibit] ?? 99);
    return exhibit || left.documentKey.localeCompare(right.documentKey);
  });
}

function exhibitRoleOf(exhibit: string): RdteCycleSourceDocumentV1['exhibitRole'] {
  if (exhibit === 'R-1') return 'r1_catalog';
  if (exhibit === 'R-2') return 'r2_pe_summary';
  if (exhibit === 'R-2A') return 'r2a_project_detail';
  if (exhibit === 'R-3') return 'r3_cost_analysis';
  return 'r4_schedule';
}

function builtArtifact(
  documentKey: string,
  artifact: DefenseBudgetExtractionArtifactV1,
): BuiltRdteArtifactV1 {
  const serializedArtifact = `${JSON.stringify(artifact, null, 2)}\n`;
  return {
    documentKey,
    artifact,
    serializedArtifact,
    artifactRef: {
      manifestDocumentKey: documentKey,
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.contentSha256,
      artifactByteSha256: sha256Bytes(Buffer.from(serializedArtifact, 'utf8')),
    },
  };
}

function peCodeOf(assertion: DefenseBudgetAssertionV1): string | null {
  if ('identity' in assertion && assertion.identity?.lineKind === 'RDTE_PE') {
    return assertion.identity.peCode;
  }
  if ('parentPeCode' in assertion && typeof assertion.parentPeCode === 'string') {
    return assertion.parentPeCode;
  }
  return null;
}

function projectRelationships(
  artifacts: readonly DefenseBudgetExtractionArtifactV1[],
): RdteProjectRelationshipV1 {
  const projects: Array<{ peCode: string; projectCode: string }> = [];
  const projectFundingKeys: Array<{ peCode: string; projectCode: string }> = [];
  const referencedProjectKeys: Array<{ peCode: string; projectCode: string }> = [];
  for (const artifact of artifacts) {
    for (const assertion of artifact.assertions) {
      if (assertion.assertionKind === 'project') {
        projects.push({ peCode: assertion.parentPeCode, projectCode: assertion.projectCode });
      } else if (assertion.assertionKind === 'project_funding') {
        projectFundingKeys.push({
          peCode: assertion.parentPeCode,
          projectCode: assertion.projectCode,
        });
      } else if (assertion.assertionKind === 'performer' && assertion.projectCode) {
        referencedProjectKeys.push({
          peCode: assertion.parentPeCode,
          projectCode: assertion.projectCode,
        });
      } else if (assertion.assertionKind === 'milestone') {
        const projectCode = assertion.metadata?.projectCode;
        if (typeof projectCode === 'string' && projectCode.trim()) {
          referencedProjectKeys.push({ peCode: assertion.parentPeCode, projectCode });
        }
      }
    }
  }
  return { projects, projectFundingKeys, referencedProjectKeys };
}

function r2aExtractionParts(input: { document: RdteCycleDocumentInputV1; fiscalYear: number }): {
  artifact: DefenseBudgetExtractionArtifactV1 | null;
  projectCount: number;
  fundingValues: R2aProjectFundingValue[];
} {
  const projects = extractR2aProjectsFromPages({ pages: input.document.pages });
  const funding = groupR2aPages(input.document.pages).map((group) =>
    extractR2aProjectFunding({ group, cycleFiscalYear: input.fiscalYear }),
  );
  const fundingValues = funding.flatMap((value) => value.values);
  if (
    projects.identities.length === 0 &&
    projects.omissions.length === 0 &&
    fundingValues.length === 0 &&
    funding.every((value) => value.omissions.length === 0)
  ) {
    return { artifact: null, projectCount: 0, fundingValues: [] };
  }
  return {
    artifact: buildR2aProjectArtifact({
      source: input.document.source,
      parserRuns: input.document.parserRuns,
      projects: [projects],
      funding,
      cycleFiscalYear: input.fiscalYear,
    }),
    projectCount: projects.identities.length,
    fundingValues,
  };
}

export function buildRdteCycleArtifacts(
  input: RdteCycleArtifactBuildInput,
): RdteCycleArtifactBuildResult {
  const suppliedDocuments = orderedDocuments(input.documents);
  const manifestDocuments = orderedManifestDocuments(
    input.manifestDocuments ?? suppliedDocuments.map((value) => value.document),
  );
  const artifacts: BuiltRdteArtifactV1[] = [];
  const sourceDocuments: RdteCycleSourceDocumentV1[] = suppliedDocuments.map((value) => {
    const pageCount = value.pages.length + value.unresolvedPages.length;
    return {
      manifestDocumentKey: value.document.documentKey,
      sourceDocumentId: value.source.sourceDocumentId,
      exhibitRole: exhibitRoleOf(value.document.exhibit),
      required: value.document.required,
      sourcePdfSha256: value.source.sourcePdfSha256,
      sourceLocator: value.source.sourceLocator,
      ...(pageCount > 0 ? { pageCount } : {}),
      parserRunIds: value.parserRuns.map((run) => run.parserRunId).sort(),
      unresolvedPages: [...value.unresolvedPages].sort((a, b) => a - b),
    };
  });

  const r1RequestKeys = new Set<string>();
  const peTotals: R2PeTotalCell[] = [];
  const r2aProjectValues: R2aProjectFundingValue[] = [];
  let r2NarrativeSectionCount = 0;
  let r2aProjectCount = 0;
  let r3PerformerCount = 0;
  let r4MilestoneCount = 0;

  for (const value of suppliedDocuments) {
    if (value.parserRuns.length === 0 && value.pages.length > 0) {
      throw new Error(`${value.document.documentKey} has selected pages without parser runs`);
    }

    if (value.document.exhibit === 'R-1') {
      const extraction = extractR1FromPages({
        pages: value.pages,
        cycleFiscalYear: input.fiscalYear,
      });
      for (const funding of extraction.funding) {
        if (funding.disposition === 'canonical_request_candidate' && funding.fiscalYear != null) {
          r1RequestKeys.add(`${funding.peCode}|${funding.fiscalYear}`);
        }
      }
      artifacts.push(
        builtArtifact(
          value.document.documentKey,
          buildR1Artifact({
            source: value.source,
            parserRuns: value.parserRuns,
            extraction,
            cycleFiscalYear: input.fiscalYear,
          }),
        ),
      );
      continue;
    }

    if (value.document.exhibit === 'R-2') {
      const parts: DefenseBudgetExtractionArtifactV1[] = [];
      const segmentation = segmentR2ExhibitPages(value.pages);
      const resolution = resolveR2Contexts(segmentation);
      const identities = extractR2Identities({ pages: value.pages, contextResolution: resolution });
      const narrative = extractR2Narrative({ pages: value.pages, contextResolution: resolution });
      r2NarrativeSectionCount += narrative.sections.length;
      const peContexts = new Map<string, { pageStart: number; pageEnd: number }>();
      for (const page of resolution.pages) {
        if (page.kind !== 'r2_pe_summary' && page.kind !== 'r2_continuation') continue;
        if (!page.peCode) continue;
        const existing = peContexts.get(page.peCode);
        if (existing) {
          existing.pageStart = Math.min(existing.pageStart, page.page);
          existing.pageEnd = Math.max(existing.pageEnd, page.page);
        } else {
          peContexts.set(page.peCode, { pageStart: page.page, pageEnd: page.page });
        }
      }
      const fundingResults = [...peContexts.entries()].map(([peCode, range]) =>
        extractR2PeFunding({
          pages: value.pages,
          peContext: { peCode, ...range },
          cycleFiscalYear: input.fiscalYear,
        }),
      );
      for (const result of fundingResults) {
        for (const funding of result.values) collectR2Value(funding, peTotals);
      }
      const fundingArtifact = buildR2PeFundingArtifact({
        source: value.source,
        parserRuns: value.parserRuns,
        extractions: fundingResults,
        comparisonRequests: buildR2R1ComparisonRequests({
          r2Results: fundingResults,
          r1RequestKeys,
        }),
        cycleFiscalYear: input.fiscalYear,
      });
      parts.push(
        buildCompleteR2Artifact({
          fundingArtifact,
          parserRuns: value.parserRuns,
          identities,
          narrative,
        }),
      );

      const projectPart = r2aExtractionParts({ document: value, fiscalYear: input.fiscalYear });
      if (projectPart.artifact) parts.push(projectPart.artifact);
      r2aProjectCount += projectPart.projectCount;
      r2aProjectValues.push(...projectPart.fundingValues);

      const r3 = extractR3PerformersFromPages({
        pages: value.pages,
        cycleFiscalYear: input.fiscalYear,
      });
      if (r3.length > 0) {
        parts.push(
          buildR3PerformerArtifact({
            source: value.source,
            parserRuns: value.parserRuns,
            extractions: r3,
            cycleFiscalYear: input.fiscalYear,
          }),
        );
      }
      r3PerformerCount += r3.reduce((sum, result) => sum + result.performers.length, 0);

      const r4 = extractR4MilestonesFromPages({ pages: value.pages });
      if (r4.length > 0) {
        parts.push(
          buildR4MilestoneArtifact({
            source: value.source,
            parserRuns: value.parserRuns,
            extractions: r4,
          }),
        );
      }
      r4MilestoneCount += r4.reduce((sum, result) => sum + result.milestones.length, 0);

      artifacts.push(builtArtifact(value.document.documentKey, mergeRdteArtifactsV1(parts)));
      continue;
    }

    if (value.document.exhibit === 'R-2A') {
      const projectPart = r2aExtractionParts({ document: value, fiscalYear: input.fiscalYear });
      if (!projectPart.artifact) {
        throw new Error(
          `required R-2A document ${value.document.documentKey} produced no project ledger`,
        );
      }
      r2aProjectCount += projectPart.projectCount;
      r2aProjectValues.push(...projectPart.fundingValues);
      artifacts.push(builtArtifact(value.document.documentKey, projectPart.artifact));
      continue;
    }

    if (value.document.exhibit === 'R-3') {
      const extractions = extractR3PerformersFromPages({
        pages: value.pages,
        cycleFiscalYear: input.fiscalYear,
      });
      r3PerformerCount += extractions.reduce(
        (sum, extraction) => sum + extraction.performers.length,
        0,
      );
      artifacts.push(
        builtArtifact(
          value.document.documentKey,
          buildR3PerformerArtifact({
            source: value.source,
            parserRuns: value.parserRuns,
            extractions,
            cycleFiscalYear: input.fiscalYear,
          }),
        ),
      );
      continue;
    }

    if (value.document.exhibit === 'R-4' || value.document.exhibit === 'R-4A') {
      const extractions = extractR4MilestonesFromPages({ pages: value.pages });
      r4MilestoneCount += extractions.reduce(
        (sum, extraction) => sum + extraction.milestones.length,
        0,
      );
      artifacts.push(
        builtArtifact(
          value.document.documentKey,
          buildR4MilestoneArtifact({
            source: value.source,
            parserRuns: value.parserRuns,
            extractions,
          }),
        ),
      );
    }
  }

  const artifactValues = artifacts.map((value) => value.artifact);
  const comparisons = buildR1R2CycleComparisons(artifactValues);
  const r1PeCodes = artifactValues
    .filter((artifact) => artifact.source.exhibit === 'R-1')
    .flatMap((artifact) =>
      artifact.assertions
        .filter((assertion) => assertion.assertionKind === 'program_element_identity')
        .map((assertion) => assertion.identity.peCode),
    );
  const otherPeCodes = artifactValues
    .filter((artifact) => artifact.source.exhibit !== 'R-1')
    .flatMap((artifact) =>
      artifact.assertions.map(peCodeOf).filter((candidate): candidate is string => !!candidate),
    );
  const projectKeys = artifactValues.flatMap((artifact) =>
    artifact.assertions
      .filter((assertion) => assertion.assertionKind === 'project')
      .map((assertion) => ({ peCode: assertion.parentPeCode, projectCode: assertion.projectCode })),
  );
  const projectSums = peTotals
    .filter(
      (total) =>
        total.columnRole === 'budget_year_request' || total.columnRole === 'outyear_projection',
    )
    .map((total) => {
      const expectedProjectCodes = projectKeys
        .filter((project) => project.peCode === total.peCode)
        .map((project) => project.projectCode);
      const columnInput: ReconcileR2aColumnInput = {
        peCode: total.peCode,
        fiscalYear: total.fiscalYear,
        columnRole: total.columnRole,
        peTotal: total,
        projectValues: r2aProjectValues.filter(
          (project) =>
            project.parentPeCode === total.peCode &&
            project.fiscalYear === total.fiscalYear &&
            project.columnRole === total.columnRole,
        ),
        unit: total.unit,
        ...(expectedProjectCodes.length > 0 ? { expectedProjectCodes } : {}),
      };
      return reconcileR2aProjectColumn(columnInput);
    });

  const reconciliation = reconcileRdteCycle({
    identity: {
      r1PeCodes,
      otherExhibitPeCodes: otherPeCodes,
      ...(input.reviewedNewPeExceptions
        ? { reviewedNewPeExceptions: input.reviewedNewPeExceptions }
        : {}),
    },
    fundingComparisons: comparisons.map((comparison) => ({
      peCode: comparison.peCode,
      fiscalYear: comparison.fiscalYear,
      columnRole: comparison.columnRole,
      result: comparison.result,
      message: comparison.message,
      evidenceIds: comparison.evidenceIds,
    })),
    projectSumReconciliations: projectSums,
    projectRelationships: projectRelationships(artifactValues),
    coverageInputs: buildManifestCoverageInputs({
      documents: manifestDocuments,
      artifacts: artifactValues,
    }),
    blockingOmissionPeCodes: collectBlockingOmissionPeCodes(artifactValues),
    unresolvedPages: suppliedDocuments.flatMap((value) => value.unresolvedPages),
    duplicateNaturalKeys: collectDuplicateNaturalKeys(artifactValues),
  });

  return {
    fiscalYear: input.fiscalYear,
    manifestContentSha256: input.manifestContentSha256,
    manifestDocuments,
    documents: suppliedDocuments,
    sourceDocuments,
    artifacts,
    comparisons,
    reconciliation,
    ...(input.reviewedNewPeExceptions
      ? { reviewedNewPeExceptions: input.reviewedNewPeExceptions }
      : {}),
    counts: {
      r1PeCount: new Set(r1PeCodes).size,
      r2PeCount: new Set(
        artifactValues
          .filter((artifact) => artifact.source.exhibit === 'R-2')
          .flatMap((artifact) =>
            artifact.assertions
              .filter((assertion) => assertion.assertionKind === 'program_element_identity')
              .map((assertion) => assertion.identity.peCode),
          ),
      ).size,
      r2NarrativeSectionCount,
      r2aProjectCount,
      r3PerformerCount,
      r4MilestoneCount,
      comparisonCount: comparisons.length,
      blockingFindingCount: reconciliation.findings.filter(
        (finding) => finding.severity === 'blocking',
      ).length,
    },
  };
}

export function finalizeRdteCycle(input: RdteCycleFinalizeInput): RdteCyclePipelineResult {
  const requiredManifestDocumentKeys = input.build.manifestDocuments
    .filter((value) => value.required)
    .map((value) => value.documentKey);
  const common = {
    cycleIdIdentity: input.cycleIdIdentity,
    fiscalYear: input.build.fiscalYear,
    manifestContentSha256: input.build.manifestContentSha256,
    requiredManifestDocumentKeys,
    sourceDocuments: input.build.sourceDocuments,
    artifacts: input.build.artifacts.map((value) => value.artifactRef),
    verifications: input.verifications,
    comparisons: input.build.comparisons,
    reconciliation: input.build.reconciliation,
  };
  const preflight = certifyRdteCycle({
    ...common,
    projectionPlanningSucceeded: false,
  });
  const nonProjectionBlockers = preflight.bundle.blockingFindings.filter(
    (finding) => finding.code !== 'projection_planning_not_complete',
  );
  if (nonProjectionBlockers.length > 0) {
    return {
      artifacts: input.build.artifacts,
      certification: preflight.certification,
      bundle: preflight.bundle,
      projectionPlan: null,
      reason: preflight.reason,
      counts: input.build.counts,
    };
  }

  const projection = planRdteProjectionForCertification({
    preflightBundle: preflight.bundle,
    artifacts: input.build.artifacts.map((value) => value.artifact),
    ...(input.canonicalRows ? { canonicalRows: input.canonicalRows } : {}),
  });
  const final = certifyRdteCycle({
    ...common,
    projectionPlanningSucceeded: true,
    projectionPlanContentSha256: projection.plan.contentSha256,
  });
  return {
    artifacts: input.build.artifacts,
    certification: final.certification,
    bundle: final.bundle,
    projectionPlan: projection.plan,
    reason: final.reason,
    counts: {
      ...input.build.counts,
      blockingFindingCount: final.bundle.blockingFindings.length,
    },
  };
}

export function runRdteCyclePipeline(input: RdteCyclePipelineInput): RdteCyclePipelineResult {
  return finalizeRdteCycle({
    cycleIdIdentity: input.cycleIdIdentity,
    build: buildRdteCycleArtifacts(input),
    verifications: input.verifications,
    ...(input.canonicalRows ? { canonicalRows: input.canonicalRows } : {}),
  });
}

function collectR2Value(value: R2FundingValue, peTotals: R2PeTotalCell[]): void {
  if (value.rowKind === 'pe_total' && value.fiscalYear != null) {
    peTotals.push({
      peCode: value.peCode,
      fiscalYear: value.fiscalYear,
      columnRole: value.columnRole,
      printedTotal: value.originalValue,
      unit: value.originalUnit,
      page: value.page,
      ...(value.printedPage ? { printedPage: value.printedPage } : {}),
      rowIndex: value.rowIndex,
      columnIndex: value.columnIndex,
    });
  }
}

const R2A_MARKER_RE = /\bR-2A\b|RDT&E\s+Project\s+Justification/i;
const PE_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
const PROJECT_CODE_RE = /\bproject\s+code\s*[:.\-]?\s*(\S+(?:\s+\S+)*)/i;

function groupR2aPages(pages: RdteCycleDocumentInputV1['pages']): R2aProjectPageGroup[] {
  const groups: R2aProjectPageGroup[] = [];
  let currentKey: string | null = null;
  let currentParentPe = '';
  let currentProjectCode = '';
  let currentPages: RdteCycleDocumentInputV1['pages'][number][] = [];
  const flush = () => {
    if (!currentKey) return;
    groups.push({
      parentPeCode: currentParentPe,
      projectCode: currentProjectCode,
      pages: [...currentPages],
    });
    currentKey = null;
    currentPages = [];
  };
  for (const page of pages) {
    const texts = [page.text ?? '', ...page.blocks.map((block) => block.text)];
    if (!texts.some((text) => R2A_MARKER_RE.test(text))) continue;
    const parentPeCode = texts.map((text) => PE_RE.exec(text)?.[1]).find(Boolean) ?? '';
    const projectCode =
      texts.map((text) => PROJECT_CODE_RE.exec(text)?.[1]?.trim()).find(Boolean) ?? '';
    const key = `${parentPeCode}|${projectCode}`;
    if (key === currentKey) currentPages.push(page);
    else {
      flush();
      currentKey = key;
      currentParentPe = parentPeCode;
      currentProjectCode = projectCode;
      currentPages = [page];
    }
  }
  flush();
  return groups;
}
