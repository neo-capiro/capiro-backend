/** Phase 6 Workstream N — deterministic full-cycle certification. */
import { z } from 'zod';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import {
  phase6NativeProjectionV1Schema,
  phase6ProjectionContentHashV1,
  type Phase6NativeProjectionV1,
} from './phase6-native-projection-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});

export const phase6RequiredDocumentV1Schema = z
  .object({
    documentKey: nonBlank,
    required: z.boolean(),
    status: z.enum(['present', 'missing', 'blocked', 'not_applicable']),
    profileHash: sha256Schema.optional(),
    sourceProofStatus: z.enum(['PASS', 'NOT_RUN', 'BLOCKED']).optional(),
  })
  .strict();

export const phase6ComparisonSummaryV1Schema = z
  .object({
    code: nonBlank,
    outcome: z.enum(['PASS', 'FAIL', 'NOT_RUN', 'SKIPPED']),
    required: z.boolean(),
  })
  .strict();

export const phase6CycleCertificationInputV1Schema = z
  .object({
    schemaVersion: z.literal('phase6_cycle_certification_input_v1'),
    cycleId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    manifestHash: sha256Schema,
    documents: z.array(phase6RequiredDocumentV1Schema),
    projections: z.array(phase6NativeProjectionV1Schema),
    comparisons: z.array(phase6ComparisonSummaryV1Schema),
    lineFamilyCoverage: z.record(z.number().int().nonnegative()),
    bindingCounts: z
      .object({
        accepted: z.number().int().nonnegative(),
        candidate: z.number().int().nonnegative(),
        unresolved: z.number().int().nonnegative(),
        conflicting: z.number().int().nonnegative(),
      })
      .strict(),
    enactmentProofCoverage: z
      .object({
        direct: z.number().int().nonnegative(),
        incorporated: z.number().int().nonnegative(),
        unresolved: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
      })
      .strict(),
    reprogrammingCoverage: z.number().int().nonnegative(),
    executionCoverage: z.number().int().nonnegative(),
    parserStats: z
      .object({
        localPages: z.number().int().nonnegative(),
        paidPages: z.number().int().nonnegative(),
        cacheHits: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type Phase6CycleCertificationInputV1 = z.infer<typeof phase6CycleCertificationInputV1Schema>;

export interface Phase6CycleCertificationV1 {
  schemaVersion: 'phase6_cycle_certification_v1';
  cycleId: string;
  fiscalYear: number;
  manifestHash: string;
  /** Exact immutable set of projection CONTENT hashes certified by this record. */
  projectionSetSha256: string;
  projectionCount: number;
  status: 'CERTIFIED' | 'NEEDS_REVIEW' | 'INCOMPLETE' | 'REJECTED';
  reasons: string[];
  documentSummary: {
    required: number;
    present: number;
    missing: number;
    blocked: number;
  };
  projectionSummary: Record<string, number>;
  bindingCounts: Phase6CycleCertificationInputV1['bindingCounts'];
  lineFamilyCoverage: Record<string, number>;
  comparisonSummary: Record<'PASS' | 'FAIL' | 'NOT_RUN' | 'SKIPPED', number>;
  enactmentProofCoverage: Phase6CycleCertificationInputV1['enactmentProofCoverage'];
  reprogrammingCoverage: number;
  executionCoverage: number;
  parserStats: Phase6CycleCertificationInputV1['parserStats'];
  canonicalWrites: false;
  contentSha256: string;
}

/**
 * Hash the exact normalized projection contents, not their count or kinds.
 *
 * Before this binding existed, two different projection sets with the same
 * summary counts could produce the same certification hash. That made a later
 * Phase 7 plan unable to prove which rows the certification actually covered.
 */
export function phase6ProjectionSetSha256V1(
  projections: readonly Phase6NativeProjectionV1[],
): string {
  const hashes = projections
    .map((projection) => phase6ProjectionContentHashV1(projection))
    .sort((a, b) => a.localeCompare(b));
  return sha256CanonicalJson(hashes as JsonValue);
}

export function certifyPhase6CycleV1(value: unknown): Phase6CycleCertificationV1 {
  const input = phase6CycleCertificationInputV1Schema.parse(value);
  const reasons: string[] = [];
  const required = input.documents.filter((doc) => doc.required);
  const missing = required.filter((doc) => doc.status === 'missing');
  const blockedDocs = required.filter(
    (doc) => doc.status === 'blocked' || doc.sourceProofStatus === 'BLOCKED',
  );
  if (missing.length > 0)
    reasons.push(`missing required documents: ${missing.map((d) => d.documentKey).join(',')}`);
  if (blockedDocs.length > 0)
    reasons.push(`blocked required documents: ${blockedDocs.map((d) => d.documentKey).join(',')}`);

  const failedComparisons = input.comparisons.filter(
    (comparison) => comparison.required && comparison.outcome === 'FAIL',
  );
  const notRunComparisons = input.comparisons.filter(
    (comparison) => comparison.required && comparison.outcome === 'NOT_RUN',
  );
  if (failedComparisons.length > 0) reasons.push('required comparison failed');
  if (notRunComparisons.length > 0) reasons.push('required comparison not run');

  const blockedProjections = input.projections.filter(
    (projection) => projection.projectionStatus === 'blocked',
  );
  const reviewProjections = input.projections.filter(
    (projection) =>
      projection.projectionStatus === 'candidate' ||
      projection.bindingStatus === 'candidate' ||
      projection.bindingStatus === 'unresolved',
  );
  if (blockedProjections.length > 0) reasons.push('blocked projections exist');
  if (input.bindingCounts.conflicting > 0) reasons.push('conflicting native bindings exist');
  if (input.enactmentProofCoverage.blocked > 0) reasons.push('blocked enactment proof exists');

  const hasEnactedProjection = input.projections.some(
    (projection) =>
      projection.projectionKind === 'stage_position' && projection.fundingField === 'enacted',
  );
  if (
    hasEnactedProjection &&
    input.enactmentProofCoverage.direct + input.enactmentProofCoverage.incorporated === 0
  ) {
    reasons.push('enacted projection lacks proof coverage');
  }

  let status: Phase6CycleCertificationV1['status'] = 'CERTIFIED';
  if (
    blockedDocs.length > 0 ||
    failedComparisons.length > 0 ||
    blockedProjections.length > 0 ||
    input.bindingCounts.conflicting > 0 ||
    input.enactmentProofCoverage.blocked > 0
  ) {
    status = 'REJECTED';
  } else if (
    missing.length > 0 ||
    (hasEnactedProjection &&
      input.enactmentProofCoverage.direct + input.enactmentProofCoverage.incorporated === 0)
  ) {
    status = 'INCOMPLETE';
  } else if (
    notRunComparisons.length > 0 ||
    reviewProjections.length > 0 ||
    input.bindingCounts.candidate > 0 ||
    input.bindingCounts.unresolved > 0 ||
    input.enactmentProofCoverage.unresolved > 0
  ) {
    status = 'NEEDS_REVIEW';
  }

  const projectionSummary: Record<string, number> = {};
  for (const projection of input.projections) {
    projectionSummary[projection.projectionKind] =
      (projectionSummary[projection.projectionKind] ?? 0) + 1;
  }
  const comparisonSummary = { PASS: 0, FAIL: 0, NOT_RUN: 0, SKIPPED: 0 };
  for (const comparison of input.comparisons) comparisonSummary[comparison.outcome] += 1;
  const projectionSetSha256 = phase6ProjectionSetSha256V1(input.projections);
  const unsigned = {
    schemaVersion: 'phase6_cycle_certification_v1' as const,
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    manifestHash: input.manifestHash,
    projectionSetSha256,
    projectionCount: input.projections.length,
    status,
    reasons,
    documentSummary: {
      required: required.length,
      present: required.filter((doc) => doc.status === 'present').length,
      missing: missing.length,
      blocked: blockedDocs.length,
    },
    projectionSummary,
    bindingCounts: input.bindingCounts,
    lineFamilyCoverage: input.lineFamilyCoverage,
    comparisonSummary,
    enactmentProofCoverage: input.enactmentProofCoverage,
    reprogrammingCoverage: input.reprogrammingCoverage,
    executionCoverage: input.executionCoverage,
    parserStats: input.parserStats,
    canonicalWrites: false as const,
  };
  return {
    ...unsigned,
    contentSha256: sha256CanonicalJson(unsigned as unknown as JsonValue),
  };
}
