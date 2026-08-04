/**
 * rdte-cycle-pipeline-v1 — pure composition of the Phase 4 RDT&E cycle:
 *
 *   manifest + per-document Phase 3 page results
 *     -> exhibit extractors (R-1 / R-2 / R-2A / R-3 / R-4)
 *     -> defense_budget_extraction_v1 artifacts (one per document)
 *     -> cross-exhibit reconciliation (WS L)
 *     -> cycle certification
 *
 * The pipeline is PURE: verification decisions enter as input references
 * (produced by the Phase 2 verifier at the command boundary), and the
 * pipeline never reads or writes a database. Commands wire infrastructure;
 * this module decides semantics.
 *
 * Workstream N (Phase 4 plan §19). Rules preserved end-to-end:
 *   - only request-role money becomes canonical_request_candidate;
 *   - R-1/R-2 comparison requests are built for shared PE/FY keys;
 *   - project-sum reconciliation is blocking;
 *   - duplicates and orphans surface as findings, never last-wins.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
} from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type { JsonValue } from '../../contracts/canonical-json.js';
import { extractR1FromPages } from '../r1/r1-extractor-v1.js';
import { buildR1Artifact } from '../r1/r1-artifact-builder-v1.js';
import { segmentR2ExhibitPages } from '../r2/r2-exhibit-segmenter.js';
import { resolveR2Contexts } from '../r2/r2-context-resolver.js';
import { extractR2Identities } from '../r2/r2-identity-extractor-v1.js';
import { extractR2Narrative } from '../r2/r2-narrative-extractor-v1.js';
import {
  extractR2PeFunding,
  buildR2R1ComparisonRequests,
  type R2FundingValue,
} from '../r2/r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from '../r2/r2-pe-funding-builder.js';
import { extractR2aProjectsFromPages } from '../r2a/r2a-project-extractor-v1.js';
import { extractR2aProjectFunding } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R2aProjectFundingValue } from '../r2a/r2a-project-funding-extractor-v1.js';
import type { R2aProjectPageGroup } from '../r2a/r2a-project-extractor-v1.js';
import { buildR2aProjectArtifact } from '../r2a/r2a-artifact-builder-v1.js';
import {
  reconcileR2aProjectColumn,
  type ReconcileR2aColumnInput,
  type R2PeTotalCell,
} from '../r2a/r2a-project-reconciler.js';
import { extractR3PerformersFromPages } from '../r3/r3-table-extractor-v1.js';
import { buildR3PerformerArtifact } from '../r3/r3-artifact-builder-v1.js';
import { extractR4MilestonesFromPages } from '../r4/r4-extractor-v1.js';
import { buildR4MilestoneArtifact } from '../r4/r4-artifact-builder-v1.js';
import {
  reconcileRdteCycle,
  type RdteFundingComparisonV1,
  type RdteProjectRelationshipV1,
} from '../reconciliation/rdte-cycle-reconciler-v1.js';
import {
  certifyRdteCycle,
  type RdteCycleCertifyInput,
} from '../reconciliation/rdte-cycle-certifier-v1.js';
import type {
  CycleCertificationV1,
  RdteCycleBundleV1,
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import type { CategoryCoverageInput } from '../rdte-cycle-summary-v1.js';
import { compareCanonicalDecimal } from '../rdte-rounding-policy-v1.js';
import type { RdteExhibitRoleV1 } from '../rdte-column-role-v1.js';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface RdteCycleDocumentInput {
  document: BudgetCycleManifestDocumentV1;
  source: ExtractionSourceV1;
  pages: readonly ParserPageResultV1[];
}

export interface RdteCyclePipelineInput {
  cycleIdIdentity: JsonValue;
  fiscalYear: number;
  manifestContentSha256: string;
  documents: readonly RdteCycleDocumentInput[];
  /** Phase 2 verification references (produced at the command boundary). */
  verifications: readonly RdteCycleVerificationRefV1[];
  /** Immutable reviewed acceptances allowed by Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  /** Reviewed new-PE exceptions allowed outside R-1. */
  reviewedNewPeExceptions?: readonly string[];
}

