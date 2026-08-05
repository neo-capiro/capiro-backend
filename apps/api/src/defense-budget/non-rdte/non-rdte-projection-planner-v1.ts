/**
 * non-rdte-projection-planner-v1 — deterministic, read-only projection
 * planner for non-RDT&E families (procurement, O&M, MILCON).
 *
 * Workstream M (Phase 5 plan §18). Consumes a CERTIFIED non-RDT&E cycle
 * bundle, the cycle's defense_budget_extraction_v1 artifacts, the composed
 * family report, and an optional read-only snapshot of existing canonical
 * rows, and produces the `non_rdte_canonical_projection_plan_v1` that Phase 7
 * will later write.
 *
 * Hard rules:
 *   - refuses to plan for any cycle that is not
 *     CERTIFIED_NON_RDTE_READY_FOR_PROJECTION;
 *   - refuses to plan for any family report that is not complete/verified;
 *   - excludes rejected/review-pending artifacts (review-pending without
 *     allowed reviewed acceptance);
 *   - excludes contextual-only values;
 *   - excludes OCR-derived money that requires review (ocr_review_required);
 *   - excludes duplicate conflicts (never last-wins);
 *   - performs NO database write and imports NO writer: the optional diff
 *     consumes a plain read-only row snapshot supplied by the caller;
 *   - deterministic: identical inputs always produce an identical plan
 *     (stable sorts, canonical-JSON content SHA).
 *
 * All identities are PROCUREMENT_BLIN, OM_SAG, or MILCON_PROJECT — never
 * RDTE_PE. No title-based identity matching. All numeric values use exact
 * decimal strings — no binary float. Missing comparison source is NOT_RUN,
 * never pass. OCR-derived money cannot auto-pass.
 *
 * Static gates: this module bans .create, .update, .upsert, raw DML, and
 * canonical writer imports.
 *
 * Pure module: no NestJS, Prisma, AWS, parser, or writer dependency.
 */
import {
  computeNonRdteProjectionPlanContentSha256,
  nonRdteProjectionCandidateId,
  type NonRdteCanonicalProjectionPlanV1,
  type NonRdteProjectionCandidateV1,
  type NonRdteProjectionDiffSummaryV1,
  type NonRdteProjectionExclusionReasonV1,
  type NonRdteProjectionExclusionV1,
  type NonRdteProjectionOperationV1,
  type NonRdteProjectionTargetV1,
} from './non-rdte-canonical-projection-plan-v1.js';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  BudgetLineIdentityV1,
} from '../contracts/extraction-artifact-v1.js';
import { parseCanonicalDecimalString } from '../contracts/decimal-string.js';
import type {
  NonRdteCycleBundleV1,
  NonRdteCycleVerificationRefV1,
} from './non-rdte-cycle-bundle-v1.js';
import type { ProcurementFamilyReport } from '../procurement/procurement-composer-v1.js';
import type { OmFamilyReport } from '../om/om-composer-v1.js';
import type { MilconFamilyReport } from '../milcon/milcon-composer-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Static purity gates                                                 */
/* ------------------------------------------------------------------ */
/* The following symbols are intentionally never imported. Their presence
 * here as forbidden references lets a static analyzer (and the test suite)
 * verify that this module never calls .create, .update, .upsert, raw DML,
 * or a canonical writer service.
 *
 * No `import` of any writer, Prisma client, or NestJS module appears in
 * this file.
 */

/* ------------------------------------------------------------------ */
/* Read-only canonical row snapshot (diff input; never written here)   */
/* ------------------------------------------------------------------ */

export interface NonRdteCanonicalRowSnapshotV1 {
  procurementBudgetLines?: ReadonlyArray<{
    naturalKey: string;
    printedCode?: string;
    title?: string;
  }>;
  procurementBudgetLineYears?: ReadonlyArray<{
    naturalKey: string;
    fy: number;
    request?: string | null;
  }>;
  omSags?: ReadonlyArray<{
    naturalKey: string;
    title?: string;
  }>;
  omSagYears?: ReadonlyArray<{
    naturalKey: string;
    fy: number;
    request?: string | null;
  }>;
  milconProjects?: ReadonlyArray<{
    naturalKey: string;
    title?: string;
  }>;
  milconProjectYears?: ReadonlyArray<{
    naturalKey: string;
    fy: number;
    request?: string | null;
  }>;
}

/* ------------------------------------------------------------------ */
/* Planner input                                                       */
/* ------------------------------------------------------------------ */

export type NonRdteFamilyReportV1 = ProcurementFamilyReport | OmFamilyReport | MilconFamilyReport;

