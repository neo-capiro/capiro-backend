/**
 * Phase 10B-10 Part I -- the mutation gate for
 * `replay-defense-budget-ingestion-outbox-v1`, extracted as a pure function
 * so "supplying --outbox-row-id/--reason/--actor alone never mutates" is
 * directly unit-testable without a database connection, separate from
 * `replayDeadLetterForVerifierFixV1` itself (which is what actually performs
 * the one-row transition once this gate is open).
 *
 * Same convention as execute-defense-budget-promotion-v1 and
 * rollback-defense-budget-snapshot-v1: dry run unless `--commit`; `--commit`
 * additionally requires `--confirm <environment>` to echo the target
 * environment exactly.
 */
export interface ReplayCommitGateInputV1 {
  commit: boolean;
  confirm: string | undefined;
  environment: string;
}

export interface ReplayCommitGateResultV1 {
  /** True only when the caller may proceed to call replayDeadLetterForVerifierFixV1. */
  allowed: boolean;
  mode: 'dry_run' | 'commit';
  /** Set only when mode='commit' and allowed=false -- a usage error, not a legitimate dry run. */
  refusalReason?: string;
}

export function evaluateReplayCommitGateV1(input: ReplayCommitGateInputV1): ReplayCommitGateResultV1 {
  if (!input.commit) {
    // Not a refusal: the default, safe behavior. Supplying
    // --outbox-row-id/--reason/--actor alone must never be enough to mutate.
    return { allowed: false, mode: 'dry_run' };
  }
  if (input.confirm !== input.environment) {
    return {
      allowed: false,
      mode: 'commit',
      refusalReason:
        `--commit requires --confirm ${input.environment} (echo the target environment exactly); ` +
        `got ${input.confirm ?? 'nothing'}`,
    };
  }
  return { allowed: true, mode: 'commit' };
}
