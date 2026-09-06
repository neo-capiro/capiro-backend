/**
 * Phase 10B-28R -- job-file generator for the ingestion-drain offline startup
 * gate (`scripts/verify-defense-budget-drain-offline-startup.sh`).
 *
 * Runs INSIDE the drain image (the API image ships tsx and the TypeScript
 * sources) so the profile and parse jobs it writes carry exactly the parser
 * identities production computes:
 *
 *   - profiling: DEFAULT_PROFILING_THRESHOLDS + computeProfilingConfigSha256
 *     (source-document-parser-handoff.ts builds its profile job the same way);
 *   - parsing:   getDefaultParserConfig(engine) + computeParserConfigSha256
 *     (parser-router-v1.service.ts builds each engine job the same way).
 *
 * Nothing here talks to a database, S3, or the network. Both job files are
 * validated against the cross-language runtime contracts before being written.
 *
 * usage (in-container):
 *   tsx scripts/lib/defense-budget-offline-startup-jobs.ts \
 *     --source-path /src/source.pdf --source-sha256 <sha256> --out-dir /out/jobs \
 *     --pages 11,15,20,37 --engine paddleocr \
 *     --pdfplumber-version <engines.deterministic_pdfplumber from `version --json`> \
 *     --engine-version <engines.<engine> from `version --json`>
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
} from '../../src/defense-budget/parser-router/page-profiler.js';
import { getDefaultParserConfig } from '../../src/defense-budget/parser-router/parser-engine-defaults.js';
import {
  computeParserConfigSha256,
  parseParserRuntimeJobV1,
} from '../../src/defense-budget/parser-router/parser-runtime-contract-v1.js';
import { parseParserProfileJobV1 } from '../../src/defense-budget/parser-router/profile-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../../src/defense-budget/contracts/extraction-artifact-v1.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(flag: string): string {
  const value = argValue(flag)?.trim();
  if (!value) {
    console.error(`defense-budget-offline-startup-jobs: ${flag} is required`);
    process.exit(2);
  }
  return value;
}

const sourcePath = required('--source-path');
const sourceSha256 = required('--source-sha256');
const outDir = required('--out-dir');
const pdfplumberVersion = required('--pdfplumber-version');
const engine = (argValue('--engine')?.trim() ?? 'paddleocr') as ExtractionMethodV1;
const engineVersion = required('--engine-version');
const pages = (argValue('--pages') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value.length > 0)
  .map((value) => Number(value));
if (pages.some((page) => !Number.isInteger(page) || page < 1)) {
  console.error('defense-budget-offline-startup-jobs: --pages must be positive integers');
  process.exit(2);
}
if (!/^[a-f0-9]{64}$/.test(sourceSha256)) {
  console.error('defense-budget-offline-startup-jobs: --source-sha256 must be 64 lowercase hex characters');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });

// Profile job: identical construction to runParserHandoffForSourceDocument.
const profileJob = parseParserProfileJobV1({
  schemaVersion: 'defense_budget_profile_job_v1',
  jobId: 'offline-startup-gate-profile',
  sourcePath,
  sourceSha256,
  engine: 'deterministic_pdfplumber',
  allPages: true,
  requestedPages: [],
  parserVersion: pdfplumberVersion,
  parserConfig: DEFAULT_PROFILING_THRESHOLDS,
  parserConfigSha256: computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS),
  outputDirectory: outDir,
  includeDebugArtifacts: false,
});
writeFileSync(join(outDir, 'profile.job.json'), `${JSON.stringify(profileJob, null, 2)}\n`, 'utf8');

// Parse jobs: identical construction to ParserRouterV1Service.executeLocalStep.
const parserConfig = getDefaultParserConfig(engine);
const parserConfigSha256 = computeParserConfigSha256(parserConfig);
const written: string[] = ['profile.job.json'];
for (const page of pages) {
  const job = parseParserRuntimeJobV1({
    schemaVersion: 'defense_budget_parser_job_v1',
    jobId: `offline-startup-gate-p${page}`,
    sourcePath,
    sourceSha256,
    engine,
    requestedPages: [page],
    parserVersion: engineVersion,
    parserConfig,
    parserConfigSha256,
    outputDirectory: join(outDir, '..', `p${page}`),
    includeDebugArtifacts: false,
  });
  const name = `p${page}.job.json`;
  writeFileSync(join(outDir, name), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  written.push(name);
}

console.log(
  JSON.stringify({
    outDir,
    engine,
    engineVersion,
    pdfplumberVersion,
    profilingConfigSha256: profileJob.parserConfigSha256,
    parserConfigSha256,
    pages,
    written,
  }),
);
