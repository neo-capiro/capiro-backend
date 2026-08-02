/**
 * Local-only validator for defense_budget_extraction_v1 artifacts.
 *
 *   pnpm --filter @capiro/api validate:defense-budget-artifact -- \
 *     --artifact <output.extraction-v1.json> [--require-complete]
 *
 * Behavior:
 *   - Parses JSON, validates schema, semantics, references, summary, and hash.
 *   - Prints a deterministic summary and findings.
 *   - Exit 1 on schema/semantic error.
 *   - With --require-complete: exit 1 on any omission or incomplete status.
 *   - Without --require-complete: a valid artifact with explicit omissions
 *     exits 0 while clearly reporting complete_with_omissions.
 *   - No network, no database, no file writes.
 */
import * as fs from 'node:fs';
import {
  parseDefenseBudgetExtractionArtifactV1,
  validateDefenseBudgetExtractionArtifactV1,
  type ContractFindingV1,
} from '../src/defense-budget/contracts/extraction-artifact-v1.semantic.js';
import type { CompletenessStatusV1 } from '../src/defense-budget/contracts/extraction-artifact-v1.js';

export interface ArtifactValidationResult {
  valid: boolean;
  requireComplete: boolean;
  artifactPath: string;
  artifactId?: string;
  completenessStatus?: CompletenessStatusV1;
  summary?: {
    sourceFactCount: number;
    assertionCount: number;
    warningCount: number;
    omissionCount: number;
  };
  findings: ContractFindingV1[];
  schemaErrors?: string[];
}

/** Pure validation entry — importable for unit tests without spawning. */
export function validateArtifactFile(
  artifactPath: string,
  options: { requireComplete?: boolean } = {},
): ArtifactValidationResult {
  const requireComplete = options.requireComplete === true;
  const raw = fs.readFileSync(artifactPath, 'utf8');
  const json = JSON.parse(raw) as unknown;

  let artifact;
  try {
    artifact = parseDefenseBudgetExtractionArtifactV1(json);
  } catch (cause) {
    const schemaErrors =
      cause != null && typeof cause === 'object' && 'issues' in cause
        ? (cause as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues.map(
            (issue) => `${issue.path.join('.')}: ${issue.message}`,
          )
        : [(cause as Error).message];
    return { valid: false, requireComplete, artifactPath, findings: [], schemaErrors };
  }

  const findings = validateDefenseBudgetExtractionArtifactV1(artifact);
  const hasError = findings.some((finding) => finding.severity === 'error');
  const blockedByCompleteness =
    requireComplete && artifact.summary.completenessStatus !== 'complete';

  return {
    valid: !hasError && !blockedByCompleteness,
    requireComplete,
    artifactPath,
    artifactId: artifact.artifactId,
    completenessStatus: artifact.summary.completenessStatus,
    summary: {
      sourceFactCount: artifact.summary.sourceFactCount,
      assertionCount: artifact.summary.assertionCount,
      warningCount: artifact.summary.warningCount,
      omissionCount: artifact.summary.omissionCount,
    },
    findings,
  };
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const artifactPath = argValue('artifact');
  if (artifactPath == null) {
    console.error(
      'Usage: validate-defense-budget-extraction-artifact.ts --artifact <artifact.json> [--require-complete]',
    );
    process.exit(1);
  }
  const requireComplete = process.argv.includes('--require-complete');

  const result = validateArtifactFile(artifactPath, { requireComplete });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] != null &&
  process.argv[1].endsWith('validate-defense-budget-extraction-artifact.ts');
if (invokedDirectly) {
  main();
}
