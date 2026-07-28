/**
 * DB-free executable safety gate for Program Elements trust remediation.
 * Runs during API typecheck. Any failed invariant throws and exits non-zero.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  resolveDefenseBudgetIngestPosture,
  usesDeprecatedDryRunAlias,
} from './lib/defense-budget-ingest-mode.js';
import {
  assertApprovedShaMatches,
  classifyUnitRatio,
  requireApprovedSha256,
} from './lib/defense-budget-commit.js';

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

function verifyMoneyAndApprovalHelpers(): void {
  const sha = 'a'.repeat(64);
  assert.equal(requireApprovedSha256(sha), sha);
  assert.doesNotThrow(() => assertApprovedShaMatches(sha, sha));
  expectThrow(() => requireApprovedSha256(undefined), '--commit requires --approved-sha256');
  expectThrow(
    () => assertApprovedShaMatches('b'.repeat(64), sha),
    'Approved SHA-256 does not match source bytes',
  );
  assert.equal(classifyUnitRatio(13_500, 13.5), 'candidate_1000x_reference');
  assert.equal(classifyUnitRatio(13.5, 13.5), 'same_scale');
  assert.equal(classifyUnitRatio(0, 13.5), 'not_comparable');
}

function verifyMigrationGuard(): void {
  const active = apiFile('scripts/entrypoint.sh');
  const compatibility = apiFile('scripts/entrypoint-legacy.sh');
  for (const source of [active, compatibility]) {
    assert.equal(source.includes('_prisma_migrations'), false);
    assert.equal(source.includes('rolled_back_at = NOW()'), false);
    assert.equal(source.includes('Resolving failed migration:'), false);
  }
  assert.match(active, /node .*prisma.* migrate deploy/);
  assert.match(compatibility, /Refusing legacy migrate dispatch/);
  assert.match(active, /audit-llamaparse-pe-units/);
}

function verifyPromotionSafety(): void {
  const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
  assert.match(source, /requireApprovedSha256\(arg\('approved-sha256'\)\)/);
  assert.match(source, /assertApprovedShaMatches\(sourceSha256, approvedSha256\)/);
  assert.match(source, /--commit promotes exactly one processable PDF/);
  assert.match(source, /onePdfPerTransaction: true/);
  assert.match(source, /CANONICAL_TRANSACTION_TIMEOUT_MS/);
  assert.match(source, /Do not run generalized --commit in production until Phase D/);

  const approvalParse = source.indexOf("requireApprovedSha256(arg('approved-sha256'))");
  const comparison = source.indexOf('assertApprovedShaMatches(sourceSha256, approvedSha256)');
  const prismaConstruction = source.indexOf('const prisma = new PrismaClient()');
  assert(approvalParse >= 0 && comparison > approvalParse && prismaConstruction > comparison);

  const loaderStart = source.indexOf('function loadVendorParseEnvironment');
  assert(loaderStart >= 0, 'loadVendorParseEnvironment must exist');
  assert.equal(source.slice(0, loaderStart).includes('dotenvConfig('), false);
  assert.match(source, /const ALLOW_VENDOR_PARSE = '--allow-vendor-parse'/);
  assert.match(
    source,
    /--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call\./,
  );
}

function verifyAuditIsReadOnly(): void {
  const source = apiFile('scripts/audit-llamaparse-pe-units.ts');
  assert.doesNotMatch(source, /\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/);
  assert.doesNotMatch(source, /\$executeRaw|\$executeRawUnsafe|\$queryRawUnsafe/);
  assert.match(source, /SELECT_ONLY_NO_AUTOMATIC_DIVISION/);
  assert.match(
    source,
    /canonicalIsLlama && thousandScale && hasArchiveProof && hasMatchingParseProof/,
  );
}

verifyPostures();
verifyMoneyAndApprovalHelpers();
verifyMigrationGuard();
verifyPromotionSafety();
verifyAuditIsReadOnly();
console.log('PE_PHASE_A_B_SAFETY_OK');
