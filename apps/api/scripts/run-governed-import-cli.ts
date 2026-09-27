#!/usr/bin/env tsx
/** Phase 10B-18 Part M — CLI entry point for governed operator-attested source import.
 *
 * Usage: tsx run-governed-import-cli.ts \
 *   --expected-source-id <id> \
 *   --member-id <id> \
 *   --official-url <url> \
 *   --file-path <path> \
 *   --actor <identity> \
 *   --reason <justification> \
 *   [--commit] \
 *   [--database-url <db-string>]
 *
 * Behavior:
 *   1. Reads file bytes from --file-path
 *   2. Validates operator identity and reason are non-empty
 *   3. Calls service.run() with commit: false first (dry run)
 *   4. Prints the dry-run result as JSON
 *   5. If --commit was passed AND dry run accepted, calls service.run() with commit: true
 *   6. Prints the commit result as JSON
 *   7. Exits with code 0 on success, 1 on failure
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { PrismaClient } from '@prisma/client';

import { GovernedSourceImportService } from '../src/defense-budget/governed-import/governed-source-import.service.js';
import { GovernedSourceImportStore } from '../src/defense-budget/governed-import/governed-source-import.store.js';
import { makeS3, awsS3Commands } from '../src/defense-budget/s3-aws-commands.js';

// Constants for the governed import infra
const RAW_ARCHIVE_BUCKET = 'capiro-defense-budget-raw-dev-967807252336';
const RAW_ARCHIVE_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:967807252336:key/29f4399d-4a5c-449e-b28d-29a7e71b8970';
const RETENTION_YEARS = 7;
const PARSER_ARTIFACT_ROOT = 'derived/public/dod-budget';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

/** CLI argument parsing. */
interface CliArgs {
  'expected-source-id': string;
  'member-id': string;
  'official-url': string;
  'file-path': string;
  actor: string;
  reason: string;
  commit?: boolean;
  'database-url'?: string;
}

function parseCliArgs(): CliArgs {
  const { values } = parseArgs({
    options: {
      'expected-source-id': { type: 'string', short: 'e' },
      'member-id': { type: 'string', short: 'm' },
      'official-url': { type: 'string', short: 'u' },
      'file-path': { type: 'string', short: 'f' },
      actor: { type: 'string', short: 'a' },
      reason: { type: 'string', short: 'r' },
      commit: { type: 'boolean', short: 'c' },
      'database-url': { type: 'string', short: 'd' },
    },
    allowPositionals: false,
    strict: true,
  });

  // Validate required args
  const required: (keyof CliArgs)[] = [
    'expected-source-id',
    'member-id',
    'official-url',
    'file-path',
    'actor',
    'reason',
  ];
  for (const key of required) {
    if (!values[key]) {
      console.error(`Error: --${key.replace(/-/g, '-').replace('d', 'd')} is required`);
      process.exit(1);
    }
  }

  // Resolve database URL: CLI arg takes precedence, then env var
  const databaseUrl = values['database-url'] ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('Error: --database-url is required (or set DATABASE_URL env var)');
    process.exit(1);
  }

  return {
    'expected-source-id': values['expected-source-id']!,
    'member-id': values['member-id']!,
    'official-url': values['official-url']!,
    'file-path': values['file-path']!,
    actor: values.actor!,
    reason: values.reason!,
    commit: values.commit ?? false,
    'database-url': databaseUrl,
  };
}

/** Read file bytes from path. */
function readFileBytes(filePath: string): Buffer {
  const resolvedPath = resolve(filePath);
  if (!existsSync(resolvedPath)) {
    console.error(`Error: File not found: ${resolvedPath}`);
    process.exit(1);
  }
  return readFileSync(resolvedPath);
}

/** Build GovernedSourceImportInfra. */
function buildInfra(): {
  s3: { send(command: unknown): Promise<Record<string, unknown>> };
  s3Commands: {
    head(input: { Bucket: string; Key: string }): unknown;
    put(input: {
      Bucket: string;
      Key: string;
      Body: Buffer | string;
      ContentType: string;
      ChecksumSHA256?: string;
      IfNoneMatch?: string;
      ServerSideEncryption: string;
      SSEKMSKeyId?: string;
      ObjectLockMode?: string;
      ObjectLockRetainUntilDate?: Date;
    }): unknown;
  };
} {
  const s3 = makeS3(AWS_REGION);
  return {
    s3,
    s3Commands: awsS3Commands,
  };
}

/** Main entry point. */
async function main(): Promise<void> {
  try {
    const args = parseCliArgs();

    // Read file bytes
    const fileBytes = readFileBytes(args['file-path']);

    // Build Prisma client
    const prisma = new PrismaClient({
      datasources: {
        db: {
          url: args['database-url'],
        },
      },
    });

    // Build infra
    const { s3, s3Commands } = buildInfra();

    // Build service dependencies
    const store = new GovernedSourceImportStore(prisma);
    const infra = {
      rawArchiveBucket: RAW_ARCHIVE_BUCKET,
      rawArchiveKmsKeyArn: RAW_ARCHIVE_KMS_KEY_ARN,
      retentionYears: RETENTION_YEARS,
      parserArtifactRoot: PARSER_ARTIFACT_ROOT,
      s3,
      s3Commands,
    };

    const service = new GovernedSourceImportService(store, prisma, infra);

    const nowIso = new Date().toISOString();

    // Dry run first
    const dryRunRequest = {
      expectedSourceId: args['expected-source-id'],
      memberId: args['member-id'],
      officialUrl: args['official-url'],
      fileBytes,
      actor: args.actor,
      reason: args.reason,
      commit: false,
      nowIso,
    };

    const dryRunResult = await service.run(dryRunRequest);

    // Print dry run result
    console.log(JSON.stringify(dryRunResult, null, 2));

    // If --commit was passed AND dry run accepted, run commit
    if (args.commit) {
      if (
        typeof dryRunResult === 'object' &&
        dryRunResult !== null &&
        'accepted' in dryRunResult &&
        dryRunResult.accepted === false
      ) {
        console.error('\nError: Dry run rejected the request. Refusing to commit.');
        process.exit(1);
      }

      const commitRequest = {
        ...dryRunRequest,
        commit: true,
      };

      const commitResult = await service.run(commitRequest);

      // Print commit result
      console.log('\n' + JSON.stringify(commitResult, null, 2));
    }

    // Disconnect Prisma client
    await prisma.$disconnect();

    // Exit with 0 on success
    process.exit(0);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
