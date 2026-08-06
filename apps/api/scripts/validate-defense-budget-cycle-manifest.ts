/**
 * Local-only validator for defense_budget_cycle_manifest_v1 files.
 *
 *   pnpm --filter @capiro/api validate:defense-budget-manifest -- \
 *     --manifest apps/api/scripts/__config__/defense-budget-cycle-manifest.example.json
 *
 * Behavior:
 *   - Parses JSON, runs Zod schema validation plus manifest semantic rules.
 *   - Prints a deterministic JSON summary.
 *   - Exit 0 when valid; exit 1 with path-specific errors when invalid.
 *   - No network, no database, no file writes.
 */
import * as fs from 'node:fs';
import {
  parseBudgetCycleManifestV1,
  validateBudgetCycleManifestV1,
  type ManifestFindingV1,
} from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';

export interface ManifestValidationResult {
  valid: boolean;
  manifestPath: string;
  cycleId?: string;
  fiscalYear?: number;
  documentCount?: number;
  findings: ManifestFindingV1[];
  schemaErrors?: string[];
}

export interface ManifestValidatorArgs {
  manifestPath: string;
}

export class ManifestValidatorArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidatorArgError';
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
export function validateManifestFile(manifestPath: string): ManifestValidationResult {
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const json = JSON.parse(raw) as unknown;
    const manifest = parseBudgetCycleManifestV1(json);
    const findings = validateBudgetCycleManifestV1(manifest);
    const valid = findings.every((finding) => finding.severity !== 'error');
    return {
      valid,
      manifestPath,
      cycleId: manifest.cycleId,
      fiscalYear: manifest.fiscalYear,
      documentCount: manifest.documents.length,
      findings,
    };
  } catch (cause) {
    return {
      valid: false,
      manifestPath,
      findings: [],
      schemaErrors: errorMessages(cause),
    };
  }
}

export function parseManifestValidatorArgs(argv: readonly string[]): ManifestValidatorArgs {
  let manifestPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token !== '--manifest') {
      throw new ManifestValidatorArgError(`unknown argument: ${token}`);
    }
    if (manifestPath != null) {
      throw new ManifestValidatorArgError('duplicate --manifest');
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--') || value.trim() === '') {
      throw new ManifestValidatorArgError('--manifest requires a nonblank file path');
    }
    manifestPath = value;
    index += 1;
  }
  if (manifestPath == null) {
    throw new ManifestValidatorArgError('missing required --manifest');
  }
  return { manifestPath };
}

function main(): void {
  try {
    const args = parseManifestValidatorArgs(process.argv.slice(2));
    const result = validateManifestFile(args.manifestPath);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
  } catch (cause) {
    console.error(
      'Usage: validate-defense-budget-cycle-manifest.ts --manifest <manifest.json>',
    );
    console.error(`validate-defense-budget-cycle-manifest: ${errorMessages(cause).join('; ')}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] != null && process.argv[1].endsWith('validate-defense-budget-cycle-manifest.ts');
if (invokedDirectly) {
  main();
}
