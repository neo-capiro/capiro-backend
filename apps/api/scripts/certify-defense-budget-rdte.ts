#!/usr/bin/env tsx
/** @cleanup-smoke noArgsExit=5 */
/** Durable RDT&E stage 3: reload accepted artifacts and run the existing certifier/planner. */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { loadArtifact, loadArtifactMap, loadPhase5Manifest, readJsonFile, refuseUnknownFlags, requireValue, writeJsonFile } from './lib/non-rdte-phase5-operator-lib.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { defenseBudgetVerificationResultV1Schema, type DefenseBudgetVerificationResultV1 } from '../src/defense-budget/verification/verification-contract-v1.js';
import { rdteCycleVerificationRefV1Schema, type RdteCycleVerificationRefV1 } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';
import { buildRdteCycleArtifactsFromPersistedArtifacts, finalizeRdteCycle } from '../src/defense-budget/rdte/cycle/rdte-cycle-pipeline-v1.js';
import { sha256Bytes } from '../src/defense-budget/contracts/canonical-json.js';

function array<T>(file: string, parse: (value: unknown) => T): T[] { const value = readJsonFile(path.resolve(file)); if (!Array.isArray(value)) throw new Error(`${file} must contain an array`); return value.map(parse); }
function acceptedArtifact(artifact: DefenseBudgetExtractionArtifactV1, result: DefenseBudgetVerificationResultV1, ref: RdteCycleVerificationRefV1): DefenseBudgetExtractionArtifactV1 {
  if (result.verificationRunId !== ref.verificationRunId || result.candidateId !== ref.candidateId || result.extractionArtifactId !== artifact.artifactId || result.extractionArtifactSha256 !== artifact.contentSha256 || result.manifestDocumentKey !== artifact.source.manifestDocumentKey) throw new Error(`verification identity mismatch for ${artifact.artifactId}`);
  const known = new Set(artifact.assertions.map((value) => value.assertionId));
  for (const id of result.acceptedAssertionIds) if (!known.has(id)) throw new Error(`verification accepted unknown assertion ${id}`);
  const accepted = new Set(result.acceptedAssertionIds);
  return { ...artifact, assertions: result.decision === 'REJECT' ? [] : artifact.assertions.filter((value) => accepted.has(value.assertionId)) };
}
function main(): void {
  const argv = process.argv.slice(2);
  refuseUnknownFlags(argv, ['--manifest', '--artifact-map', '--verification-results', '--verification-refs', '--out-dir']);
  const loaded = loadPhase5Manifest(path.resolve(requireValue(argv, '--manifest')));
  const map = loadArtifactMap(path.resolve(requireValue(argv, '--artifact-map')));
  const results = array(requireValue(argv, '--verification-results'), (value) => defenseBudgetVerificationResultV1Schema.parse(value));
  const refs = array(requireValue(argv, '--verification-refs'), (value) => rdteCycleVerificationRefV1Schema.parse(value));
  const resultByRun = new Map(results.map((value) => [value.verificationRunId, value]));
  const refByDocument = new Map(refs.map((value) => [value.manifestDocumentKey, value]));
  const documents = [];
  for (const document of loaded.manifest.documents.filter((value) => value.family === 'rdte')) {
    const entry = map[document.documentKey]; const ref = refByDocument.get(document.documentKey);
    if (entry == null || ref == null) { if (document.required) throw new Error(`missing required durable input ${document.documentKey}`); continue; }
    if (ref.status !== 'VERIFICATION_PASSED' && ref.status !== 'REVIEW_ACCEPTED') throw new Error(`candidate ${ref.candidateId} is ${ref.status}; refusing certification`);
    const result = resultByRun.get(ref.verificationRunId); if (result == null) throw new Error(`missing verification result ${ref.verificationRunId}`);
    const artifactByteSha256 = sha256Bytes(fs.readFileSync(entry.artifactPath));
    if (artifactByteSha256 !== ref.artifactByteSha256) throw new Error(`artifact byte SHA mismatch for ${document.documentKey}`);
    documents.push({ document, artifact: acceptedArtifact(loadArtifact(entry), result, ref) });
  }
  const pipeline = finalizeRdteCycle({
    governedCycleId: loaded.manifest.cycleId,
    cycleIdIdentity: {
      family: 'rdte',
      fiscalYear: loaded.manifest.fiscalYear,
      manifestContentSha256: loaded.contentSha256,
    },
    build: buildRdteCycleArtifactsFromPersistedArtifacts({ fiscalYear: loaded.manifest.fiscalYear, manifestContentSha256: loaded.contentSha256, manifestDocuments: loaded.manifest.documents.filter((value) => value.family === 'rdte'), documents }),
    verifications: refs,
  });
  const outDir = path.resolve(requireValue(argv, '--out-dir'));
  writeJsonFile(path.join(outDir, 'cycle-bundle.json'), pipeline.bundle);
  writeJsonFile(path.join(outDir, 'projection-plan.json'), pipeline.projectionPlan);
  writeJsonFile(path.join(outDir, 'certification.json'), { certification: pipeline.certification, reason: pipeline.reason, counts: pipeline.counts });
  process.stdout.write(`${JSON.stringify({ command: 'certify-defense-budget-rdte', certification: pipeline.certification, reason: pipeline.reason, canonicalWrites: false }, null, 2)}\n`);
  process.exitCode = pipeline.certification === 'CERTIFIED_RDTE_READY_FOR_PROJECTION' ? 0 : pipeline.certification === 'NEEDS_REVIEW' ? 2 : pipeline.certification === 'INCOMPLETE' ? 3 : 4;
}
try {
  if (process.argv.length <= 2) console.error('Usage: certify-defense-budget-rdte --manifest <manifest.json> --artifact-map <map.json> --verification-results <results.json> --verification-refs <refs.json> --out-dir <directory>');
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 5;
}
