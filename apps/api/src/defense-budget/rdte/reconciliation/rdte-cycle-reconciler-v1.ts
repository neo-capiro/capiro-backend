/**
 * rdte-cycle-reconciler-v1 — cross-exhibit reconciliation for one RDT&E cycle.
 *
 * Workstream L (Phase 4 plan §17). Combines identity, R-1↔R-2 funding,
 * R-2 PE total ↔ R-2A project sum, project relationships, and coverage into
 * one deterministic reconciliation result. Pure module.
 */
import type { RdteCycleCoverageEntryV1 } from '../rdte-cycle-bundle-v1.js';
import {
  computeCoverageEntry,
  type CategoryCoverageInput,
  type RdteRequiredCategoryV1,
} from '../rdte-cycle-summary-v1.js';
import type { R2aColumnReconciliation } from '../r2a/r2a-project-reconciler.js';

/* ------------------------------------------------------------------ */
/* Input types                                                         */
/* ------------------------------------------------------------------ */

export interface RdteIdentityCatalogV1 {
  /** PE codes from R-1 (primary catalog denominator). */
  r1PeCodes: readonly string[];
  /** PE codes appearing in R-2/R-2A/R-3/R-4. */
  otherExhibitPeCodes: readonly string[];
  /** Reviewed new-PE exceptions allowed outside R-1. */
  reviewedNewPeExceptions?: readonly string[];
  /** PE title aliases (same PE, different title) — not identity-key changes. */
  titleAliases?: ReadonlyArray<{ peCode: string; titles: readonly string[] }>;
  /** PE title conflicts that need review. */
  titleConflicts?: ReadonlyArray<{ peCode: string; titles: readonly string[] }>;
}

export interface RdteFundingComparisonV1 {
  peCode: string;
  fiscalYear: number;
  columnRole: string;
  result: 'pass' | 'fail' | 'review' | 'not_applicable';
  message?: string;
}

export interface RdteProjectRelationshipV1 {
  /** Every project must have a parent PE. */
  projects: ReadonlyArray<{ peCode: string; projectCode: string }>;
  /** Every project_funding assertion must have a project assertion. */
  projectFundingKeys: ReadonlyArray<{ peCode: string; projectCode: string }>;
  /** R-3/R-4 project references that must resolve. */
  referencedProjectKeys?: ReadonlyArray<{ peCode: string; projectCode: string }>;
}

