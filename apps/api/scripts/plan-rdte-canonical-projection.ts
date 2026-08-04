/**
 * plan-rdte-canonical-projection — produce the deterministic, read-only
 * future-canonical projection plan from a certified cycle (WS N / WS M).
 *
 * Usage:
 *   pnpm --filter @capiro/api plan:rdte-projection -- \
 *     --cycle-dir <cycle-output-directory> \
 *     --out <projection-plan.json>
 *
 * Reads cycle-bundle.json + artifacts/*.extraction-v1.json from the cycle
 * output directory produced by build-rdte-cycle, then runs the pure planner.
 *
 * This command NEVER accepts --commit and performs NO database write — the
 * projection plan is a read-only description of future Phase 7 writes.
 *
 * Exit codes:
 *   0 plan produced (cycle certified)
 *   2 needs review (cycle not certified — refusal printed)
 *   5 operational/configuration failure
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { rdteCycleBundleV1Schema } from '../src/defense-budget/rdte/rdte-cycle-bundle-v1.js';
import { defenseBudgetExtractionArtifactV1Schema } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { planRdteCanonicalProjection } from '../src/defense-budget/rdte/projection/rdte-projection-planner-v1.js';

const EXIT_OK = 0;
const EXIT_NEEDS_REVIEW = 2;
const EXIT_ERROR = 5;

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  /* Refuse --commit outright: projection is read-only by construction. */
  if (process.argv.includes('--commit')) {
    console.error('plan-rdte-canonical-projection never accepts --commit (read-only projection).');
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
  if (!fs.existsSync(bundlePath)) {
    console.error(`cycle bundle not found: ${bundlePath}`);
    process.exit(EXIT_ERROR);
  }
  if (!fs.existsSync(artifactsDir)) {
    console.error(`artifacts directory not found: ${artifactsDir}`);
    process.exit(EXIT_ERROR);
  }

  const bundle = rdteCycleBundleV1Schema.parse(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));

  const artifacts = [];
  for (const file of fs.readdirSync(artifactsDir).sort()) {
    if (!file.endsWith('.extraction-v1.json')) continue;
    const parsed = defenseBudgetExtractionArtifactV1Schema.parse(
      JSON.parse(fs.readFileSync(path.join(artifactsDir, file), 'utf8')),
    );
    artifacts.push(parsed);
  }

  let plan;
  try {
    const result = planRdteCanonicalProjection({ bundle, artifacts });
    plan = result.plan;
  } catch (err) {
    /* Uncertified cycle: refuse with a needs-review exit. */
    console.error(`projection refused: ${(err as Error).message}`);
    process.exit(EXIT_NEEDS_REVIEW);
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(plan, null, 2));
  console.log(
    JSON.stringify({
      contentSha256: plan.contentSha256,
      candidates: plan.candidates.length,
      exclusions: plan.exclusions.length,
      out: outPath,
    }),
  );
  process.exit(EXIT_OK);
}

main();
