/**
 * rdte-cycle-certifier-v1 — deterministic RDT&E cycle decision.
 *
 * Certification is fail-closed on exact manifest/source/artifact/verification
 * binding and on successful projection planning.
 */
import {
  computeRdteCycleBundleContentSha256,
  rdteCycleBundleId,
  type CycleCertificationV1,
  type RdteCycleArtifactRefV1,
  type RdteCycleBundleV1,
  type RdteCycleComparisonV1,
  type RdteCycleFindingV1,
  type RdteCycleSourceDocumentV1,
  type RdteCycleVerificationRefV1,
} from '../rdte-cycle-bundle-v1.js';
import type { RdteCycleReconciliationResult } from './rdte-cycle-reconciler-v1.js';
import type { JsonValue } from '../../contracts/canonical-json.js';

export interface RdteCycleCertifyInput {
  cycleIdIdentity: JsonValue;
  fiscalYear: number;
  manifestContentSha256: string;
  requiredManifestDocumentKeys: readonly string[];
  sourceDocuments: readonly RdteCycleSourceDocumentV1[];
  artifacts: readonly RdteCycleArtifactRefV1[];
  verifications: readonly RdteCycleVerificationRefV1[];
  comparisons: readonly RdteCycleComparisonV1[];
  reconciliation: RdteCycleReconciliationResult;
  projectionPlanContentSha256?: string;
  projectionPlanningSucceeded: boolean;
}

export interface RdteCycleCertificationResult {
  certification: CycleCertificationV1;
  bundle: RdteCycleBundleV1;
  reason: string;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) output.add(value);
    seen.add(value);
  }
  return [...output].sort();
}

function isTrustedTerminalVerification(value: RdteCycleVerificationRefV1): boolean {
  return (
    (value.phase2Decision === 'PASS' && value.status === 'VERIFICATION_PASSED') ||
    (value.phase2Decision === 'REVIEW' && value.status === 'REVIEW_ACCEPTED')
  );
}

