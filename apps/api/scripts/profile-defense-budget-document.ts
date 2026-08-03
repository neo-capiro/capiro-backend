/**
 * profile-defense-budget-document — cheap PDF page profiler CLI.
 *
 *   pnpm --filter @capiro/api profile:defense-budget-document -- \
 *     --manifest <manifest.json> \
 *     --document <document-key> \
 *     --source <local.pdf> \
 *     --out <profile.json>
 *
 * Behavior (M1):
 *   - Validates manifest/document.
 *   - Computes actual source SHA.
 *   - Checks expected SHA if manifest declares one.
 *   - Invokes only the cheap profiler (no parser engines).
 *   - No database, network, or paid call.
 *   - Refuses overwrite without --force.
 *
 * Exit codes (M9):
 *   0 success
 *   2 argument/manifest contract failure
 *   3 source/proof/hash failure
 *   9 internal failure
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function computeFileSha256(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

function main(): void {
  const manifestPath = argValue('manifest');
  const documentKey = argValue('document');
  const sourcePath = argValue('source');
  const outPath = argValue('out');

  if (!manifestPath || !documentKey || !sourcePath || !outPath) {
    console.error(
      'Usage: profile-defense-budget-document.ts --manifest <manifest.json> --document <key> --source <local.pdf> --out <profile.json> [--force]',
    );
    process.exit(2);
  }

  // Validate manifest
  let manifest: BudgetCycleManifestV1;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    manifest = parseBudgetCycleManifestV1(JSON.parse(raw));
  } catch (e) {
    console.error(`Manifest validation failed: ${(e as Error).message}`);
    process.exit(2);
    return; // unreachable
  }

  // Find document in manifest
  const docEntry = manifest.documents.find(
    (d: { documentKey: string }) => d.documentKey === documentKey,
  );
  if (!docEntry) {
    console.error(
      `Document '${documentKey}' not found in manifest. Available: ${manifest.documents.map((d: { documentKey: string }) => d.documentKey).join(', ')}`,
    );
    process.exit(2);
  }

  // Compute actual source SHA
  if (!fs.existsSync(sourcePath)) {
    console.error(`Source file not found: ${sourcePath}`);
    process.exit(3);
  }

  const actualSha = computeFileSha256(sourcePath);
  console.log(`Source SHA-256: ${actualSha}`);

  // Check expected SHA if manifest declares one
  const expectedSha = (docEntry as Record<string, unknown>)['sourceSha256'] as string | undefined;
  if (expectedSha && expectedSha !== actualSha) {
    console.error(
      `Source SHA mismatch: manifest declares ${expectedSha}, actual is ${actualSha}`,
    );
    process.exit(3);
  }

  // Check overwrite
  if (fs.existsSync(outPath) && !hasFlag('force')) {
    console.error(`Output file exists: ${outPath}. Use --force to overwrite.`);
    process.exit(2);
  }

  // Invoke profiler via Python runtime
  const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
  const workDir = path.dirname(outPath);
  fs.mkdirSync(workDir, { recursive: true });

  const profileJob = {
    schemaVersion: 'defense_budget_parser_job_v1',
    jobId: `profile-${documentKey}-${Date.now()}`,
    sourcePath: path.resolve(sourcePath),
    sourceSha256: actualSha,
    engine: 'deterministic_pdfplumber', // profiling uses the base engine
    requestedPages: [], // profiler profiles all pages
    parserVersion: '1.0.0',
    parserConfig: {},
    parserConfigSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // sha256 of {}
    outputDirectory: workDir,
    includeDebugArtifacts: false,
  };

  const jobPath = path.join(workDir, '.profile-job.json');
  fs.writeFileSync(jobPath, JSON.stringify(profileJob, null, 2), 'utf8');

  try {
    const parserDir = path.resolve(__dirname, '../../defense-budget-parser');
    execFileSync(
      'uv',
      ['run', 'capiro-defense-budget-parser', 'profile', '--job', jobPath, '--out', outPath],
      { cwd: parserDir, stdio: 'pipe', timeout: 300_000 },
    );

    // Read and display summary
    const profile = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    console.log(`Profile written: ${outPath}`);
    console.log(`Pages profiled: ${profile.pages?.length ?? 0}`);
    if (profile.summary) {
      console.log(`  image-only: ${profile.summary.imageOnlyPageCount ?? 0}`);
      console.log(`  table-likely: ${profile.summary.tableLikelyPageCount ?? 0}`);
      console.log(`  mixed-layout: ${profile.summary.mixedLayoutPageCount ?? 0}`);
    }
  } catch (e) {
    console.error(`Profiler failed: ${(e as Error).message}`);
    process.exit(9);
  } finally {
    // Clean up temp job file
    try { fs.unlinkSync(jobPath); } catch { /* ignore */ }
  }

  process.exit(0);
}

const invokedDirectly =
  process.argv[1] != null &&
  process.argv[1].endsWith('profile-defense-budget-document.ts');
if (invokedDirectly) {
  main();
}