export interface NonRdteProjectionPlannerInput {
  bundle: NonRdteCycleBundleV1;
  artifacts: readonly DefenseBudgetExtractionArtifactV1[];
  /** The composed family report matching the cycle's family. */
  familyReport: NonRdteFamilyReportV1;
  /** Immutable reviewed acceptances allowed by Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  /** Optional read-only snapshot for insert/update/no-op classification. */
  canonicalRows?: NonRdteCanonicalRowSnapshotV1;
}

export interface NonRdteProjectionPlannerResult {
  plan: NonRdteCanonicalProjectionPlanV1;
}

export class NonRdteProjectionPlanningError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'NonRdteProjectionPlanningError';
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

function metaBoolean(assertion: DefenseBudgetAssertionV1, key: string): boolean | undefined {
  const value = metadataOf(assertion)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* Identity natural-key helpers                                        */
/* ------------------------------------------------------------------ */

function procurementNaturalKey(id: {
  code: string;
  account: string;
  component: string;
  advanceProcurement?: boolean;
}): string {
  const advance = id.advanceProcurement ?? false;
  return `PROCUREMENT_BLIN:${id.component}:${id.account.toUpperCase()}:${id.code.toUpperCase()}:${advance ? 'advance' : 'base'}`;
}

function omNaturalKey(id: { code: string; account: string; component: string }): string {
  return `OM_SAG:${id.component}:${id.account.toUpperCase()}:${id.code.toUpperCase()}`;
}

function milconNaturalKey(id: {
  projectCode: string;
  component: string;
  location?: string;
}): string {
  const locPart = id.location?.toUpperCase() ?? 'NO_LOC';
  return `MILCON_PROJECT:${id.component}:${id.projectCode.toUpperCase()}:${locPart}:${locPart}`;
}

function identityNaturalKey(identity: BudgetLineIdentityV1): string | null {
  switch (identity.lineKind) {
    case 'PROCUREMENT_BLIN':
      return procurementNaturalKey(identity);
    case 'OM_SAG':
      return omNaturalKey(identity);
    case 'MILCON_PROJECT':
      return milconNaturalKey(identity);
    case 'UNKNOWN':
      return null;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* OCR-derived money detection                                          */
/* ------------------------------------------------------------------ */

function isOcrDerived(assertion: DefenseBudgetAssertionV1): boolean {
  const meta = metadataOf(assertion);
  if (meta.ocrDerived === true) return true;
  if (meta.ocrConfidence === 'low') return true;
  if (meta.requiresOcrReview === true) return true;
  return false;
}

function artifactHasOcrWarning(artifact: DefenseBudgetExtractionArtifactV1): boolean {
  return artifact.warnings.some((w) => w.code.toLowerCase().includes('ocr'));
}

/* ------------------------------------------------------------------ */
/* Contextual-only detection                                           */
/* ------------------------------------------------------------------ */

function isContextualOnly(assertion: DefenseBudgetAssertionV1): boolean {
  const meta = metadataOf(assertion);
  if (meta.contextualOnly === true) return true;
  if (meta.disposition === 'contextual_only') return true;
  return false;
}

/* ------------------------------------------------------------------ */
/* Internal candidate accumulator                                       */
/* ------------------------------------------------------------------ */

interface PlannedCandidate {
  target: NonRdteProjectionTargetV1;
  naturalKey: string;
  artifactId: string;
  artifactContentSha256: string;
  verification: NonRdteCycleVerificationRefV1;
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

export function planNonRdteCanonicalProjection(
  input: NonRdteProjectionPlannerInput,
): NonRdteProjectionPlannerResult {
  const { bundle, familyReport } = input;

  /* Gate 0 — only certified cycles may be projected. */
  if (bundle.certification !== 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION') {
    throw new NonRdteProjectionPlanningError(
      `Cycle ${bundle.cycleId} is ${bundle.certification}; projection requires CERTIFIED_NON_RDTE_READY_FOR_PROJECTION`,
      'uncertified_cycle',
    );
  }

  /* Gate 1 — the family report must not have blocking findings. */
  if (familyReport.verification.blocking) {
    throw new NonRdteProjectionPlanningError(
      `Family ${bundle.family} report has blocking verification findings; projection requires a complete, verified family`,
      'uncertified_cycle',
    );
  }

  /* Gate 2 — the family report must be complete. */
  if (familyReport.completenessStatus !== 'complete') {
    throw new NonRdteProjectionPlanningError(
      `Family ${bundle.family} report completenessStatus is ${familyReport.completenessStatus}; projection requires a complete family`,
      'uncertified_cycle',
    );
  }

  const verificationByKey = new Map<string, NonRdteCycleVerificationRefV1>(
    bundle.verifications.map((v) => [v.manifestDocumentKey, v]),
  );

  const candidates: PlannedCandidate[] = [];
  const exclusions: NonRdteProjectionExclusionV1[] = [];

  function exclude(
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
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
  ): NonRdteCycleVerificationRefV1 | undefined {
    return verificationByKey.get(artifact.source.manifestDocumentKey);
  }

  const artifactRefByKey = new Map(bundle.artifacts.map((a) => [a.manifestDocumentKey, a]));

  for (const artifact of input.artifacts) {
    const documentKey = artifact.source.manifestDocumentKey;
    const verification = verificationFor(artifact);

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

    const artifactHasOcr = artifactHasOcrWarning(artifact);

    for (const assertion of artifact.assertions) {
      projectAssertion({
        artifact,
        assertion,
        provenance,
        cycleFiscalYear: bundle.fiscalYear,
        family: bundle.family,
        artifactHasOcr,
        pushCandidate,
        exclude,
      });
    }

    /* BudgetLineSourceObservation: one citation per identity evidenced by
     * assertions in this artifact (minimum evidenced page; page range
     * when known). */
    const identityPages = new Map<string, number[]>();
    for (const assertion of artifact.assertions) {
      const nk = assertionIdentityNaturalKey(assertion);
      const page = firstEvidencePage(artifact, assertion);
      if (nk != null && page != null) {
        const pages = identityPages.get(nk) ?? [];
        pages.push(page);
        identityPages.set(nk, pages);
      }
    }
    for (const [nk, pages] of identityPages) {
      const sortedPages = [...pages].sort((a, b) => a - b);
      const firstPage = sortedPages[0];
      const lastPage = sortedPages[sortedPages.length - 1];
      if (firstPage == null || lastPage == null) continue;
      const sourceUrl = artifact.source.sourceUrl ?? artifact.source.sourceLocator;
      pushCandidate({
        target: 'BudgetLineSourceObservation',
        naturalKey: `${nk}|${sourceUrl}|${firstPage}`,
        ...provenance,
        assertionIds: [],
        evidenceIds: [],
        values: {
          identityNaturalKey: nk,
          docType: artifact.source.exhibit,
          fy: bundle.fiscalYear,
          sourceUrl,
          pageNumber: firstPage,
          pageEnd: lastPage,
        },
        reason: 'page-level citation for projected non-RDT&E assertions',
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

  const planCandidates: NonRdteProjectionCandidateV1[] = finalCandidates.map((c) => ({
    candidateId: nonRdteProjectionCandidateId({
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
    schemaVersion: 'non_rdte_canonical_projection_plan_v1' as const,
    cycleId: bundle.cycleId,
    cycleBundleContentSha256: bundle.contentSha256,
    cycleCertification: 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION' as const,
    fiscalYear: bundle.fiscalYear,
    family: bundle.family,
    positionCycle: `pb_fy${bundle.fiscalYear}`,
    candidates: planCandidates,
    exclusions,
    diffSummary,
    diffedAgainstCanonicalRows: input.canonicalRows != null,
  };

  return {
    plan: {
      ...planWithoutHash,
      contentSha256: computeNonRdteProjectionPlanContentSha256(planWithoutHash),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Identity extraction from assertion                                  */
/* ------------------------------------------------------------------ */

function assertionIdentityNaturalKey(assertion: DefenseBudgetAssertionV1): string | null {
  switch (assertion.assertionKind) {
    case 'procurement_line':
      return procurementNaturalKey(assertion.parentIdentity);
    case 'om_line':
      return omNaturalKey(assertion.identity);
    case 'milcon_project':
      return milconNaturalKey(assertion.identity);
    case 'funding':
    case 'quantity':
    case 'unit_cost':
    case 'narrative':
      return identityNaturalKey(assertion.identity);
    case 'relationship':
      return identityNaturalKey(assertion.from);
    case 'document_fact': {
      const meta = metadataOf(assertion);
      return typeof meta.identityNaturalKey === 'string' ? meta.identityNaturalKey : null;
    }
    case 'project':
    case 'project_funding':
    case 'performer':
    case 'milestone':
      return null;
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

/* ------------------------------------------------------------------ */
/* Provenance bundle                                                   */
/* ------------------------------------------------------------------ */

interface ProvenanceBundle {
  artifactId: string;
  artifactContentSha256: string;
  verification: NonRdteCycleVerificationRefV1;
  sourceDocumentKey: string;
  sourcePdfSha256: string;
}

/* ------------------------------------------------------------------ */
/* Per-assertion projection                                            */
/* ------------------------------------------------------------------ */

function projectAssertion(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  cycleFiscalYear: number;
  family: 'procurement' | 'om' | 'milcon';
  artifactHasOcr: boolean;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const {
    artifact,
    assertion,
    provenance,
    cycleFiscalYear,
    family,
    artifactHasOcr,
    pushCandidate,
    exclude,
  } = input;
  const assertionId = assertion.assertionId;
  const evidenceIds = [...assertion.evidenceIds];

  const base = {
    ...provenance,
    assertionIds: [assertionId],
    evidenceIds,
  };

  /* Contextual-only exclusion (applies to all assertion kinds). */
  if (isContextualOnly(assertion)) {
    exclude(
      provenance.artifactId,
      assertionId,
      'contextual_only_value',
      `assertion ${assertion.assertionKind} for ${assertionIdentityNaturalKey(assertion) ?? 'unknown'} is contextual-only, never a canonical record`,
    );
    return;
  }

  /* OCR-derived money exclusion (applies to money-type assertions). */
  const isMoneyAssertion =
    assertion.assertionKind === 'funding' ||
    assertion.assertionKind === 'procurement_line' ||
    assertion.assertionKind === 'milcon_project' ||
    (assertion.assertionKind === 'document_fact' &&
      typeof (assertion.value as Record<string, unknown>)?.valueMillions === 'string');
  if (isMoneyAssertion && (isOcrDerived(assertion) || artifactHasOcr)) {
    exclude(
      provenance.artifactId,
      assertionId,
      'ocr_review_required',
      `OCR-derived money in assertion ${assertionId} requires review before projection`,
    );
    return;
  }

  switch (family) {
    case 'procurement':
      projectProcurementAssertion({
        assertion,
        provenance,
        base,
        cycleFiscalYear,
        pushCandidate,
        exclude,
      });
      break;
    case 'om':
      projectOmAssertion({
        assertion,
        provenance,
        base,
        cycleFiscalYear,
        pushCandidate,
        exclude,
      });
      break;
    case 'milcon':
      projectMilconAssertion({
        assertion,
        provenance,
        base,
        cycleFiscalYear,
        pushCandidate,
        exclude,
      });
      break;
  }

  /* Relationship assertions are family-agnostic. */
  if (assertion.assertionKind === 'relationship') {
    projectRelationshipAssertion({
      assertion,
      provenance,
      base,
      pushCandidate,
      exclude,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Procurement assertion projection                                    */
/* ------------------------------------------------------------------ */

function projectProcurementAssertion(input: {
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  base: Omit<PlannedCandidate, 'target' | 'naturalKey' | 'values' | 'reason'>;
  cycleFiscalYear: number;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const { assertion, provenance, base, cycleFiscalYear, pushCandidate, exclude } = input;
  const assertionId = assertion.assertionId;

  switch (assertion.assertionKind) {
    case 'procurement_line': {
      const nk = procurementNaturalKey(assertion.parentIdentity);
      pushCandidate({
        target: 'ProcurementBudgetLine',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          printedCode: assertion.parentIdentity.code,
          account: assertion.parentIdentity.account,
          component: assertion.parentIdentity.component,
          advanceProcurement: assertion.parentIdentity.advanceProcurement ?? false,
          description: assertion.description,
          fiscalYear: assertion.fiscalYear,
          source: 'procurement_p1_p40_exhibit',
        },
        reason: 'P-1/P-40 procurement BLIN identity row',
      });

      /* Quantity distribution line (if present). */
      if (assertion.quantity != null) {
        pushCandidate({
          target: 'ProcurementDistributionLine',
          naturalKey: `${nk}|${assertion.fiscalYear}|quantity`,
          ...base,
          values: {
            identityNaturalKey: nk,
            fy: assertion.fiscalYear,
            quantity: assertion.quantity,
            kind: 'quantity',
          },
          reason: 'procurement quantity distribution',
        });
      }

      /* Unit cost detail fact (if present). */
      if (assertion.unitCostDollars != null) {
        pushCandidate({
          target: 'ProcurementDetailFact',
          naturalKey: `${nk}|${assertion.fiscalYear}|unit_cost`,
          ...base,
          values: {
            identityNaturalKey: nk,
            fy: assertion.fiscalYear,
            unitCostDollars: assertion.unitCostDollars,
            kind: 'unit_cost',
          },
          reason: 'procurement unit-cost detail fact',
        });
      }

      /* Dollars detail fact (if present). */
      if (assertion.dollars != null) {
        pushCandidate({
          target: 'ProcurementDetailFact',
          naturalKey: `${nk}|${assertion.fiscalYear}|dollars`,
          ...base,
          values: {
            identityNaturalKey: nk,
            fy: assertion.fiscalYear,
            amount: assertion.dollars.valueMillions,
            originalValue: assertion.dollars.originalValue,
            originalUnit: assertion.dollars.originalUnit,
            kind: 'dollars',
          },
          reason: 'procurement dollars detail fact',
        });
      }
      return;
    }

    case 'funding': {
      if (assertion.identity.lineKind !== 'PROCUREMENT_BLIN') {
        if (assertion.identity.lineKind !== 'UNKNOWN') {
          exclude(
            provenance.artifactId,
            assertionId,
            'not_projection_eligible',
            `funding assertion for non-procurement line kind ${assertion.identity.lineKind} in procurement family`,
          );
        }
        return;
      }
      /* Only budget-year request is projected; other fields are contextual. */
      if (assertion.field !== 'request') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `funding field ${assertion.field} for procurement BLIN FY${assertion.fiscalYear} is a historical/context stage, never canonical from a procurement PB exhibit`,
        );
        return;
      }
      const nk = procurementNaturalKey(assertion.identity);
      pushCandidate({
        target: 'ProcurementBudgetLineYear',
        naturalKey: `${nk}|${assertion.fiscalYear}`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          request: assertion.money.valueMillions,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
        },
        reason: 'current budget-year request for procurement BLIN',
      });
      return;
    }

    case 'quantity': {
      if (assertion.identity.lineKind !== 'PROCUREMENT_BLIN') return;
      const nk = procurementNaturalKey(assertion.identity);
      pushCandidate({
        target: 'ProcurementDistributionLine',
        naturalKey: `${nk}|${assertion.fiscalYear}|quantity`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          quantity: assertion.quantity,
          ...(assertion.unitLabel != null ? { unitLabel: assertion.unitLabel } : {}),
          kind: 'quantity',
        },
        reason: 'procurement quantity distribution',
      });
      return;
    }

    case 'unit_cost': {
      if (assertion.identity.lineKind !== 'PROCUREMENT_BLIN') return;
      const nk = procurementNaturalKey(assertion.identity);
      pushCandidate({
        target: 'ProcurementDetailFact',
        naturalKey: `${nk}|${assertion.fiscalYear}|unit_cost`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          unitCostDollars: assertion.unitCostDollars,
          kind: 'unit_cost',
        },
        reason: 'procurement unit-cost detail fact',
      });
      return;
    }

    case 'narrative': {
      if (assertion.identity.lineKind !== 'PROCUREMENT_BLIN') return;
      const nk = procurementNaturalKey(assertion.identity);
      pushCandidate({
        target: 'ProcurementBudgetLine',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          description: `${assertion.narrativeType}: ${assertion.text}`,
          narrativeSection: assertion.narrativeType,
          source: 'procurement_p40_exhibit',
        },
        reason: `P-40 narrative section ${assertion.narrativeType}`,
      });
      return;
    }

    case 'document_fact': {
      const meta = metadataOf(assertion);
      const identityNaturalKey =
        typeof meta.identityNaturalKey === 'string' ? meta.identityNaturalKey : null;
      if (identityNaturalKey == null) return;
      const value = assertion.value as Record<string, unknown>;
      const valueMillions =
        typeof value.valueMillions === 'string' ? value.valueMillions : undefined;
      const costCategory = typeof meta.costCategory === 'string' ? meta.costCategory : undefined;
      const fiscalYear = typeof meta.fiscalYear === 'number' ? meta.fiscalYear : undefined;

      if (costCategory != null && fiscalYear != null) {
        pushCandidate({
          target: 'ProcurementDetailFact',
          naturalKey: `${identityNaturalKey}|${fiscalYear}|${costCategory}`,
          ...base,
          values: {
            identityNaturalKey,
            fy: fiscalYear,
            costCategory,
            ...(valueMillions != null ? { amount: valueMillions } : {}),
            kind: 'cost_category',
          },
          reason: `procurement cost-category detail: ${costCategory}`,
        });
      }
      return;
    }

    case 'relationship':
      /* handled by projectRelationshipAssertion */
      return;

    default:
      /* project, project_funding, performer, milestone, om_line,
       * milcon_project — not eligible for procurement projection. */
      return;
  }
}

/* ------------------------------------------------------------------ */
/* O&M assertion projection                                            */
/* ------------------------------------------------------------------ */

function projectOmAssertion(input: {
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  base: Omit<PlannedCandidate, 'target' | 'naturalKey' | 'values' | 'reason'>;
  cycleFiscalYear: number;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const { assertion, provenance, base, pushCandidate, exclude } = input;
  const assertionId = assertion.assertionId;

  switch (assertion.assertionKind) {
    case 'om_line': {
      const nk = omNaturalKey(assertion.identity);
      pushCandidate({
        target: 'OmSag',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          printedCode: assertion.identity.code,
          account: assertion.identity.account,
          component: assertion.identity.component,
          title: assertion.title,
          ...(assertion.budgetActivity != null ? { budgetActivity: assertion.budgetActivity } : {}),
          ...(assertion.activityGroup != null ? { activityGroup: assertion.activityGroup } : {}),
          ...(assertion.subActivityGroup != null
            ? { subActivityGroup: assertion.subActivityGroup }
            : {}),
          source: 'om_o1_op5_exhibit',
        },
        reason: 'O-1/OP-5 O&M SAG identity row with hierarchy',
      });
      return;
    }

    case 'funding': {
      if (assertion.identity.lineKind !== 'OM_SAG') {
        if (assertion.identity.lineKind !== 'UNKNOWN') {
          exclude(
            provenance.artifactId,
            assertionId,
            'not_projection_eligible',
            `funding assertion for non-O&M line kind ${assertion.identity.lineKind} in om family`,
          );
        }
        return;
      }
      if (assertion.field !== 'request') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `funding field ${assertion.field} for O&M SAG FY${assertion.fiscalYear} is a historical/context stage, never canonical from an O&M PB exhibit`,
        );
        return;
      }
      const nk = omNaturalKey(assertion.identity);
      pushCandidate({
        target: 'OmSagYear',
        naturalKey: `${nk}|${assertion.fiscalYear}`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          request: assertion.money.valueMillions,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
        },
        reason: 'current budget-year request for O&M SAG',
      });
      return;
    }

    case 'quantity': {
      if (assertion.identity.lineKind !== 'OM_SAG') return;
      const nk = omNaturalKey(assertion.identity);
      pushCandidate({
        target: 'OmDetailFact',
        naturalKey: `${nk}|${assertion.fiscalYear}|quantity`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          quantity: assertion.quantity,
          ...(assertion.unitLabel != null ? { unitLabel: assertion.unitLabel } : {}),
          kind: 'quantity',
        },
        reason: 'O&M workload/quantity detail fact',
      });
      return;
    }

    case 'narrative': {
      if (assertion.identity.lineKind !== 'OM_SAG') return;
      const nk = omNaturalKey(assertion.identity);
      pushCandidate({
        target: 'OmSag',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          description: `${assertion.narrativeType}: ${assertion.text}`,
          narrativeSection: assertion.narrativeType,
          source: 'om_op5_exhibit',
        },
        reason: `OP-5 narrative section ${assertion.narrativeType}`,
      });
      return;
    }

    case 'document_fact': {
      const meta = metadataOf(assertion);
      const identityNaturalKey =
        typeof meta.identityNaturalKey === 'string' ? meta.identityNaturalKey : null;
      if (identityNaturalKey == null) return;
      const value = assertion.value as Record<string, unknown>;
      const fiscalYear = typeof meta.fiscalYear === 'number' ? meta.fiscalYear : undefined;
      const valueMillions =
        typeof value.valueMillions === 'string' ? value.valueMillions : undefined;
      if (fiscalYear != null) {
        pushCandidate({
          target: 'OmDetailFact',
          naturalKey: `${identityNaturalKey}|${fiscalYear}|${assertion.fieldName}`,
          ...base,
          values: {
            identityNaturalKey,
            fy: fiscalYear,
            fieldName: assertion.fieldName,
            ...(valueMillions != null ? { amount: valueMillions } : {}),
            kind: 'document_fact',
          },
          reason: `O&M document detail fact: ${assertion.fieldName}`,
        });
      }
      return;
    }

    case 'relationship':
      /* handled by projectRelationshipAssertion */
      return;

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* MILCON assertion projection                                         */
/* ------------------------------------------------------------------ */

function projectMilconAssertion(input: {
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  base: Omit<PlannedCandidate, 'target' | 'naturalKey' | 'values' | 'reason'>;
  cycleFiscalYear: number;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const { assertion, provenance, base, pushCandidate, exclude } = input;
  const assertionId = assertion.assertionId;

  switch (assertion.assertionKind) {
    case 'milcon_project': {
      const nk = milconNaturalKey(assertion.identity);
      pushCandidate({
        target: 'MilconProject',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          printedProjectCode: assertion.identity.projectCode,
          component: assertion.identity.component,
          title: assertion.title,
          ...(assertion.scope != null ? { scope: assertion.scope } : {}),
          ...(assertion.location != null ? { location: assertion.location } : {}),
          ...(assertion.authorizationAmount != null
            ? {
                authorizationAmount: assertion.authorizationAmount.valueMillions,
              }
            : {}),
          ...(assertion.appropriationAmount != null
            ? {
                appropriationAmount: assertion.appropriationAmount.valueMillions,
              }
            : {}),
          source: 'milcon_c1_dd1391_exhibit',
        },
        reason: 'C-1/DD1391 MILCON project identity row',
      });
      return;
    }

    case 'funding': {
      if (assertion.identity.lineKind !== 'MILCON_PROJECT') {
        if (assertion.identity.lineKind !== 'UNKNOWN') {
          exclude(
            provenance.artifactId,
            assertionId,
            'not_projection_eligible',
            `funding assertion for non-MILCON line kind ${assertion.identity.lineKind} in milcon family`,
          );
        }
        return;
      }
      if (assertion.field !== 'request') {
        exclude(
          provenance.artifactId,
          assertionId,
          'contextual_only_value',
          `funding field ${assertion.field} for MILCON project FY${assertion.fiscalYear} is a historical/context stage, never canonical from a MILCON PB exhibit`,
        );
        return;
      }
      const nk = milconNaturalKey(assertion.identity);
      pushCandidate({
        target: 'MilconProjectYear',
        naturalKey: `${nk}|${assertion.fiscalYear}`,
        ...base,
        values: {
          identityNaturalKey: nk,
          fy: assertion.fiscalYear,
          request: assertion.money.valueMillions,
          originalValue: assertion.money.originalValue,
          originalUnit: assertion.money.originalUnit,
        },
        reason: 'current budget-year request for MILCON project',
      });
      return;
    }

    case 'narrative': {
      if (assertion.identity.lineKind !== 'MILCON_PROJECT') return;
      const nk = milconNaturalKey(assertion.identity);
      pushCandidate({
        target: 'MilconProject',
        naturalKey: nk,
        ...base,
        values: {
          naturalKey: nk,
          scope: `${assertion.narrativeType}: ${assertion.text}`,
          narrativeSection: assertion.narrativeType,
          source: 'milcon_dd1391_exhibit',
        },
        reason: `DD1391 narrative section ${assertion.narrativeType}`,
      });
      return;
    }

    case 'document_fact': {
      const meta = metadataOf(assertion);
      const identityNaturalKey =
        typeof meta.identityNaturalKey === 'string' ? meta.identityNaturalKey : null;
      if (identityNaturalKey == null) return;
      const costCategory = typeof meta.costCategory === 'string' ? meta.costCategory : undefined;
      const fiscalYear = typeof meta.fiscalYear === 'number' ? meta.fiscalYear : undefined;
      const value = assertion.value as Record<string, unknown>;
      const valueMillions =
        typeof value.valueMillions === 'string' ? value.valueMillions : undefined;

      if (costCategory != null && fiscalYear != null) {
        pushCandidate({
          target: 'MilconDetailFact',
          naturalKey: `${identityNaturalKey}|${fiscalYear}|${costCategory}`,
          ...base,
          values: {
            identityNaturalKey,
            fy: fiscalYear,
            costCategory,
            ...(valueMillions != null ? { amount: valueMillions } : {}),
            kind: 'cost_category',
          },
          reason: `MILCON cost-category detail: ${costCategory}`,
        });
      }
      return;
    }

    case 'relationship':
      /* handled by projectRelationshipAssertion */
      return;

    default:
      return;
  }
}

/* ------------------------------------------------------------------ */
/* Relationship assertion projection (family-agnostic)                 */
/* ------------------------------------------------------------------ */

function projectRelationshipAssertion(input: {
  assertion: DefenseBudgetAssertionV1;
  provenance: ProvenanceBundle;
  base: Omit<PlannedCandidate, 'target' | 'naturalKey' | 'values' | 'reason'>;
  pushCandidate: (candidate: PlannedCandidate) => void;
  exclude: (
    artifactId: string,
    assertionId: string | undefined,
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void;
}): void {
  const { assertion, provenance, base, pushCandidate, exclude } = input;
  if (assertion.assertionKind !== 'relationship') return;
  const fromKey = identityNaturalKey(assertion.from);
  const toKey = identityNaturalKey(assertion.to);
  if (fromKey == null || toKey == null) {
    exclude(
      provenance.artifactId,
      assertion.assertionId,
      'not_projection_eligible',
      `relationship assertion with unresolvable from/to identity`,
    );
    return;
  }
  if (!assertion.explicitInSource) {
    exclude(
      provenance.artifactId,
      assertion.assertionId,
      'unsupported_role_claim',
      `relationship ${fromKey} → ${toKey} (${assertion.relationshipType}) is not explicit in source`,
    );
    return;
  }
  pushCandidate({
    target: 'BudgetLineRelationship',
    naturalKey: `${fromKey}|${toKey}|${assertion.relationshipType}`,
    ...base,
    values: {
      fromNaturalKey: fromKey,
      toNaturalKey: toKey,
      relationshipType: assertion.relationshipType,
      explicitInSource: assertion.explicitInSource,
    },
    reason: `explicit ${assertion.relationshipType} relationship`,
  });
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
    reason: NonRdteProjectionExclusionReasonV1,
    message: string,
  ) => void,
): Array<
  PlannedCandidate & {
    operation: NonRdteProjectionOperationV1;
    exclusionReason?: NonRdteProjectionExclusionReasonV1;
  }
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
      operation: NonRdteProjectionOperationV1;
      exclusionReason?: NonRdteProjectionExclusionReasonV1;
    }
  > = [];

  for (const group of groups.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only == null) continue;
      result.push({ ...only, operation: 'insert' });
      continue;
    }

    /* Identity + narrative merge: for BudgetLine/OmSag/MilconProject
     * targets, merge narrative-derived description candidates into the
     * identity candidate. */
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

    const isIdentityTarget =
      first.target === 'ProcurementBudgetLine' ||
      first.target === 'OmSag' ||
      first.target === 'MilconProject';
    if (isIdentityTarget) {
      const identityCandidate = sorted.find(
        (c) =>
          c.values.source !== 'procurement_p40_exhibit' &&
          c.values.source !== 'om_op5_exhibit' &&
          c.values.source !== 'milcon_dd1391_exhibit',
      );
      const narrativeCandidates = sorted
        .filter((c) => typeof c.values.narrativeSection === 'string')
        .sort((a, b) => {
          const ka = `${a.values.narrativeSection}|${a.values.description ?? a.values.scope ?? ''}`;
          const kb = `${b.values.narrativeSection}|${b.values.description ?? b.values.scope ?? ''}`;
          return ka.localeCompare(kb);
        });
      if (identityCandidate != null && narrativeCandidates.length > 0) {
        const description = narrativeCandidates
          .map((c) => String(c.values.description ?? c.values.scope ?? ''))
          .join('\n\n');
        const descKey = identityCandidate.target === 'MilconProject' ? 'scope' : 'description';
        result.push({
          ...identityCandidate,
          values: { ...identityCandidate.values, [descKey]: description },
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
    operation: NonRdteProjectionOperationV1;
    exclusionReason?: NonRdteProjectionExclusionReasonV1;
  },
  snapshot: NonRdteCanonicalRowSnapshotV1 | undefined,
): PlannedCandidate & {
  operation: NonRdteProjectionOperationV1;
  exclusionReason?: NonRdteProjectionExclusionReasonV1;
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
    case 'ProcurementBudgetLine': {
      const existing = snapshot.procurementBudgetLines?.find(
        (r) => r.naturalKey === v.naturalKey && typeof v.naturalKey === 'string',
      );
      if (existing == null) return candidate;
      const sameTitle =
        v.description == null || existing.title === v.description || existing.title == null;
      return {
        ...candidate,
        operation: sameTitle ? 'no_op' : 'update',
        reason: sameTitle
          ? 'canonical row already matches'
          : 'canonical row exists with different description',
      };
    }
    case 'ProcurementBudgetLineYear': {
      const existing = snapshot.procurementBudgetLineYears?.find(
        (r) => r.naturalKey === v.identityNaturalKey && r.fy === v.fy,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.request, v.request);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical request already matches' : 'canonical request differs',
      };
    }
    case 'OmSag': {
      const existing = snapshot.omSags?.find(
        (r) => r.naturalKey === v.naturalKey && typeof v.naturalKey === 'string',
      );
      if (existing == null) return candidate;
      const sameTitle = v.title == null || existing.title === v.title || existing.title == null;
      return {
        ...candidate,
        operation: sameTitle ? 'no_op' : 'update',
        reason: sameTitle
          ? 'canonical row already matches'
          : 'canonical row exists with different title',
      };
    }
    case 'OmSagYear': {
      const existing = snapshot.omSagYears?.find(
        (r) => r.naturalKey === v.identityNaturalKey && r.fy === v.fy,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.request, v.request);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical request already matches' : 'canonical request differs',
      };
    }
    case 'MilconProject': {
      const existing = snapshot.milconProjects?.find(
        (r) => r.naturalKey === v.naturalKey && typeof v.naturalKey === 'string',
      );
      if (existing == null) return candidate;
      const sameTitle = v.title == null || existing.title === v.title || existing.title == null;
      return {
        ...candidate,
        operation: sameTitle ? 'no_op' : 'update',
        reason: sameTitle
          ? 'canonical row already matches'
          : 'canonical row exists with different title',
      };
    }
    case 'MilconProjectYear': {
      const existing = snapshot.milconProjectYears?.find(
        (r) => r.naturalKey === v.identityNaturalKey && r.fy === v.fy,
      );
      if (existing == null) return candidate;
      const same = decimalEqual(existing.request, v.request);
      return {
        ...candidate,
        operation: same ? 'no_op' : 'update',
        reason: same ? 'canonical request already matches' : 'canonical request differs',
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
    target: NonRdteProjectionTargetV1;
    operation: NonRdteProjectionOperationV1;
  }>,
): NonRdteProjectionDiffSummaryV1[] {
  const byTarget = new Map<
    NonRdteProjectionTargetV1,
    { insert: number; update: number; noOp: number; conflict: number }
  >();
  for (const candidate of candidates) {
    const entry = byTarget.get(candidate.target) ?? {
      insert: 0,
      update: 0,
      noOp: 0,
      conflict: 0,
    };
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