export function certifyRdteCycle(input: RdteCycleCertifyInput): RdteCycleCertificationResult {
  const findings: RdteCycleFindingV1[] = [...input.reconciliation.findings];
  let findingSeq = findings.length;
  const nextId = (code: string) => `cert_${code}_${++findingSeq}`;
  const addBlocking = (code: string, message: string, evidenceIds: string[] = []) => {
    findings.push({
      findingId: nextId(code),
      severity: 'blocking',
      code,
      message,
      evidenceIds,
    });
  };

  const requiredKeys = [...new Set(input.requiredManifestDocumentKeys)].sort();
  if (requiredKeys.length === 0) {
    addBlocking(
      'required_manifest_inventory_empty',
      'Manifest declares no required RDT&E documents',
    );
  }

  for (const key of duplicates(input.sourceDocuments.map((value) => value.manifestDocumentKey))) {
    addBlocking('duplicate_source_document_key', `Multiple source documents supplied for ${key}`);
  }
  for (const key of duplicates(input.artifacts.map((value) => value.manifestDocumentKey))) {
    addBlocking('duplicate_artifact_document_key', `Multiple artifacts supplied for ${key}`);
  }
  for (const key of duplicates(input.verifications.map((value) => value.manifestDocumentKey))) {
    addBlocking(
      'duplicate_verification_document_key',
      `Multiple verification results supplied for ${key}`,
    );
  }

  const sourceByKey = new Map(
    input.sourceDocuments.map((value) => [value.manifestDocumentKey, value]),
  );
  const artifactByKey = new Map(input.artifacts.map((value) => [value.manifestDocumentKey, value]));
  const verificationByKey = new Map(
    input.verifications.map((value) => [value.manifestDocumentKey, value]),
  );

  for (const documentKey of requiredKeys) {
    const source = sourceByKey.get(documentKey);
    const artifact = artifactByKey.get(documentKey);
    const verification = verificationByKey.get(documentKey);

    if (!source) {
      addBlocking('required_document_missing', `Required document ${documentKey} is missing`);
      continue;
    }
    if (source.parserRunIds.length === 0) {
      addBlocking(
        'required_parser_lineage_missing',
        `Required document ${documentKey} has no Phase 3 parser lineage`,
      );
    }
    if (source.unresolvedPages.length > 0) {
      addBlocking(
        'unresolved_source_page',
        `Required document ${documentKey} has unresolved pages: ${source.unresolvedPages.join(', ')}`,
      );
    }
    if (!artifact) {
      addBlocking(
        'required_artifact_missing',
        `Required document ${documentKey} has no extraction artifact`,
      );
      continue;
    }
    if (!verification) {
      addBlocking(
        'required_document_unverified',
        `Required document ${documentKey} has no Phase 2 result`,
      );
      continue;
    }

    const mismatches: string[] = [];
    if (verification.manifestContentSha256 !== input.manifestContentSha256) {
      mismatches.push('manifestContentSha256');
    }
    if (verification.artifactId !== artifact.artifactId) mismatches.push('artifactId');
    if (verification.artifactContentSha256 !== artifact.artifactContentSha256) {
      mismatches.push('artifactContentSha256');
    }
    const verificationCarriesExactByteSha =
      verification.artifactByteSha256 !== verification.artifactContentSha256;
    if (
      verificationCarriesExactByteSha &&
      verification.artifactByteSha256 !== artifact.artifactByteSha256
    ) {
      mismatches.push('artifactByteSha256');
    }
    if (verification.sourceDocumentId !== source.sourceDocumentId) {
      mismatches.push('sourceDocumentId');
    }
    if (verification.sourcePdfSha256 !== source.sourcePdfSha256) {
      mismatches.push('sourcePdfSha256');
    }
    if (mismatches.length > 0) {
      addBlocking(
        'verification_identity_mismatch',
        `Phase 2 result for ${documentKey} does not bind to this cycle: ${mismatches.join(', ')}`,
      );
      continue;
    }

    if (!isTrustedTerminalVerification(verification)) {
      if (verification.phase2Decision === 'REJECT' || verification.status === 'REJECTED') {
        addBlocking('required_document_rejected', `Required document ${documentKey} is rejected`);
      } else {
        addBlocking(
          'required_document_needs_review',
          `Required document ${documentKey} is ${verification.phase2Decision}/${verification.status}`,
        );
      }
    }
  }

  for (const comparison of input.comparisons) {
    if (comparison.result === 'fail') {
      addBlocking(
        'cross_exhibit_comparison_failed',
        comparison.message ?? `Comparison ${comparison.comparisonId} failed`,
        [...comparison.evidenceIds],
      );
    } else if (comparison.result === 'review') {
      addBlocking(
        'cross_exhibit_comparison_needs_review',
        comparison.message ?? `Comparison ${comparison.comparisonId} needs review`,
        [...comparison.evidenceIds],
      );
    }
  }

  if (!input.projectionPlanningSucceeded || !input.projectionPlanContentSha256) {
    addBlocking(
      'projection_planning_not_complete',
      'Projection planning must succeed and provide an exact content SHA before certification',
    );
  }

  findings.sort((left, right) => {
    const severity = left.severity.localeCompare(right.severity);
    if (severity !== 0) return severity;
    const code = left.code.localeCompare(right.code);
    if (code !== 0) return code;
    return left.message.localeCompare(right.message);
  });

  const blockingFindings = findings.filter((finding) => finding.severity === 'blocking');
  const nonBlockingFindings = findings.filter((finding) => finding.severity !== 'blocking');
  const hasRejected = input.verifications.some(
    (value) => value.phase2Decision === 'REJECT' || value.status === 'REJECTED',
  );
  const hasIncomplete = blockingFindings.some((finding) =>
    [
      'required_manifest_inventory_empty',
      'required_document_missing',
      'required_artifact_missing',
      'required_document_unverified',
      'required_parser_lineage_missing',
      'category_coverage_missing',
      'unresolved_source_page',
      'projection_planning_not_complete',
    ].includes(finding.code),
  );

  let certification: CycleCertificationV1;
  let reason: string;
  if (blockingFindings.length === 0) {
    certification = 'CERTIFIED_RDTE_READY_FOR_PROJECTION';
    reason =
      'All required source, artifact, verification, reconciliation, and projection gates passed';
  } else if (hasRejected) {
    certification = 'REJECTED';
    reason = `Cycle rejected: ${blockingFindings.length} blocking finding(s)`;
  } else if (hasIncomplete) {
    certification = 'INCOMPLETE';
    reason = `Cycle incomplete: ${blockingFindings.length} blocking finding(s)`;
  } else {
    certification = 'NEEDS_REVIEW';
    reason = `Cycle needs review: ${blockingFindings.length} blocking finding(s)`;
  }

  const bundleWithoutHash = {
    schemaVersion: 'rdte_cycle_bundle_v1' as const,
    cycleId: rdteCycleBundleId(input.cycleIdIdentity),
    fiscalYear: input.fiscalYear,
    manifestContentSha256: input.manifestContentSha256,
    sourceDocuments: [...input.sourceDocuments].sort((left, right) =>
      left.manifestDocumentKey.localeCompare(right.manifestDocumentKey),
    ),
    artifacts: [...input.artifacts].sort((left, right) =>
      left.artifactId.localeCompare(right.artifactId),
    ),
    verifications: [...input.verifications].sort((left, right) =>
      left.manifestDocumentKey.localeCompare(right.manifestDocumentKey),
    ),
    comparisons: [...input.comparisons].sort((left, right) =>
      left.comparisonId.localeCompare(right.comparisonId),
    ),
    coverage: [...input.reconciliation.coverage].sort((left, right) =>
      left.category.localeCompare(right.category),
    ),
    ...(input.projectionPlanContentSha256
      ? { projectionPlanContentSha256: input.projectionPlanContentSha256 }
      : {}),
    certification,
    blockingFindings,
    nonBlockingFindings,
  };
  const bundle: RdteCycleBundleV1 = {
    ...bundleWithoutHash,
    contentSha256: computeRdteCycleBundleContentSha256(bundleWithoutHash),
  };
  return { certification, bundle, reason };
}
