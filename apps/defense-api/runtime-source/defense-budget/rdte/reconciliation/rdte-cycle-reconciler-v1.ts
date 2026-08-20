/** Cross-exhibit reconciliation for one RDT&E cycle. */
import type { RdteCycleCoverageEntryV1 } from '../rdte-cycle-bundle-v1.js';
import {
  computeCoverageEntry,
  type CategoryCoverageInput,
  type RdteRequiredCategoryV1,
} from '../rdte-cycle-summary-v1.js';
import type { R2aColumnReconciliation } from '../r2a/r2a-project-reconciler.js';

export interface RdteIdentityCatalogV1 {
  r1PeCodes: readonly string[];
  otherExhibitPeCodes: readonly string[];
  reviewedNewPeExceptions?: readonly string[];
  titleAliases?: ReadonlyArray<{ peCode: string; titles: readonly string[] }>;
  titleConflicts?: ReadonlyArray<{ peCode: string; titles: readonly string[] }>;
}

export interface RdteFundingComparisonV1 {
  peCode: string;
  fiscalYear: number;
  columnRole: string;
  result: 'pass' | 'fail' | 'review' | 'not_applicable';
  message?: string;
  evidenceIds?: readonly string[];
}

export interface RdteProjectRelationshipV1 {
  projects: ReadonlyArray<{ peCode: string; projectCode: string }>;
  projectFundingKeys: ReadonlyArray<{ peCode: string; projectCode: string }>;
  referencedProjectKeys?: ReadonlyArray<{ peCode: string; projectCode: string }>;
}

export interface RdteCycleReconcileInput {
  identity: RdteIdentityCatalogV1;
  fundingComparisons: readonly RdteFundingComparisonV1[];
  projectSumReconciliations: readonly R2aColumnReconciliation[];
  projectRelationships: RdteProjectRelationshipV1;
  coverageInputs: readonly CategoryCoverageInput[];
  blockingOmissionPeCodes?: readonly string[];
  unresolvedPages?: readonly number[];
  duplicateNaturalKeys?: readonly string[];
}

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
  blocking: boolean;
}

function projectKey(peCode: string, projectCode: string): string {
  return `${peCode}|${projectCode}`;
}

