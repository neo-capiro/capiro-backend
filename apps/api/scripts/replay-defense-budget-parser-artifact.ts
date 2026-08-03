/**
 * replay-defense-budget-parser-artifact — recompute and report proof dimensions.
 *
 *   pnpm --filter @capiro/api replay:defense-budget-parser-artifact -- \
 *     --descriptor <metadata.json>
 *
 * Behavior (M6):
 *   - Reads the artifact descriptor.
 *   - Recomputes byte SHA of the result file.
 *   - Parses the result against the strict result schema.
 *   - Recomputes result content SHA.
 *   - Compares source SHA, method/version/config SHA, requested pages.
 *   - Reports every proof dimension.
 *   - No parser call.
 *
 * Exit codes (M9): 0 proof valid, 2 argument failure, 3 proof/hash failure, 9 internal.
 */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
  parseParserRuntimeResultV1,
  computeResultContentSha256,
  verifyResultContentSha256,
} from '../src/defense-budget/parser-router/parser-runtime-contract-v1.js';

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function computeByteSha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ReplayReport {
  descriptorPath: string;
  resultPath: string;
  byteSha256: string;
  byteSha256Match: boolean;
  schemaValid: boolean;
  schemaErrors?: string[];
  contentSha256: string;
  contentSha256Match: boolean;
  recordedContentSha256?: string;
  sourceSha256: string;
  sourceSha256Match: boolean;
  method: string;
  methodMatch: boolean;
  parserVersion: string;
  versionMatch: boolean;
  configSha256: string;
  configSha256Match: boolean;
  requestedPages: number[];
  pagesMatch: boolean;
  overallProofValid: boolean;
}

function main(): void {
  const descriptorPath = argValue('descriptor');
  if (!descriptorPath) {
    console.error(
      'Usage: replay-defense-budget-parser-artifact.ts --descriptor <metadata.json>',
    );
    process.exit(2);
  }

  // Read descriptor
  let descriptor: Record<string, unknown>;
  try {
    descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  } catch (e) {
    console.error(`Cannot read descriptor: ${(e as Error).message}`);
    process.exit(2);
    return;
  }

  const resultPath = (descriptor['resultPath'] ?? descriptor['resultLocator']) as string;
  if (!resultPath || !fs.existsSync(resultPath)) {
    console.error(`Result file not found: ${resultPath ?? 'not specified in descriptor'}`);
    process.exit(3);
  }

  // 1. Read actual bytes
  const resultBytes = fs.readFileSync(resultPath);
  const byteSha = computeByteSha256(resultBytes);
  const recordedByteSha = descriptor['byteSha256'] as string | undefined;
  const byteShaMatch = recordedByteSha ? byteSha === recordedByteSha : false;

  // 2. Parse strict result schema
  let result;
  let schemaValid = true;
  let schemaErrors: string[] | undefined;
  try {
    result = parseParserRuntimeResultV1(JSON.parse(resultBytes.toString('utf8')));
  } catch (e) {
    schemaValid = false;
    schemaErrors = [(e as Error).message];
    console.error(`Schema validation failed: ${(e as Error).message}`);
    process.exit(3);
  }

  // 3. Recompute result content SHA
  const resultDict = JSON.parse(resultBytes.toString('utf8'));
  const recomputedContentSha = computeResultContentSha256(resultDict);
  const recordedContentSha = result.contentSha256;
  const contentShaMatch = recomputedContentSha === recordedContentSha;

  // 4. Compare source SHA
  const recordedSourceSha = descriptor['sourceSha256'] as string | undefined;
  const sourceShaMatch = recordedSourceSha
    ? result.inputSourceSha256 === recordedSourceSha
    : false;

  // 5. Compare method/version/config SHA
  const recordedMethod = descriptor['method'] as string | undefined;
  const methodMatch = recordedMethod ? result.engine === recordedMethod : false;

  const recordedVersion = descriptor['parserVersion'] as string | undefined;
  const versionMatch = recordedVersion
    ? result.parserVersion === recordedVersion
    : false;

  const recordedConfigSha = descriptor['parserConfigSha256'] as string | undefined;
  const configShaMatch = recordedConfigSha
    ? result.parserConfigSha256 === recordedConfigSha
    : false;

  // 6. Compare requested pages
  const recordedPages = descriptor['requestedPages'] as number[] | undefined;
  const pagesMatch = recordedPages
    ? JSON.stringify(result.requestedPages) === JSON.stringify(recordedPages)
    : false;

  const overallValid =
    byteShaMatch &&
    schemaValid &&
    contentShaMatch &&
    sourceShaMatch &&
    methodMatch &&
    versionMatch &&
    configShaMatch &&
    pagesMatch;

  const report: ReplayReport = {
    descriptorPath,
    resultPath,
    byteSha256: byteSha,
    byteSha256Match: byteShaMatch,
    schemaValid,
    schemaErrors,
    contentSha256: recomputedContentSha,
    contentSha256Match: contentShaMatch,
    recordedContentSha256: recordedContentSha,
    sourceSha256: result.inputSourceSha256,
    sourceSha256Match: sourceShaMatch,
    method: result.engine,
    methodMatch,
    parserVersion: result.parserVersion,
    versionMatch,
    configSha256: result.parserConfigSha256,
    configSha256Match: configShaMatch,
    requestedPages: result.requestedPages,
    pagesMatch,
    overallProofValid: overallValid,
  };

  console.log(JSON.stringify(report, null, 2));

  if (!overallValid) {
    console.error('\nPROOF INVALID — artifact is NOT replayable');
    process.exit(3);
  }

  console.log('\nProof valid — artifact is replayable');
  process.exit(0);
}

const invokedDirectly =
  process.argv[1] != null &&
  process.argv[1].endsWith('replay-defense-budget-parser-artifact.ts');
if (invokedDirectly) {
  main();
}
