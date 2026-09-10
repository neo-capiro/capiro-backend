/**
 * Phase 10B-18 Part F/M — pure CLI-argument decision for the two-flag
 * commit gate (`--commit --confirm <environment>`). Extracted so "wrong
 * --confirm causes zero mutation" is directly unit-testable without spawning
 * the real CLI process.
 */
export interface GovernedImportCommitIntentInput {
  readonly commitFlagPresent: boolean;
  readonly confirmValue: string | undefined;
  readonly environment: string;
}

export type GovernedImportCommitIntentResult =
  | { readonly commit: true }
  | { readonly commit: false; readonly error: string | null };

export function resolveGovernedImportCommitIntent(
  input: GovernedImportCommitIntentInput,
): GovernedImportCommitIntentResult {
  if (!input.commitFlagPresent) {
    return { commit: false, error: null };
  }
  if (input.confirmValue !== input.environment) {
    return {
      commit: false,
      error: `--commit requires --confirm ${input.environment} (the exact --environment value, typed out)`,
    };
  }
  return { commit: true };
}
