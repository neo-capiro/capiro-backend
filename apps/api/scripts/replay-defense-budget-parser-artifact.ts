/** Read-only replay proof for a local parser artifact descriptor. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FilesystemParserArtifactStore } from '../src/defense-budget/parser-router/parser-artifact-store.js';
import {
  computeParserRunCacheKey,
  computeParserRunId,
  parseParserArtifactDescriptorV1,
} from '../src/defense-budget/parser-router/parser-runtime-contract-v1.js';

function parseArgs(argv: string[]): { descriptor: string } {
  if (argv.length !== 2 || argv[0] !== '--descriptor' || !argv[1]) {
    throw new Error('--descriptor <metadata.json> is required and no other flags are accepted');
  }
  return { descriptor: path.resolve(argv[1]) };
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  let descriptor;
  try {
    descriptor = parseParserArtifactDescriptorV1(
      JSON.parse(fs.readFileSync(args.descriptor, 'utf8')),
    );
  } catch (error) {
    console.error(`descriptor validation failed: ${(error as Error).message}`);
    process.exit(3);
  }
  if (descriptor.resultLocator.startsWith('s3://')) {
    console.error(
      'S3 replay requires the injected S3ParserArtifactStore boundary; this local command does not silently resolve AWS credentials',
    );
    process.exit(3);
  }

  const identity = {
    sourceSha256: descriptor.sourceSha256,
    method: descriptor.method,
    parserVersion: descriptor.parserVersion,
    parserConfigSha256: descriptor.parserConfigSha256,
    pages: descriptor.requestedPages,
    runtimeContractVersion: descriptor.runtimeContractVersion,
  };
  const cacheKeyMatch = computeParserRunCacheKey(identity) === descriptor.cacheKey;
  const parserRunIdMatch = computeParserRunId(identity) === descriptor.parserRunId;

  try {
    const store = new FilesystemParserArtifactStore(path.dirname(args.descriptor));
    const result = await store.readVerified(descriptor);
    const report = {
      descriptorPath: args.descriptor,
      resultLocator: descriptor.resultLocator,
      cacheKeyMatch,
      parserRunIdMatch,
      byteSha256Match: true,
      contentSha256Match: result.contentSha256 === descriptor.contentSha256,
      sourceSha256Match: result.inputSourceSha256 === descriptor.sourceSha256,
      methodMatch: result.engine === descriptor.method,
      parserVersionMatch: result.parserVersion === descriptor.parserVersion,
      parserConfigSha256Match: result.parserConfigSha256 === descriptor.parserConfigSha256,
      requestedPagesMatch:
        JSON.stringify(result.requestedPages) === JSON.stringify(descriptor.requestedPages),
      overallProofValid: cacheKeyMatch && parserRunIdMatch,
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.overallProofValid) {
      console.error('proof invalid: descriptor identity does not recompute');
      process.exit(3);
    }
    process.exit(0);
  } catch (error) {
    console.error(`proof invalid: ${(error as Error).message}`);
    process.exit(3);
  }
}

main().catch((error) => {
  console.error(`internal failure: ${(error as Error).message}`);
  process.exit(9);
});
