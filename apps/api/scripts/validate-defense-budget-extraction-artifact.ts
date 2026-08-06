/**
 * Local-only validator for defense_budget_extraction_v1 artifacts.
 *
 *   pnpm --filter @capiro/api validate:defense-budget-artifact -- \
 *     --artifact <output.extraction-v1.json> [--require-complete]
 *
 * Behavior:
 *   - Parses JSON, validates schema, semantics, references, summary, and hash.
 *   - Prints a deterministic summary and findings.
 *   - Exit 1 on file/JSON/schema/semantic error.
 *   - With --require-complete: exit 1 on any non-complete status.
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

export interface ArtifactValidatorArgs {
  artifactPath: string;
  requireComplete: boolean;
}

export class ArtifactValidatorArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactValidatorArgError';
  }
}

function errorMessages(cause: unknown): string[] {
  if (cause != null && typeof cause === 'object' && 'issues' in cause) {
    return (cause as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues.map(
      (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
    );
  }
  if (cause instanceof Error) return [cause.message];
  return [String(cause)];
}

/** Pure validation entry — importable for unit tests without spawning. */
export function validateArtifactFile(
  artifactPath: string,
  options: { requireComplete?: boolean } = {},
): ArtifactValidationResult {
  const requireComplete = options.requireComplete === true;
  try {
    const raw = fs.readFileSync(artifactPath, 'utf8');
    const json = JSON.parse(raw) as unknown;
    const artifact = parseDefenseBudgetExtractionArtifactV1(json);
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
  } catch (cause) {
    return {
      valid: false,
      requireComplete,
      artifactPath,
      findings: [],
      schemaErrors: errorMessages(cause),
    };
  }
}

export function parseArtifactValidatorArgs(argv: readonly string[]): ArtifactValidatorArgs {
  let artifactPath: string | undefined;
  let requireComplete = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--require-complete') {
      if (requireComplete) {
        throw new ArtifactValidatorArgError('duplicate --require-complete');
      }
      requireComplete = true;
      continue;
    }
    if (token !== '--artifact') {
      throw new ArtifactValidatorArgError(`unknown argument: ${token}`);
    }
    if (artifactPath != null) {
      throw new ArtifactValidatorArgError('duplicate --artifact');
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--') || value.trim() === '') {
      throw new ArtifactValidatorArgError('--artifact requires a nonblank file path');
    }
    artifactPath = value;
    index += 1;
  }
  if (artifactPath == null) {
    throw new ArtifactValidatorArgError('missing required --artifact');
  }
  return { artifactPath, requireComplete };
}

function main(): void {
  try {
    const args = parseArtifactValidatorArgs(process.argv.slice(2));
    const result = validateArtifactFile(args.artifactPath, {
      requireComplete: args.requireComplete,
    });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  } catch (cause) {
    console.error(
      'Usage: validate-defense-budget-extraction-artifact.ts --artifact <artifact.json> [--require-complete]',
    );
    console.error(`validate-defense-budget-extraction-artifact: ${errorMessages(cause).join('; ')}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] != null &&
  process.argv[1].endsWith('validate-defense-budget-extraction-artifact.ts');
if (invokedDirectly) {
  main();
}
