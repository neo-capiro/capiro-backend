/**
 * Safety posture for the generalized defense-budget PDF command.
 *
 * Phase A made the absence of a posture flag the safest possible mode: local /
 * S3-name preflight only, with no network or DB I/O. Phase 7 adds a second,
 * independent boundary: even an exact-SHA `--commit` is a legacy canonical
 * write and is refused by default. Direct invocation must obey the same kill
 * switch as the dispatcher.
 */
import {
  assertLegacyBudgetWriteGateForLoaderV1,
  type LegacyBudgetWriteGateRuntimeV1,
} from './pe-exact-sha-loader-contract.js';

export type DefenseBudgetIngestPosture = 'preflight' | 'extract_only' | 'commit';

const EXTRACT_ONLY = '--extract-only';
const DRY_RUN = '--dry-run';
const COMMIT = '--commit';

/**
 * Resolve mutually-exclusive operator intent. Unknown flags are deliberately
 * ignored here because the main command owns flags such as --path, --mode and
 * --fy; this helper answers only the write/external-call posture question.
 */
export function resolveDefenseBudgetIngestPosture(
  argv: readonly string[],
  runtime: LegacyBudgetWriteGateRuntimeV1 = {},
): DefenseBudgetIngestPosture {
  const extractOnly = argv.includes(EXTRACT_ONLY);
  const dryRunAlias = argv.includes(DRY_RUN);
  const commit = argv.includes(COMMIT);
  const selected = [extractOnly, dryRunAlias, commit].filter(Boolean).length;

  if (selected > 1) {
    throw new Error(
      'Choose exactly one ingestion posture: --extract-only, deprecated --dry-run, or --commit.',
    );
  }

  if (commit) {
    assertLegacyBudgetWriteGateForLoaderV1(argv, {
      verb: runtime.verb ?? 'ingest-defense-budget',
      environment: runtime.environment,
    });
    return 'commit';
  }
  if (extractOnly || dryRunAlias) return 'extract_only';
  return 'preflight';
}

/** True only when the deprecated flag selected extract-only behavior. */
export function usesDeprecatedDryRunAlias(argv: readonly string[]): boolean {
  return argv.includes(DRY_RUN);
}
