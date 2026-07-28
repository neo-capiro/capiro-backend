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
  classifyUnitAuditFinding,
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
  // Opposite signs are different facts, not one figure at another scale.
  assert.equal(classifyUnitRatio(13_500, -13.5), 'sign_mismatch');
  assert.equal(classifyUnitRatio(-13_500, -13.5), 'candidate_1000x_reference');
}

function verifyMigrationGuard(): void {
  const active = apiFile('scripts/entrypoint.sh');
  const compatibility = apiFile('scripts/entrypoint-legacy.sh');
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
  const executableLines = (source: string): string =>
    source
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
  const executes = [active, compatibility, dispatcher].filter((source) =>
    /migrate deploy/.test(executableLines(source)),
  );
  assert.equal(executes.length, 1, 'exactly one entrypoint may execute prisma migrate deploy');
  // Every verb the wrapper handles must also be discoverable from the usage output
  // the dispatcher prints for an unknown command, or operators cannot find it.
  for (const verb of ['diag-pe-trust', 'audit-llamaparse-pe-units']) {
    assert.match(active, new RegExp(`^\\s+${verb}\\)`, 'm'), `${verb} must be dispatched`);
    assert.match(
      dispatcher,
      new RegExp(`Unknown command[^\\n]*${verb}`),
      `${verb} must appear in the supported-command usage output`,
    );
  }
}

function verifyPromotionSafety(): void {
  const source = apiFile('scripts/ingest-defense-budget-pdf.ts');
  assert.match(source, /requireApprovedSha256\(arg\('approved-sha256'\)\)/);
  assert.match(source, /assertApprovedShaMatches\(sourceSha256, approvedSha256\)/);
  assert.match(source, /--commit promotes exactly one processable PDF/);
  assert.match(source, /onePdfPerTransaction: true/);
  assert.match(source, /CANONICAL_TRANSACTION_TIMEOUT_MS/);
  assert.match(source, /Do not run generalized --commit in production until Phase D/);
  assert.match(source, /Immutable source archive did not return an S3 VersionId/);
  assert.match(source, /registered\.document\.supersededByDocumentId/);
  assert.match(source, /const preExistingObservationIds = new Set/);
  assert.match(source, /function listLocalPdfsRequired/);
  // Artifact replay must PROVE the bytes are the ones originally parsed, not merely
  // recompute a digest, and the head flip must be deferred into the transaction.
  assert.match(source, /recordedArtifactSha256 !== actualArtifactSha256/);
  assert.match(source, /has no recorded output checksum/);
  assert.match(source, /deferSupersede: true/);
  assert.match(source, /supersedeSourceDocumentHead\(/);

  const mainStart = source.indexOf('async function main(): Promise<void>');
  const approvalParse = source.indexOf(
    "requireApprovedSha256(arg('approved-sha256'))",
    mainStart,
  );
  const commitDispatch = source.indexOf(': await runCommit(', approvalParse);
  assert(
    mainStart >= 0 && approvalParse > mainStart && commitDispatch > approvalParse,
    'main() must parse the exact SHA approval before dispatching runCommit()',
  );

  const runCommitStart = source.indexOf('async function runCommit(');
  const comparison = source.indexOf(
    'assertApprovedShaMatches(sourceSha256, approvedSha256)',
    runCommitStart,
  );
  const prismaConstruction = source.indexOf('const prisma = new PrismaClient()', runCommitStart);
  assert(
    runCommitStart >= 0 && comparison > runCommitStart && prismaConstruction > comparison,
    'runCommit() must compare source bytes before constructing Prisma',
  );

  // Phase A guaranteed the default posture touches no database. Phase B adds a
  // guarded writer, so that guarantee now has to be stated as: Prisma is
  // constructed exactly once, and only inside runCommit(). Without this a future
  // edit could open a connection during preflight and nothing would catch it.
  const constructions = source.match(/new PrismaClient\(/g) ?? [];
  assert.equal(
    constructions.length,
    1,
    'PrismaClient must be constructed exactly once (inside runCommit)',
  );
  assert(
    prismaConstruction > runCommitStart,
    'the only PrismaClient construction must be inside runCommit()',
  );
  const preflightStart = source.indexOf('function runPreflight(');
  const preflightEnd = source.indexOf('\n}', preflightStart);
  assert(preflightStart >= 0 && preflightEnd > preflightStart);
  const preflightBody = source.slice(preflightStart, preflightEnd);
  for (const forbidden of ['PrismaClient', 'ProgramElementWriterService', 'await ']) {
    assert.equal(
      preflightBody.includes(forbidden),
      false,
      `runPreflight() must remain synchronous and database-free; found ${forbidden}`,
    );
  }

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
  // The audit must not perform the 1,000x division itself, and must expose the
  // preserved artifact to replay from so a repair never re-runs a paid parse.
  assert.doesNotMatch(source, /\/\s*1_?000\b/);
  assert.match(source, /recommendedReplaySource/);
  // Execute the proof rule instead of asserting the text of a boolean expression:
  // a formatting change must not pass or fail this gate, and an unreachable rule
  // must not pass it. Nothing is "proven affected" without every piece of evidence.
  assert.match(source, /classifyUnitAuditFinding\(\{/);
  const documented = { hasArchiveProof: true, hasMatchingParseProof: true } as const;
  assert.equal(
    classifyUnitAuditFinding({
      canonicalIsLlama: true,
      classifications: ['candidate_1000x_reference'],
      ...documented,
    }).bucket,
    'provenAffected',
  );
  for (const weakened of [
    { canonicalIsLlama: false, classifications: ['candidate_1000x_reference'] as const, ...documented },
    {
      canonicalIsLlama: true,
      classifications: ['candidate_1000x_reference'] as const,
      hasArchiveProof: false,
      hasMatchingParseProof: true,
    },
    {
      canonicalIsLlama: true,
      classifications: ['candidate_1000x_reference'] as const,
      hasArchiveProof: true,
      hasMatchingParseProof: false,
    },
    { canonicalIsLlama: true, classifications: ['sign_mismatch'] as const, ...documented },
    { canonicalIsLlama: true, classifications: ['different_scale'] as const, ...documented },
    { canonicalIsLlama: true, classifications: [] as const, ...documented },
  ]) {
    assert.notEqual(
      classifyUnitAuditFinding(weakened).bucket,
      'provenAffected',
      `incomplete evidence must never prove affection: ${JSON.stringify(weakened)}`,
    );
  }
}

verifyPostures();
verifyMoneyAndApprovalHelpers();
verifyMigrationGuard();
verifyPromotionSafety();
verifyAuditIsReadOnly();
console.log('PE_PHASE_A_B_SAFETY_OK');
