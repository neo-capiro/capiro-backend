/**
 * Produce the deterministic, read-only, proof-bound future-canonical RDT&E
 * projection plan from a certified cycle output directory.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rdteCycleBundleV1Schema } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';
import { defenseBudgetExtractionArtifactV1Schema } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { planProofBoundRdteCanonicalProjection } from '../src/defense-budget/rdte/projection/rdte-proof-bound-projection-planner-v1.js';

const EXIT_OK = 0;
const EXIT_NEEDS_REVIEW = 2;
const EXIT_ERROR = 5;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  if (process.argv.includes('--commit')) {
    console.error('plan-rdte-canonical-projection never accepts --commit.');
    process.exit(EXIT_ERROR);
  }
  const cycleDir = argValue('cycle-dir');
  const outPath = argValue('out');
  if (!cycleDir || !outPath) {
    console.error('Usage: plan-rdte-canonical-projection.ts --cycle-dir <dir> --out <plan.json>');
    process.exit(EXIT_ERROR);
  }
  const bundlePath = path.join(cycleDir, 'cycle-bundle.json');
  const artifactsDir = path.join(cycleDir, 'artifacts');
  if (!fs.existsSync(bundlePath) || !fs.existsSync(artifactsDir)) {
    console.error('cycle-bundle.json and artifacts/ are required');
    process.exit(EXIT_ERROR);
  }
  const bundle = rdteCycleBundleV1Schema.parse(
    JSON.parse(fs.readFileSync(bundlePath, 'utf8')),
  );
  const artifacts = fs
    .readdirSync(artifactsDir)
    .filter((file) => file.endsWith('.extraction-v1.json'))
    .sort()
    .map((file) =>
      defenseBudgetExtractionArtifactV1Schema.parse(
        JSON.parse(fs.readFileSync(path.join(artifactsDir, file), 'utf8')),
      ),
    );
  try {
    const { plan } = planProofBoundRdteCanonicalProjection({ bundle, artifacts });
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    console.log(
      JSON.stringify({
        contentSha256: plan.contentSha256,
        candidates: plan.candidates.length,
        exclusions: plan.exclusions.length,
        out: outPath,
      }),
    );
    process.exit(EXIT_OK);
  } catch (error) {
    console.error(`projection refused: ${(error as Error).message}`);
    process.exit(EXIT_NEEDS_REVIEW);
  }
}

main();
