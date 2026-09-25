/**
 * Run the isolated FY2027 HASC Package 3 qualification and emit portable
 * evidence. This command never registers a production manifest, opens a
 * database, performs a backfill, publishes data, or sends notifications.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { runHascFy2027QualificationV1 } from '../src/defense-budget/stages/hasc-fy2027-qualification-harness-v1.js';

const repositoryRoot = resolve(__dirname, '../../..');
const packetPath = resolve(
  repositoryRoot,
  'docs/defense-budget/package-3/qualification/hasc-fy2027-rdte-mark-only.json',
);
const defaultOutputPath = resolve(
  repositoryRoot,
  'docs/defense-budget/package-3/qualification/qualification-result.json',
);

function outputPathFromArgs(argv: readonly string[]): string {
  const index = argv.indexOf('--out');
  if (index === -1) return defaultOutputPath;
  const value = argv[index + 1];
  if (value == null || value.trim() === '') throw new Error('--out requires a path');
  return resolve(process.cwd(), value);
}

async function main(): Promise<void> {
  const outputPath = outputPathFromArgs(process.argv.slice(2));
  const packetBytes = await readFile(packetPath);
  const artifactRoot = await mkdtemp(resolve(tmpdir(), 'capiro-p3-hasc-qualification-'));
  try {
    const result = await runHascFy2027QualificationV1({ packetBytes, artifactRoot });
    const report = {
      schema: 'package3_congressional_qualification_result_v1',
      decision: 'QUALIFIED_ISOLATED_PILOT',
      qualificationOnly: result.qualification_only,
      productionRegistration: result.production_registration,
      databaseWritten: false,
      backfill: result.backfill,
      publication: result.publication,
      notificationsSent: false,
      source: {
        documentKey: 'CRPT-119hrpt698',
        sha256: result.sourceSha256,
        retainedUri: result.retainedSourceUri,
        retainedVersionId: result.retainedSourceVersionId,
        pages: result.sourcePages,
      },
      governedPacket: {
        path: relative(repositoryRoot, packetPath).replaceAll('\\', '/'),
        byteSha256: result.governedPacketSha256,
        rowCount: result.governedRowCount,
        markTotalDollars: result.governedMarkTotalDollars,
        requestAssertionCount: result.requestAssertionCount,
        markAssertionCount: result.markAssertionCount,
      },
      persistedProof: {
        stageProfileSha256: result.stageProfileSha256,
        parserResultByteSha256: result.parserResultByteSha256,
        parserResultByteLength: result.parserResultByteLength,
        semanticArtifactId: result.artifactId,
        semanticArtifactByteSha256: result.artifactByteSha256,
        sourceFactCount: result.sourceFactCount,
        assertionCount: result.assertionCount,
        evidenceCount: result.evidenceCount,
        warningCount: result.warningCount,
        omissionCount: result.omissionCount,
        completenessStatus: result.completenessStatus,
        storageScope: 'disposable_local_directory_removed_after_run',
      },
      limitations: [
        'RDT&E-only HASC qualification cohort; not the mixed-family production HASC profile.',
        'The proof represents the governed reviewed row packet and pypdf provenance; it does not rerun the production lifecycle worker.',
        'No production manifest admission, database write, historical backfill, publication, notification, or feature-flag activation occurred.',
      ],
    };
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(artifactRoot, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
