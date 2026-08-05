/** Cheap deterministic full-document page profiler. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBudgetCycleManifestV1 } from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import {
  DEFAULT_PROFILING_THRESHOLDS,
  computeProfilingConfigSha256,
  parseDocumentProfileResultV1,
} from '../src/defense-budget/parser-router/page-profiler.js';
import { LocalParserRuntimeClient } from '../src/defense-budget/parser-router/local-parser-runtime-client.js';

const FLAGS = new Set(['--manifest', '--document', '--source', '--out', '--force']);

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  let force = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    if (flag === '--force') {
      force = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
  }
  const manifest = values.get('--manifest');
  const document = values.get('--document');
  const source = values.get('--source');
  const out = values.get('--out');
  if (!manifest || !document || !source || !out) {
    throw new Error('--manifest, --document, --source, and --out are required');
  }
  return { manifest, document, source, out, force };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = parseBudgetCycleManifestV1(
      JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8')),
    );
  } catch (error) {
    console.error(`manifest validation failed: ${(error as Error).message}`);
    process.exit(2);
  }
  const document = manifest.documents.find((item) => item.documentKey === args.document);
  if (!document) {
    console.error(`document not found in manifest: ${args.document}`);
    process.exit(2);
  }

  const sourcePath = path.resolve(args.source);
  const outputPath = path.resolve(args.out);
  if (!fs.existsSync(sourcePath)) {
    console.error(`source file not found: ${sourcePath}`);
    process.exit(3);
  }
  if (fs.existsSync(outputPath) && !args.force) {
    console.error(`output exists: ${outputPath}; use --force to overwrite`);
    process.exit(2);
  }

  const sourceSha256 = sha256File(sourcePath);
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const parserProjectDir = path.resolve(__dirname, '../../defense-budget-parser');
  const client = new LocalParserRuntimeClient({
    command: 'uv',
    commandArgs: ['run', 'capiro-defense-budget-parser'],
    cwd: parserProjectDir,
    workDir: outputDirectory,
  });

  try {
    const versions = await client.getVersionInfo();
    const parserVersion = versions.engines.deterministic_pdfplumber;
    if (!parserVersion) throw new Error('runtime did not report pdfplumber version');
    const job = {
      schemaVersion: 'defense_budget_parser_job_v1' as const,
      jobId: `profile-${document.documentKey}-${sourceSha256.slice(0, 16)}`,
      sourcePath,
      sourceSha256,
      engine: 'deterministic_pdfplumber' as const,
      requestedPages: [],
      parserVersion,
      parserConfig: DEFAULT_PROFILING_THRESHOLDS,
      parserConfigSha256: computeProfilingConfigSha256(DEFAULT_PROFILING_THRESHOLDS),
      outputDirectory,
      includeDebugArtifacts: false,
    };
    const jobPath = path.join(outputDirectory, `${job.jobId}.job.json`);
    fs.writeFileSync(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    const execution = await client.profileJob(jobPath, outputPath);
    if (execution.exitCode !== 0) {
      throw new Error(execution.stderr || `profiler exited ${execution.exitCode}`);
    }
    const profile = parseDocumentProfileResultV1(
      JSON.parse(fs.readFileSync(outputPath, 'utf8')),
    );
    if (profile.sourceSha256 !== sourceSha256 || profile.pages.length === 0) {
      throw new Error('profile is empty or not bound to the supplied source bytes');
    }
    console.log(
      JSON.stringify(
        {
          documentKey: document.documentKey,
          sourceSha256,
          profileContentSha256: profile.contentSha256,
          pageCount: profile.pages.length,
          summary: profile.summary,
          outputPath,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (error) {
    const message = (error as Error).message;
    console.error(`profiler failed: ${message}`);
    process.exit(/SHA/i.test(message) ? 3 : 9);
  }
}

main().catch((error) => {
  console.error(`internal failure: ${(error as Error).message}`);
  process.exit(9);
});
