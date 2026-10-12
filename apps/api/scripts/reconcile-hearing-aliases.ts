/**
 * Reviewed, explicit-ID repair. Defaults to a read-only dry run.
 * pnpm exec tsx scripts/reconcile-hearing-aliases.ts --pairs reviewed-pairs.json
 * Apply only after reviewing the emitted plan and pausing hearing writers:
 *   ... --pairs reviewed-pairs.json --apply --plan-hash <dry-run planHash>
 * No delete, fuzzy matching, secret output, or automatic RLS bypass. References
 * retain their row IDs; any uniqueness/FK conflict rolls back the entire batch.
 */
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import type { AliasReview } from '../src/hearing-discovery/hearing-alias-review.js';
import { reconcileReviewedAliases } from '../src/hearing-discovery/hearing-alias-reconciliation.js';

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/reconcile-hearing-aliases.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index < 0 ? undefined : args[index + 1];
  };
  const path = value('--pairs');
  if (!path) throw new Error('--pairs <reviewed-pairs.json> is required');
  const reviews = JSON.parse(await readFile(path, 'utf8')) as AliasReview[];
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reconcileReviewedAliases(tx, reviews, {
          apply: args.includes('--apply'),
          expectedPlanHash: value('--plan-hash'),
        }),
      { timeout: 120_000, isolationLevel: 'Serializable' },
    );
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}
if (require.main === module)
  main().catch((error: unknown) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
