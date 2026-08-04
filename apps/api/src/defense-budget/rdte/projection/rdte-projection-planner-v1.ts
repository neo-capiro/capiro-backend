/**
 * rdte-projection-planner-v1 — deterministic, read-only projection planner.
 *
 * Workstream M (Phase 4 plan §18). Consumes a CERTIFIED RDT&E cycle bundle,
 * the cycle's defense_budget_extraction_v1 artifacts, and an optional
 * read-only snapshot of existing canonical rows, and produces the
 * `rdte_canonical_projection_plan_v1` that Phase 7 will later write.
 *
 * Hard rules:
 *   - refuses to plan for any cycle that is not
 *     CERTIFIED_RDTE_READY_FOR_PROJECTION;
 *   - excludes rejected/review-pending artifacts, contextual-only values,
 *     cost-to-complete/total-cost values, outyear values from
 *     ProgramElementYear.request, duplicate conflicts, unsupported role
 *     claims, and unresolved evidence;
 *   - performs NO database write and imports NO writer: the optional diff
 *     consumes a plain read-only row snapshot supplied by the caller;
 *   - deterministic: identical inputs always produce an identical plan
 *     (stable sorts, canonical-JSON content SHA).
 *
 * Pure module: no NestJS, Prisma, AWS, parser, or writer dependency.
 */
import {
  computeProjectionPlanContentSha256,
  rdteProjectionCandidateId,
  type RdteCanonicalProjectionPlanV1,
  type RdteProjectionCandidateV1,
  type RdteProjectionDiffSummaryV1,
  type RdteProjectionExclusionReasonV1,
  type RdteProjectionExclusionV1,
  type RdteProjectionOperationV1,
  type RdteProjectionTargetV1,
} from './rdte-canonical-projection-plan-v1.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
} from '../../contracts/extraction-artifact-v1.js';
import { parseCanonicalDecimalString } from '../../contracts/decimal-string.js';
import type { RdteCycleBundleV1, RdteCycleVerificationRefV1 } from '../rdte-cycle-bundle-v1.js';
import type { JsonValue } from '../../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Read-only canonical row snapshot (diff input; never written here)   */
/* ------------------------------------------------------------------ */

export interface RdteCanonicalRowSnapshotV1 {
  programElements?: ReadonlyArray<{ peCode: string; title?: string }>;
  programElementYears?: ReadonlyArray<{ peCode: string; fy: number; request?: string | null }>;
  budgetPositions?: ReadonlyArray<{
    peCode: string;
    positionCycle: string;
    assertedFy: number;
    valueKind: string;
    amount: string;
  }>;
  projects?: ReadonlyArray<{ peCode: string; projectCode: string; title?: string }>;
  projectBudgetPositions?: ReadonlyArray<{
    peCode: string;
    projectCode: string;
    positionCycle: string;
    assertedFy: number;
    valueKind: string;
    amount: string;
  }>;
  performers?: ReadonlyArray<{
    peCode: string;
    performerNormalized: string;
    location: string;
    contractMethod: string;
    costCategory: string;
    fy: number;
    totalCostM?: string | null;
  }>;
  milestones?: ReadonlyArray<{
    peCode: string;
    milestoneType: string;
    plannedDate?: string | null;
    actualDate?: string | null;
  }>;
}

/* ------------------------------------------------------------------ */
/* Planner input                                                       */
/* ------------------------------------------------------------------ */

export interface RdteProjectionPlannerInput {
  bundle: RdteCycleBundleV1;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  /** Immutable reviewed acceptances allowed by Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  /** Optional read-only snapshot for insert/update/no-op classification. */
  canonicalRows?: RdteCanonicalRowSnapshotV1;
}

export interface RdteProjectionPlannerResult {
  plan: RdteCanonicalProjectionPlanV1;
}

export class ProjectionPlanningError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'ProjectionPlanningError';
  }
}

/* ------------------------------------------------------------------ */
/* Metadata access helpers                                             */
/* ------------------------------------------------------------------ */

type AssertionMetadata = Record<string, unknown>;

function metadataOf(assertion: DefenseBudgetAssertionV1): AssertionMetadata {
  return (assertion.metadata ?? {}) as AssertionMetadata;
}

function metaString(assertion: DefenseBudgetAssertionV1, key: string): string | undefined {
  const value = metadataOf(assertion)[key];
  return typeof value === 'string' ? value : undefined;
}

function metaNumber(assertion: DefenseBudgetAssertionV1, key: string): number | undefined {
  const value = metadataOf(assertion)[key];
  return typeof value === 'number' ? value : undefined;
}

