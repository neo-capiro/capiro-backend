/**
 * Manifest-driven repair for explicitly reviewed Florida OpenStates/TFC
 * duplicate pairs. Defaults to a read-only dry run. Production can supply the
 * manifest through FLORIDA_ALIAS_REPAIR_MANIFEST_JSON so no writable volume is
 * required. Apply requires the exact dry-run hash and repair-specific token.
 * Run this verb only with the migration/master database credentials: the
 * safety inventory must see FORCE-RLS tenant references and take short,
 * fail-fast locks that the ordinary capiro_app role intentionally cannot.
 *
 * Dry run:
 *   FLORIDA_ALIAS_REPAIR_MANIFEST_JSON='[...]' pnpm exec tsx scripts/repair-florida-openstates-aliases.ts
 * Apply:
 *   ... --apply --writers-quiesced --plan-hash <hash> --confirm <repairId>:apply-reviewed-aliases
 */
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  fetchFloridaChannelSource,
  fetchFloridaSource,
  floridaKalturaEntryId,
} from '../src/hearing-discovery/adapters/florida-calendar.adapter.js';
import {
  reconcileFloridaOpenstatesAliases,
  verifyFloridaAliasMediaEvidence,
} from '../src/hearing-discovery/florida-openstates-alias-reconciliation.js';
import type { FloridaOpenstatesAliasReview } from '../src/hearing-discovery/florida-openstates-alias-review.js';

function argument(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

async function manifest(args: string[]): Promise<FloridaOpenstatesAliasReview[]> {
  const path = argument(args, '--manifest');
  const raw = path ? await readFile(path, 'utf8') : process.env.FLORIDA_ALIAS_REPAIR_MANIFEST_JSON;
  if (!raw) throw new Error('--manifest <json> or FLORIDA_ALIAS_REPAIR_MANIFEST_JSON is required');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Florida alias repair manifest must be an array');
  return parsed as FloridaOpenstatesAliasReview[];
}

async function fetchEvidence(url: string): Promise<Uint8Array> {
  return new URL(url).hostname.toLowerCase() === 'thefloridachannel.org'
    ? (await fetchFloridaChannelSource(url)).bytes
    : fetchFloridaSource(url);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/repair-florida-openstates-aliases.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const reviews = await manifest(args);
  // Publisher proof runs before the database transaction. A slow/unavailable
  // page can fail safely without holding locks; no network runs under locks.
  const verifiedMedia = await verifyFloridaAliasMediaEvidence(
    reviews,
    fetchEvidence,
    floridaKalturaEntryId,
  );
  const apply = args.includes('--apply') || process.env.FLORIDA_ALIAS_REPAIR_APPLY === 'true';
  const expectedPlanHash =
    argument(args, '--plan-hash') ?? process.env.FLORIDA_ALIAS_REPAIR_PLAN_HASH;
  const confirmation = argument(args, '--confirm') ?? process.env.FLORIDA_ALIAS_REPAIR_CONFIRMATION;
  const writersQuiesced =
    args.includes('--writers-quiesced') ||
    process.env.FLORIDA_ALIAS_REPAIR_WRITERS_QUIESCED === 'true';
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      (tx) =>
        reconcileFloridaOpenstatesAliases(tx, reviews, verifiedMedia, {
          apply,
          expectedPlanHash,
          confirmation,
          writersQuiesced,
        }),
      // The apply path intentionally acquires its broad anti-phantom table
      // locks late, then re-reads under READ COMMITTED before mutating. A
      // repeatable/serializable snapshot could not see changes that committed
      // while those locks were being acquired.
      { timeout: 120_000, isolationLevel: 'ReadCommitted' },
    );
    process.stdout.write(`FLORIDA_ALIAS_REPAIR ${JSON.stringify(result)}\n`);
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
