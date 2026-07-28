/**
 * DB-free executable safety gate for Program Elements trust remediation Phase A.
 * Runs in ci-pr after TypeScript compilation. Any failed invariant throws and
 * exits non-zero; success emits one stable marker for the workflow log.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveDefenseBudgetIngestPosture,
  usesDeprecatedDryRunAlias,
} from './lib/defense-budget-ingest-mode.js';

function apiRoot(): string {
  const cwd = process.cwd();
  return cwd.replace(/\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
}

function apiFile(relativePath: string): string {
  return readFileSync(resolve(apiRoot(), relativePath), 'utf8');
}

function expectThrow(fn: () => unknown, messagePart: string): void {
  let error: unknown;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof Error, `Expected error containing ${JSON.stringify(messagePart)}`);
  assert.match(error.message, new RegExp(messagePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

function verifyPostures(): void {
  assert.equal(resolveDefenseBudgetIngestPosture([]), 'preflight');
  assert.equal(resolveDefenseBudgetIngestPosture(['--path', 'x.pdf']), 'preflight');
  assert.equal(resolveDefenseBudgetIngestPosture(['--extract-only']), 'extract_only');
  assert.equal(resolveDefenseBudgetIngestPosture(['--dry-run']), 'extract_only');
  assert.equal(resolveDefenseBudgetIngestPosture(['--commit']), 'commit');
  assert.equal(resolveDefenseBudgetIngestPosture(['--allow-vendor-parse']), 'preflight');
  assert.equal(usesDeprecatedDryRunAlias(['--dry-run']), true);
  assert.equal(usesDeprecatedDryRunAlias(['--extract-only']), false);
  expectThrow(
    () => resolveDefenseBudgetIngestPosture(['--commit', '--extract-only']),
    'Choose exactly one ingestion posture',
  );
  expectThrow(
    () => resolveDefenseBudgetIngestPosture(['--dry-run', '--extract-only']),
    'Choose exactly one ingestion posture',
  );
}

function verifyMigrationGuard(): void {
  const active = apiFile('scripts/entrypoint.sh');
  const compatibility = apiFile('scripts/entrypoint-legacy.sh');
  // The dispatcher include is reached by `/bin/sh <path>` from the compatibility
  // shim, so it is a supported entrypoint and must be held to the same rule.
  // Omitting it is how the auto-resolve block survived the first Phase A pass.
  const dispatcher = apiFile('scripts/entrypoint-dispatcher.inc');
  for (const source of [active, compatibility, dispatcher]) {
    assert.equal(source.includes('_prisma_migrations'), false);
    assert.equal(source.includes('rolled_back_at = NOW()'), false);
    assert.equal(source.includes('Resolving failed migration:'), false);
    assert.equal(/prisma[^\n]*migrate\s+resolve/.test(source), false);
  }
  assert.match(active, /node .*prisma.* migrate deploy/);
  assert.match(compatibility, /Refusing legacy migrate dispatch/);
  assert.match(dispatcher, /Refusing legacy migrate dispatch/);
  // Exactly one supported path may actually execute a migration. Compare only
  // executable lines: a prose mention of the command in a header comment is not
  // a second execution path, and grepping raw text would miscount it as one.
  const executableLines = (source: string): string =>
    source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  const executesMigrateDeploy = [active, compatibility, dispatcher].filter((source) =>
    /migrate deploy/.test(executableLines(source)),
  );
  assert.equal(
    executesMigrateDeploy.length,
    1,
    'exactly one entrypoint may execute prisma migrate deploy',
  );
  // The diagnostic verb users are told about must be discoverable from the
  // usage output the dispatcher prints for an unknown command.
  assert.match(dispatcher, /Unknown command[^\n]*diag-pe-trust/);
}

function verifyIngestionFreeze(): void {
  const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
  for (const forbidden of ['ProgramElementWriterService', 'PrismaClient', 'PrismaService']) {
    assert.doesNotMatch(
      source,
      new RegExp(`(?:import\\s+[^;]*\\b${forbidden}\\b|new\\s+${forbidden}\\b)`),
      `${forbidden} must not be imported or constructed`,
    );
  }
  assert.doesNotMatch(source, /from ['"][^'"]*prisma[^'"]*['"]/i);
  assert.match(
    source,
    /Canonical generalized defense-budget writes are disabled until the USD-millions migration in Phase b is verified\./,
  );
  assert.match(
    source,
    /if \(posture === 'commit'\) throw new Error\(COMMIT_DISABLED_MESSAGE\)/,
  );
  assert.match(source, /const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'/);
  assert.match(
    source,
    /--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call\./,
  );

  const loaderStart = source.indexOf('function loadVendorParseEnvironment');
  assert(loaderStart >= 0, 'loadVendorParseEnvironment must exist');
  assert.equal(source.slice(0, loaderStart).includes('dotenvConfig('), false);
  assert.match(
    source,
    /function loadConfig\(\): RunConfig \{\s+loadVendorParseEnvironment\(\);/,
  );

  const commitCheck = source.indexOf("if (posture === 'commit')");
  const vendorFlagCheck = source.indexOf('const vendorParseAllowed');
  const targetRead = source.indexOf("const target = arg('path')");
  assert(commitCheck >= 0 && vendorFlagCheck > commitCheck && targetRead > vendorFlagCheck);
}

verifyPostures();
verifyMigrationGuard();
verifyIngestionFreeze();
console.log('PE_PHASE_A_SAFETY_OK');