export interface RdteCycleReconcileInput {
  identity: RdteIdentityCatalogV1;
  fundingComparisons: readonly RdteFundingComparisonV1[];
  projectSumReconciliations: readonly R2aColumnReconciliation[];
  projectRelationships: RdteProjectRelationshipV1;
  /** Category coverage inputs (identity/funding/narrative/...). */
  coverageInputs: readonly CategoryCoverageInput[];
  /** Optional: PE codes with blocking omissions remaining. */
  blockingOmissionPeCodes?: readonly string[];
  /** Optional: unresolved source pages. */
  unresolvedPages?: readonly number[];
  /** Optional: duplicate natural-key conflicts. */
  duplicateNaturalKeys?: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface RdteCycleFinding {
  findingId: string;
  severity: 'blocking' | 'review' | 'info';
  code: string;
  message: string;
  evidenceIds: string[];
}

export interface RdteCycleReconciliationResult {
  identity: {
    orphanPeCodes: string[];
    reviewedExceptions: string[];
    titleConflictPeCodes: string[];
    complete: boolean;
  };
  funding: {
    failedComparisons: RdteFundingComparisonV1[];
    reviewComparisons: RdteFundingComparisonV1[];
    complete: boolean;
  };
  projectSums: {
    blockingColumns: R2aColumnReconciliation[];
    complete: boolean;
  };
  relationships: {
    projectsWithoutParent: Array<{ peCode: string; projectCode: string }>;
    fundingWithoutProject: Array<{ peCode: string; projectCode: string }>;
    unresolvedReferences: Array<{ peCode: string; projectCode: string }>;
    complete: boolean;
  };
  coverage: RdteCycleCoverageEntryV1[];
  findings: RdteCycleFinding[];
  /** True when any blocking finding exists. */
  blocking: boolean;
}

/* ------------------------------------------------------------------ */
/* Reconciler                                                          */
/* ------------------------------------------------------------------ */

function projectKey(peCode: string, projectCode: string): string {
  return `${peCode}|${projectCode}`;
}

export function reconcileRdteCycle(input: RdteCycleReconcileInput): RdteCycleReconciliationResult {
  const findings: RdteCycleFinding[] = [];
  let findingSeq = 0;
  const nextId = (code: string) => `find_${code}_${++findingSeq}`;

  /* ---------- Identity ---------- */
  const r1Set = new Set(input.identity.r1PeCodes);
  const exceptionSet = new Set(input.identity.reviewedNewPeExceptions ?? []);
  const orphanPeCodes = [
    ...new Set(
      input.identity.otherExhibitPeCodes.filter((pe) => !r1Set.has(pe) && !exceptionSet.has(pe)),
    ),
  ].sort();
  const reviewedExceptions = [...exceptionSet].sort();
  const titleConflictPeCodes = [
    ...new Set((input.identity.titleConflicts ?? []).map((t) => t.peCode)),
  ].sort();

  for (const pe of orphanPeCodes) {
    findings.push({
      findingId: nextId('orphan_pe'),
      severity: 'blocking',
      code: 'orphan_pe_outside_r1',
      message: `PE ${pe} appears in R-2/R-2A/R-3/R-4 but not in R-1 catalog and has no reviewed exception`,
      evidenceIds: [],
    });
  }
  for (const pe of titleConflictPeCodes) {
    findings.push({
      findingId: nextId('title_conflict'),
      severity: 'review',
      code: 'pe_title_conflict',
      message: `PE ${pe} has conflicting titles across exhibits`,
      evidenceIds: [],
    });
  }
  for (const pe of reviewedExceptions) {
    findings.push({
      findingId: nextId('new_pe_exception'),
      severity: 'review',
      code: 'reviewed_new_pe_exception',
      message: `PE ${pe} is a reviewed R-2-only new PE exception`,
      evidenceIds: [],
    });
  }

  const identityComplete = orphanPeCodes.length === 0;

  /* ---------- R-1 ↔ R-2 funding ---------- */
  const failedComparisons = input.fundingComparisons.filter((c) => c.result === 'fail');
  const reviewComparisons = input.fundingComparisons.filter((c) => c.result === 'review');
  for (const c of failedComparisons) {
    findings.push({
      findingId: nextId('funding_mismatch'),
      severity: 'blocking',
      code: 'r1_r2_funding_mismatch',
      message:
        c.message ?? `R-1/R-2 funding mismatch for ${c.peCode} FY${c.fiscalYear} ${c.columnRole}`,
      evidenceIds: [],
    });
  }
  for (const c of reviewComparisons) {
    findings.push({
      findingId: nextId('funding_review'),
      severity: 'review',
      code: 'r1_r2_funding_review',
      message:
        c.message ??
        `R-1/R-2 funding needs review for ${c.peCode} FY${c.fiscalYear} ${c.columnRole}`,
      evidenceIds: [],
    });
  }
  const fundingComplete = failedComparisons.length === 0;

  /* ---------- R-2 PE total ↔ R-2A project sum ---------- */
  const blockingColumns = input.projectSumReconciliations.filter((c) => c.blocking);
  for (const c of blockingColumns) {
    findings.push({
      findingId: nextId('project_sum'),
      severity: 'blocking',
      code: 'r2a_project_sum_unreconciled',
      message: c.message,
      evidenceIds: [],
    });
  }
  const projectSumsComplete = blockingColumns.length === 0;

  /* ---------- Project relationships ---------- */
  const projectSet = new Set(
    input.projectRelationships.projects.map((p) => projectKey(p.peCode, p.projectCode)),
  );
  const projectsWithoutParent = input.projectRelationships.projects.filter(
    (p) => !p.peCode || p.peCode.trim() === '',
  );
  const fundingWithoutProject = input.projectRelationships.projectFundingKeys.filter(
    (p) => !projectSet.has(projectKey(p.peCode, p.projectCode)),
  );
  const unresolvedReferences = (input.projectRelationships.referencedProjectKeys ?? []).filter(
    (p) => !projectSet.has(projectKey(p.peCode, p.projectCode)),
  );

  for (const p of projectsWithoutParent) {
    findings.push({
      findingId: nextId('project_no_parent'),
      severity: 'blocking',
      code: 'project_missing_parent_pe',
      message: `Project ${p.projectCode} has no parent PE`,
      evidenceIds: [],
    });
  }
  for (const p of fundingWithoutProject) {
    findings.push({
      findingId: nextId('funding_no_project'),
      severity: 'blocking',
      code: 'project_funding_without_project',
      message: `Project funding for ${p.peCode}/${p.projectCode} has no project assertion`,
      evidenceIds: [],
    });
  }
  for (const p of unresolvedReferences) {
    findings.push({
      findingId: nextId('unresolved_ref'),
      severity: 'review',
      code: 'unresolved_project_reference',
      message: `R-3/R-4 project reference ${p.peCode}/${p.projectCode} does not resolve`,
      evidenceIds: [],
    });
  }
  const relationshipsComplete =
    projectsWithoutParent.length === 0 && fundingWithoutProject.length === 0;

  /* ---------- Coverage ---------- */
  const coverage = input.coverageInputs
    .map((c) => computeCoverageEntry(c))
    .sort((a, b) => a.category.localeCompare(b.category));

  for (const entry of coverage) {
    if (entry.status === 'missing' && entry.denominator > 0) {
      findings.push({
        findingId: nextId('coverage_missing'),
        severity: 'blocking',
        code: 'category_coverage_missing',
        message: `Category ${entry.category} coverage missing: ${entry.numerator}/${entry.denominator}`,
        evidenceIds: [],
      });
    } else if (entry.status === 'needs_review') {
      findings.push({
        findingId: nextId('coverage_partial'),
        severity: 'review',
        code: 'category_coverage_partial',
        message: `Category ${entry.category} coverage partial: ${entry.numerator}/${entry.denominator}; missing ${entry.missingKeys.join(', ')}`,
        evidenceIds: [],
      });
    }
  }

  /* ---------- Additional blockers ---------- */
  for (const pe of input.blockingOmissionPeCodes ?? []) {
    findings.push({
      findingId: nextId('blocking_omission'),
      severity: 'blocking',
      code: 'blocking_omission_remaining',
      message: `Blocking omission remains for PE ${pe}`,
      evidenceIds: [],
    });
  }
  for (const page of input.unresolvedPages ?? []) {
    findings.push({
      findingId: nextId('unresolved_page'),
      severity: 'blocking',
      code: 'unresolved_source_page',
      message: `Required source page ${page} remains unresolved`,
      evidenceIds: [],
    });
  }
  for (const key of input.duplicateNaturalKeys ?? []) {
    findings.push({
      findingId: nextId('duplicate_key'),
      severity: 'blocking',
      code: 'duplicate_natural_key',
      message: `Duplicate natural-key conflict: ${key}`,
      evidenceIds: [],
    });
  }

  /* Deterministic ordering of findings. */
  findings.sort((a, b) => {
    const sev = a.severity.localeCompare(b.severity);
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return a.message.localeCompare(b.message);
  });

  const blocking = findings.some((f) => f.severity === 'blocking');

  return {
    identity: {
      orphanPeCodes,
      reviewedExceptions,
      titleConflictPeCodes,
      complete: identityComplete,
    },
    funding: {
      failedComparisons,
      reviewComparisons,
      complete: fundingComplete,
    },
    projectSums: {
      blockingColumns,
      complete: projectSumsComplete,
    },
    relationships: {
      projectsWithoutParent,
      fundingWithoutProject,
      unresolvedReferences,
      complete: relationshipsComplete,
    },
    coverage,
    findings,
    blocking,
  };
}

/** Convenience: empty category coverage input for a required category. */
export function emptyCoverageInput(
  category: RdteRequiredCategoryV1,
  applicable = true,
): CategoryCoverageInput {
  return { category, expectedKeys: [], coveredKeys: [], applicable };
}
