/** @cleanup-smoke noArgsExit=1 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ENTITY_RESOLUTION_GOLDEN_CORPUS } from '../src/knowledge/entities/entity-resolution-golden-corpus.js';
import {
  evaluateEntityResolutionGoldenCorpus,
  type EntityResolutionGoldenObservation,
} from '../src/knowledge/entities/entity-resolution-evaluator.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
    },
  });
  const path = values.results?.trim();
  if (!path) {
    console.error('Usage: eval-canonical-entity-resolution --results <json-file>');
    throw new Error('--results <json-file> is required');
  }

  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('Golden results file must contain a JSON array.');
  }
  const observations = parsed as EntityResolutionGoldenObservation[];
  const report = evaluateEntityResolutionGoldenCorpus(
    ENTITY_RESOLUTION_GOLDEN_CORPUS,
    observations,
  );
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[eval-canonical-entity-resolution] ${message}`);
  process.exit(1);
});
