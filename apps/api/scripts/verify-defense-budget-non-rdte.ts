#!/usr/bin/env tsx
/**
 * Delegates every Phase 5 artifact to the merged Phase 2 trusted verifier.
 * Default is read-only inspect; --persist-audit writes only Phase 2 audit rows.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  PHASE5_EXIT,
  loadArtifact,
  loadArtifactMap,
  loadPhase5Manifest,
  parseFamily,
  readJsonFile,
  refuseUnknownFlags,
  requireValue,
  selectPhase5Documents,
  valueAfter,
  writeJsonFile,
} from './lib/non-rdte-phase5-operator-lib.js';
import {
  defenseBudgetVerificationResultV1Schema,
  type DefenseBudgetVerificationResultV1,
} from '../src/defense-budget/verification/verification-contract-v1.js';
import {
  nonRdteCycleVerificationRefV1Schema,
  type NonRdteCycleVerificationRefV1,
} from '../src/defense-budget/non-rdte/non-rdte-cycle-bundle-v1.js';
import { sha256CanonicalJson } from '../src/defense-budget/contracts/canonical-json.js';

const API_ROOT = path.resolve(__dirname, '..');

type VerificationJobs = Record<string, { sourceDocumentId: string; referenceFile?: string }>;

function loadVerificationJobs(filePath: string): VerificationJobs {
  const input = readJsonFile(filePath);
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('verification jobs must be an object keyed by document key');
  }
  const output: VerificationJobs = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`verification job ${key} must be an object`);
    }
    const record = raw as Record<string, unknown>;
    if (typeof record.sourceDocumentId !== 'string' || !record.sourceDocumentId.trim()) {
      throw new Error(`verification job ${key}.sourceDocumentId is required`);
    }
    output[key] = {
      sourceDocumentId: record.sourceDocumentId,
      ...(typeof record.referenceFile === 'string'
        ? { referenceFile: path.resolve(record.referenceFile) }
        : {}),
    };
  }
  return output;
}

function resolvePnpm(): { command: string; prefix: string[]; shell: boolean } {
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (fs.existsSync(corepack)) {
    return { command: process.execPath, prefix: [corepack], shell: false };
  }
  return {
    command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    prefix: [],
    shell: process.platform === 'win32',
  };
}

function runPhase2(input: {
  manifestPath: string;
  documentKey: string;
  artifactPath: string;
  sourceDocumentId: string;
  sourceSha256: string;
  artifactSha256: string;
  referenceFile?: string;
  persistAudit: boolean;
}): DefenseBudgetVerificationResultV1 {
  const pnpm = resolvePnpm();
  const args = [
    ...pnpm.prefix,
    'exec',
    'tsx',
    'scripts/verify-defense-budget-extraction-v1.ts',
    '--manifest',
    input.manifestPath,
    '--document',
    input.documentKey,
    '--artifact',
    path.resolve(input.artifactPath),
    '--source-document-id',
    input.sourceDocumentId,
    '--expected-source-sha256',
    input.sourceSha256,
    '--expected-artifact-sha256',
    input.artifactSha256,
  ];
  if (input.referenceFile != null) args.push('--reference-file', input.referenceFile);
  if (input.persistAudit) args.push('--persist-audit');
  const child = spawnSync(pnpm.command, args, {
    cwd: API_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: pnpm.shell,
    timeout: 20 * 60 * 1000,
  });
  if (child.error != null) throw child.error;
  const exitCode = child.status ?? PHASE5_EXIT.operational;
  if (![0, 2, 3].includes(exitCode)) {
    throw new Error(
      `Phase 2 verifier failed for ${input.documentKey} (exit ${exitCode}): ${child.stderr.trim()}`,
    );
  }
  const result = defenseBudgetVerificationResultV1Schema.parse(JSON.parse(child.stdout) as unknown);
  if (
    result.manifestDocumentKey !== input.documentKey ||
    result.extractionArtifactSha256 !== input.artifactSha256 ||
    result.sourcePdfSha256 !== input.sourceSha256
  ) {
    throw new Error(`Phase 2 verifier identity mismatch for ${input.documentKey}`);
  }
  return result;
}

function cycleRef(result: DefenseBudgetVerificationResultV1): NonRdteCycleVerificationRefV1 {
  const decision =
    result.decision === 'PASS'
      ? 'VERIFICATION_PASSED'
      : result.decision === 'REVIEW'
        ? 'NEEDS_REVIEW'
        : 'REJECTED';
  return nonRdteCycleVerificationRefV1Schema.parse({
    manifestDocumentKey: result.manifestDocumentKey,
    artifactId: result.extractionArtifactId,
    verificationCandidateId: result.candidateId,
    verificationRunId: result.verificationRunId,
    decision,
    decisionId: `non_rdte_decision_${sha256CanonicalJson({
      verificationRunId: result.verificationRunId,
      decision,
      acceptedAssertionIds: result.acceptedAssertionIds,
      rejectedAssertionIds: result.rejectedAssertionIds,
    })}`,
  });
}

function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, [
    '--manifest',
    '--artifact-map',
    '--verification-jobs',
    '--out-dir',
    '--family',
    '--persist-audit',
  ]);
  const manifestPath = path.resolve(requireValue(argv, '--manifest'));
  const artifactMap = loadArtifactMap(path.resolve(requireValue(argv, '--artifact-map')));
  const jobs = loadVerificationJobs(path.resolve(requireValue(argv, '--verification-jobs')));
  const outDir = path.resolve(requireValue(argv, '--out-dir'));
  const family = parseFamily(valueAfter(argv, '--family'));
  const persistAudit = argv.includes('--persist-audit');
  const loaded = loadPhase5Manifest(manifestPath);
  const documents = selectPhase5Documents(loaded.manifest, family);
  const results: DefenseBudgetVerificationResultV1[] = [];
  const refs: NonRdteCycleVerificationRefV1[] = [];
  const missingRequired: string[] = [];
  const missingOptional: string[] = [];

  for (const document of documents) {
    const entry = artifactMap[document.documentKey];
    const job = jobs[document.documentKey];
    if (entry == null || job == null) {
      (document.required ? missingRequired : missingOptional).push(document.documentKey);
      continue;
    }
    const artifact = loadArtifact(entry);
    if (artifact.source.manifestDocumentKey !== document.documentKey) {
      throw new Error(`artifact/document key mismatch for ${document.documentKey}`);
    }
    if (
      artifact.source.sourceDocumentId != null &&
      artifact.source.sourceDocumentId !== job.sourceDocumentId
    ) {
      throw new Error(`artifact/verification SourceDocument mismatch for ${document.documentKey}`);
    }
    if (entry.sourceDocumentId != null && entry.sourceDocumentId !== job.sourceDocumentId) {
      throw new Error(
        `artifact-map/verification SourceDocument mismatch for ${document.documentKey}`,
      );
    }
    if (
      document.expectedSourceSha256 == null ||
      artifact.source.sourcePdfSha256 !== document.expectedSourceSha256
    ) {
      throw new Error(`source SHA mismatch for ${document.documentKey}`);
    }
    const result = runPhase2({
      manifestPath,
      documentKey: document.documentKey,
      artifactPath: entry.artifactPath,
      sourceDocumentId: job.sourceDocumentId,
      sourceSha256: document.expectedSourceSha256,
      artifactSha256: artifact.contentSha256,
      ...(job.referenceFile != null ? { referenceFile: job.referenceFile } : {}),
      persistAudit,
    });
    if (result.extractionArtifactId !== artifact.artifactId) {
      throw new Error(`Phase 2 artifact ID mismatch for ${document.documentKey}`);
    }
    results.push(result);
    refs.push(cycleRef(result));
  }

  results.sort((a, b) => a.manifestDocumentKey.localeCompare(b.manifestDocumentKey));
  refs.sort((a, b) => a.manifestDocumentKey.localeCompare(b.manifestDocumentKey));
  writeJsonFile(path.join(outDir, 'verification-results.json'), results);
  writeJsonFile(path.join(outDir, 'verification-refs.json'), refs);
  const rejected = refs.filter((ref) => ref.decision === 'REJECTED').length;
  const needsReview = refs.filter((ref) => ref.decision === 'NEEDS_REVIEW').length;
  process.stdout.write(
    `${JSON.stringify(
      {
        command: 'verify-defense-budget-non-rdte',
        mode: persistAudit ? 'trusted_persist_audit' : 'trusted_inspect',
        cycleId: loaded.manifest.cycleId,
        manifestContentSha256: loaded.contentSha256,
        family: family ?? 'all',
        verifiedDocumentCount: refs.length,
        passedCount: refs.filter((ref) => ref.decision === 'VERIFICATION_PASSED').length,
        needsReviewCount: needsReview,
        rejectedCount: rejected,
        missingRequired: missingRequired.sort(),
        missingOptional: missingOptional.sort(),
        resultsPath: path.join(outDir, 'verification-results.json'),
        referencesPath: path.join(outDir, 'verification-refs.json'),
        canonicalWrites: false,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode =
    rejected > 0
      ? PHASE5_EXIT.rejected
      : missingRequired.length > 0
        ? PHASE5_EXIT.incomplete
        : needsReview > 0
          ? PHASE5_EXIT.needsReview
          : PHASE5_EXIT.ok;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = PHASE5_EXIT.operational;
}