function metaBoolean(assertion: DefenseBudgetAssertionV1, key: string): boolean | undefined {
  const value = metadataOf(assertion)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* Internal candidate accumulator                                       */
/* ------------------------------------------------------------------ */

interface PlannedCandidate {
  target: RdteProjectionTargetV1;
  naturalKey: string;
  artifactId: string;
  artifactContentSha256: string;
  verification: RdteCycleVerificationRefV1;
  sourceDocumentKey: string;
  sourcePdfSha256: string;
  assertionIds: string[];
  evidenceIds: string[];
  values: Record<string, string | number | boolean | null>;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

export function planRdteCanonicalProjection(
  input: RdteProjectionPlannerInput,
): RdteProjectionPlannerResult {
  const { bundle } = input;

  /* Gate 0 — only certified cycles may be projected. */
  if (bundle.certification !== 'CERTIFIED_RDTE_READY_FOR_PROJECTION') {
    throw new ProjectionPlanningError(
      `Cycle ${bundle.cycleId} is ${bundle.certification}; projection requires CERTIFIED_RDTE_READY_FOR_PROJECTION`,
      'uncertified_cycle',
    );
  }

  const verificationByKey = new Map<string, RdteCycleVerificationRefV1>(
    bundle.verifications.map((v) => [v.manifestDocumentKey, v]),
  );
  const sourceDocByKey = new Map(
    bundle.sourceDocuments.map((d) => [d.manifestDocumentKey, d]),
  );

  const candidates: PlannedCandidate[] = [];
  const exclusions: RdteProjectionExclusionV1[] = [];

  function exclude(
    artifactId: string,
    assertionId: string | undefined,
    reason: RdteProjectionExclusionReasonV1,
    message: string,
  ): void {
    exclusions.push({
      artifactId,
      ...(assertionId != null ? { assertionId } : {}),
      reason,
      message,
    });
  }

  function pushCandidate(candidate: PlannedCandidate): void {
    candidates.push(candidate);
  }

  function verificationFor(
    artifact: DefenseBudgetExtractionArtifactV1,
  ): RdteCycleVerificationRefV1 | undefined {
    return verificationByKey.get(artifact.source.manifestDocumentKey);
  }

  const artifactRefByKey = new Map(
    bundle.artifacts.map((a) => [a.manifestDocumentKey, a]),
  );

  for (const artifact of input.artifacts) {
    const documentKey = artifact.source.manifestDocumentKey;
    const verification = verificationFor(artifact);
    const sourceDoc = sourceDocByKey.get(documentKey);

    /* Gate 1a — the artifact must be the exact artifact the certified
     * bundle references (ID + content SHA binding). */
    const artifactRef = artifactRefByKey.get(documentKey);
    if (artifactRef == null) {
      exclude(
        artifact.artifactId,
        undefined,
        'unresolved_evidence',
        `Artifact ${artifact.artifactId} (${documentKey}) is not referenced by the certified cycle bundle`,
      );
      continue;
    }
    if (
      artifactRef.artifactId !== artifact.artifactId ||
      artifactRef.artifactContentSha256 !== artifact.contentSha256
    ) {
      exclude(
        artifact.artifactId,
        undefined,
        'unresolved_evidence',
        `Artifact ${artifact.artifactId} (${documentKey}) does not match the certified bundle reference ${artifactRef.artifactId}`,
      );
      continue;
    }

    /* Gate 1b — every projected artifact must carry a Phase 2 decision. */
    if (verification == null) {
      exclude(
        artifact.artifactId,
        undefined,
        'unresolved_evidence',
        `Artifact ${artifact.artifactId} (${documentKey}) has no Phase 2 verification reference`,
      );
      continue;
    }
    if (verification.decision === 'REJECTED') {
      exclude(
        artifact.artifactId,
        undefined,
        'artifact_rejected',
        `Artifact ${artifact.artifactId} (${documentKey}) is REJECTED`,
      );
      continue;
    }
    if (
      verification.decision === 'NEEDS_REVIEW' &&
      !input.allowedReviewedAcceptances?.has(verification.decisionId)
    ) {
      exclude(
        artifact.artifactId,
        undefined,
        'artifact_needs_review',
        `Artifact ${artifact.artifactId} (${documentKey}) is NEEDS_REVIEW without an allowed reviewed acceptance`,
      );
      continue;
    }

    const provenance = {
      artifactId: artifact.artifactId,
      artifactContentSha256: artifact.contentSha256,
      verification,
      sourceDocumentKey: documentKey,
      sourcePdfSha256: artifact.source.sourcePdfSha256,
    };

    for (const assertion of artifact.assertions) {
      projectAssertion({
        artifact,
        assertion,
        provenance,
        sourceUrl: artifact.source.sourceUrl ?? artifact.source.sourceLocator,
        cycleFiscalYear: bundle.fiscalYear,
        pushCandidate,
        exclude,
      });
    }

    /* ProgramElementSource linkage: one citation candidate per PE evidenced
     * by assertions in this artifact (minimum evidenced page; page range
     * when known). */
    const pePages = new Map<string, number[]>();
    for (const assertion of artifact.assertions) {
      const peCode = peCodeOfAssertion(assertion);
      const page = firstEvidencePage(artifact, assertion);
      if (peCode != null && page != null) {
        const pages = pePages.get(peCode) ?? [];
        pages.push(page);
        pePages.set(peCode, pages);
      }
    }
    const exhibitType = exhibitTypeOf(artifact);
    for (const [peCode, pages] of pePages) {
      const sortedPages = [...pages].sort((a, b) => a - b);
      const firstPage = sortedPages[0];
      const lastPage = sortedPages[sortedPages.length - 1];
      if (firstPage == null || lastPage == null) continue;
      /* Natural key mirrors the canonical unique constraint
       * (peCode, docType, sourceUrl, pageNumber). */
      const sourceUrl = artifact.source.sourceUrl ?? artifact.source.sourceLocator;
      pushCandidate({
        target: 'ProgramElementSource',
        naturalKey: `${peCode}|R|${sourceUrl}|${firstPage}`,
        ...provenance,
        assertionIds: [],
        evidenceIds: [],
        values: {
          peCode,
          docType: 'R',
          exhibitType,
          fy: bundle.fiscalYear,
          sourceUrl: artifact.source.sourceUrl ?? artifact.source.sourceLocator,
          pageNumber: firstPage,
          pageEnd: lastPage,
        },
        reason: 'page-level citation for projected RDT&E assertions',
      });
    }
  }

  /* Duplicate natural keys: never last-wins. Identical values merge;
   * distinct values all become conflicts. */
  const deduped = dedupeCandidates(candidates, exclude);

  /* Diff classification against the optional read-only snapshot. */
  const finalCandidates = deduped.map((c) => classifyOperation(c, input.canonicalRows));

  finalCandidates.sort((a, b) => {
    const t = a.target.localeCompare(b.target);
    if (t !== 0) return t;
    const k = a.naturalKey.localeCompare(b.naturalKey);
    if (k !== 0) return k;
    return a.artifactId.localeCompare(b.artifactId);
  });

  const planCandidates: RdteProjectionCandidateV1[] = finalCandidates.map((c) => ({
    candidateId: rdteProjectionCandidateId({
      target: c.target,
      naturalKey: c.naturalKey,
      artifactId: c.artifactId,
    }),
    target: c.target,
    naturalKey: c.naturalKey,
    operation: c.operation,
    reason: c.reason,
    artifactId: c.artifactId,
    artifactContentSha256: c.artifactContentSha256,
    verificationCandidateId: c.verification.verificationCandidateId,
    verificationRunId: c.verification.verificationRunId,
    verificationDecisionId: c.verification.decisionId,
    sourceDocumentKey: c.sourceDocumentKey,
    sourcePdfSha256: c.sourcePdfSha256,
    assertionIds: [...new Set(c.assertionIds)].sort(),
    evidenceIds: [...new Set(c.evidenceIds)].sort(),
    values: c.values,
    ...(c.exclusionReason != null ? { exclusionReason: c.exclusionReason } : {}),
  }));

  exclusions.sort((a, b) => {
    const art = a.artifactId.localeCompare(b.artifactId);
    if (art !== 0) return art;
    const r = a.reason.localeCompare(b.reason);
    if (r !== 0) return r;
    return a.message.localeCompare(b.message);
  });

  const diffSummary = summarizeDiff(finalCandidates);

  const planWithoutHash = {
    schemaVersion: 'rdte_canonical_projection_plan_v1' as const,
    cycleId: bundle.cycleId,
    cycleBundleContentSha256: bundle.contentSha256,
    cycleCertification: 'CERTIFIED_RDTE_READY_FOR_PROJECTION' as const,
    fiscalYear: bundle.fiscalYear,
    positionCycle: `pb_fy${bundle.fiscalYear}`,
    candidates: planCandidates,
    exclusions,
    diffSummary,
    diffedAgainstCanonicalRows: input.canonicalRows != null,
  };

  return {
    plan: {
      ...planWithoutHash,
      contentSha256: computeProjectionPlanContentSha256(planWithoutHash),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Per-assertion projection                                            */
/* ------------------------------------------------------------------ */

function peCodeOfAssertion(assertion: DefenseBudgetAssertionV1): string | null {
  switch (assertion.assertionKind) {
    case 'program_element_identity':
      return assertion.identity.peCode;
    case 'funding':
    case 'narrative':
      return assertion.identity.lineKind === 'RDTE_PE' ? assertion.identity.peCode : null;
    case 'project':
    case 'project_funding':
    case 'performer':
    case 'milestone':
      return assertion.parentPeCode;
    default:
      return null;
  }
}

function firstEvidencePage(
  artifact: DefenseBudgetExtractionArtifactV1,
  assertion: DefenseBudgetAssertionV1,
): number | null {
  const evidenceIds = new Set(assertion.evidenceIds);
  const pages = artifact.evidence
    .filter((e) => evidenceIds.has(e.evidenceId) && e.page != null)
    .map((e) => e.page as number)
    .sort((a, b) => a - b);
  return pages[0] ?? null;
}

function exhibitTypeOf(artifact: DefenseBudgetExtractionArtifactV1): string {
  /* The contract enum already carries the printed exhibit labels. */
  return artifact.source.exhibit;
}

interface ProvenanceBundle {
  artifactId: string;
  artifactContentSha256: string;
  verification: RdteCycleVerificationRefV1;
  sourceDocumentKey: string;
  sourcePdfSha256: string;
}

function projectAssertion(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  sourceUrl: string;
  cycleFiscalYear: number;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: RdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const { artifact, assertion, provenance, cycleFiscalYear, pushCandidate, exclude } = input;
  const assertionId = assertion.assertionId;
  const evidenceIds = [...assertion.evidenceIds];

  const base = {
    ...provenance,
    assertionIds: [assertionId],
    evidenceIds,
  };

  switch (assertion.assertionKind) {
    /* ---------------- Identity ---------------- */
    case 'program_element_identity': {
      /* R-1 owns PE identity (WS E doctrine): only the R-1 catalog artifact
       * projects ProgramElement rows. Other exhibits reference PEs but do
       * not create canonical identity. */
      if (artifact.source.exhibit !== 'R-1') return;
      pushCandidate({
        target: 'ProgramElement',
        naturalKey: assertion.identity.peCode,
        ...base,
        values: {
          peCode: assertion.identity.peCode,
          title: assertion.title,
          ...(assertion.serviceCode != null ? { serviceCode: assertion.serviceCode } : {}),
          ...(assertion.appropriationType != null
            ? { appropriationType: assertion.appropriationType }
            : {}),
          ...(assertion.budgetActivity != null
            ? { budgetActivity: assertion.budgetActivity }
            : {}),
          ...(assertion.budgetActivityName != null
            ? { budgetActivityName: assertion.budgetActivityName }
            : {}),
          ...(assertion.lineNumber != null ? { lineNumber: assertion.lineNumber } : {}),
          source: 'rdte_r1_exhibit',
        },
        reason: 'R-1 PE identity row',
      });
      return;
    }

    /* ---------------- Funding ---------------- */
    case 'funding': {
      if (assertion.identity.lineKind !== 'RDTE_PE') {
        exclude(
          provenance.artifactId,
          assertionId,
          'not_projection_eligible',
          `funding assertion for non-RDT&E line kind ${assertion.identity.lineKind}`,
        );
        return;
      }
      const peCode = assertion.identity.peCode;
      const columnRole = metaString(assertion, 'columnRole');

      /* Only the budget-year request disposition may become
       * ProgramElementYear.request. */
      if (assertion.field !== 'request') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `funding field ${assertion.field} for ${peCode} FY${assertion.fiscalYear} is a historical/context stage, never canonical from an RDT&E PB exhibit`,
        );
        return;
      }
      if (columnRole === 'outyear_projection' || assertion.fiscalYear !== cycleFiscalYear) {
        exclude(
          provenance.artifactId,
          assertionId,
          'outyear_not_request',
          `outyear value ${peCode} FY${assertion.fiscalYear} must not map to ProgramElementYear.request of cycle FY${cycleFiscalYear}`,
        );
        return;
      }
      const disposition = metaString(assertion, 'disposition');
      if (disposition != null && disposition !== 'canonical_request_candidate') {
        exclude(
          provenance.artifactId,
          assertionId,
          'not_projection_eligible',
          `funding assertion disposition ${disposition} is not canonical_request_candidate`,
        );
        return;
      }
      pushCandidate({
        target: 'ProgramElementYear',
        naturalKey: `${peCode}|${assertion.fiscalYear}`,
        ...base,
        values: {
          peCode,
          fy: assertion.fiscalYear,
          request: assertion.money.valueMillions,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
        },
        reason: 'current budget-year request (canonical_request_candidate)',
      });
      return;
    }

    /* ---------------- PE budget positions (document facts) ---------------- */
    case 'document_fact': {
      const value = assertion.value as Record<string, unknown>;
      const disposition = typeof value.disposition === 'string' ? value.disposition : undefined;
      const columnRole = typeof value.columnRole === 'string' ? value.columnRole : undefined;
      const peCode = typeof value.peCode === 'string' ? value.peCode : undefined;
      const fiscalYear = typeof value.fiscalYear === 'number' ? value.fiscalYear : undefined;
      const valueMillions =
        typeof value.valueMillions === 'string' ? value.valueMillions : undefined;
      const originalValue =
        typeof value.originalValue === 'string' ? value.originalValue : undefined;
      const originalUnit =
        typeof value.originalUnit === 'string' ? value.originalUnit : undefined;
      const positionCycle =
        typeof value.positionCycle === 'string'
          ? value.positionCycle
          : `pb_fy${cycleFiscalYear}`;
      const direct = value.direct !== false;

      /* Comparison-request facts and other non-value document facts are
       * Phase 2 reconciliation material, not canonical candidates. */
      if (
        assertion.fieldName === 'r1_r2_pe_funding_agreement_request' ||
        peCode == null ||
        valueMillions == null
      ) {
        return;
      }

      if (!direct) {
        exclude(
          provenance.artifactId,
          assertionId,
          'unresolved_evidence',
          `derived (non-direct) document_fact for ${peCode} is never projected`,
        );
        return;
      }

      if (disposition === 'contextual_only') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `${columnRole ?? 'contextual'} value for ${peCode}${
            fiscalYear != null ? ` FY${fiscalYear}` : ''
          } is historical context, never a canonical stage or position`,
        );
        return;
      }
      if (disposition === 'non_annual_cost') {
        exclude(
          provenance.artifactId,
          assertionId,
          'non_annual_cost_value',
          `${columnRole ?? 'non-annual'} value for ${peCode} is cost-to-complete/total-cost, never annual funding`,
        );
        return;
      }
      if (disposition === 'omitted') {
        return;
      }

      if (disposition === 'pe_budget_position' && fiscalYear != null) {
        const valueKind = columnRole === 'quantity' ? 'quantity' : 'total';
        pushCandidate({
          target: 'ProgramElementBudgetPosition',
          naturalKey: `${peCode}|${positionCycle}|${fiscalYear}|${valueKind}`,
          ...base,
          values: {
            peCode,
            positionCycle,
            assertedFy: fiscalYear,
            valueKind,
            amount: valueMillions,
            ...(originalValue != null ? { originalValue } : {}),
            ...(originalUnit != null ? { originalUnit } : {}),
          },
          reason: 'PE FYDP position tied to the printing PB cycle',
        });
        return;
      }

      if (disposition === 'project_budget_position' && fiscalYear != null) {
        const projectCode =
          typeof value.projectCode === 'string' ? value.projectCode : undefined;
        if (projectCode == null) {
          exclude(
            provenance.artifactId,
            assertionId,
            'not_projection_eligible',
            'project_budget_position document fact without a project code',
          );
          return;
        }
        pushCandidate({
          target: 'ProgramElementProjectBudgetPosition',
          naturalKey: `${peCode}|${projectCode}|${positionCycle}|${fiscalYear}|total`,
          ...base,
          values: {
            peCode,
            projectCode,
            positionCycle,
            assertedFy: fiscalYear,
            valueKind: 'total',
            amount: valueMillions,
            ...(originalValue != null ? { originalValue } : {}),
            ...(originalUnit != null ? { originalUnit } : {}),
          },
          reason: 'project FYDP position tied to the printing PB cycle',
        });
        return;
      }

      /* Any other disposition/shape: excluded, never silently dropped. */
      exclude(
        provenance.artifactId,
        assertionId,
        'not_projection_eligible',
        `document_fact ${assertion.fieldName} with disposition ${disposition ?? 'unknown'} has no canonical target`,
      );
      return;
    }

    /* ---------------- Project identity ---------------- */
    case 'project': {
      if (assertion.projectCode.length > 32) {
        exclude(
          provenance.artifactId,
          assertionId,
          'not_projection_eligible',
          `project code ${assertion.projectCode} exceeds the source-faithful VarChar(32) width; never truncated`,
        );
        return;
      }
      pushCandidate({
        target: 'ProgramElementProject',
        naturalKey: `${assertion.parentPeCode}|${assertion.projectCode}`,
        ...base,
        values: {
          peCode: assertion.parentPeCode,
          projectCode: assertion.projectCode,
          title: assertion.title,
          ...(assertion.mission != null ? { mission: assertion.mission } : {}),
          ...(assertion.budgetActivity != null
            ? { budgetActivity: assertion.budgetActivity }
            : {}),
        },
        reason: 'R-2A project identity child of its parent PE',
      });
      return;
    }

    /* ---------------- Project funding ---------------- */
    case 'project_funding': {
      const disposition = metaString(assertion, 'disposition');
      const positionCycle = metaString(assertion, 'positionCycle') ?? `pb_fy${cycleFiscalYear}`;
      const columnRole = metaString(assertion, 'columnRole');

      if (assertion.field !== 'request') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `project_funding field ${assertion.field} for ${assertion.parentPeCode}/${assertion.projectCode} FY${assertion.fiscalYear} is historical context, never a project position`,
        );
        return;
      }
      if (disposition === 'contextual_only' || disposition === 'non_annual_cost') {
        exclude(
          provenance.artifactId,
          assertionId,
          disposition === 'contextual_only'
            ? 'contextual_only_value'
            : 'non_annual_cost_value',
          `project_funding disposition ${disposition} for ${assertion.parentPeCode}/${assertion.projectCode} is not an annual position`,
        );
        return;
      }
      if (columnRole === 'outyear_projection') {
        /* Outyear project values remain positions of the printing cycle —
         * never the outyear cycle's independent request. */
      }
      pushCandidate({
        target: 'ProgramElementProjectBudgetPosition',
        naturalKey: `${assertion.parentPeCode}|${assertion.projectCode}|${positionCycle}|${assertion.fiscalYear}|total`,
        ...base,
        values: {
          peCode: assertion.parentPeCode,
          projectCode: assertion.projectCode,
          positionCycle,
          assertedFy: assertion.fiscalYear,
          valueKind: 'total',
          amount: assertion.money.valueMillions,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
        },
        reason: 'project budget position of the printing PB cycle',
      });
      return;
    }

    /* ---------------- Performer ---------------- */
    case 'performer': {
      if (assertion.performerRole === 'PRIME_CONTRACTOR') {
        const roleExplicit = metaBoolean(assertion, 'roleExplicit');
        if (roleExplicit !== true) {
          exclude(
            provenance.artifactId,
            assertionId,
            'unsupported_role_claim',
            `performer ${assertion.performerName} claims PRIME_CONTRACTOR without explicit source evidence`,
          );
          return;
        }
      }
      if (assertion.fiscalYear == null) {
        exclude(
          provenance.artifactId,
          assertionId,
          'not_projection_eligible',
          `performer ${assertion.performerName} has no fiscal-year context`,
        );
        return;
      }
      const page = firstEvidencePage(artifact, assertion) ?? 0;
      pushCandidate({
        target: 'ProgramElementPerformer',
        naturalKey: `${assertion.parentPeCode}|${assertion.performerNormalized ?? assertion.performerName}|${assertion.location ?? ''}|${assertion.contractMethod ?? ''}|${assertion.costCategory ?? ''}|${assertion.fiscalYear}`,
        ...base,
        values: {
          peCode: assertion.parentPeCode,
          performer: assertion.performerName,
          performerNormalized: assertion.performerNormalized ?? assertion.performerName,
          performerRole: assertion.performerRole,
          location: assertion.location ?? '',
          contractMethod: assertion.contractMethod ?? '',
          costCategory: assertion.costCategory ?? '',
          fy: assertion.fiscalYear,
          ...(assertion.totalCost != null
            ? { totalCostM: assertion.totalCost.valueMillions }
            : {}),
          sourceUrl: input.sourceUrl,
          pageNumber: page,
        },
        reason: 'R-3 performer/cost-analysis row (role-honest)',
      });
      return;
    }

    /* ---------------- Milestone ---------------- */
    case 'milestone': {
      pushCandidate({
        target: 'ProgramElementMilestone',
        naturalKey: `${assertion.parentPeCode}|${assertion.milestoneType}`,
        ...base,
        values: {
          peCode: assertion.parentPeCode,
          milestoneType: assertion.milestoneType,
          ...(assertion.plannedDate != null ? { plannedDate: assertion.plannedDate } : {}),
          ...(assertion.actualDate != null ? { actualDate: assertion.actualDate } : {}),
          ...(assertion.status != null ? { status: assertion.status } : {}),
          ...(assertion.notes != null ? { notes: assertion.notes } : {}),
          source: 'rdte_r4_exhibit',
        },
        reason: 'R-4 milestone with truthful schedule periods (no fabricated dates)',
      });

      /* Schedule-period child records preserve the raw period fidelity. */
      const plannedPeriod = metadataOf(assertion).plannedPeriod as
        | Record<string, unknown>
        | undefined;
      const actualPeriod = metadataOf(assertion).actualPeriod as
        | Record<string, unknown>
        | undefined;
      for (const [role, period] of [
        ['planned', plannedPeriod],
        ['actual', actualPeriod],
      ] as const) {
        if (period == null) continue;
        const rawText = typeof period.rawText === 'string' ? period.rawText : '';
        const kind = typeof period.kind === 'string' ? period.kind : 'unknown';
        pushCandidate({
          target: 'ProgramElementMilestoneSchedulePeriod',
          naturalKey: `${assertion.parentPeCode}|${assertion.milestoneType}|${role}|${rawText}`,
          ...base,
          values: {
            peCode: assertion.parentPeCode,
            milestoneType: assertion.milestoneType,
            periodRole: role,
            rawText,
            periodKind: kind,
            ...(typeof period.exactDate === 'string' ? { exactDate: period.exactDate } : {}),
            ...(typeof period.year === 'number' ? { calendarYear: period.year } : {}),
            ...(typeof period.month === 'number' ? { calendarMonth: period.month } : {}),
            ...(typeof period.calendarQuarter === 'number'
              ? { calendarQuarter: period.calendarQuarter }
              : {}),
            ...(typeof period.fiscalYear === 'number' ? { fiscalYear: period.fiscalYear } : {}),
            ...(typeof period.fiscalQuarter === 'number'
              ? { fiscalQuarter: period.fiscalQuarter }
              : {}),
          },
          reason: `R-4 ${role} schedule period preserved without date fabrication`,
        });
      }
      return;
    }

    /* ---------------- Narrative ---------------- */
    case 'narrative': {
      /* PE narrative maps to ProgramElement.description of the owning PE.
       * Only R-2 PE narrative is projected; project narrative rides on the
       * project assertion's mission field. Text is preserved exactly. */
      if (assertion.identity.lineKind !== 'RDTE_PE') return;
      const peCode = assertion.identity.peCode;
      pushCandidate({
        target: 'ProgramElement',
        naturalKey: peCode,
        ...base,
        values: {
          peCode,
          title: '',
          description: `${assertion.narrativeType}: ${assertion.text}`,
          narrativeSection: assertion.narrativeType,
          source: 'rdte_r2_exhibit',
        },
        reason: `R-2 narrative section ${assertion.narrativeType}`,
      });
      return;
    }

    default:
      /* quantity/relationship/procurement/om/milcon/unit_cost assertions are
       * out of Phase 4 RDT&E canonical scope; they remain in the artifact
       * for Phase 2 and are never silently projected. */
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Duplicate handling (never last-wins)                                */
/* ------------------------------------------------------------------ */

function valuesEqual(
  a: Record<string, string | number | boolean | null>,
  b: Record<string, string | number | boolean | null>,
): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.join('|') !== bKeys.join('|')) return false;
  return aKeys.every((k) => a[k] === b[k]);
}

