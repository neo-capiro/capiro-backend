/**
 * One-time repair for the single reviewed September 11 JLBC OpenStates alias.
 * There is no manifest input and the default is a read-only dry run. Apply
 * requires the dry-run plan hash, a repair-specific token, and an operator
 * attestation that both Florida calendar and OpenStates event writers are
 * quiesced. Run with migration/master database credentials.
 */
import { PrismaClient } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import { fetchFloridaSource } from '../src/hearing-discovery/adapters/florida-calendar.adapter.js';
import {
  FLORIDA_JLBC_ALIAS_REVIEW,
  verifyFloridaJlbcOfficialProof,
} from '../src/hearing-discovery/florida-jlbc-alias-review.js';
import { reconcileFloridaJlbcAlias } from '../src/hearing-discovery/florida-jlbc-alias-reconciliation.js';

function argument(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = new PDFParse({ data: bytes });
  try {
    return (await pdf.getText()).text;
  } finally {
    await pdf.destroy();
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/repair-florida-jlbc-openstates-alias.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  // Publisher proof is deliberately outside the database transaction: a slow
  // or unavailable official page fails without holding any database lock.
  const proof = await verifyFloridaJlbcOfficialProof(
    FLORIDA_JLBC_ALIAS_REVIEW,
    fetchFloridaSource,
    pdfText,
  );
  const apply = args.includes('--apply') || process.env.FLORIDA_JLBC_ALIAS_REPAIR_APPLY === 'true';
  const expectedPlanHash =
    argument(args, '--plan-hash') ?? process.env.FLORIDA_JLBC_ALIAS_REPAIR_PLAN_HASH;
  const confirmation =
    argument(args, '--confirm') ?? process.env.FLORIDA_JLBC_ALIAS_REPAIR_CONFIRMATION;
  const writersQuiesced =
    args.includes('--writers-quiesced') ||
    process.env.FLORIDA_JLBC_ALIAS_REPAIR_WRITERS_QUIESCED === 'true';
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reconcileFloridaJlbcAlias(tx, FLORIDA_JLBC_ALIAS_REVIEW, proof, {
          apply,
          expectedPlanHash,
          confirmation,
          writersQuiesced,
        }),
      { timeout: 120_000, isolationLevel: 'ReadCommitted' },
    );
    process.stdout.write(`FLORIDA_JLBC_ALIAS_REPAIR ${JSON.stringify(result)}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
