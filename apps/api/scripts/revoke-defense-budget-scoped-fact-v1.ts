/**
 * Phase 10B-35 -- revoke an active scoped fact review decision.
 *
 * Usage:
 *   pnpm --filter @capiro/api revoke:defense-budget-scoped-fact-v1 -- \
 *     --id <uuid> --actor <id> --reason-file <path> [--commit]
 *
 * Dry-run by default (reads the row, reports whether it is currently active
 * and therefore revocable, writes nothing). --commit performs the revocation
 * (active -> revoked) through ScopedFactReviewV1Service, matching the
 * review:defense-budget-scoped-fact-v1 CLI's own pattern -- a row that is
 * already revoked/superseded, including one that lost a concurrent revoke
 * race against another operator, is refused with a typed error, never
 * reported as a silent success.
 */
import * as fs from 'node:fs';
import {
  ScopedFactReviewV1Service,
  ScopedFactReviewError,
  TrustedByteLocatorScopedFactReviewArtifactLoaderV1,
} from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-v1.service.js';
import { PrismaScopedFactReviewRepositoryV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-repository-v1.js';
import { PrismaScopedFactReviewCandidateLocatorReaderV1 } from '../src/defense-budget/governed-acceptance/scoped-fact-review/scoped-fact-review-prisma-locator-reader-v1.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../src/defense-budget/verification/trusted-proof/trusted-byte-locator-reader.js';
import { SdkS3ProofClient } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const KNOWN_FLAGS = new Set(['--id', '--actor', '--reason-file', '--commit']);

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
  return { id: need('--id'), actor: need('--actor'), reasonFile: need('--reason-file'), commit: raw['--commit'] === true };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.reasonFile)) {
    console.error(`reason file not found: ${args.reasonFile}`);
    process.exit(EXIT_ERROR);
  }
  const reason = fs.readFileSync(args.reasonFile, 'utf8');

  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  // `revoke()` never touches `artifacts` (pinned by
  // scoped-fact-review-v1.service.spec.ts's "must not touch
  // verification/locators/artifacts" fake) -- a storage outage must never
  // block withdrawing an approval. This loader is constructed only to keep
  // the service's dependency shape uniform with the review CLI's real one;
  // it is exercised by nothing on this path.
  const s3ProofClient = new SdkS3ProofClient();
  const byteReader = new CompositeByteLocatorReader(
    new FilesystemByteLocatorReader(),
    new S3ByteLocatorReader(s3ProofClient),
  );
  try {
    const { createPrismaBudgetVerificationRepository } = await import(
      '../src/defense-budget/verification/persistence/prisma-budget-verification.repository.js'
    );
    const verification = createPrismaBudgetVerificationRepository(prisma);
    const locators = new PrismaScopedFactReviewCandidateLocatorReaderV1(prisma);
    const artifacts = new TrustedByteLocatorScopedFactReviewArtifactLoaderV1(byteReader);
    const reviews = new PrismaScopedFactReviewRepositoryV1(prisma as never);
    const service = new ScopedFactReviewV1Service(verification, locators, artifacts, reviews);

    const existing = await reviews.readById(args.id);
    if (existing == null) {
      console.error(`no such scoped fact review: ${args.id}`);
      process.exit(EXIT_ERROR);
    }
    console.log(JSON.stringify({ mode: args.commit ? 'commit' : 'dry-run', before: existing }, null, 2));
    if (existing.status !== 'active') {
      console.error(`row ${args.id} is already ${existing.status}; nothing to revoke.`);
      process.exit(EXIT_ERROR);
    }
    if (!args.commit) {
      console.error('Dry-run complete — no writes performed.');
      process.exit(EXIT_OK);
    }
    const row = await service.revoke({ id: args.id, actor: args.actor, reason });
    console.log(JSON.stringify({ mode: 'committed', after: row }, null, 2));
    console.error('Revocation committed.');
  } catch (err) {
    if (err instanceof ScopedFactReviewError) {
      console.error(`Revoke refused: ${err.message} (code: ${err.code})`);
      process.exit(EXIT_ERROR);
    }
    console.error(`Revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  } finally {
    await prisma.$disconnect().catch(() => {});
    await s3ProofClient.destroy().catch(() => {});
  }
  process.exit(EXIT_OK);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(EXIT_ERROR);
});
