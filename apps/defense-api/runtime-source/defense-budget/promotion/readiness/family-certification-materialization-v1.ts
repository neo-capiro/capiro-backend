/**
 * Phase 10B-2D — Certification Materialization.
 *
 * Closes the remaining transition Phase 10B-2C did NOT close:
 *
 *   durable corpus reaches ready_for_reconciliation
 *     -> invoke/reuse the EXISTING correct family pipeline
 *     -> persist its NORMAL existing artifact
 *     -> reload that persisted artifact
 *     -> Phase 10B-2C's shared certification interpretation reads it
 *     -> deterministic promotion planning -> awaiting_authorization
 *
 * This module does not create a new certification system. It is the smallest
 * legitimate orchestration boundary that, for a family whose durable corpus
 * is genuinely reconstructable, calls the EXISTING Phase 4/5 pipeline
 * (`runNonRdteCyclePipeline`) with inputs assembled purely from durable rows,
 * then persists the plan through the EXISTING substrate
 * (`buildProjectionPlanRecordV1` / `PrismaProjectionPlanRepositoryV1`), then
 * reloads it (never trusts the in-memory return value for the proof binding).
 *
 * ---------------------------------------------------------------------------
 * Family routing (Phase A audit conclusion, see PR body for the full trace)
 * ---------------------------------------------------------------------------
 *
 * procurement / om / milcon:
 *   RECONSTRUCTABLE. `runNonRdteCyclePipeline` (existing, non-RDT&E) takes
 *   only `{document, artifact}[]` plus a family report already built from
 *   those exact artifacts by the existing composer
 *   (`composeProcurementFamily` / `composeOmFamily` / `composeMilconFamily`).
 *   Every artifact is durably locatable via
 *   `BudgetExtractionCandidateV1.extractionArtifactLocator` +
 *   `.extractionArtifactSha256`, gated on `BudgetVerificationRunV1.decision`
 *   (only PASS/REVIEW_ACCEPTED candidates are used — REJECT is never
 *   materialized). This adapter wires exactly that: durable candidate lookup
 *   -> durable artifact bytes reload+verify -> composer -> existing pipeline
 *   -> existing persistence substrate.
 *
 * committee:
 *   Reuses the EXISTING #1298 read path unchanged
 *   (`PrismaFamilyReconciliationCertificationV1.readCommitteeCertification`):
 *   Phase 6's own producer (`persist-phase6-audit-projections-v1.ts`) is a
 *   SEPARATE, already-existing write path outside readiness's control. This
 *   module does not re-invoke it — doing so would require reconstructing the
 *   full annual `Phase6CycleCertificationInputV1` (coverage counts, binding
 *   counts, comparison summaries) from durable rows, which Phase 6's own
 *   audit-projection persistence never stores as a re-callable whole. That is
 *   a genuine "missing durable input" case, reported, not solved here (see
 *   `MISSING_DURABLE_INPUT_NOTES` below) — readiness continues to treat an
 *   ALREADY-CERTIFIED committee cycle (one whose Phase 6 producer already ran)
 *   as materialized, which is what #1298 already delivers.
 *
 * rdte:
 *   RECONSTRUCTABLE. RDT&E uses the same family-agnostic durable candidate
 *   and verification-run substrate. The split extraction/verification tools
 *   persist ordinary extraction artifacts, and the RDT&E materializer reloads
 *   their accepted bytes. R-2/R-2A reconciliation inputs are reconstructed
 *   from the accepted assertions and evidence before the existing certifier
 *   and projection planner run.
 *
 * Unsupported tracks (`alternative_funding`, `execution`) never reach this
 * module: `evaluateCycleFamilyReadinessV1` already reports
 * `certification_not_supported` for them before readiness advances.
 */