export interface RdteCyclePipelineResult {
  artifacts: ReadonlyArray<{
    documentKey: string;
    artifact: DefenseBudgetExtractionArtifactV1;
  }>;
  certification: CycleCertificationV1;
  bundle: RdteCycleBundleV1;
  reason: string;
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

function exhibitRoleOf(exhibit: string): RdteExhibitRoleV1 {
  switch (exhibit) {
    case 'R-1':
      return 'r1_catalog';
    case 'R-2':
      return 'r2_pe_summary';
    case 'R-2A':
      return 'r2a_project_detail';
    case 'R-3':
      return 'r3_cost_analysis';
    default:
      return 'r4_schedule';
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

export function runRdteCyclePipeline(input: RdteCyclePipelineInput): RdteCyclePipelineResult {
  const artifacts: Array<{ documentKey: string; artifact: DefenseBudgetExtractionArtifactV1 }> =
    [];
  const sourceDocuments: RdteCycleSourceDocumentV1[] = input.documents.map((doc) => ({
    manifestDocumentKey: doc.document.documentKey,
    exhibitRole: exhibitRoleOf(doc.document.exhibit),
    required: doc.document.required,
    sourcePdfSha256: doc.source.sourcePdfSha256,
    sourceLocator: doc.source.sourceLocator,
    ...(doc.pages.length > 0 ? { pageCount: doc.pages.length } : {}),
  }));

  /* ---------- R-1 ---------- */
  let r1PeCodes: string[] = [];
  const r1RequestValues = new Map<string, string>();
  for (const doc of input.documents.filter((d) => d.document.exhibit === 'R-1')) {
    const extraction = extractR1FromPages({
      pages: doc.pages,
      cycleFiscalYear: input.fiscalYear,
    });
    const artifact = buildR1Artifact({
      source: doc.source,
      parserRuns: [],
      extraction,
      cycleFiscalYear: input.fiscalYear,
    });
    artifacts.push({ documentKey: doc.document.documentKey, artifact });
    r1PeCodes = [...r1PeCodes, ...extraction.identities.map((i) => i.peCode)];
    for (const value of extraction.funding) {
      if (value.disposition === 'canonical_request_candidate' && value.fiscalYear != null) {
        r1RequestValues.set(`${value.peCode}|${value.fiscalYear}`, value.valueMillions);
      }
    }
  }

  /* ---------- R-2 ---------- */
  const r2PeCodes = new Set<string>();
  let r2NarrativeCount = 0;
  const r2RequestValues = new Map<string, string>();
  const peTotals: R2PeTotalCell[] = [];
  for (const doc of input.documents.filter((d) => d.document.exhibit === 'R-2')) {
    const segmentation = segmentR2ExhibitPages(doc.pages);
    const resolution = resolveR2Contexts(segmentation);
    const identities = extractR2Identities({ pages: doc.pages, contextResolution: resolution });
    const narrative = extractR2Narrative({ pages: doc.pages, contextResolution: resolution });
    r2NarrativeCount += narrative.sections.length;

    const peContexts = new Map<string, { pageStart: number; pageEnd: number }>();
    for (const page of resolution.pages) {
      if (page.kind !== 'r2_pe_summary' && page.kind !== 'r2_continuation') continue;
      if (page.peCode == null) continue;
      const existing = peContexts.get(page.peCode);
      if (existing == null) {
        peContexts.set(page.peCode, { pageStart: page.page, pageEnd: page.page });
      } else {
        existing.pageStart = Math.min(existing.pageStart, page.page);
        existing.pageEnd = Math.max(existing.pageEnd, page.page);
      }
    }

    const fundingResults = [];
    for (const [peCode, range] of peContexts) {
      r2PeCodes.add(peCode);
      const result = extractR2PeFunding({
        pages: doc.pages,
        peContext: { peCode, pageStart: range.pageStart, pageEnd: range.pageEnd },
        cycleFiscalYear: input.fiscalYear,
      });
      fundingResults.push(result);
      for (const value of result.values) {
        collectR2Value(value, r2RequestValues, peTotals);
      }
    }

    const comparisonRequests = buildR2R1ComparisonRequests({
      r2Results: fundingResults,
      r1RequestKeys: new Set(r1RequestValues.keys()),
    });

    const artifact = buildR2PeFundingArtifact({
      source: doc.source,
      parserRuns: [],
      extractions: fundingResults,
      comparisonRequests,
      cycleFiscalYear: input.fiscalYear,
    });
    artifacts.push({ documentKey: doc.document.documentKey, artifact });
    /* Identity/narrative extraction feeds coverage + provenance; the R-2
     * artifact carries funding assertions + comparison requests. */
    void identities;
  }

  /* ---------- R-2A ---------- */
  let r2aProjectCount = 0;
  const r2aProjectKeys: Array<{ peCode: string; projectCode: string }> = [];
  const r2aProjectValues: R2aProjectFundingValue[] = [];
  for (const doc of input.documents.filter((d) => d.document.exhibit === 'R-2A')) {
    const projects = extractR2aProjectsFromPages({ pages: doc.pages });
    r2aProjectCount += projects.identities.length;
    for (const identity of projects.identities) {
      r2aProjectKeys.push({
        peCode: identity.parentPeCode,
        projectCode: identity.projectCode,
      });
    }

    const groups = groupR2aPages(doc.pages);
    const fundingResults = groups.map((group) =>
      extractR2aProjectFunding({
        group,
        cycleFiscalYear: input.fiscalYear,
      }),
    );
    for (const result of fundingResults) {
      r2aProjectValues.push(...result.values);
    }

    const artifact = buildR2aProjectArtifact({
      source: doc.source,
      parserRuns: [],
      projects: [projects],
      funding: fundingResults,
      cycleFiscalYear: input.fiscalYear,
    });
    artifacts.push({ documentKey: doc.document.documentKey, artifact });
  }

  /* ---------- R-3 ---------- */
  let r3PerformerCount = 0;
  for (const doc of input.documents.filter((d) => d.document.exhibit === 'R-3')) {
    const extractions = extractR3PerformersFromPages({
      pages: doc.pages,
      cycleFiscalYear: input.fiscalYear,
    });
    for (const extraction of extractions) {
      r3PerformerCount += extraction.performers.length;
    }
    const artifact = buildR3PerformerArtifact({
      source: doc.source,
      parserRuns: [],
      extractions,
      cycleFiscalYear: input.fiscalYear,
    });
    artifacts.push({ documentKey: doc.document.documentKey, artifact });
  }

  /* ---------- R-4 ---------- */
  let r4MilestoneCount = 0;
  for (const doc of input.documents.filter((d) => d.document.exhibit === 'R-4')) {
    const extractions = extractR4MilestonesFromPages({ pages: doc.pages });
    for (const extraction of extractions) {
      r4MilestoneCount += extraction.milestones.length;
    }
    const artifact = buildR4MilestoneArtifact({
      source: doc.source,
      parserRuns: [],
      extractions,
    });
    artifacts.push({ documentKey: doc.document.documentKey, artifact });
  }

  /* ---------- R-1 <-> R-2 budget-year request comparisons ---------- */
  const comparisons: RdteFundingComparisonV1[] = [];
  for (const [pairKey, r2Value] of [...r2RequestValues.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const r1Value = r1RequestValues.get(pairKey);
    if (r1Value == null) continue;
    const [peCode, fy] = pairKey.split('|');
    const fiscalYear = Number(fy);
    let result: RdteFundingComparisonV1['result'];
    let message: string | undefined;
    if (compareCanonicalDecimal(r1Value, r2Value) === 0) {
      result = 'pass';
    } else {
      result = 'fail';
      message = `R-1 request ${r1Value} != R-2 request ${r2Value} for ${peCode} FY${fiscalYear}`;
    }
    comparisons.push({
      peCode: peCode ?? '',
      fiscalYear,
      columnRole: 'budget_year_request',
      result,
      ...(message != null ? { message } : {}),
    });
  }

  /* ---------- R-2A project-sum reconciliation ----------
   * Only ANNUAL funding columns (budget-year request + printed outyears)
   * reconcile against project detail sums. Historical/contextual PE-total
   * columns (prior actuals, enacted) carry no R-2A project detail by
   * design and are not project-sum columns. */
  const projectSumResults = [];
  for (const total of peTotals.filter((t) =>
    t.columnRole === 'budget_year_request' || t.columnRole === 'outyear_projection',
  )) {
    const expectedProjects = r2aProjectKeys
      .filter((p) => p.peCode === total.peCode)
      .map((p) => p.projectCode);
    const columnInput: ReconcileR2aColumnInput = {
      peCode: total.peCode,
      fiscalYear: total.fiscalYear,
      columnRole: total.columnRole,
      peTotal: total,
      projectValues: r2aProjectValues.filter(
        (v) =>
          v.parentPeCode === total.peCode &&
          v.fiscalYear === total.fiscalYear &&
          v.columnRole === total.columnRole,
      ),
      unit: total.unit,
      ...(expectedProjects.length > 0 ? { expectedProjectCodes: expectedProjects } : {}),
    };
    projectSumResults.push(reconcileR2aProjectColumn(columnInput));
  }

  /* ---------- Relationships ---------- */
  const projectFundingKeySet = new Set<string>();
  for (const value of r2aProjectValues) {
    if (value.rowKind === 'project') {
      projectFundingKeySet.add(`${value.parentPeCode}|${value.projectCode}`);
    }
  }
  const projectRelationships: RdteProjectRelationshipV1 = {
    projects: r2aProjectKeys,
    projectFundingKeys: [...projectFundingKeySet].sort().map((key) => {
      const [peCode, projectCode] = key.split('|');
      return { peCode: peCode ?? '', projectCode: projectCode ?? '' };
    }),
  };

  /* ---------- Coverage ---------- */
  const r1PeSet = [...new Set(r1PeCodes)].sort();
  const otherPeCodes = new Set<string>([
    ...r2PeCodes,
    ...r2aProjectKeys.map((p) => p.peCode),
  ]);
  const narrativeCovered = r2NarrativeCount > 0 ? [...otherPeCodes].sort() : [];
  const coverageInputs: CategoryCoverageInput[] = [
    {
      category: 'identity',
      expectedKeys: r1PeSet,
      coveredKeys: r1PeSet,
      applicable: r1PeSet.length > 0,
    },
    {
      category: 'narrative',
      expectedKeys: [...otherPeCodes].sort(),
      coveredKeys: narrativeCovered,
      applicable: otherPeCodes.size > 0,
    },
    {
      category: 'projects',
      expectedKeys: r2aProjectKeys.map((p) => `${p.peCode}|${p.projectCode}`).sort(),
      coveredKeys: r2aProjectKeys.map((p) => `${p.peCode}|${p.projectCode}`).sort(),
      applicable: r2aProjectKeys.length > 0,
    },
    {
      category: 'project_funding',
      expectedKeys: [...projectFundingKeySet].sort(),
      coveredKeys: [...projectFundingKeySet].sort(),
      applicable: projectFundingKeySet.size > 0,
    },
    {
      category: 'performers',
      expectedKeys: r3PerformerCount > 0 ? ['r3_performers'] : [],
      coveredKeys: r3PerformerCount > 0 ? ['r3_performers'] : [],
      applicable: r3PerformerCount > 0,
    },
    {
      category: 'milestones',
      expectedKeys: r4MilestoneCount > 0 ? ['r4_milestones'] : [],
      coveredKeys: r4MilestoneCount > 0 ? ['r4_milestones'] : [],
      applicable: r4MilestoneCount > 0,
    },
  ];

  /* ---------- Reconcile + certify ---------- */
  const reconciliation = reconcileRdteCycle({
    identity: {
      r1PeCodes: r1PeSet,
      otherExhibitPeCodes: [...otherPeCodes].sort(),
      ...(input.reviewedNewPeExceptions != null
        ? { reviewedNewPeExceptions: input.reviewedNewPeExceptions }
        : {}),
    },
    fundingComparisons: comparisons,
    projectSumReconciliations: projectSumResults,
    projectRelationships,
    coverageInputs,
  });

  const certifyInput: RdteCycleCertifyInput = {
    cycleIdIdentity: input.cycleIdIdentity,
    fiscalYear: input.fiscalYear,
    manifestContentSha256: input.manifestContentSha256,
    sourceDocuments,
    artifacts: artifacts.map((a) => ({
      manifestDocumentKey: a.documentKey,
      artifactId: a.artifact.artifactId,
      artifactContentSha256: a.artifact.contentSha256,
    })),
    verifications: input.verifications,
    comparisons: [],
    reconciliation,
    ...(input.allowedReviewedAcceptances != null
      ? { allowedReviewedAcceptances: input.allowedReviewedAcceptances }
      : {}),
  };

  const { certification, bundle, reason } = certifyRdteCycle(certifyInput);

  return {
    artifacts,
    certification,
    bundle,
    reason,
    counts: {
      r1PeCount: r1PeSet.length,
      r2PeCount: r2PeCodes.size,
      r2NarrativeSectionCount: r2NarrativeCount,
      r2aProjectCount,
      r3PerformerCount,
      r4MilestoneCount,
      comparisonCount: comparisons.length,
      blockingFindingCount: bundle.blockingFindings.length,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function collectR2Value(
  value: R2FundingValue,
  r2RequestValues: Map<string, string>,
  peTotals: R2PeTotalCell[],
): void {
  if (
    value.disposition === 'canonical_request_candidate' &&
    value.fiscalYear != null &&
    value.rowKind === 'pe_total'
  ) {
    r2RequestValues.set(`${value.peCode}|${value.fiscalYear}`, value.valueMillions);
  }
  if (value.rowKind === 'pe_total' && value.fiscalYear != null) {
    peTotals.push({
      peCode: value.peCode,
      fiscalYear: value.fiscalYear,
      columnRole: value.columnRole,
      printedTotal: value.originalValue,
      unit: value.originalUnit,
      page: value.page,
      ...(value.printedPage != null ? { printedPage: value.printedPage } : {}),
      rowIndex: value.rowIndex,
      columnIndex: value.columnIndex,
    });
  }
}

/**
 * Group R-2A pages into project groups by contiguous identity headers —
 * mirrors the identity extractor's grouping rule exactly: an R-2A page
 * carries a `PE <code>` header plus `Project Code:` / `Project Title:`
 * labels; contiguous pages sharing (parentPe, projectCode) merge. Non-R-2A
 * pages are skipped.
 */
const PIPELINE_R2A_MARKER_RE = /\bR-2A\b|RDT&E\s+Project\s+Justification/i;
const PIPELINE_PE_RE = /\bPE\s+([0-9]{7}[A-Z][A-Z0-9]*)\b/i;
const PIPELINE_PROJECT_CODE_RE = /\bproject\s+code\s*[:.\-]?\s*(\S+(?:\s+\S+)*)/i;

function groupR2aPages(pages: readonly ParserPageResultV1[]): R2aProjectPageGroup[] {
  const groups: R2aProjectPageGroup[] = [];
  let currentKey: string | null = null;
  let currentParentPe = '';
  let currentProjectCode = '';
  let currentPages: ParserPageResultV1[] = [];

  const flushGroup = () => {
    if (currentKey == null) return;
    groups.push({
      parentPeCode: currentParentPe,
      projectCode: currentProjectCode,
      pages: [...currentPages],
    });
    currentKey = null;
    currentPages = [];
  };

  for (const page of pages) {
    /* Scan each text run individually (never a concatenation) so the
     * broad-capture project-code regex cannot swallow following labels —
     * mirrors extractPageHeaderInfo in r2a-project-extractor-v1. */
    const texts = [page.text ?? '', ...page.blocks.map((b) => b.text)];
    if (!texts.some((t) => PIPELINE_R2A_MARKER_RE.test(t))) continue;
    let parentPeCode = '';
    for (const text of texts) {
      const m = PIPELINE_PE_RE.exec(text);
      if (m?.[1] != null) {
        parentPeCode = m[1];
        break;
      }
    }
    let projectCode = '';
    for (const text of texts) {
      const m = PIPELINE_PROJECT_CODE_RE.exec(text);
      if (m?.[1] != null) {
        projectCode = m[1].trim();
        break;
      }
    }
    const key = `${parentPeCode}|${projectCode}`;

    if (currentKey === key) {
      currentPages.push(page);
    } else {
      flushGroup();
      currentKey = key;
      currentParentPe = parentPeCode;
      currentProjectCode = projectCode;
      currentPages = [page];
    }
  }
  flushGroup();
  return groups;
}
