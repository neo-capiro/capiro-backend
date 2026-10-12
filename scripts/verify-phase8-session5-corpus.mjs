#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const usage = 'Usage: node scripts/verify-phase8-session5-corpus.mjs (no arguments verify the review ledger)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length !== 0) {
  console.error(usage);
  process.exit(2);
}
console.error(usage);

const {
  loadCorpusReviewLedger,
  validateCorpusReviewLedger,
} = await import('../apps/defense-parser-orchestrator/src/corpus-review.mjs');

const LEDGER_PATH =
  'docs/defense-budget/phase8-session5-corpus-review-ledger.json';
const MANIFEST_PATH =
  'docs/defense-budget/phase8-session5-live-benchmark-manifest.json';
const LIVE_EVIDENCE_PATH =
  'docs/defense-budget/phase8-session5-live-benchmark-evidence.json';

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

async function main() {
  const { ledger, evidenceByPath } = await loadCorpusReviewLedger(LEDGER_PATH);
  const analysis = validateCorpusReviewLedger(ledger, evidenceByPath);
  const manifest = JSON.parse(
    readFileSync(resolve(MANIFEST_PATH), 'utf8'),
  );
  const review = manifest.corpusReview;

  if (!review) throw new Error('Manifest corpusReview summary is missing');
  if (review.ledgerPath !== LEDGER_PATH) {
    throw new Error('Manifest corpusReview ledgerPath does not match');
  }
  if (review.ledgerSha256 !== ledger.contentSha256) {
    throw new Error('Manifest corpusReview ledgerSha256 does not match');
  }
  if (
    review.acceptedStrataCount !== analysis.acceptedStrata.length ||
    review.blockedStrataCount !== analysis.blockedStrata.length ||
    review.liveCorpusReady !== analysis.liveCorpusReady ||
    !sameSet(review.acceptedStrata, analysis.acceptedStrata) ||
    !sameSet(review.blockedStrata, analysis.blockedStrata)
  ) {
    throw new Error('Manifest corpusReview summary differs from ledger truth');
  }

  if (!analysis.liveCorpusReady && existsSync(resolve(LIVE_EVIDENCE_PATH))) {
    throw new Error(
      'Live benchmark evidence must not exist while the accepted corpus is incomplete',
    );
  }

  for (const stratum of analysis.acceptedStrata) {
    process.stdout.write(
      `[phase8-session5-corpus] PASS accepted source-grounded gold: ${stratum}\n`,
    );
  }
  for (const stratum of analysis.blockedStrata) {
    process.stdout.write(
      `[phase8-session5-corpus] BLOCKED documented source gap: ${stratum}\n`,
    );
  }

  process.stdout.write(
    `${analysis.liveCorpusReady
      ? 'SESSION5_CORPUS_READY_PASS'
      : 'SESSION5_CORPUS_REVIEW_LEDGER_PASS'} accepted=${analysis.acceptedStrata.length} blocked=${analysis.blockedStrata.length}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      error: error?.name ?? 'Error',
      code: error?.code ?? 'SESSION5_CORPUS_VERIFY_FAILED',
      message: error?.message ?? String(error),
      details: error?.details,
    })}\n`,
  );
  process.exitCode = 1;
});
