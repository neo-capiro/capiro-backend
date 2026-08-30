/**
 * replay-defense-budget-ingestion-outbox-v1 (Phase 10B-10 Part I).
 *
 * Narrowly scoped operator command for governed terminal-replay of exactly
 * one `dead_letter` governed-ingestion-outbox row. See
 * `defense-budget-ingestion-outbox-replay-v1.ts` for the full eligibility
 * contract and why a raw SQL state reset is not used instead.
 *
 *   replay-defense-budget-ingestion-outbox-v1 --environment <env> \
 *     --outbox-row-id <uuid> --reason "<text>" --actor "<identity>" \
 *     [--commit --confirm <env>]
 *
 * Exact-row only: no batch flag, no "all dead letters", no family/FY sweep.
 *
 * It is `dry_run` unless `--commit`, matching every other trust-critical
 * defense-budget operator verb in this directory
 * (execute-defense-budget-promotion-v1, rollback-defense-budget-snapshot-v1,
 * resume-defense-budget-promotion-side-effects-v1): supplying
 * --outbox-row-id/--reason/--actor alone must never mutate anything on its
 * own. `--commit` additionally requires `--confirm <environment>` echoing
 * the target environment exactly -- the realistic operator error this
 * catches is pasting the right row id against the wrong environment.
 *
 * Always previews and prints the target row's current disposition BEFORE
 * evaluating eligibility or attempting any mutation, in both dry-run and
 * commit mode, and refuses (without mutating) if it is not currently
 * eligible.
 *
 * Exit codes: 0 committed or clean dry run, 3 refused, 2 usage, 1 error.
 */
import { PrismaClient } from '@prisma/client';
import {
  createGovernedReplayRepositoryV1,
  GovernedReplayValidationErrorV1,
  type GovernedReplayPreviewV1,
} from '../src/defense-budget/governed-replay/defense-budget-ingestion-outbox-replay-v1.js';
import { evaluateReplayCommitGateV1 } from '../src/defense-budget/governed-replay/replay-commit-gate-v1.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function usage(message: string): never {
  console.error(`replay-defense-budget-ingestion-outbox-v1: ${message}`);
  console.error(
    'usage: replay-defense-budget-ingestion-outbox-v1 --environment <env> --outbox-row-id <uuid> ' +
      '--reason "<text>" --actor "<identity>" [--commit --confirm <env>]',
  );
  process.exit(2);
}
function refuse(message: string): never {
  console.error(`refusing: ${message}`);
  process.exit(3);
}

/** Null when the row is not currently eligible; also the reason it isn't. */
function ineligibilityReason(rowId: string, preview: GovernedReplayPreviewV1 | null): string | null {
  if (!preview) return `no outbox row found for id ${rowId}`;
  if (preview.state !== 'dead_letter') {
    return `row ${rowId} is state="${preview.state}", not "dead_letter" -- this command never resets a non-terminal row`;
  }
  if (preview.leasedBy != null) return `row ${rowId} is currently leased by ${preview.leasedBy}`;
  if (preview.governedDisposition !== 'verification_rejected' || preview.verifierDecision !== 'REJECT') {
    return (
      `row ${rowId} governedDisposition="${preview.governedDisposition}" ` +
      `verifierDecision="${preview.verifierDecision}" is not a supported replay-eligible disposition ` +
      `(only governedDisposition="verification_rejected" + verifierDecision="REJECT" is supported today)`
    );
  }
  return null;
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  const rowId = argValue('--outbox-row-id');
  const reason = argValue('--reason');
  const actor = argValue('--actor');
  const commit = process.argv.includes('--commit');
  const confirm = argValue('--confirm');

  if (!environment) usage('--environment is required');
  if (!rowId) usage('--outbox-row-id is required (exact row only -- no batch/family/FY sweep flag exists)');
  if (!reason) usage('--reason is required');
  if (!actor) usage('--actor is required');
  // Checked before ever touching the database: a --commit with a wrong or
  // absent --confirm must perform zero UPDATEs, for any environment,
  // production included. `gate.allowed` is the ONLY thing below that may
  // authorize calling replayDeadLetterForVerifierFixV1.
  const gate = evaluateReplayCommitGateV1({ commit, confirm, environment });
  if (gate.mode === 'commit' && !gate.allowed) usage(gate.refusalReason!);

  const prisma = new PrismaClient();
  try {
    const repository = createGovernedReplayRepositoryV1(prisma);

    const preview = await repository.previewReplayTarget(rowId);
    console.log(
      JSON.stringify(
        {
          phase: 'preview',
          mode: gate.mode,
          environment,
          outboxRowId: rowId,
          target: preview,
        },
        null,
        2,
      ),
    );

    const reasonIneligible = ineligibilityReason(rowId, preview);
    if (reasonIneligible) {
      if (!gate.allowed) {
        // Dry run still reports ineligibility, but reports it as a clean
        // dry run (exit 0), not a refusal -- there was never going to be a
        // mutation to refuse.
        console.log(
          JSON.stringify({ phase: 'dry_run_result', wouldMutate: false, reason: reasonIneligible }, null, 2),
        );
        return;
      }
      refuse(reasonIneligible);
    }

    const wouldChange = {
      state: 'pending',
      leasedBy: null,
      leasedUntil: null,
      lastError: null,
      metadataJsonb: 'governedDisposition/verifierDecision removed from top level; appended to replayHistory[]',
      attempts: preview!.attempts,
    };

    if (!gate.allowed) {
      console.log(JSON.stringify({ phase: 'dry_run_result', wouldMutate: true, wouldChange }, null, 2));
      console.log('dry run -- no UPDATE issued. Re-run with --commit --confirm ' + environment + ' to mutate.');
      return;
    }

    const result = await repository.replayDeadLetterForVerifierFixV1({
      rowId,
      now: new Date(),
      actor,
      reason,
    });
    if (!result) {
      refuse(
        `row ${rowId} was no longer eligible at mutation time (concurrent replay, or state changed between preview and mutation)`,
      );
    }
    console.log(JSON.stringify({ phase: 'committed', outboxRowId: rowId, result }, null, 2));
  } catch (error) {
    if (error instanceof GovernedReplayValidationErrorV1) {
      usage(error.message);
    }
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('replay-defense-budget-ingestion-outbox-v1 FAILED:', error);
  process.exit(1);
});
