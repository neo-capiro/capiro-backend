/**
 * Safety posture for the generalized defense-budget PDF command.
 *
 * Phase A freezes canonical writes until the project-wide USD-millions contract
 * is repaired and independently verified. The absence of a posture flag is the
 * safest possible mode: local/S3-name preflight only, with no network or DB I/O.
 */
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

  if (commit) return 'commit';
  if (extractOnly || dryRunAlias) return 'extract_only';
  return 'preflight';
}

/** True only when the deprecated flag selected extract-only behavior. */
export function usesDeprecatedDryRunAlias(argv: readonly string[]): boolean {
  return argv.includes(DRY_RUN);
}
