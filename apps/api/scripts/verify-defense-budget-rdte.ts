#!/usr/bin/env tsx
/** @cleanup-smoke noArgsExit=5 helpExit=0 */
/** Durable RDT&E stage 2: invoke the shared verifier, optionally persisting audit rows. */
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadArtifact, loadArtifactMap, loadPhase5Manifest, readJsonFile, refuseUnknownFlags, requireValue, writeJsonFile } from './lib/non-rdte-phase5-operator-lib.js';
import { defenseBudgetVerificationResultV1Schema } from '../src/defense-budget/verification/verification-contract-v1.js';
import { rdteVerificationRefFromResult } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';
import { sha256Bytes } from '../src/defense-budget/contracts/canonical-json.js';
import * as fs from 'node:fs';

function main(): void {
  const argv = process.argv.slice(2);
  const usage = 'Usage: verify-defense-budget-rdte --manifest FILE --artifact-map FILE --verification-jobs FILE --out-dir DIR [--persist-audit]';
  if (argv.length === 0) {
    console.error('missing --manifest');
    console.error(usage);
    process.exitCode = 5;
    return;
  }
  if (argv.length === 1 && argv[0] === '--help') {
    process.stdout.write(`${usage}\n`);
    return;
  }
  refuseUnknownFlags(argv, ['--manifest', '--artifact-map', '--verification-jobs', '--out-dir', '--persist-audit']);
  const manifestPath = path.resolve(requireValue(argv, '--manifest'));
  const map = loadArtifactMap(path.resolve(requireValue(argv, '--artifact-map')));
  const jobs = readJsonFile(path.resolve(requireValue(argv, '--verification-jobs'))) as Record<string, { sourceDocumentId: string; referenceFile?: string }>;
  const outDir = path.resolve(requireValue(argv, '--out-dir'));
  const persist = argv.includes('--persist-audit');
  const loaded = loadPhase5Manifest(manifestPath);
  const results = []; const refs = [];
  for (const document of loaded.manifest.documents.filter((value) => value.family === 'rdte')) {
    const entry = map[document.documentKey]; const job = jobs[document.documentKey];
    if (entry == null || job == null) { if (document.required) throw new Error(`missing artifact/job for ${document.documentKey}`); continue; }
    const artifact = loadArtifact(entry); const artifactBytes = fs.readFileSync(entry.artifactPath);
    const args = ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-defense-budget-extraction-v1.ts', '--manifest', manifestPath, '--document', document.documentKey, '--artifact', path.resolve(entry.artifactPath), '--source-document-id', job.sourceDocumentId, '--expected-source-sha256', artifact.source.sourcePdfSha256, '--expected-artifact-sha256', artifact.contentSha256];
    if (job.referenceFile) args.push('--reference-file', path.resolve(job.referenceFile));
    if (persist) args.push('--persist-audit');
    const child = spawnSync(process.execPath, args, { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 20 * 60 * 1000 });
    if (child.error || ![0, 2, 3].includes(child.status ?? 5)) throw child.error ?? new Error(`verifier failed for ${document.documentKey}: ${child.stderr}`);
    const result = defenseBudgetVerificationResultV1Schema.parse(JSON.parse(child.stdout));
    results.push(result); refs.push(rdteVerificationRefFromResult({ result, artifactContentSha256: artifact.contentSha256, artifactByteSha256: sha256Bytes(artifactBytes) }));
  }
  writeJsonFile(path.join(outDir, 'verification-results.json'), results);
  writeJsonFile(path.join(outDir, 'verification-refs.json'), refs);
  process.stdout.write(`${JSON.stringify({ command: 'verify-defense-budget-rdte', mode: persist ? 'trusted_persist_audit' : 'trusted_inspect', verifiedDocumentCount: refs.length }, null, 2)}\n`);
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 5; }
