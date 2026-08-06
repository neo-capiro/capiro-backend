#!/usr/bin/env tsx
/**
 * Build a deterministic, read-only future-canonical projection plan from an
 * already certified Phase 5 family. No Prisma client is instantiated and
 * `--commit` is permanently refused by the shared argument guard.
 */
import * as path from 'node:path';
import {
  PHASE5_EXIT,
  loadArtifact,
  loadArtifactMap,
  loadArtifactParserResultProofs,
  loadPhase5Manifest,
  parseFamily,
  readJsonFile,
  refuseUnknownFlags,
  requireValue,
  selectPhase5Documents,
  valueAfter,
  writeJsonFile,
  type Phase5FamilyReport,
} from './lib/non-rdte-phase5-operator-lib.js';
import { nonRdteCycleBundleV1Schema } from '../src/defense-budget/non-rdte/non-rdte-cycle-bundle-v1.js';
import { defenseBudgetVerificationResultV1Schema } from '../src/defense-budget/verification/verification-contract-v1.js';
import type { NonRdteCanonicalRowSnapshotV1 } from '../src/defense-budget/non-rdte/non-rdte-projection-planner-v1.js';
import { planProofBoundNonRdteCanonicalProjection } from '../src/defense-budget/non-rdte/non-rdte-proof-bound-projection-planner-v1.js';

function readCanonicalRows(filePath: string): NonRdteCanonicalRowSnapshotV1 {
  const value = readJsonFile(filePath);
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a canonical-row snapshot object`);
  }
  return value as NonRdteCanonicalRowSnapshotV1;
}

function assertFamilyReport(value: unknown): asserts value is Phase5FamilyReport {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('family report must be an object');
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.identities) || !Array.isArray(record.fundingComparisons)) {
    throw new Error('family report is missing identities or fundingComparisons');
  }
  if (
    record.completenessStatus !== 'complete' &&
    record.completenessStatus !== 'incomplete' &&
    record.completenessStatus !== 'needs_review'
  ) {
    throw new Error('family report has an invalid completenessStatus');
  }
}

function uniqueResultMap(
  values: ReturnType<typeof defenseBudgetVerificationResultV1Schema.parse>[],
) {
  const map = new Map<string, ReturnType<typeof defenseBudgetVerificationResultV1Schema.parse>>();
  for (const result of values) {
    if (map.has(result.verificationRunId)) {
      throw new Error(`duplicate verification result ${result.verificationRunId}`);
    }
    map.set(result.verificationRunId, result);
  }
  return map;
}

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, [
    '--manifest',
    '--bundle',
    '--family-report',
    '--artifact-map',
    '--verification-results',
    '--family',
    '--out',
    '--canonical-rows',
  ]);
  const manifestPath = requireValue(argv, '--manifest');
  const bundlePath = requireValue(argv, '--bundle');
  const reportPath = requireValue(argv, '--family-report');
  const artifactMapPath = requireValue(argv, '--artifact-map');
  const verificationResultsPath = requireValue(argv, '--verification-results');
  const family = parseFamily(requireValue(argv, '--family'))!;
  const outPath = path.resolve(requireValue(argv, '--out'));
  const canonicalRowsPath = valueAfter(argv, '--canonical-rows');

  const loaded = loadPhase5Manifest(manifestPath);
  const bundle = nonRdteCycleBundleV1Schema.parse(readJsonFile(bundlePath));
  if (bundle.family !== family) throw new Error(`bundle family ${bundle.family} != ${family}`);
  if (bundle.manifestContentSha256 !== loaded.contentSha256) {
    throw new Error('bundle is not bound to the supplied manifest bytes');
  }
  if (bundle.certification !== 'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION') {
    throw new Error(`bundle is not projection-ready: ${bundle.certification}`);
  }

  const familyReportInput = readJsonFile(reportPath);
  assertFamilyReport(familyReportInput);
  const familyReport = familyReportInput;
  const artifactMap = loadArtifactMap(artifactMapPath);
  const documents = selectPhase5Documents(loaded.manifest, family);
  const documentsByKey = new Map(documents.map((document) => [document.documentKey, document]));

  const artifacts = bundle.artifacts.map((artifactRef) => {
    const document = documentsByKey.get(artifactRef.manifestDocumentKey);
    if (document == null) {
      throw new Error(
        `bundle artifact ${artifactRef.manifestDocumentKey} is not a ${family} manifest document`,
      );
    }
    const entry = artifactMap[artifactRef.manifestDocumentKey];
    if (entry == null) {
      throw new Error(`artifact map missing certified document ${artifactRef.manifestDocumentKey}`);
    }
    const artifact = loadArtifact(entry);
    if (
      artifact.artifactId !== artifactRef.artifactId ||
      artifact.contentSha256 !== artifactRef.artifactContentSha256
    ) {
      throw new Error(`bundle/artifact mismatch for ${artifactRef.manifestDocumentKey}`);
    }
    return artifact;
  });

  const parserResultProofsByArtifactId = new Map(
    artifacts.map((artifact) => {
      const entry = artifactMap[artifact.source.manifestDocumentKey];
      if (entry == null) {
        throw new Error(`artifact ${artifact.artifactId} has no artifact-map entry`);
      }
      return [artifact.artifactId, loadArtifactParserResultProofs({ entry, artifact })] as const;
    }),
  );

  const rawResults = readJsonFile(verificationResultsPath);
  if (!Array.isArray(rawResults)) throw new Error('verification results must be an array');
  const verificationResults = rawResults.map((value) =>
    defenseBudgetVerificationResultV1Schema.parse(value),
  );
  const verificationResultsByRunId = uniqueResultMap(verificationResults);
  for (const ref of bundle.verifications) {
    if (!verificationResultsByRunId.has(ref.verificationRunId)) {
      throw new Error(`missing exact verification result ${ref.verificationRunId}`);
    }
  }

  const certifiedDocumentKeys = new Set(
    bundle.artifacts.map((artifact) => artifact.manifestDocumentKey),
  );
  const milconAccountByDocumentKey = new Map(
    documents
      .filter((document) => certifiedDocumentKeys.has(document.documentKey))
      .map((document) => [document.documentKey, document.account ?? '']),
  );
  const canonicalRows =
    canonicalRowsPath == null ? undefined : readCanonicalRows(canonicalRowsPath);

  const result = planProofBoundNonRdteCanonicalProjection({
    bundle,
    artifacts,
    familyReport,
    parserResultProofsByArtifactId,
    verificationResultsByRunId,
    milconAccountByDocumentKey,
    ...(canonicalRows != null ? { canonicalRows } : {}),
  });
  writeJsonFile(outPath, result.plan);
  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'plan-defense-budget-non-rdte-projection',
        family,
        cycleId: bundle.cycleId,
        planPath: outPath,
        planContentSha256: result.plan.contentSha256,
        candidateCount: result.plan.candidates.length,
        exclusionCount: result.plan.exclusions.length,
        diffedAgainstCanonicalRows: result.plan.diffedAgainstCanonicalRows,
        canonicalWrites: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = PHASE5_EXIT.ok;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = PHASE5_EXIT.operational;
}
