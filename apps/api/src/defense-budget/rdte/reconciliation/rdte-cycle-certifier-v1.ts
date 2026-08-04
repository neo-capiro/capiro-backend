/**
 * rdte-cycle-certifier-v1 — produce one deterministic RDT&E cycle decision.
 *
 * Workstream L (Phase 4 plan §17). A cycle is CERTIFIED_RDTE_READY_FOR_PROJECTION
 * only when every required gate holds. Never certifies on coverage percentage
 * alone. Pure module.
 */
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleId,
  type CycleCertificationV1,
  type RdteCycleBundleV1,
  type RdteCycleComparisonV1,
  type RdteCycleFindingV1,
  type RdteCycleSourceDocumentV1,
  type RdteCycleVerificationRefV1,
  type VerificationDecisionV1,
} from '../rdte-cycle-bundle-v1.js';
import type { RdteCycleReconciliationResult } from './rdte-cycle-reconciler-v1.js';
import type { JsonValue } from '../../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface RdteCycleCertifyInput {
  cycleIdIdentity: JsonValue;
  fiscalYear: number;
  manifestContentSha256: string;
  sourceDocuments: readonly RdteCycleSourceDocumentV1[];
  artifacts: ReadonlyArray<{
    manifestDocumentKey: string;
    artifactId: string;
    artifactContentSha256: string;
  }>;
  verifications: readonly RdteCycleVerificationRefV1[];
  comparisons: readonly RdteCycleComparisonV1[];
  reconciliation: RdteCycleReconciliationResult;
  /** Allowed immutable reviewed acceptances under Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  projectionPlanContentSha256?: string;
  /** True when projection planning succeeded without excluded required records. */
  projectionPlanningSucceeded?: boolean;
}