import {
  buildProjectionPlanRecordV1,
  type DefenseBudgetProjectionPlanRecordV1,
} from '../../projection-plan/projection-plan-record-v1.js';
import type { ProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import {
  runNonRdteCyclePipeline,
  type NonRdteCycleDocumentInput,
} from '../../non-rdte/non-rdte-cycle-pipeline-v1.js';
import { planNonRdteCanonicalProjection } from '../../non-rdte/non-rdte-projection-planner-v1.js';
import {
  composeOmFamily,
  type OmExhibitArtifacts,
} from '../../om/om-composer-v1.js';
import {
  composeProcurementFamily,
  type ProcurementExhibitArtifacts,
} from '../../procurement/procurement-composer-v1.js';
import {
  composeMilconFamily,
  type MilconExhibitArtifacts,
} from '../../milcon/milcon-composer-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type { BudgetCycleManifestDocumentV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import type { NonRdteCycleVerificationRefV1 } from '../../non-rdte/non-rdte-cycle-bundle-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';

/** Families this module can actually materialize a certification for. */
export const MATERIALIZABLE_NON_RDTE_FAMILIES = ['procurement', 'om', 'milcon'] as const;
export type MaterializableNonRdteFamilyV1 = (typeof MATERIALIZABLE_NON_RDTE_FAMILIES)[number];

export function isMaterializableNonRdteFamily(
  family: string,
): family is MaterializableNonRdteFamilyV1 {
  return (MATERIALIZABLE_NON_RDTE_FAMILIES as readonly string[]).includes(family);
}

/**
 * Documented, testable list of families this PR could NOT wire a real
 * materialization boundary for, and exactly why — the brief requires this be
 * reported, never silently reconstructed.
 */
export const MISSING_DURABLE_INPUT_NOTES: Readonly<Record<string, string>> = Object.freeze({
  committee:
    'certifyPhase6CycleV1 requires a full Phase6CycleCertificationInputV1 ' +
    '(document presence, native projections, comparison summaries, binding ' +
    'counts, enactment-proof coverage, parser stats) assembled from an entire ' +
    'annual corpus. Phase 6\u2019s own audit-projection persistence ' +
    '(phase6_audit_projection / phase6_cycle_certification) stores the OUTPUT ' +
    'of that assembly, never the assembled INPUT itself, so there is no durable ' +
    'row this module could reload to reinvoke the pipeline. Readiness instead ' +
    'continues to rely on Phase 6\u2019s existing, separately-triggered producer ' +
    '(persist-phase6-audit-projections-v1.ts) having already run -- exactly ' +
    'the #1298 read path, unchanged by this PR.',
});

export interface MaterializationCandidateArtifactRefV1 {
  readonly manifestDocumentKey: string;
  readonly extractionArtifactId: string;
  readonly extractionArtifactSha256: string;
  readonly extractionArtifactLocator: string;
  readonly sourceDocumentId: string;
  readonly sourceSha256: string;
  readonly candidateId: string;
  readonly verificationRunId: string;
  readonly decision: 'PASS' | 'REVIEW' | 'REJECT';
  readonly status: 'VERIFICATION_PASSED' | 'REVIEW_ACCEPTED' | 'NEEDS_REVIEW' | 'REJECTED';
  readonly manifestContentSha256: string;
  readonly acceptedAssertionIds: readonly string[];
  readonly rejectedAssertionIds?: readonly string[];
  readonly policySha256?: string;
}

/**
 * Durable lookup of every candidate artifact reference for one non-RDT&E
 * family's manifest documents, plus a byte-verified reload of the artifact
 * itself. Kept as a narrow port so the real Prisma implementation stays a
 * thin, independently testable adapter — this module never talks to Prisma
 * directly.
 */
export interface MaterializationArtifactSourcePortV1 {
  /**
   * Returns the latest terminal (non-VALIDATING) candidate for each supplied
   * manifest document key within the given cycle, or null when none exists
   * yet. Only PASS/REVIEW_ACCEPTED candidates are usable for materialization;
   * REJECTED and still-VALIDATING candidates are surfaced so the caller can
   * decide the run is incomplete rather than silently skipping the document.
   */
  loadCandidateRefs(input: {
    cycleId: string;
    manifestDocumentKeys: readonly string[];
  }): Promise<ReadonlyMap<string, MaterializationCandidateArtifactRefV1>>;

  /**
   * Reload the exact artifact bytes the candidate names, re-verify its
   * content hash, and apply the exact same accepted-assertion filter the
   * original verification decided (mirrors `acceptedArtifact` in
   * `scripts/certify-defense-budget-non-rdte.ts` -- never re-run here as a
   * second implementation, this is the identical filter rule restated over a
   * reloaded artifact).
   */
  loadVerifiedArtifact(
    ref: MaterializationCandidateArtifactRefV1,
  ): Promise<DefenseBudgetExtractionArtifactV1>;
}

/**
 * The exact required-document/manifest inventory for one family group,
 * reconstructed from `DefenseBudgetExpectedSource` + the governed manifest
 * this readiness identity's corpus was evaluated against -- never
 * fabricated. A real caller supplies this from the same corpus the readiness
 * layer already loaded.
 */
export interface MaterializationManifestInputV1 {
  readonly manifestContentSha256: string;
  readonly documents: readonly BudgetCycleManifestDocumentV1[];
  readonly requiredIdentityKeys: readonly string[];
  readonly requiredNarrativeSections: readonly string[];
  readonly requiredQuantityCategories?: readonly string[];
  readonly requiredUnitCostCategories?: readonly string[];
}

export interface MaterializationRequestV1 {
  readonly identity: CycleFamilyReadinessIdentityV1;
  readonly cycleId: string;
  readonly manifest: MaterializationManifestInputV1;
}

export const MATERIALIZATION_OUTCOME_V1_VALUES = [
  'materialized',
  'no_candidates_yet',
  'candidate_rejected',
  'candidate_incomplete',
  'certification_failed',
  'missing_durable_input',
] as const;
export type MaterializationOutcomeV1 = (typeof MATERIALIZATION_OUTCOME_V1_VALUES)[number];

export interface MaterializationResultV1 {
  readonly outcome: MaterializationOutcomeV1;
  readonly detail: string;
  /** Present only when outcome === 'materialized'. */
  readonly record: DefenseBudgetProjectionPlanRecordV1 | null;
  /** True when an identical record already existed (idempotent replay). */
  readonly replay: boolean;
}

function exhibitArtifactMapV1(
  family: MaterializableNonRdteFamilyV1,
  documents: readonly NonRdteCycleDocumentInput[],
): OmExhibitArtifacts | ProcurementExhibitArtifacts | MilconExhibitArtifacts {
  const byExhibit = new Map<string, DefenseBudgetExtractionArtifactV1[]>();
  for (const value of documents) {
    const list = byExhibit.get(value.document.exhibit) ?? [];
    list.push(value.artifact);
    byExhibit.set(value.document.exhibit, list);
  }
  const of = (exhibit: string): DefenseBudgetExtractionArtifactV1[] => byExhibit.get(exhibit) ?? [];
  if (family === 'om') {
    return { o1Artifacts: of('O-1'), op5Artifacts: of('OP-5') };
  }
  if (family === 'procurement') {
    return {
      p1Artifacts: of('P-1'),
      p40Artifacts: of('P-40'),
      p5Artifacts: of('P-5'),
      p21Artifacts: of('P-21'),
      p3aArtifacts: of('P-3A'),
    };
  }
  return { c1Artifacts: of('C-1'), dd1391Artifacts: of('DD1391') };
}

/**
 * Maps the durable candidate/run status vocabulary
 * (`VERIFICATION_PASSED`|`REVIEW_ACCEPTED`|`NEEDS_REVIEW`|`REJECTED`) onto the
 * non-RDT&E cycle bundle's own `decision` vocabulary
 * (`VERIFICATION_PASSED`|`NEEDS_REVIEW`|`REJECTED`) exactly as
 * `scripts/certify-defense-budget-non-rdte.ts`'s `decisionForResult` already
 * does: `REVIEW_ACCEPTED` is a NEEDS_REVIEW decision whose review was
 * accepted, so it maps to `NEEDS_REVIEW` here and its `verificationRunId` is
 * added to `allowedReviewedAcceptances` for the certifier's own
 * `isPassedOrAllowed` gate to admit.
 */
function nonRdteDecisionFromCandidateStatus(
  status: MaterializationCandidateArtifactRefV1['status'],
): 'VERIFICATION_PASSED' | 'NEEDS_REVIEW' | 'REJECTED' {
  if (status === 'VERIFICATION_PASSED') return 'VERIFICATION_PASSED';
  if (status === 'REVIEW_ACCEPTED' || status === 'NEEDS_REVIEW') return 'NEEDS_REVIEW';
  return 'REJECTED';
}

function verificationRefFromCandidate(
  ref: MaterializationCandidateArtifactRefV1,
  artifact: DefenseBudgetExtractionArtifactV1,
): NonRdteCycleVerificationRefV1 {
  return {
    manifestDocumentKey: ref.manifestDocumentKey,
    artifactId: artifact.artifactId,
    verificationCandidateId: ref.candidateId,
    verificationRunId: ref.verificationRunId,
    decision: nonRdteDecisionFromCandidateStatus(ref.status),
    decisionId: ref.verificationRunId,
  };
}

/**
 * Materialize a certification for a non-RDT&E family (procurement/om/milcon)
 * from durable rows, then persist through the EXISTING projection-plan
 * substrate. Returns `missing_durable_input` for any other family -- the
 * caller (the readiness orchestrator's real port implementation) routes by
 * `identity.familyGroup` before calling this, this function is the defensive
 * inner check.
 */
export async function materializeNonRdteFamilyCertificationV1(
  request: MaterializationRequestV1,
  ports: {
    artifactSource: MaterializationArtifactSourcePortV1;
    projectionPlans: ProjectionPlanRepositoryV1;
    producerVersion: string;
  },
): Promise<MaterializationResultV1> {
  const family = request.identity.familyGroup;
  if (!isMaterializableNonRdteFamily(family)) {
    return {
      outcome: 'missing_durable_input',
      detail:
        MISSING_DURABLE_INPUT_NOTES[family] ??
        `no materialization boundary exists for family group ${family}`,
      record: null,
      replay: false,
    };
  }

  const documentKeys = request.manifest.documents.map((value) => value.documentKey);
  const candidateRefs = await ports.artifactSource.loadCandidateRefs({
    cycleId: request.cycleId,
    manifestDocumentKeys: documentKeys,
  });

  const requiredDocuments = request.manifest.documents.filter((value) => value.required);
  for (const document of requiredDocuments) {
    const ref = candidateRefs.get(document.documentKey);
    if (ref == null) {
      return {
        outcome: 'no_candidates_yet',
        detail: `required document ${document.documentKey} has no terminal verification candidate yet`,
        record: null,
        replay: false,
      };
    }
    if (ref.decision === 'REJECT') {
      return {
        outcome: 'candidate_rejected',
        detail: `required document ${document.documentKey} candidate ${ref.candidateId} was REJECTED; refusing to materialize`,
        record: null,
        replay: false,
      };
    }
    if (ref.status !== 'VERIFICATION_PASSED' && ref.status !== 'REVIEW_ACCEPTED') {
      return {
        outcome: 'candidate_incomplete',
        detail: `required document ${document.documentKey} candidate ${ref.candidateId} status is ${ref.status}, not yet a usable terminal decision`,
        record: null,
        replay: false,
      };
    }
  }

  const nonRdteDocuments: NonRdteCycleDocumentInput[] = [];
  const verifications: NonRdteCycleVerificationRefV1[] = [];
  const allowedReviewedAcceptances = new Set<string>();
  for (const document of request.manifest.documents) {
    const ref = candidateRefs.get(document.documentKey);
    if (ref == null) continue; // optional document, genuinely absent
    if (ref.status !== 'VERIFICATION_PASSED' && ref.status !== 'REVIEW_ACCEPTED') continue;
    const reloaded = await ports.artifactSource.loadVerifiedArtifact(ref);
    nonRdteDocuments.push({ document, artifact: reloaded });
    verifications.push(verificationRefFromCandidate(ref, reloaded));
    if (ref.status === 'REVIEW_ACCEPTED') allowedReviewedAcceptances.add(ref.verificationRunId);
  }

  const familyArtifacts = exhibitArtifactMapV1(family, nonRdteDocuments);
  const familyReport =
    family === 'om'
      ? composeOmFamily({
          artifacts: familyArtifacts as OmExhibitArtifacts,
          requiredIdentityKeys: request.manifest.requiredIdentityKeys,
          op5Required: request.manifest.documents.some(
            (value) => value.exhibit === 'OP-5' && value.required,
          ),
          requiredNarrativeSections: request.manifest.requiredNarrativeSections,
          requiredQuantityCategories: request.manifest.requiredQuantityCategories ?? [],
        })
      : family === 'procurement'
        ? composeProcurementFamily({
            artifacts: familyArtifacts as ProcurementExhibitArtifacts,
            requiredIdentityKeys: request.manifest.requiredIdentityKeys,
            p40Required: request.manifest.documents.some(
              (value) => value.exhibit === 'P-40' && value.required,
            ),
            enrichmentRequired: false,
            requiredQuantityCategories: request.manifest.requiredQuantityCategories ?? [],
            requiredUnitCostCategories: request.manifest.requiredUnitCostCategories ?? [],
            requiredNarrativeSections: request.manifest.requiredNarrativeSections,
          })
        : composeMilconFamily({
            artifacts: familyArtifacts as MilconExhibitArtifacts,
            requiredIdentityKeys: request.manifest.requiredIdentityKeys,
            dd1391Required: request.manifest.documents.some(
              (value) => value.exhibit === 'DD1391' && value.required,
            ),
            requiredNarrativeSections: request.manifest.requiredNarrativeSections,
          });

  const pipelineResult = runNonRdteCyclePipeline({
    governedCycleId: request.cycleId,
    cycleIdIdentity: {
      family,
      fiscalYear: request.identity.fiscalYear,
      manifestContentSha256: request.manifest.manifestContentSha256,
    },
    fiscalYear: request.identity.fiscalYear,
    family,
    manifestContentSha256: request.manifest.manifestContentSha256,
    documents: nonRdteDocuments,
    verifications,
    allowedReviewedAcceptances,
    familyReport,
    requiredIdentityKeys: request.manifest.requiredIdentityKeys,
  });

  if (pipelineResult.certification !== 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION') {
    return {
      outcome: 'certification_failed',
      detail: `${family} cycle certification reports ${pipelineResult.certification}: ${pipelineResult.reason}`,
      record: null,
      replay: false,
    };
  }

  // The certified BUNDLE is not itself the immutable artifact this substrate
  // persists -- it has no `candidates` field. The existing family planner
  // (`planNonRdteCanonicalProjection`, same pure module every other Phase 5
  // producer already calls) turns a certified bundle + its exact artifact
  // set + the composed family report into the real
  // `NonRdteCanonicalProjectionPlanV1` document, which IS what
  // `projection-plan-record-v1.ts`'s structural view expects (`candidates`,
  // `exclusions`, `contentSha256`). This mirrors RDT&E's own
  // `finalizeRdteCycle` two-step shape (certify, then plan) exactly.
  const projection = planNonRdteCanonicalProjection({
    bundle: pipelineResult.bundle,
    artifacts: nonRdteDocuments.map((value) => value.artifact),
    familyReport,
  });

  const record = buildProjectionPlanRecordV1({
    family,
    producerVersion: ports.producerVersion,
    certificationId: null, // non-RDT&E self-certifies inside the bundle; no separate row to name.
    certificationSha256: pipelineResult.bundle.contentSha256,
    planDocument: projection.plan,
  });

  await ports.projectionPlans.insert(record);
  const reloaded = await ports.projectionPlans.loadVerified(record.projectionPlanId);
  if (reloaded == null) {
    throw new Error(
      `materialized projection plan ${record.projectionPlanId} could not be reloaded immediately after insert; refusing to report success without proof`,
    );
  }
  if (reloaded.contentSha256 !== record.contentSha256) {
    throw new Error(
      `reloaded projection plan ${record.projectionPlanId} content SHA ${reloaded.contentSha256} does not match the freshly built ${record.contentSha256}; refusing to proceed on unproven identity`,
    );
  }

  return {
    outcome: 'materialized',
    detail: `${family} cycle materialized and certified from durable corpus`,
    record: reloaded,
    replay: false,
  };
}
