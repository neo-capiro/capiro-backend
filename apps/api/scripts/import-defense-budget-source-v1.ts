/**
 * Phase 10B-18 Part F — governed operator-attested source import.
 *
 * A DEDICATED command for one narrow situation: an expected source's
 * official document is confirmed to exist at a known, registered official
 * URL, but production cannot fetch it itself (the Akamai/WAF block on
 * asafm.army.mil found in Phase 10B-17/10B-18). An operator who obtained the
 * exact official bytes some other way (a browser, a different network path)
 * can attest to them here — this is NOT a generic file uploader: every
 * argument is checked against the ALREADY-REGISTERED expected source and
 * bundle member identity (see governed-source-import.validation.ts), and a
 * mismatch on ANY of them fails closed with zero writes.
 *
 * Dry-run by default. Mutation requires BOTH --commit and
 * --confirm production — this mirrors the two-flag pattern already used
 * elsewhere in this codebase for irreversible production writes.
 *
 * ABSOLUTE INVARIANT: this script never imports or invokes a promotion
 * authorization service, never invokes canonical promotion execution, and
 * never reads the promoter-only database credential — same boundary
 * `drain-defense-budget-ingestion-outbox-v1.ts` holds.
 */
import { readFileSync, statSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

import { makeS3, awsS3Commands } from '../src/defense-budget/s3-aws-commands.js';
import { GovernedSourceImportStore } from '../src/defense-budget/governed-import/governed-source-import.store.js';
import { GovernedSourceImportService } from '../src/defense-budget/governed-import/governed-source-import.service.js';
import { resolveGovernedImportCommitIntent } from '../src/defense-budget/governed-import/governed-source-import.cli-args.js';

dotenvConfig();

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}
function usage(message: string): never {
  console.error(`import-defense-budget-source-v1: ${message}`);
  console.error(
    'usage: import-defense-budget-source-v1 --environment <env> --expected-source-id <uuid> ' +
      '--member-id <uuid> --official-url <url> --file <path> --actor "<name>" --reason "<why>" ' +
      '[--commit --confirm production]',
  );
  process.exit(2);
}
function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const environment = argValue('--environment');
  if (!environment) usage('--environment is required');
  const expectedSourceId = argValue('--expected-source-id');
  if (!expectedSourceId) usage('--expected-source-id is required');
  const memberId = argValue('--member-id');
  if (!memberId) usage('--member-id is required');
  const officialUrl = argValue('--official-url');
  if (!officialUrl) usage('--official-url is required');
  const filePath = argValue('--file');
  if (!filePath) usage('--file is required');
  const actor = argValue('--actor');
  if (!actor) usage('--actor is required');
  const reason = argValue('--reason');
  if (!reason) usage('--reason is required');

  const commitIntent = resolveGovernedImportCommitIntent({
    commitFlagPresent: hasFlag('--commit'),
    confirmValue: argValue('--confirm'),
    environment,
  });
  if (!commitIntent.commit && commitIntent.error) usage(commitIntent.error);
  const commit = commitIntent.commit;

  let fileStat;
  try {
    fileStat = statSync(filePath);
  } catch {
    usage(`--file ${filePath} does not exist or is not readable`);
  }
  if (!fileStat.isFile()) usage(`--file ${filePath} is not a regular file`);
  const fileBytes = readFileSync(filePath);

  const prisma = new PrismaClient();
  try {
    const store = new GovernedSourceImportStore(prisma);
    const service = new GovernedSourceImportService(store, prisma, {
      rawArchiveBucket: requiredEnv('DEFENSE_BUDGET_RAW_BUCKET'),
      rawArchiveKmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN,
      retentionYears: Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7'),
      parserArtifactRoot: requiredEnv('BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT'),
      s3: makeS3(process.env.AWS_REGION_DEFAULT ?? 'us-east-1'),
      s3Commands: awsS3Commands,
    });

    const result = await service.run({
      expectedSourceId,
      memberId,
      officialUrl,
      fileBytes,
      actor,
      reason,
      commit,
      nowIso: new Date().toISOString(),
    });

    console.log(
      JSON.stringify(
        {
          safety: commit
            ? 'Committed a governed import. No promotion authorization, canonical execution, or ' +
              'promoter-only credential was touched.'
            : 'DRY RUN — no database or S3 mutation occurred. Pass --commit --confirm ' +
              `${environment} to execute.`,
          environment,
          commit,
          ...result,
        },
        null,
        2,
      ),
    );
    if ('error' in result || result.accepted === false) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  console.error('import-defense-budget-source-v1 FAILED:', error);
  process.exit(1);
});
