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
  assertImmutableArchive,
  assertPromotableSourceDocument,
  assertQualityAuditPassed,
  classifyUnitAuditFinding,
  classifyUnitRatio,
  requireApprovedSha256,
} from './lib/defense-budget-commit.js';

function apiRoot(): string {
  const cwd = process.cwd();
  return cwd.replace(/\\/g, '/').endsWith('/apps/api') ? cwd : resolve(cwd, 'apps/api');
}

function apiFile(relativePath: string): string {
  // Normalize line endings: this repo is edited on Windows checkouts and verified on
  // Linux CI, so any multi-line assertion below would otherwise pass on one platform
  // and fail on the other purely because of \r.
  return readFileSync(resolve(apiRoot(), relativePath), 'utf8').replace(/\r\n/g, '\n');
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
  // Every Program Elements trust verb must be dispatched by the layer that owns it
  // AND be discoverable from the usage output the dispatcher prints for an unknown
  // command, or an operator cannot find it. Scoped to this program's verbs
  // deliberately: 53 unrelated verbs predate the discoverability rule, and fixing
  // those is not Phase B's change.
  const peTrustVerbs = [
    { verb: 'diag-pe-trust', dispatchedBy: active },
    { verb: 'audit-llamaparse-pe-units', dispatchedBy: active },
    // The generalized ingestion verb this phase hardens is dispatched only by the
    // historical .inc, which is exactly why it was missing from the usage list.
    { verb: 'ingest-defense-budget', dispatchedBy: dispatcher },
  ] as const;
  for (const { verb, dispatchedBy } of peTrustVerbs) {
    assert(
      new RegExp(`^\\s+${verb}\\)`, 'm').test(dispatchedBy),
      `${verb} must be dispatched by its owning entrypoint layer`,
    );
    assert(
      new RegExp(`Unknown command[^\\n]*\\| ${verb} \\|`).test(dispatcher),
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
  assert.match(source, /const preExistingObservationIds = new Set/);
  assert.match(source, /function listLocalPdfsRequired/);
  // The three promotion gates are EXECUTED here rather than matched as the text of
  // an `if`, so a reformat cannot pass this check and an unreachable guard cannot.
  expectThrow(
    () => assertImmutableArchive({ versionId: null }),
    'Immutable source archive did not return an S3 VersionId',
  );
  assert.doesNotThrow(() => assertImmutableArchive({ versionId: 'v1' }));
  expectThrow(
    () => assertPromotableSourceDocument({ id: 'doc-new', supersededByDocumentId: 'doc-newer' }),
    'is superseded by doc-newer',
  );
  assert.doesNotThrow(() =>
    assertPromotableSourceDocument({ id: 'doc-new', supersededByDocumentId: null }),
  );
  expectThrow(
    () => assertQualityAuditPassed({ status: 'fail', unitsAnomalies: 3, titleTruncated: 1 }),
    'Quality audit failed before canonical promotion',
  );
  for (const status of ['ok', 'warn'] as const) {
    assert.doesNotThrow(() =>
      assertQualityAuditPassed({ status, unitsAnomalies: 0, titleTruncated: 0 }),
    );
  }
  // The run summary must carry the artifact's identity, not its multi-megabyte body.
  // (`parse: prepared` remains correct as the ARGUMENT to promoteMappedArtifact,
  // which needs the parsed JSON; only the emitted summary must exclude it.)
  assert.match(source, /parse: parseSummary\(prepared\)/);
  const summaryStart = source.indexOf('function parseSummary(');
  assert(summaryStart >= 0, 'parseSummary must exist');
  const summaryBody = source.slice(summaryStart, source.indexOf('\n}', summaryStart));
  assert.doesNotMatch(summaryBody, /\bjson\b/, 'the emitted parse summary must omit the artifact body');
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

  // Guard ORDER is the safety property, so assert each gate's position relative to
  // the irreversible step it protects.
  const archiveGate = source.indexOf('assertImmutableArchive(archive)', runCommitStart);
  assert(
    archiveGate > comparison && archiveGate < prismaConstruction,
    'immutable-archive proof must be required after the SHA match and before Prisma',
  );
  const supersedeGate = source.indexOf('assertPromotableSourceDocument(', prismaConstruction);
  const artifactLoad = source.indexOf('await loadExistingParseArtifact(', prismaConstruction);
  assert(
    supersedeGate > prismaConstruction && artifactLoad > supersedeGate,
    'a superseded source document must be rejected before any parse artifact is loaded',
  );
  const promoteStart = source.indexOf('async function promoteMappedArtifact(');
  const auditGate = source.indexOf('assertQualityAuditPassed(auditRows(', promoteStart);
  const transactionOpen = source.indexOf('input.prisma.$transaction(', promoteStart);
  assert(
    promoteStart >= 0 && auditGate > promoteStart && transactionOpen > auditGate,
    'the quality audit must gate promotion before the canonical transaction opens',
  );

  // Artifact replay must not advertise a remedy it cannot perform: the unprovable-
  // artifact path has to consult the vendor authorization rather than throw first.
  assert.match(source, /vendorParseAllowed: boolean/);
  assert.match(source, /if \(!vendorParseAllowed\) \{\n\s+throw new Error\(\n\s+`Parse job/);

  // main() must stay importable so the helpers above can be tested by execution.
  assert.match(source, /if \(require\.main === module\) \{/);

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
  // b5 forbids a mutation transaction as well as direct mutation calls; the audit
  // opens no interactive transaction at all, which is the strongest form of that.
  assert.doesNotMatch(source, /\$transaction/);
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
    // Contradictory comparators: one deterministic source is ~1,000x smaller while
    // another agrees with the canonical value. Never proof in either ordering.
    {
      canonicalIsLlama: true,
      classifications: ['candidate_1000x_reference', 'same_scale'] as const,
      ...documented,
    },
    {
      canonicalIsLlama: true,
      classifications: ['same_scale', 'candidate_1000x_reference'] as const,
      ...documented,
    },
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
