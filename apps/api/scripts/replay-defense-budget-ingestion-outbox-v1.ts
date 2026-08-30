/**
 * Phase 10B-10 Part I -- narrowly scoped operator command for governed
 * terminal-replay of exactly one `dead_letter` governed-ingestion-outbox
 * row. See `defense-budget-ingestion-outbox-replay-v1.ts` for the full
 * eligibility contract and why a raw SQL state reset is not used instead.
 *
 * Exact-row only: no batch flag, no "all dead letters", no family/FY sweep.
 * Always prints the target row's current disposition BEFORE attempting any
 * mutation, and refuses (without mutating) if it is not currently eligible.
 */
import { PrismaClient } from '@prisma/client';
import {
  createGovernedReplayRepositoryV1,
  GovernedReplayValidationErrorV1,
} from '../src/defense-budget/governed-replay/defense-budget-ingestion-outbox-replay-v1.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function usage(message: string): never {
  console.error(`replay-defense-budget-ingestion-outbox-v1: ${message}`);
  console.error(
    'usage: replay-defense-budget-ingestion-outbox-v1 --outbox-row-id <uuid> --reason "<text>" --actor "<identity>"',
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const rowId = argValue('--outbox-row-id');
  const reason = argValue('--reason');
  const actor = argValue('--actor');
  if (!rowId) usage('--outbox-row-id is required (exact row only -- no batch/family/FY sweep flag exists)');
  if (!reason) usage('--reason is required');
  if (!actor) usage('--actor is required');

  const prisma = new PrismaClient();
  try {
    const repository = createGovernedReplayRepositoryV1(prisma);

    const preview = await repository.previewReplayTarget(rowId);
    console.log(
      JSON.stringify(
        { phase: 'preview_before_mutation', outboxRowId: rowId, target: preview },
        null,
        2,
      ),
    );
    if (!preview) {
      console.error(`refusing: no outbox row found for id ${rowId}`);
      process.exit(1);
    }
    if (preview.state !== 'dead_letter') {
      console.error(
        `refusing: row ${rowId} is state="${preview.state}", not "dead_letter" -- this command never resets a non-terminal row`,
      );
      process.exit(1);
    }
    if (preview.leasedBy != null) {
      console.error(`refusing: row ${rowId} is currently leased by ${preview.leasedBy}`);
      process.exit(1);
    }
    if (preview.governedDisposition !== 'verification_rejected' || preview.verifierDecision !== 'REJECT') {
      console.error(
        `refusing: row ${rowId} governedDisposition="${preview.governedDisposition}" ` +
          `verifierDecision="${preview.verifierDecision}" is not a supported replay-eligible disposition ` +
          `(only governedDisposition="verification_rejected" + verifierDecision="REJECT" is supported today)`,
      );
      process.exit(1);
    }

    const result = await repository.replayDeadLetterForVerifierFixV1({
      rowId,
      now: new Date(),
      actor,
      reason,
    });
    if (!result) {
      console.error(
        `refusing: row ${rowId} was no longer eligible at mutation time (concurrent replay, or state changed between preview and mutation)`,
      );
      process.exit(1);
    }
    console.log(JSON.stringify({ phase: 'replayed', outboxRowId: rowId, result }, null, 2));
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
