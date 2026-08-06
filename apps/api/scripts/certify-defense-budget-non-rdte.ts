#!/usr/bin/env tsx
/**
 * Compose and certify one Phase 5 family from proof-bound artifacts and exact
 * Phase 2 results. No canonical write or promotion option exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PHASE5_EXIT,
  composePhase5FamilyReport,
  loadArtifact,
  loadArtifactMap,
  loadArtifactParserResultProofs,
  loadPhase5Manifest,
  parseFamily,
  readJsonFile,
  refuseUnknownFlags,
  requireValue,
  selectPhase5Documents,
  writeJsonFile,
  type Phase5Family,
} from './lib/non-rdte-phase5-operator-lib.js';
import type { BudgetCycleManifestDocumentV1 } from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import {
  defenseBudgetVerificationResultV1Schema,
  type DefenseBudgetVerificationResultV1,
} from '../src/defense-budget/verification/verification-contract-v1.js';
import {
  nonRdteCycleVerificationRefV1Schema,
  type NonRdteCycleVerificationRefV1,
} from '../src/defense-budget/non-rdte/non-rdte-cycle-bundle-v1.js';
import { assertPhase5ArtifactProofBound } from '../src/defense-budget/non-rdte/non-rdte-proof-bound-artifact-v1.js';
import { inspectPhase5DocumentCompleteness } from '../src/defense-budget/non-rdte/non-rdte-document-completeness-v1.js';
import { runNonRdteCyclePipeline } from '../src/defense-budget/non-rdte/non-rdte-cycle-pipeline-v1.js';

function parseArray<T>(filePath: string, parse: (value: unknown) => T): T[] {
  const input = readJsonFile(filePath);
  if (!Array.isArray(input)) throw new Error(`${filePath} must contain a JSON array`);
  return input.map(parse);
}

function uniqueMap<K, V>(entries: readonly (readonly [K, V])[], label: string): Map<K, V> {
  const map = new Map<K, V>();
  for (const [key, value] of entries) {
    if (map.has(key)) throw new Error(`duplicate ${label}: ${String(key)}`);
    map.set(key, value);
  }
  return map;
}

function decisionForResult(
  result: DefenseBudgetVerificationResultV1,
): NonRdteCycleVerificationRefV1['decision'] {
  return result.decision === 'PASS'
    ? 'VERIFICATION_PASSED'
    : result.decision === 'REVIEW'
      ? 'NEEDS_REVIEW'
      : 'REJECTED';
}

function acceptedArtifact(input: {
  artifact: DefenseBudgetExtractionArtifactV1;
  result: DefenseBudgetVerificationResultV1;
  ref: NonRdteCycleVerificationRefV1;
}): DefenseBudgetExtractionArtifactV1 {
  const { artifact, result, ref } = input;
  if (
    result.verificationRunId !== ref.verificationRunId ||
    result.candidateId !== ref.verificationCandidateId ||
    result.extractionArtifactId !== artifact.artifactId ||
    result.extractionArtifactSha256 !== artifact.contentSha256 ||
    result.sourcePdfSha256 !== artifact.source.sourcePdfSha256 ||
    result.manifestDocumentKey !== artifact.source.manifestDocumentKey ||
    artifact.source.sourceDocumentId == null ||
    result.sourceDocumentId !== artifact.source.sourceDocumentId ||
    ref.artifactId !== artifact.artifactId ||
    ref.decision !== decisionForResult(result)
  ) {
    throw new Error(`verification result/reference mismatch for ${artifact.artifactId}`);
  }
  const artifactAssertionIds = new Set(
    artifact.assertions.map((assertion) => assertion.assertionId),
  );
  const accepted = new Set(result.acceptedAssertionIds);
  for (const assertionId of accepted) {
    if (!artifactAssertionIds.has(assertionId)) {
      throw new Error(
        `verification run ${result.verificationRunId} accepted unknown assertion ${assertionId}`,
      );
    }
  }
  for (const assertionId of result.rejectedAssertionIds) {
    if (accepted.has(assertionId)) {
      throw new Error(
        `verification run ${result.verificationRunId} accepted and rejected ${assertionId}`,
      );
    }
  }
  return {
    ...artifact,
    assertions:
      result.decision === 'REJECT'
        ? []
        : artifact.assertions.filter((assertion) => accepted.has(assertion.assertionId)),
  };
}

function requiredIdentityKeys(
  metadata: Record<string, unknown> | undefined,
  family: Phase5Family,
): string[] {
  const generic = metadata?.requiredIdentityKeys;
  if (Array.isArray(generic)) {
    return generic.filter((value): value is string => typeof value === 'string').sort();
  }
  const familyKeys = metadata?.[`${family}RequiredIdentityKeys`];
  return Array.isArray(familyKeys)
    ? familyKeys.filter((value): value is string => typeof value === 'string').sort()
    : [];
}

function suppliedDocuments(input: {
  documents: readonly BudgetCycleManifestDocumentV1[];
  artifactsByDocument: ReadonlyMap<string, DefenseBudgetExtractionArtifactV1>;
}): Array<{
  document: BudgetCycleManifestDocumentV1;
  artifact: DefenseBudgetExtractionArtifactV1;
}> {
  const supplied: Array<{
    document: BudgetCycleManifestDocumentV1;
    artifact: DefenseBudgetExtractionArtifactV1;
  }> = [];
  for (const document of input.documents) {
    const artifact = input.artifactsByDocument.get(document.documentKey);
    if (artifact != null) supplied.push({ document, artifact });
  }
  return supplied;
}

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, [
    '--manifest',
    '--artifact-map',
    '--verification-results',
    '--verification-refs',
    '--family',
    '--out-dir',
  ]);
  const manifestPath = requireValue(argv, '--manifest');
  const artifactMapPath = requireValue(argv, '--artifact-map');
  const verificationResultsPath = requireValue(argv, '--verification-results');
  const verificationRefsPath = requireValue(argv, '--verification-refs');
  const family = parseFamily(requireValue(argv, '--family'))!;
  const outDir = path.resolve(requireValue(argv, '--out-dir'));

  const loaded = loadPhase5Manifest(manifestPath);
  const artifactMap = loadArtifactMap(artifactMapPath);
  const results = parseArray(verificationResultsPath, (value) =>
    defenseBudgetVerificationResultV1Schema.parse(value),
  );
  const refs = parseArray(verificationRefsPath, (value) =>
    nonRdteCycleVerificationRefV1Schema.parse(value),
  );
  const resultsByRun = uniqueMap(
    results.map((result) => [result.verificationRunId, result] as const),
    'verification run',
  );
  const refsByDocument = uniqueMap(
    refs.map((ref) => [ref.manifestDocumentKey, ref] as const),
    'verification document reference',
  );
  const documents = selectPhase5Documents(loaded.manifest, family);
  const missingRequired = new Set<string>();
  const blockingDocumentFindings: Array<{
    documentKey: string;
    code: string;
    message: string;
  }> = [];
  const originalArtifactsByDocument = new Map<string, DefenseBudgetExtractionArtifactV1>();
  const acceptedArtifactsByDocument = new Map<string, DefenseBudgetExtractionArtifactV1>();

  for (const document of documents) {
    const entry = artifactMap[document.documentKey];
    const ref = refsByDocument.get(document.documentKey);
    if (entry == null || ref == null) {
      if (document.required) missingRequired.add(document.documentKey);
      continue;
    }
    const artifact = loadArtifact(entry);
    const completenessFindings = inspectPhase5DocumentCompleteness({ document, artifact });
    for (const finding of completenessFindings) {
      if (!finding.blocking) continue;
      blockingDocumentFindings.push({
        documentKey: document.documentKey,
        code: finding.code,
        message: finding.message,
      });
      if (document.required) missingRequired.add(document.documentKey);
    }
    const parserResultProofs = loadArtifactParserResultProofs({ entry, artifact });
    assertPhase5ArtifactProofBound({
      artifact,
      parserResultProofs,
      requireResultByteSha256: true,
    });
    const result = resultsByRun.get(ref.verificationRunId);
    if (result == null) throw new Error(`missing Phase 2 result ${ref.verificationRunId}`);
    originalArtifactsByDocument.set(document.documentKey, artifact);
    acceptedArtifactsByDocument.set(
      document.documentKey,
      acceptedArtifact({ artifact, result, ref }),
    );
  }

  const familyReport = composePhase5FamilyReport({
    manifest: loaded.manifest,
    family,
    artifactsByDocumentKey: acceptedArtifactsByDocument,
  });
  fs.mkdirSync(outDir, { recursive: true });
  const familyReportPath = path.join(outDir, `${family}-family-report.json`);
  const bundlePath = path.join(outDir, `${family}-cycle-bundle.json`);
  const certificationPath = path.join(outDir, `${family}-certification.json`);
  writeJsonFile(familyReportPath, familyReport);

  if (missingRequired.size > 0) {
    const incomplete = {
      certification: 'INCOMPLETE' as const,
      reason: `missing or incomplete required documents: ${[...missingRequired].sort().join(', ')}`,
      counts: {
        artifactCount: originalArtifactsByDocument.size,
        identityCount: familyReport.identities.length,
        fundingComparisonCount: familyReport.fundingComparisons.length,
        blockingFindingCount: blockingDocumentFindings.length + missingRequired.size,
      },
      missingRequired: [...missingRequired].sort(),
      blockingDocumentFindings,
    };
    writeJsonFile(certificationPath, incomplete);
    process.stdout.write(
      `${JSON.stringify(
        {
          command: 'certify-defense-budget-non-rdte',
          family,
          ...incomplete,
          familyReportPath,
          bundlePath: null,
          certificationPath,
          canonicalWrites: false,
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = PHASE5_EXIT.incomplete;
    return;
  }

  const supplied = suppliedDocuments({
    documents,
    artifactsByDocument: originalArtifactsByDocument,
  });
  const suppliedKeys = new Set(supplied.map(({ document }) => document.documentKey));

  // A Phase 2 NEEDS_REVIEW result remains NEEDS_REVIEW in Phase 5. This command
  // accepts no caller-provided review override; governed acceptance belongs to
  // a future authenticated promotion service.
  const pipeline = runNonRdteCyclePipeline({
    cycleIdIdentity: {
      cycleId: loaded.manifest.cycleId,
      manifestContentSha256: loaded.contentSha256,
      family,
    },
    fiscalYear: loaded.manifest.fiscalYear,
    family,
    manifestContentSha256: loaded.contentSha256,
    documents: supplied,
    verifications: refs.filter((ref) => suppliedKeys.has(ref.manifestDocumentKey)),
    familyReport,
    requiredIdentityKeys: requiredIdentityKeys(
      loaded.manifest.metadata as unknown as Record<string, unknown> | undefined,
      family,
    ),
  });

  writeJsonFile(bundlePath, pipeline.bundle);
  const missingOptional = documents
    .filter((document) => !document.required && !suppliedKeys.has(document.documentKey))
    .map((document) => document.documentKey)
    .sort();
  writeJsonFile(certificationPath, {
    certification: pipeline.certification,
    reason: pipeline.reason,
    counts: pipeline.counts,
    missingRequired: [],
    missingOptional,
    blockingDocumentFindings,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'certify-defense-budget-non-rdte',
        family,
        certification: pipeline.certification,
        reason: pipeline.reason,
        counts: pipeline.counts,
        missingRequired: [],
        missingOptional,
        blockingDocumentFindings,
        familyReportPath,
        bundlePath,
        certificationPath,
        canonicalWrites: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode =
    pipeline.certification === 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION'
      ? PHASE5_EXIT.ok
      : pipeline.certification === 'NEEDS_REVIEW'
        ? PHASE5_EXIT.needsReview
        : pipeline.certification === 'REJECTED'
          ? PHASE5_EXIT.rejected
          : PHASE5_EXIT.incomplete;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = PHASE5_EXIT.operational;
}
