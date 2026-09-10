/**
 * Phase 10B-15 Part E -- the mutation gate for
 * `accept-defense-budget-ingestion-review-v1`, extracted as a pure function
 * so "supplying --outbox-row-id/--review-decision-id/--actor/--reason alone
 * never mutates" is directly unit-testable without a database connection --
 * same convention as `evaluateReplayCommitGateV1`,
 * execute-defense-budget-promotion-v1, and rollback-defense-budget-snapshot-v1:
 * dry run unless `--commit`; `--commit` additionally requires `--confirm
 * <environment>` to echo the target environment exactly.
 */
export interface ReviewAcceptanceCommitGateInputV1 {
  commit: boolean;
  confirm: string | undefined;
  environment: string;
}

export interface ReviewAcceptanceCommitGateResultV1 {
  /** True only when the caller may proceed to call acceptReviewedIngestionV1. */
  allowed: boolean;
  mode: 'dry_run' | 'commit';
  /** Set only when mode='commit' and allowed=false -- a usage error, not a legitimate dry run. */
  refusalReason?: string;
}

export function evaluateReviewAcceptanceCommitGateV1(
  input: ReviewAcceptanceCommitGateInputV1,
): ReviewAcceptanceCommitGateResultV1 {
  if (!input.commit) {
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
