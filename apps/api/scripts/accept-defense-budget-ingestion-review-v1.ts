/**
 * accept-defense-budget-ingestion-review-v1 (Phase 10B-15 Parts E/F).
 *
 * Narrowly scoped operator command for governed REVIEW acceptance of
 * exactly one `dead_letter` governed-ingestion-outbox row. Separate from,
 * and never reusing, replay-defense-budget-ingestion-outbox-v1 -- that
 * command is intentionally for `governedDisposition:'verification_rejected'`
 * + `verifierDecision:'REJECT'` rows being retried after a code/policy fix,
 * and refuses any row whose verifierDecision is not exactly 'REJECT'. This
 * is the mirror-image command for the opposite terminal disposition
 * (`governedDisposition:'review_required'` + `verifierDecision:'REVIEW'`),
 * advanced not by a code fix but by a pre-existing, immutable human
 * acceptance recorded via review-defense-budget-verification-v1 /
 * `BudgetReviewDecisionV1`.
 *
 * The verifier decision itself is NEVER changed by this command --
 * `verifierDecision:'REVIEW'` remains a permanent, truthful fact in the
 * row's metadata forever. See
 * defense-budget-ingestion-outbox-review-acceptance-v1.ts for the full
 * eligibility contract (acceptance-eligibility policy: zero FAIL checks,
 * all reconcilable-evidence checks PASS, every remaining discrepancy in
 * the one allowed irreducible-omission class).
 *
 *   accept-defense-budget-ingestion-review-v1 --environment <env> \
 *     --outbox-row-id <uuid> --review-decision-id <uuid> \
 *     --actor "<identity>" --reason "<text>" \
 *     [--commit --confirm <env>]
 *
 * Exact-row only: no batch flag, no "all dead letters", no family/FY sweep.
 *
 * Dry-run by default, matching every other trust-critical defense-budget
 * operator verb in this directory. `--commit` additionally requires
 * `--confirm <environment>` echoing the target environment exactly.
 *
 * Always previews the target row's current disposition AND the full
 * binding+eligibility result BEFORE attempting any mutation, in both
 * dry-run and commit mode, and refuses (without mutating) if not
 * currently eligible.
 *
 * Exit codes: 0 committed or clean dry run, 3 refused, 2 usage, 1 error.
 */
import { PrismaClient } from '@prisma/client';
import {
  createReviewAcceptanceRepositoryV1,
  ReviewAcceptanceValidationErrorV1,
} from '../src/defense-budget/governed-acceptance/defense-budget-ingestion-outbox-review-acceptance-v1.js';
import { evaluateReviewAcceptanceCommitGateV1 } from '../src/defense-budget/governed-acceptance/review-acceptance-commit-gate-v1.js';
import { createPrismaBudgetVerificationRepository } from '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function usage(message: string): never {
  console.error(`accept-defense-budget-ingestion-review-v1: ${message}`);
  console.error(
    'usage: accept-defense-budget-ingestion-review-v1 --environment <env> --outbox-row-id <uuid> ' +
      '--review-decision-id <uuid> --actor "<identity>" --reason "<text>" [--commit --confirm <env>]',
  );
  process.exit(2);
}
function refuse(message: string): never {
  console.error(`refusing: ${message}`);
  process.exit(3);
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  const rowId = argValue('--outbox-row-id');
  const reviewDecisionId = argValue('--review-decision-id');
  const reason = argValue('--reason');
  const actor = argValue('--actor');
  const commit = process.argv.includes('--commit');
  const confirm = argValue('--confirm');

  if (!environment) usage('--environment is required');
  if (!rowId) usage('--outbox-row-id is required (exact row only -- no batch/family/FY sweep flag exists)');
  if (!reviewDecisionId) usage('--review-decision-id is required');
  if (!reason) usage('--reason is required');
  if (!actor) usage('--actor is required');
  // Checked before ever touching the database: a --commit with a wrong or
  // absent --confirm must perform zero UPDATEs, for any environment,
  // production included. `gate.allowed` is the ONLY thing below that may
  // authorize calling acceptReviewedIngestionV1.
  const gate = evaluateReviewAcceptanceCommitGateV1({ commit, confirm, environment });
  if (gate.mode === 'commit' && !gate.allowed) usage(gate.refusalReason!);

  const prisma = new PrismaClient();
  try {
    const verificationRepository = createPrismaBudgetVerificationRepository(prisma);
    const repository = createReviewAcceptanceRepositoryV1(prisma, verificationRepository);

    const target = await repository.previewAcceptanceTarget(rowId);
    console.log(
      JSON.stringify({ phase: 'preview_target', mode: gate.mode, environment, outboxRowId: rowId, target }, null, 2),
    );

    const eligibility = await repository.previewAcceptanceEligibility({ rowId, reviewDecisionId });
    console.log(JSON.stringify({ phase: 'preview_eligibility', eligibility }, null, 2));

    if (!eligibility.ok) {
      if (!gate.allowed) {
        // Dry run still reports ineligibility, but reports it as a clean
        // dry run (exit 0), not a refusal -- there was never going to be a
        // mutation to refuse.
        console.log(
          JSON.stringify(
            { phase: 'dry_run_result', wouldMutate: false, reason: eligibility.reason, detail: eligibility.detail },
            null,
            2,
          ),
        );
        return;
      }
      refuse(`${eligibility.reason}: ${eligibility.detail}`);
    }

    const wouldChange = {
      state: 'succeeded',
      leasedBy: null,
      leasedUntil: null,
      lastError: null,
      readinessPhase: 'pending',
      metadataJsonb:
        'verifierDecision/governedDisposition preserved as truthful history; ingestionResolution=governed_review_accepted, reviewDecisionId/Hash, reviewAcceptedAt/By, acceptancePolicyId/Hash added; transition appended to governedAcceptanceHistory[]',
    };

    if (!gate.allowed) {
      console.log(JSON.stringify({ phase: 'dry_run_result', wouldMutate: true, wouldChange }, null, 2));
      console.log('dry run -- no UPDATE issued. Re-run with --commit --confirm ' + environment + ' to mutate.');
      return;
    }

    const result = await repository.acceptReviewedIngestionV1({
      rowId,
      reviewDecisionId,
      now: new Date(),
      actor,
      reason,
    });
    if (!result.ok) {
      refuse(`${result.reason}: ${result.detail}`);
    }
    console.log(JSON.stringify({ phase: 'committed', outboxRowId: rowId, result }, null, 2));
  } catch (error) {
    if (error instanceof ReviewAcceptanceValidationErrorV1) {
      usage(error.message);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('accept-defense-budget-ingestion-review-v1 FAILED:', error);
  process.exit(1);
});
