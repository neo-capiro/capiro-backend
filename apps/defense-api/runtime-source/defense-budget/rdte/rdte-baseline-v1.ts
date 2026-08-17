/**
 * rdte-baseline-v1 — read-only baseline report of current FY coverage from
 * supplied artifacts or fixtures.
 *
 * Identifies the known Phase 4 starting gaps:
 *   - R-1 rows without FY columns;
 *   - R-2 PEs without funding;
 *   - R-2A projects without funding;
 *   - R-3 performers without explicit units/roles;
 *   - absent R-4 data;
 *   - current schema gaps for project positions and schedule periods.
 *
 * Pure module: no database write, no AWS, no parser calls.
 */
import { z } from 'zod';
import type { DefenseBudgetExtractionArtifactV1 } from '../contracts/extraction-artifact-v1.js';

export const RDTE_BASELINE_REPORT_SCHEMA_VERSION = 'rdte_baseline_report_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

export const rdteBaselineGapV1Schema = z
  .object({
    gapCode: nonBlank,
    severity: z.enum(['blocking', 'review', 'info']),
    message: z.string(),
    affectedKeys: z.array(nonBlank),
  })
  .strict();
export type RdteBaselineGapV1 = z.infer<typeof rdteBaselineGapV1Schema>;

export const rdteBaselineReportV1Schema = z
  .object({
    schemaVersion: z.literal(RDTE_BASELINE_REPORT_SCHEMA_VERSION),
    cycleId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    artifactCount: z.number().int().nonnegative(),
    gaps: z.array(rdteBaselineGapV1Schema),
    schemaGaps: z.array(nonBlank),
  })
  .strict();
export type RdteBaselineReportV1 = z.infer<typeof rdteBaselineReportV1Schema>;

/**
 * Compute the read-only baseline report over a set of extraction artifacts.
 * Artifacts may come from any exhibit family; the report inspects what is
 * present and what is missing relative to a complete RDT&E cycle.
 */
export function computeRdteBaselineReport(input: {
  cycleId: string;
  fiscalYear: number;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
}): RdteBaselineReportV1 {
  const gaps: RdteBaselineGapV1[] = [];
  const { artifacts } = input;

  const r1Artifacts = artifacts.filter((a) => a.source.exhibit === 'R-1');
  const r2Artifacts = artifacts.filter((a) => a.source.exhibit === 'R-2');
  const r2aArtifacts = artifacts.filter((a) => a.source.exhibit === 'R-2A');
  const r3Artifacts = artifacts.filter((a) => a.source.exhibit === 'R-3');
  const r4Artifacts = artifacts.filter(
    (a) => a.source.exhibit === 'R-4' || a.source.exhibit === 'R-4A',
  );

  /* R-1 rows without FY columns: identity assertions exist but no funding. */
  for (const artifact of r1Artifacts) {
    const peKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'program_element_identity')
        .map((a) => (a.assertionKind === 'program_element_identity' ? a.identity.peCode : ''))
        .filter((k) => k.length > 0),
    );
    const fundedPeKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'funding')
        .map((a) =>
          a.assertionKind === 'funding' && a.identity.lineKind === 'RDTE_PE'
            ? a.identity.peCode
            : '',
        )
        .filter((k) => k.length > 0),
    );
    const missing = [...peKeys].filter((k) => !fundedPeKeys.has(k)).sort();
    if (missing.length > 0) {
      gaps.push({
        gapCode: 'r1_rows_without_fy_columns',
        severity: 'blocking',
        message: `R-1 artifact ${artifact.artifactId} has ${missing.length} PE identities without any funding/FY column assertions`,
        affectedKeys: missing,
      });
    }
  }

  /* R-2 PEs without funding. */
  for (const artifact of r2Artifacts) {
    const peKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'program_element_identity')
        .map((a) => (a.assertionKind === 'program_element_identity' ? a.identity.peCode : ''))
        .filter((k) => k.length > 0),
    );
    const fundedPeKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'funding')
        .map((a) =>
          a.assertionKind === 'funding' && a.identity.lineKind === 'RDTE_PE'
            ? a.identity.peCode
            : '',
        )
        .filter((k) => k.length > 0),
    );
    const missing = [...peKeys].filter((k) => !fundedPeKeys.has(k)).sort();
    if (missing.length > 0) {
      gaps.push({
        gapCode: 'r2_pes_without_funding',
        severity: 'blocking',
        message: `R-2 artifact ${artifact.artifactId} has ${missing.length} PEs without funding assertions`,
        affectedKeys: missing,
      });
    }
  }

  /* R-2A projects without funding. */
  for (const artifact of r2aArtifacts) {
    const projectKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'project')
        .map((a) => (a.assertionKind === 'project' ? `${a.parentPeCode}/${a.projectCode}` : ''))
        .filter((k) => k.length > 0),
    );
    const fundedProjectKeys = new Set(
      artifact.assertions
        .filter((a) => a.assertionKind === 'project_funding')
        .map((a) =>
          a.assertionKind === 'project_funding' ? `${a.parentPeCode}/${a.projectCode}` : '',
        )
        .filter((k) => k.length > 0),
    );
    const missing = [...projectKeys].filter((k) => !fundedProjectKeys.has(k)).sort();
    if (missing.length > 0) {
      gaps.push({
        gapCode: 'r2a_projects_without_funding',
        severity: 'blocking',
        message: `R-2A artifact ${artifact.artifactId} has ${missing.length} projects without project_funding assertions`,
        affectedKeys: missing,
      });
    }
  }

  /* R-3 performers without explicit units/roles. */
  for (const artifact of r3Artifacts) {
    const missingRole = artifact.assertions
      .filter((a) => a.assertionKind === 'performer')
      .filter(
        (a) =>
          a.assertionKind === 'performer' && (a.performerRole === 'UNKNOWN' || a.totalCost == null),
      )
      .map((a) => (a.assertionKind === 'performer' ? a.performerName : ''))
      .filter((k) => k.length > 0)
      .sort();
    if (missingRole.length > 0) {
      gaps.push({
        gapCode: 'r3_performers_without_explicit_units_or_roles',
        severity: 'review',
        message: `R-3 artifact ${artifact.artifactId} has ${missingRole.length} performers with UNKNOWN role or missing total cost`,
        affectedKeys: missingRole,
      });
    }
  }

  /* Absent R-4 data. */
  if (r4Artifacts.length === 0) {
    gaps.push({
      gapCode: 'absent_r4_data',
      severity: 'info',
      message: 'No R-4/R-4A artifacts supplied; milestone coverage is absent',
      affectedKeys: [],
    });
  }

  /* Current schema gaps (static, from the Phase 4 plan). */
  const schemaGaps = [
    'ProgramElementProject has one project row per (peCode, projectCode) and no project-level multi-year budget-position table',
    'ProgramElementMilestone supports exact dates but does not fully represent fiscal-quarter/year schedule periods without fabricating dates',
  ];

  return {
    schemaVersion: RDTE_BASELINE_REPORT_SCHEMA_VERSION,
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    artifactCount: artifacts.length,
    gaps,
    schemaGaps,
  };
}