export interface RdteCycleCertificationResult {
  certification: CycleCertificationV1;
  bundle: RdteCycleBundleV1;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Certifier                                                           */
/* ------------------------------------------------------------------ */

function isPassedOrAllowed(
  decision: VerificationDecisionV1,
  decisionId: string,
  allowed: ReadonlySet<string> | undefined,
): boolean {
  if (decision === 'VERIFICATION_PASSED') return true;
  if (decision === 'NEEDS_REVIEW' && allowed?.has(decisionId) === true) return true;
  return false;
}

export function certifyRdteCycle(input: RdteCycleCertifyInput): RdteCycleCertificationResult {
  const findings: RdteCycleFindingV1[] = [...input.reconciliation.findings];
  let findingSeq = findings.length;
  const nextId = (code: string) => `cert_${code}_${++findingSeq}`;

  /* 1. Every required manifest document is present. */
  const requiredDocs = input.sourceDocuments.filter((d) => d.required);
  const presentKeys = new Set(input.sourceDocuments.map((d) => d.manifestDocumentKey));
  for (const doc of requiredDocs) {
    if (!presentKeys.has(doc.manifestDocumentKey)) {
      findings.push({
        findingId: nextId('missing_doc'),
        severity: 'blocking',
        code: 'required_document_missing',
        message: `Required document ${doc.manifestDocumentKey} is missing`,
        evidenceIds: [],
      });
    }
  }

  /* 2. Every required document has a verification decision. */
  const verificationByKey = new Map(input.verifications.map((v) => [v.manifestDocumentKey, v]));
  for (const doc of requiredDocs) {
    const v = verificationByKey.get(doc.manifestDocumentKey);
    if (v == null) {
      findings.push({
        findingId: nextId('missing_verification'),
        severity: 'blocking',
        code: 'required_document_unverified',
        message: `Required document ${doc.manifestDocumentKey} has no Phase 2 verification`,
        evidenceIds: [],
      });
      continue;
    }
    if (!isPassedOrAllowed(v.decision, v.decisionId, input.allowedReviewedAcceptances)) {
      if (v.decision === 'REJECTED') {
        findings.push({
          findingId: nextId('rejected_artifact'),
          severity: 'blocking',
          code: 'required_document_rejected',
          message: `Required document ${doc.manifestDocumentKey} is REJECTED`,
          evidenceIds: [],
        });
      } else {
        findings.push({
          findingId: nextId('needs_review'),
          severity: 'blocking',
          code: 'required_document_needs_review',
          message: `Required document ${doc.manifestDocumentKey} is ${v.decision} without allowed reviewed acceptance`,
          evidenceIds: [],
        });
      }
    }
  }

  /* 3. Reconciliation gates (identity, funding, project sums, relationships). */
  if (!input.reconciliation.identity.complete) {
    /* Already emitted as findings by reconciler. */
  }
  if (!input.reconciliation.funding.complete) {
    /* Already emitted. */
  }
  if (!input.reconciliation.projectSums.complete) {
    /* Already emitted. */
  }
  if (!input.reconciliation.relationships.complete) {
    /* Already emitted. */
  }

  /* 4. Projection planning. */
  if (input.projectionPlanningSucceeded === false) {
    findings.push({
      findingId: nextId('projection_failed'),
      severity: 'blocking',
      code: 'projection_planning_failed',
      message: 'Projection planning failed with excluded required records',
      evidenceIds: [],
    });
  }

  /* Deterministic finding order. */
  findings.sort((a, b) => {
    const sev = a.severity.localeCompare(b.severity);
    if (sev !== 0) return sev;
    const code = a.code.localeCompare(b.code);
    if (code !== 0) return code;
    return a.message.localeCompare(b.message);
  });

  const blockingFindings = findings.filter((f) => f.severity === 'blocking');
  const nonBlockingFindings = findings.filter((f) => f.severity !== 'blocking');

  /* Terminal decision. */
  let certification: CycleCertificationV1;
  let reason: string;

  const hasRejected = input.verifications.some((v) => v.decision === 'REJECTED');
  const hasMissingRequired =
    blockingFindings.some((f) => f.code === 'required_document_missing') ||
    requiredDocs.length === 0;

  if (blockingFindings.length === 0) {
    certification = 'CERTIFIED_RDTE_READY_FOR_PROJECTION';
    reason = 'All required gates passed; cycle is ready for projection planning';
  } else if (
    hasRejected &&
    blockingFindings.every(
      (f) =>
        f.code === 'required_document_rejected' ||
        f.code.startsWith('r1_r2') ||
        f.severity === 'blocking',
    )
  ) {
    /* If any required artifact is REJECTED, the cycle is REJECTED when that
     * is the dominant failure mode (no incomplete missing-doc scenario). */
    const onlyRejectsAndMismatches = blockingFindings.every(
      (f) =>
        f.code === 'required_document_rejected' ||
        f.code === 'r1_r2_funding_mismatch' ||
        f.code === 'r2a_project_sum_unreconciled' ||
        f.code === 'orphan_pe_outside_r1' ||
        f.code === 'duplicate_natural_key' ||
        f.code === 'blocking_omission_remaining',
    );
    if (hasRejected && onlyRejectsAndMismatches && !hasMissingRequired) {
      certification = 'REJECTED';
      reason = `Cycle rejected: ${blockingFindings.length} blocking finding(s) including rejected source artifact(s)`;
    } else if (
      hasMissingRequired ||
      blockingFindings.some(
        (f) =>
          f.code === 'required_document_missing' ||
          f.code === 'required_document_unverified' ||
          f.code === 'category_coverage_missing',
      )
    ) {
      certification = 'INCOMPLETE';
      reason = `Cycle incomplete: ${blockingFindings.length} blocking finding(s)`;
    } else {
      certification = 'NEEDS_REVIEW';
      reason = `Cycle needs review: ${blockingFindings.length} blocking finding(s)`;
    }
  } else if (
    blockingFindings.some(
      (f) =>
        f.code === 'required_document_missing' ||
        f.code === 'required_document_unverified' ||
        f.code === 'category_coverage_missing' ||
        f.code === 'unresolved_source_page',
    )
  ) {
    certification = 'INCOMPLETE';
    reason = `Cycle incomplete: ${blockingFindings.length} blocking finding(s)`;
  } else if (hasRejected) {
    certification = 'REJECTED';
    reason = `Cycle rejected: ${blockingFindings.length} blocking finding(s) including rejected source artifact(s)`;
  } else {
    certification = 'NEEDS_REVIEW';
    reason = `Cycle needs review: ${blockingFindings.length} blocking finding(s)`;
  }

  /* Never certify on coverage percentage alone — already enforced by requiring
   * zero blocking findings, which includes missing category coverage. */

  const cycleId = rdteCycleBundleId(input.cycleIdIdentity);
  const coverage = [...input.reconciliation.coverage].sort((a, b) =>
    a.category.localeCompare(b.category),
  );

  const bundleWithoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId,
    fiscalYear: input.fiscalYear,
    manifestContentSha256: input.manifestContentSha256,
    sourceDocuments: [...input.sourceDocuments].sort((a, b) =>
      a.manifestDocumentKey.localeCompare(b.manifestDocumentKey),
    ),
    artifacts: [...input.artifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    verifications: [...input.verifications].sort((a, b) =>
      a.manifestDocumentKey.localeCompare(b.manifestDocumentKey),
    ),
    comparisons: [...input.comparisons].sort((a, b) =>
      a.comparisonId.localeCompare(b.comparisonId),
    ),
    coverage,
    ...(input.projectionPlanContentSha256 != null
      ? { projectionPlanContentSha256: input.projectionPlanContentSha256 }
      : {}),
    certification,
    blockingFindings,
    nonBlockingFindings,
  };

  const contentSha256 = computeRdteCycleBundleContentSha256(bundleWithoutHash);
  const bundle: RdteCycleBundleV1 = { ...bundleWithoutHash, contentSha256 };

  return { certification, bundle, reason };
}