function dedupeCandidates(
  candidates: PlannedCandidate[],
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: RdteProjectionExclusionReasonV1,
    message: string,
  ) => void,
): Array<
  PlannedCandidate & { operation: RdteProjectionOperationV1; exclusionReason?: RdteProjectionExclusionReasonV1 }
> {
  const groups = new Map<string, PlannedCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.target}|${candidate.naturalKey}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const result: Array<
    PlannedCandidate & {
      operation: RdteProjectionOperationV1;
      exclusionReason?: RdteProjectionExclusionReasonV1;
    }
  > = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only == null) continue;
      result.push({ ...only, operation: 'insert' });
      continue;
    }

    /* ProgramElement identity is R-1-owned; narrative-derived description
     * candidates for the same PE merge into the identity candidate. */
    const sorted = [...group].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
    const first = sorted[0];
    if (first == null) continue;

    const allEqual = sorted.every((c) => valuesEqual(c.values, first.values));
    if (allEqual) {
      result.push({
        ...first,
        assertionIds: sorted.flatMap((c) => c.assertionIds),
        evidenceIds: sorted.flatMap((c) => c.evidenceIds),
        operation: 'insert',
      });
      continue;
    }

    if (first.target === 'ProgramElement') {
      /* Identity candidate plus distinct narrative description candidates:
       * merge descriptions deterministically (kind order, then text). */
      const identityCandidate = sorted.find((c) => c.values.source === 'rdte_r1_exhibit');
      const narrativeCandidates = sorted
        .filter((c) => typeof c.values.narrativeSection === 'string')
        .sort((a, b) => {
          const ka = `${a.values.narrativeSection}|${a.values.description}`;
          const kb = `${b.values.narrativeSection}|${b.values.description}`;
          return ka.localeCompare(kb);
        });
      if (identityCandidate != null && narrativeCandidates.length > 0) {
        const description = narrativeCandidates
          .map((c) => String(c.values.description))
          .join('\n\n');
        result.push({
          ...identityCandidate,
          values: { ...identityCandidate.values, description },
          assertionIds: sorted.flatMap((c) => c.assertionIds),
          evidenceIds: sorted.flatMap((c) => c.evidenceIds),
          operation: 'insert',
        });
        continue;
      }
    }

    /* Genuine value conflict: every duplicate becomes a conflict record. */
    for (const candidate of sorted) {
      exclude(
        candidate.artifactId,
        candidate.assertionIds[0],
        'duplicate_conflict',
        `conflicting values for ${candidate.target} natural key ${candidate.naturalKey}; no last-wins resolution`,
      );
      result.push({
        ...candidate,
        operation: 'conflict',
        exclusionReason: 'duplicate_conflict',
      });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* Read-only diff classification                                       */
/* ------------------------------------------------------------------ */

function classifyOperation(
  candidate: PlannedCandidate & {
    operation: RdteProjectionOperationV1;
    exclusionReason?: RdteProjectionExclusionReasonV1;
  },
  snapshot: RdteCanonicalRowSnapshotV1 | undefined,
): PlannedCandidate & {
  operation: RdteProjectionOperationV1;
  exclusionReason?: RdteProjectionExclusionReasonV1;
} {
  if (snapshot == null || candidate.operation === 'conflict') return candidate;
  const v = candidate.values;

  function decimalEqual(a: unknown, b: unknown): boolean {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    try {
      return parseCanonicalDecimalString(String(a)) === parseCanonicalDecimalString(String(b));
    } catch {
      return String(a) === String(b);
    }
  }

  switch (candidate.target) {
    case 'ProgramElement': {
      const existing = snapshot.programElements?.find(
        (r) => r.peCode === v.peCode && typeof v.peCode === 'string',
      );
      if (existing == null) return candidate;
      const sameTitle =
        v.title === '' || v.title == null || existing.title === v.title;
      return {
        ...candidate,
        operation: sameTitle ? 'no_op' : 'update',
        reason: sameTitle
          ? 'canonical row already matches'
          : 'canonical row exists with different title',
      };
    }
    case 'ProgramElementYear': {
      const existing = snapshot.programElementYears?.find(
        (r) => r.peCode === v.peCode && r.fy === v.fy,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.request, v.request);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical request already matches' : 'canonical request differs',
      };
    }
    case 'ProgramElementBudgetPosition': {
      const existing = snapshot.budgetPositions?.find(
        (r) =>
          r.peCode === v.peCode &&
          r.positionCycle === v.positionCycle &&
          r.assertedFy === v.assertedFy &&
          r.valueKind === v.valueKind,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.amount, v.amount);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical position already matches' : 'canonical position differs',
      };
    }
    case 'ProgramElementProject': {
      const existing = snapshot.projects?.find(
        (r) => r.peCode === v.peCode && r.projectCode === v.projectCode,
      );
      if (existing == null) return candidate;
      const same = v.title == null || existing.title === v.title;
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical project already matches' : 'canonical project differs',
      };
    }
    case 'ProgramElementProjectBudgetPosition': {
      const existing = snapshot.projectBudgetPositions?.find(
        (r) =>
          r.peCode === v.peCode &&
          r.projectCode === v.projectCode &&
          r.positionCycle === v.positionCycle &&
          r.assertedFy === v.assertedFy &&
          r.valueKind === v.valueKind,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.amount, v.amount);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same
          ? 'canonical project position already matches'
          : 'canonical project position differs',
      };
    }
    case 'ProgramElementPerformer': {
      const existing = snapshot.performers?.find(
        (r) =>
          r.peCode === v.peCode &&
          r.performerNormalized === v.performerNormalized &&
          r.location === v.location &&
          r.contractMethod === v.contractMethod &&
          r.costCategory === v.costCategory &&
          r.fy === v.fy,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.totalCostM ?? null, v.totalCostM ?? null);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical performer already matches' : 'canonical performer differs',
      };
    }
    case 'ProgramElementMilestone': {
      const existing = snapshot.milestones?.find(
        (r) => r.peCode === v.peCode && r.milestoneType === v.milestoneType,
      );
      if (existing == null) return candidate;
      const same =
        (existing.plannedDate ?? null) === (v.plannedDate ?? null) &&
        (existing.actualDate ?? null) === (v.actualDate ?? null);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical milestone already matches' : 'canonical milestone differs',
      };
    }
    default:
      return candidate;
  }
}

/* ------------------------------------------------------------------ */
/* Diff summary                                                        */
/* ------------------------------------------------------------------ */

function summarizeDiff(
  candidates: ReadonlyArray<{
    target: RdteProjectionTargetV1;
    operation: RdteProjectionOperationV1;
  }>,
): RdteProjectionDiffSummaryV1[] {
  const byTarget = new Map<
    RdteProjectionTargetV1,
    { insert: number; update: number; noOp: number; conflict: number }
  >();
  for (const candidate of candidates) {
    const entry =
      byTarget.get(candidate.target) ?? { insert: 0, update: 0, noOp: 0, conflict: 0 };
    if (candidate.operation === 'insert') entry.insert += 1;
    else if (candidate.operation === 'update') entry.update += 1;
    else if (candidate.operation === 'no_op') entry.noOp += 1;
    else entry.conflict += 1;
    byTarget.set(candidate.target, entry);
  }
  return [...byTarget.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([target, counts]) => ({
      target,
      insertCount: counts.insert,
      updateCount: counts.update,
      noOpCount: counts.noOp,
      conflictCount: counts.conflict,
    }));
}

/* Re-export for command-layer convenience. */
export type { JsonValue };
