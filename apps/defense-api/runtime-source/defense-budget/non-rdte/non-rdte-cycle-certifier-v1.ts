/**
 * non-rdte-cycle-certifier-v1 — produce one deterministic non-RDT&E cycle
 * certification decision.
 *
 * Workstream N (Phase 5 plan §14). A cycle is
 * CERTIFIED_NON_RDTE_READY_FOR_PROJECTION only when every required gate holds.
 * Never certifies on coverage percentage alone. Pure module.
 */
import {
  computeNonRdteCycleBundleContentSha256,
  nonRdteCycleBundleId,
  type NonRdteCycleCertificationV1,
  type NonRdteCycleBundleV1,
  type NonRdteCycleFindingV1,
  type NonRdteCycleSourceDocumentV1,
  type NonRdteCycleVerificationRefV1,
  type NonRdteVerificationDecisionV1,
} from './non-rdte-cycle-bundle-v1.js';
import type { NonRdteCycleReconciliationResult } from './non-rdte-cycle-reconciler-v1.js';
import type { JsonValue } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

export interface NonRdteCycleCertifyInput {
  cycleIdIdentity: JsonValue;
  fiscalYear: number;
  family: 'procurement' | 'om' | 'milcon';
  manifestContentSha256: string;
  sourceDocuments: readonly NonRdteCycleSourceDocumentV1[];
  artifacts: ReadonlyArray<{
    manifestDocumentKey: string;
    artifactId: string;
    artifactContentSha256: string;
  }>;
  verifications: readonly NonRdteCycleVerificationRefV1[];
  reconciliation: NonRdteCycleReconciliationResult;
  /** Allowed immutable reviewed acceptances under Phase 2 policy. */
  allowedReviewedAcceptances?: ReadonlySet<string>;
  projectionPlanContentSha256?: string;
  /** True when projection planning succeeded without excluded required records. */
  projectionPlanningSucceeded?: boolean;
}

export interface NonRdteCycleCertificationResult {
  certification: NonRdteCycleCertificationV1;
  bundle: NonRdteCycleBundleV1;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Certifier                                                           */
/* ------------------------------------------------------------------ */

function isPassedOrAllowed(
  decision: NonRdteVerificationDecisionV1,
  decisionId: string,
  allowed: ReadonlySet<string> | undefined,
): boolean {
  if (decision === 'VERIFICATION_PASSED') return true;
  if (decision === 'NEEDS_REVIEW' && allowed?.has(decisionId) === true) return true;
  return false;
}

export function certifyNonRdteCycle(
  input: NonRdteCycleCertifyInput,
): NonRdteCycleCertificationResult {
  const findings: NonRdteCycleFindingV1[] = [...input.reconciliation.findings];
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

  /* 3. Reconciliation gates. */
  if (!input.reconciliation.identity.complete) {
    /* Already emitted as findings by reconciler. */
  }
  if (!input.reconciliation.funding.complete) {
    /* Already emitted. */
  }
  if (input.reconciliation.coverage) {
    for (const entry of input.reconciliation.coverage) {
      if (entry.status === 'missing' && entry.denominator > 0) {
        findings.push({
          findingId: nextId('coverage_missing'),
          severity: 'blocking',
          code: 'category_coverage_missing',
          message: `Category ${entry.category} is missing (${entry.numerator}/${entry.denominator})`,
          evidenceIds: [],
        });
      }
    }
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
  let certification: NonRdteCycleCertificationV1;
  let reason: string;

  const hasRejected = input.verifications.some((v) => v.decision === 'REJECTED');
  const hasMissingRequired = blockingFindings.some((f) => f.code === 'required_document_missing');

  if (blockingFindings.length === 0) {
    certification = 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION';
    reason = 'All required gates passed; cycle is ready for projection planning';
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

  const cycleId = nonRdteCycleBundleId(input.cycleIdIdentity);
  const coverage = [...input.reconciliation.coverage].sort((a, b) =>
    a.category.localeCompare(b.category),
  );

  const bundleWithoutHash = {
    schemaVersion: 'non_rdte_cycle_bundle_v1' as const,
    cycleId,
    fiscalYear: input.fiscalYear,
    family: input.family,
    manifestContentSha256: input.manifestContentSha256,
    sourceDocuments: [...input.sourceDocuments].sort((a, b) =>
      a.manifestDocumentKey.localeCompare(b.manifestDocumentKey),
    ),
    artifacts: [...input.artifacts].sort((a, b) => a.artifactId.localeCompare(b.artifactId)),
    verifications: [...input.verifications].sort((a, b) =>
      a.manifestDocumentKey.localeCompare(b.manifestDocumentKey),
    ),
    coverage,
    ...(input.projectionPlanContentSha256 != null
      ? { projectionPlanContentSha256: input.projectionPlanContentSha256 }
      : {}),
    certification,
    blockingFindings,
    nonBlockingFindings,
  };

  const contentSha256 = computeNonRdteCycleBundleContentSha256(bundleWithoutHash);
  const bundle: NonRdteCycleBundleV1 = { ...bundleWithoutHash, contentSha256 };

  return { certification, bundle, reason };
}
