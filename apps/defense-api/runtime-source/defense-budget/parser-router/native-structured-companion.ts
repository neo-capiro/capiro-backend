/**
 * Native-structured companion boundary.
 *
 * Phase 3 accepts an explicitly supplied companion only after it has been
 * converted through the Phase 1 contract. The router never substitutes PDF
 * parsing for a `native_structured` manifest policy.
 */
import { readFileSync } from 'node:fs';
import type {
  BudgetCycleManifestDocumentV1,
  BudgetCycleManifestV1,
} from '../contracts/budget-cycle-manifest-v1.js';
import {
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.semantic.js';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { DefenseBudgetVerificationResultV1 } from '../verification/verification-contract-v1.js';
import type { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';

export interface NativeStructuredCompanionResultV1 {
  artifactLocator: string;
  artifactId: string;
  artifactContentSha256: string;
  artifactByteSha256: string;
  verificationResult: DefenseBudgetVerificationResultV1;
}

/** Validate a preconverted companion and send it through the same Phase 2 gate. */
export async function verifyNativeStructuredCompanion(input: {
  manifest: BudgetCycleManifestV1;
  manifestLocator: string;
  manifestDocument: BudgetCycleManifestDocumentV1;
  companionLocator: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  persistVerificationAudit: boolean;
  verificationService: BudgetVerificationV1Service;
}): Promise<NativeStructuredCompanionResultV1> {
  if (input.manifestDocument.parserPolicy !== 'native_structured') {
    throw new Error(
      `document ${input.manifestDocument.documentKey} is not governed by native_structured policy`,
    );
  }
  const bytes = readFileSync(input.companionLocator);
  const artifact = parseDefenseBudgetExtractionArtifactV1(JSON.parse(bytes.toString('utf8')));
  const semanticErrors = validateDefenseBudgetExtractionArtifactV1(artifact).filter(
    (finding) => finding.severity === 'error',
  );
  if (semanticErrors.length > 0) {
    throw new Error(
      `native structured companion failed Phase 1 semantics: ${semanticErrors
        .map((finding) => `${finding.code}@${finding.path}`)
        .join(', ')}`,
    );
  }
  const document = input.manifestDocument;
  const mismatches: string[] = [];
  if (artifact.source.manifestDocumentKey !== document.documentKey) {
    mismatches.push('manifestDocumentKey');
  }
  if (artifact.source.sourcePdfSha256 !== input.sourcePdfSha256) {
    mismatches.push('sourcePdfSha256');
  }
  if (artifact.source.fiscalYear !== input.manifest.fiscalYear) mismatches.push('fiscalYear');
  if (artifact.source.family !== document.family) mismatches.push('family');
  if (artifact.source.exhibit !== document.exhibit) mismatches.push('exhibit');
  if (artifact.source.authority !== document.authority) mismatches.push('authority');
  if (artifact.source.component !== document.component) mismatches.push('component');
  if (artifact.source.budgetCycle !== document.budgetCycle) mismatches.push('budgetCycle');
  if (artifact.source.documentType !== document.documentType) mismatches.push('documentType');
  if (
    artifact.source.sourceDocumentId &&
    artifact.source.sourceDocumentId !== input.sourceDocumentId
  ) {
    mismatches.push('sourceDocumentId');
  }
  if (!artifact.parserRuns.some((run) => run.method === 'native_structured')) {
    mismatches.push('native_structured parser run');
  }
  if (mismatches.length > 0) {
    throw new Error(
      `native structured companion does not match manifest/source identity: ${mismatches.join(', ')}`,
    );
  }

  const artifactByteSha256 = sha256Bytes(bytes);
  const verificationResult = await input.verificationService.verify({
    manifestLocator: input.manifestLocator,
    manifestDocumentKey: document.documentKey,
    extractionArtifactLocator: input.companionLocator,
    sourceDocumentId: input.sourceDocumentId,
    mode: input.persistVerificationAudit ? 'persist_audit' : 'inspect',
    expectedSourcePdfSha256: input.sourcePdfSha256,
    expectedExtractionArtifactSha256: artifactByteSha256,
  });
  return {
    artifactLocator: input.companionLocator,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256,
    verificationResult,
  };
}
