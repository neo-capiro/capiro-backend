/** @cleanup-smoke noArgsExit=1 */
/**
 * Phase 10B-35c -- record that a NEW (corrected) candidate corrects an OLD
 * (tainted) candidate, one explicit named pair at a time. Never a bulk sweep.
 *
 * Usage:
 *   pnpm --filter @capiro/api correct:defense-budget-candidate-v1 -- \
 *     --old-candidate-id <uuid> --new-candidate-id <uuid> \
 *     --actor <id> --reason-file <path> \
 *     [--commit]
 *
 * Behavior:
 *   - Dry-run/inspect by default. Prints the eligibility evaluation (old
 *     candidate status, new candidate status, source-identity match) and any
 *     existing correction link already on file for the old candidate, with
 *     ZERO writes.
 *   - --commit:
 *       1. supersedes every currently-active scoped fact review on the OLD
 *          candidate (idempotent -- a no-op if there are none, or if this is
 *          a retry);
 *       2. records exactly one `budget_candidate_correction_v1` row.
 *     A repeat run for the SAME (old, new) pair reports "already recorded"
 *     and exits 0 -- never a duplicate row. A run naming a DIFFERENT new
 *     candidate for an old candidate that already has a correction on file
 *     is refused (exit 1), naming the existing link -- an operator must
 *     resolve that conflict explicitly, never silently.
 *   - Never touches budget_review_decision_v1, the outbox, or any candidate's
 *     own status column. Never transfers a human scoped approval from the
 *     old candidate to the new one -- a fresh approval on the new candidate
 *     always requires its own real reviewer action
 *     (review:defense-budget-scoped-fact-v1).
 *
 * Exit codes: 0 success (dry-run, commit, or idempotent replay); 1
 * usage/execution error or refused conflict.
 */
import * as fs from 'node:fs';
import { CandidateCorrectionV1Service, CandidateCorrectionError } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-v1.service.js';
import { PrismaCandidateCorrectionRepositoryV1 } from '../src/defense-budget/governed-acceptance/candidate-correction/candidate-correction-repository-v1.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const KNOWN_FLAGS = new Set(['--old-candidate-id', '--new-candidate-id', '--actor', '--reason-file', '--commit']);

function parseArgs(argv: string[]) {
  const raw: Record<string, string | boolean> = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (!KNOWN_FLAGS.has(arg)) {
      console.error(`Unknown flag: ${arg}`);
      process.exit(EXIT_ERROR);
    }
    raw[arg] = arg === '--commit' ? true : (argv[++i] ?? '');
    i++;
  }
  const need = (flag: string): string => {
    const v = raw[flag];
    if (typeof v !== 'string' || v.length === 0) {
      console.error(`Missing ${flag}`);
      process.exit(EXIT_ERROR);
    }
    return v;
  };
  return {
    oldCandidateId: need('--old-candidate-id'),
    newCandidateId: need('--new-candidate-id'),
    actor: need('--actor'),
    reasonFile: need('--reason-file'),
    commit: raw['--commit'] === true,
  };
}

async function main(): Promise<void> {
  if (process.argv.length <= 2) console.error('Usage: correct-defense-budget-candidate-v1 --old-candidate-id <uuid> --new-candidate-id <uuid> --actor <id> --reason-file <path> [--commit]');
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.reasonFile)) {
    console.error(`reason file not found: ${args.reasonFile}`);
    process.exit(EXIT_ERROR);
  }
  const reason = fs.readFileSync(args.reasonFile, 'utf8');

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const { createPrismaBudgetVerificationRepository } = await import(
      '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js'
    );
    const verification = createPrismaBudgetVerificationRepository(prisma);
    const corrections = new PrismaCandidateCorrectionRepositoryV1(prisma as never);
    const service = new CandidateCorrectionV1Service(verification, corrections);

    const dryRun = await service.correct(
      { oldCandidateId: args.oldCandidateId, newCandidateId: args.newCandidateId, actor: args.actor, reason },
      { commit: false },
    );
    console.log(JSON.stringify({ mode: 'dry-run', preview: dryRun }, null, 2));

    if (!args.commit) {
      console.error('Dry-run complete — no writes performed.');
      process.exit(EXIT_OK);
    }

    const result = await service.correct(
      { oldCandidateId: args.oldCandidateId, newCandidateId: args.newCandidateId, actor: args.actor, reason },
      { commit: true },
    );
    console.log(JSON.stringify({ mode: result.mode, result }, null, 2));
    if (result.mode === 'already_recorded') {
      console.error(`Correction was already recorded (link ${result.persisted?.id}); no new write.`);
    } else {
      console.error(`Correction committed (link ${result.persisted?.id}); ${result.supersededScopedFactReviewIds.length} prior scoped approval(s) superseded.`);
    }
  } catch (err) {
    if (err instanceof CandidateCorrectionError) {
      console.error(`Correction refused: ${err.message} (code: ${err.code})`);
      if (err.existingLink) console.error(`Existing link: ${JSON.stringify(err.existingLink, null, 2)}`);
      process.exit(EXIT_ERROR);
    }
    console.error(`Correction failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_ERROR);
});
