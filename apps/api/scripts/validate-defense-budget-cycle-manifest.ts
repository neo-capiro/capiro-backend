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

/** Pure validation entry — importable for unit tests without spawning. */
export function validateManifestFile(manifestPath: string): ManifestValidationResult {
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const json = JSON.parse(raw) as unknown;

  try {
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
    const schemaErrors =
      cause != null && typeof cause === 'object' && 'issues' in cause
        ? (cause as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues.map(
            (issue) => `${issue.path.join('.')}: ${issue.message}`,
          )
        : [(cause as Error).message];
    return { valid: false, manifestPath, findings: [], schemaErrors };
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const manifestPath = argValue('manifest');
  if (manifestPath == null) {
    console.error('Usage: validate-defense-budget-cycle-manifest.ts --manifest <manifest.json>');
    process.exit(1);
  }

  const result = validateManifestFile(manifestPath);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] != null && process.argv[1].endsWith('validate-defense-budget-cycle-manifest.ts');
if (invokedDirectly) {
  main();
}