export function reconcileRdteCycle(input: RdteCycleReconcileInput): RdteCycleReconciliationResult {
  const findings: RdteCycleFinding[] = [];
  let findingSeq = 0;
  const nextId = (code: string) => `find_${code}_${++findingSeq}`;
  const add = (
    severity: RdteCycleFinding['severity'],
    code: string,
    message: string,
    evidenceIds: readonly string[] = [],
  ) => {
    findings.push({
      findingId: nextId(code),
      severity,
      code,
      message,
      evidenceIds: [...new Set(evidenceIds)].sort(),
    });
  };

  const r1Set = new Set(input.identity.r1PeCodes);
  const exceptionSet = new Set(input.identity.reviewedNewPeExceptions ?? []);
  const orphanPeCodes = [
    ...new Set(
      input.identity.otherExhibitPeCodes.filter(
        (peCode) => !r1Set.has(peCode) && !exceptionSet.has(peCode),
      ),
    ),
  ].sort();
  const reviewedExceptions = [...exceptionSet].sort();
  const titleConflictPeCodes = [
    ...new Set((input.identity.titleConflicts ?? []).map((value) => value.peCode)),
  ].sort();

  for (const peCode of orphanPeCodes) {
    add(
      'blocking',
      'orphan_pe_outside_r1',
      `PE ${peCode} appears outside R-1 and has no reviewed exception`,
    );
  }
  for (const peCode of titleConflictPeCodes) {
    add('review', 'pe_title_conflict', `PE ${peCode} has conflicting titles across exhibits`);
  }
  for (const peCode of reviewedExceptions) {
    add('review', 'reviewed_new_pe_exception', `PE ${peCode} is a reviewed R-2-only exception`);
  }
  const identityComplete = orphanPeCodes.length === 0;

  const failedComparisons = input.fundingComparisons.filter((value) => value.result === 'fail');
  const reviewComparisons = input.fundingComparisons.filter((value) => value.result === 'review');
  for (const comparison of failedComparisons) {
    add(
      'blocking',
      'r1_r2_funding_mismatch',
      comparison.message ??
        `R-1/R-2 funding mismatch for ${comparison.peCode} FY${comparison.fiscalYear} ${comparison.columnRole}`,
      comparison.evidenceIds,
    );
  }
  for (const comparison of reviewComparisons) {
    add(
      'blocking',
      'r1_r2_funding_review',
      comparison.message ??
        `R-1/R-2 funding is unresolved for ${comparison.peCode} FY${comparison.fiscalYear} ${comparison.columnRole}`,
      comparison.evidenceIds,
    );
  }
  const fundingComplete = failedComparisons.length === 0 && reviewComparisons.length === 0;

  const blockingColumns = input.projectSumReconciliations.filter((value) => value.blocking);
  for (const value of blockingColumns) {
    add('blocking', 'r2a_project_sum_unreconciled', value.message);
  }
  const projectSumsComplete = blockingColumns.length === 0;

  const projectSet = new Set(
    input.projectRelationships.projects.map((value) => projectKey(value.peCode, value.projectCode)),
  );
  const projectsWithoutParent = input.projectRelationships.projects.filter(
    (value) => value.peCode.trim() === '',
  );
  const fundingWithoutProject = input.projectRelationships.projectFundingKeys.filter(
    (value) => !projectSet.has(projectKey(value.peCode, value.projectCode)),
  );
  const unresolvedReferences = (input.projectRelationships.referencedProjectKeys ?? []).filter(
    (value) => !projectSet.has(projectKey(value.peCode, value.projectCode)),
  );
  for (const value of projectsWithoutParent) {
    add('blocking', 'project_missing_parent_pe', `Project ${value.projectCode} has no parent PE`);
  }
  for (const value of fundingWithoutProject) {
    add(
      'blocking',
      'project_funding_without_project',
      `Project funding for ${value.peCode}/${value.projectCode} has no project assertion`,
    );
  }
  for (const value of unresolvedReferences) {
    add(
      'blocking',
      'unresolved_project_reference',
      `R-3/R-4 project reference ${value.peCode}/${value.projectCode} does not resolve`,
    );
  }
  const relationshipsComplete =
    projectsWithoutParent.length === 0 &&
    fundingWithoutProject.length === 0 &&
    unresolvedReferences.length === 0;

  const coverage = input.coverageInputs
    .map((value) => computeCoverageEntry(value))
    .sort((left, right) => left.category.localeCompare(right.category));
  for (const entry of coverage) {
    if (entry.status === 'missing' || entry.status === 'needs_review') {
      add(
        'blocking',
        entry.status === 'missing' ? 'category_coverage_missing' : 'category_coverage_partial',
        `Category ${entry.category} coverage is ${entry.numerator}/${entry.denominator}; missing ${entry.missingKeys.join(', ') || 'required ledger'}`,
      );
    }
  }

  for (const peCode of input.blockingOmissionPeCodes ?? []) {
    add('blocking', 'blocking_omission_remaining', `Blocking omission remains for PE ${peCode}`);
  }
  for (const page of [...new Set(input.unresolvedPages ?? [])].sort((a, b) => a - b)) {
    add('blocking', 'unresolved_source_page', `Required source page ${page} remains unresolved`);
  }
  for (const key of [...new Set(input.duplicateNaturalKeys ?? [])].sort()) {
    add('blocking', 'duplicate_natural_key', `Duplicate natural-key conflict: ${key}`);
  }

  findings.sort((left, right) => {
    const severity = left.severity.localeCompare(right.severity);
    if (severity !== 0) return severity;
    const code = left.code.localeCompare(right.code);
    if (code !== 0) return code;
    return left.message.localeCompare(right.message);
  });

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
    blocking: findings.some((finding) => finding.severity === 'blocking'),
  };
}

export function emptyCoverageInput(
  category: RdteRequiredCategoryV1,
  applicable = true,
): CategoryCoverageInput {
  return { category, expectedKeys: [], coveredKeys: [], applicable };
}
