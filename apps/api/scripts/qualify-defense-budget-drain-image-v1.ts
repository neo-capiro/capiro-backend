/**
 * qualify-defense-budget-drain-image-v1.ts
 *
 * Committed replacement for the "qualification driver" that has, until now,
 * lived ONLY as base64-chunked `containerOverrides.environment` values
 * reassembled at runtime by the `qual` container's `entryPoint` on the live
 * ECS task-definition family `capiro-dev-defense-budget-qualification`
 * (revision 21 at the time this was written). That mechanism worked -- it
 * qualified the release images for Phase 10B-28 and Phase 10B-32 -- but it
 * was never reviewable, never versioned, and the last two qualification task
 * ARNs have already rolled off ECS/CloudWatch retention. Without this file,
 * every future release would have to either skip real AWS-Fargate
 * qualification (falling back to local e2e proofs only) or re-improvise the
 * driver from scratch under time pressure. This is a disclosed PROCESS GAP
 * found during Phase 10B-36, not evidence of a defect in any specific past
 * release -- 10B-28 and 10B-32 both used a real, working (if uncommitted)
 * driver, and this file's logic was reconstructed byte-for-byte from the
 * live task-definition's own environment (which still carried the exact
 * base64 chunks + a SHA-256 of the reassembled source, both verified to
 * match before a single line here was written).
 *
 * What this script does, end to end, inside the SAME 3-container Fargate
 * task shape (`qual` + `pg` [pgvector/pgvector:pg16] + `minio`) that made
 * every prior qualification isolated-by-construction:
 *
 *   1. Wait for the isolated Postgres and MinIO sidecars to come up.
 *   2. Apply this isolated Postgres's own migrations (`prisma migrate
 *      deploy`) -- never the real production Aurora database.
 *   3. Fetch the real archived source PDF bytes via a short-lived presigned
 *      URL (injected per run through `containerOverrides.environment`,
 *      never baked into the task-definition) and verify their identity
 *      (byte count + SHA-256) before doing anything else with them.
 *   4. Seed the isolated Postgres with a real `DefenseBudgetCycle` +
 *      `SourceDocument` row, and seed the isolated, versioned MinIO bucket
 *      with those same verified bytes -- recording the real returned
 *      VersionId onto the SourceDocument row. Both are required for
 *      `CompositeProofResolver`'s `production_proof` mode (via
 *      `ArchiveProofResolver`) to genuinely resolve `verified` instead of
 *      short-circuiting to a blocking `archive_version_missing` finding.
 *   5. Call the REAL production entry point,
 *      `runParserHandoffForSourceDocument` (source-document-parser-handoff.ts),
 *      with `persistVerificationAudit: true` and a real `sourceKey` --
 *      together these are what route the call through
 *      `createProductionParserVerificationContext` ->
 *      `wireProductionProofBoundary` -> a real
 *      `CompositeProofResolver({ mode: 'production_proof', ... })` backed by
 *      a real Prisma client and a real `SdkS3ProofClient` pointed at the
 *      isolated MinIO via `BUDGET_VERIFICATION_S3_ENDPOINT`. This is the
 *      exact function `DefaultParserHandoffAdapter.handoff` calls in
 *      production; nothing here reimplements, mocks, or shortcuts it.
 *   6. Read back the REAL rows the handoff persisted --
 *      `budget_extraction_candidate_v1`, its current
 *      `budget_verification_run_v1`, and that run's
 *      `budget_verification_check_v1` / `_discrepancy_v1` / `_proof_v1`
 *      rows -- by the candidate's own real (cycleId, sourceDocumentId) key,
 *      exactly as a real reader of this candidate would. This is what makes
 *      the printed report trustworthy: it is not a second, narrower
 *      reconstruction of the proof chain.
 *   7. Print one structured, machine-parseable pass/fail report to stdout
 *      (captured by CloudWatch under this task's log stream).
 *
 * Deliberately NOT carried over from the uncommitted v7/v8 drivers this was
 * reconstructed from: per-process RSS sampling, `/proc/net/dev` deltas, and
 * a PaddleOCR model-directory fingerprint walk. Those were bespoke
 * instrumentation for specific past memory/network investigations, are
 * orthogonal to "did this image's real production-proof path produce the
 * expected, real, isolated result," and are cheap to reintroduce later if a
 * similar investigation needs them again -- keeping them out keeps this
 * script's contract focused on what release qualification actually needs.
 * The artifact determinism check (raw + run-identity-stripped normalized
 * SHA-256) IS kept: proving byte-for-byte reproducibility across qualifying
 * runs is squarely a release-qualification concern, not incident diagnostics.
 *
 * Every identity default below (fixture SHA-256/byte count/URL, target PE,
 * the FY2024 lifecycle cycle UUID) is the exact real production FY2024 Army
 * R-2 Volume 1 BA1 fixture and lifecycle cycle this program has already
 * qualified two release images against (Phase 10B-28, Phase 10B-32) -- kept
 * as the default so results stay comparable across qualification runs, but
 * every one of them is overridable via environment variable so this script
 * is not permanently welded to one fixture.
 *
 * Run standalone (this is what the ECS task-definition's `qual` container
 * entryPoint should invoke directly -- see the PR description for the exact
 * proposed task-definition diff):
 *
 *   tsx apps/api/scripts/qualify-defense-budget-drain-image-v1.ts
 *
 * Required environment: DATABASE_URL (the ISOLATED Postgres sidecar),
 * BUDGET_VERIFICATION_S3_ENDPOINT + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 * (the ISOLATED MinIO sidecar), QUAL_PRESIGNED_GET (a short-lived presigned
 * GET URL for the real archived source bytes -- injected per run, never
 * committed or baked into the task-definition).
 *
 * Exit codes: 0 qualification genuinely completed and printed a report
 * (decision may be PASS/REVIEW/REJECT -- this script's job is to report the
 * real outcome truthfully, not to gate on it; an operator reads the report
 * and decides). 2 usage/config error. 3 fetched source bytes failed identity
 * verification. 4 isolated Postgres sidecar never became reachable. 5
 * isolated MinIO sidecar never became healthy. 6 `prisma migrate deploy`
 * failed. 7 isolated fixture seeding failed. 8 the real parser handoff threw.
 * 9 dbverify found no persisted verification run for the candidate --
 * persist-audit silently failed to write through (exactly the failure mode
 * Phase 10B-32 built the v8 driver to catch; it gets its own loud exit code
 * here too).
 */
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Readable } from 'node:stream';

import type { PrismaClient as PrismaClientType } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';

import { runParserHandoffForSourceDocument } from '../src/defense-budget/parser-router/source-document-parser-handoff.js';
import { createBudgetVerificationS3Client } from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';

// ── Real fixture identity (Phase 10B-28 / Phase 10B-32's FY2024 Army R-2
// Volume 1 BA1 fixture), all overridable. ──────────────────────────────────

// Phase 10B-36 continuation: the five real PE identities this fixture's
// FY2024 request-column totals have been independently reconciled against
// on every prior qualifying run of this exact document (10B-28, 10B-31,
// 10B-32, 10B-35's own audit) -- source: the government PDF's own text
// layer via `pdftotext -layout`, not the extraction pipeline itself, so
// this is a real external check, not a tautology. Kept as a named export so
// a strict release gate can compare a run's full artifact against all five,
// not only whichever single `targetPeCode` this run's config happens to be
// pointed at.
export const KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS: Readonly<Record<string, string>> =
  Object.freeze({
    '0601102A': '296.670',
    '0601103A': '75.672',
    '0601104A': '108.946',
    '0601121A': '5.459',
    '0601601A': '10.708',
  });

const REAL_FIXTURE_DEFAULTS = Object.freeze({
  sourceSha256: '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6',
  sourceBytes: 7227604,
  sourceUrl:
    'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
  targetPeCode: '0601102A',
  fiscalYear: 2024,
  // The real FY2024 'request' lifecycle cycle row id -- production-shaped,
  // not run-dependent, kept identical across qualification runs so seeded
  // identity stays directly comparable between them.
  cycleId: 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c',
  sourceDocumentId: '1d20fc43-b6c0-4212-b6fd-aa95cbc3c342',
  sourceKey: 'defense-budget-observation-qualification-fy2024-army-r2-vol1-ba1',
  archiveBucket: 'capiro-defense-budget-qualification-archive',
  archiveKey: 'production-fy2024-army-r2-vol1-ba1-official.pdf',
  component: 'ARMY',
  documentType: 'r2',
  title: 'FY2024 Army R-2 Vol 1 BA1 (release qualification)',
  budgetFamily: 'rdte' as const,
  exhibitType: 'R-2' as const,
  authority: 'dod-comptroller' as const,
  budgetCycle: 'pb',
  parserPolicy: 'deterministic_table' as const,
});

export interface QualificationConfig {
  readonly runId: string;
  readonly outRoot: string;
  readonly workDir: string;
  readonly sourcePath: string;
  readonly presignedGetUrl: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly sourceUrl: string;
  readonly targetPeCode: string;
  readonly targetR3PeCode?: string;
  readonly fiscalYear: number;
  readonly cycleId: string;
  readonly sourceDocumentId: string;
  readonly sourceKey: string;
  readonly archiveBucket: string;
  readonly archiveKey: string;
  readonly component: string;
  readonly account?: string;
  readonly documentType: string;
  readonly title: string;
  readonly budgetFamily: 'rdte' | 'procurement' | 'om' | 'milcon';
  readonly exhibitType: string;
  readonly authority: string;
  readonly budgetCycle: string;
  readonly parserPolicy: string;
  readonly parserProjectDir: string;
  readonly appsApiDir: string;
}

const SIGNED_SOURCE_QUERY_KEY_RE =
  /^(?:x-amz-|x-goog-|awsaccesskeyid$|signature$|expires$|key-pair-id$|policy$)/i;

/** A durable source locator must never be a short-lived signed fetch credential. */
export function assertCanonicalSourceUrl(sourceUrl: string, presignedGetUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new UsageError('QUAL_SOURCE_URL must be an absolute canonical http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError('QUAL_SOURCE_URL must use http(s)');
  }
  if (
    sourceUrl === presignedGetUrl ||
    [...parsed.searchParams.keys()].some((key) => SIGNED_SOURCE_QUERY_KEY_RE.test(key))
  ) {
    throw new UsageError(
      'QUAL_SOURCE_URL must be a canonical public locator, not a signed fetch URL',
    );
  }
}

/** Resolve every knob from the environment, defaulting to the real fixture identity above. Pure -- takes env in, no I/O. */
export function resolveQualificationConfig(env: NodeJS.ProcessEnv): QualificationConfig {
  const presignedGetUrl = env.QUAL_PRESIGNED_GET?.trim();
  if (!presignedGetUrl) {
    throw new UsageError(
      'QUAL_PRESIGNED_GET is required (a short-lived presigned GET URL for the real archived source bytes)',
    );
  }
  const runId = env.QUAL_RUN_ID?.trim() || 'run1';
  const outRoot = env.QUAL_OUT_ROOT?.trim() || '/tmp/qual';
  const sourceUrl = env.QUAL_SOURCE_URL?.trim() || REAL_FIXTURE_DEFAULTS.sourceUrl;
  assertCanonicalSourceUrl(sourceUrl, presignedGetUrl);
  // This script's own file location, not process.cwd() -- so it resolves
  // correctly whether invoked from the image's WORKDIR, a bare `tsx` call
  // from anywhere, or a local dev checkout, without depending on a shell
  // wrapper having `cd`'d somewhere first. __dirname (not import.meta.url)
  // so this also works when ts-jest compiles this module to CommonJS for
  // qualify-defense-budget-drain-image-v1.spec.ts's imports.
  const appsApiDir = resolvePath(__dirname, '..');
  return {
    runId,
    outRoot,
    workDir: join(outRoot, 'work'),
    sourcePath: join(outRoot, 'source.pdf'),
    presignedGetUrl,
    sourceSha256: env.QUAL_SOURCE_SHA256?.trim() || REAL_FIXTURE_DEFAULTS.sourceSha256,
    sourceBytes: Number(env.QUAL_SOURCE_BYTES?.trim() || REAL_FIXTURE_DEFAULTS.sourceBytes),
    sourceUrl,
    targetPeCode: env.QUAL_TARGET_PE?.trim() || REAL_FIXTURE_DEFAULTS.targetPeCode,
    ...(env.QUAL_TARGET_R3_PE?.trim() ? { targetR3PeCode: env.QUAL_TARGET_R3_PE.trim() } : {}),
    fiscalYear: Number(env.QUAL_FISCAL_YEAR?.trim() || REAL_FIXTURE_DEFAULTS.fiscalYear),
    cycleId: env.QUAL_CYCLE_ID?.trim() || REAL_FIXTURE_DEFAULTS.cycleId,
    sourceDocumentId: env.QUAL_SOURCE_DOCUMENT_ID?.trim() || REAL_FIXTURE_DEFAULTS.sourceDocumentId,
    sourceKey: env.QUAL_SOURCE_KEY?.trim() || REAL_FIXTURE_DEFAULTS.sourceKey,
    archiveBucket: env.QUAL_ARCHIVE_BUCKET?.trim() || REAL_FIXTURE_DEFAULTS.archiveBucket,
    archiveKey: env.QUAL_ARCHIVE_KEY?.trim() || REAL_FIXTURE_DEFAULTS.archiveKey,
    component: env.QUAL_COMPONENT?.trim() || REAL_FIXTURE_DEFAULTS.component,
    ...(env.QUAL_ACCOUNT?.trim() ? { account: env.QUAL_ACCOUNT.trim() } : {}),
    documentType: env.QUAL_DOCUMENT_TYPE?.trim() || REAL_FIXTURE_DEFAULTS.documentType,
    title: env.QUAL_TITLE?.trim() || REAL_FIXTURE_DEFAULTS.title,
    budgetFamily:
      (env.QUAL_BUDGET_FAMILY?.trim() as QualificationConfig['budgetFamily']) ||
      REAL_FIXTURE_DEFAULTS.budgetFamily,
    exhibitType: env.QUAL_EXHIBIT_TYPE?.trim() || REAL_FIXTURE_DEFAULTS.exhibitType,
    authority: env.QUAL_AUTHORITY?.trim() || REAL_FIXTURE_DEFAULTS.authority,
    budgetCycle: env.QUAL_BUDGET_CYCLE?.trim() || REAL_FIXTURE_DEFAULTS.budgetCycle,
    parserPolicy: env.QUAL_PARSER_POLICY?.trim() || REAL_FIXTURE_DEFAULTS.parserPolicy,
    parserProjectDir:
      env.QUAL_PARSER_PROJECT_DIR?.trim() ||
      env.DEFENSE_BUDGET_PARSER_PROJECT_DIR?.trim() ||
      '/defense-budget-parser',
    appsApiDir,
  };
}

// Every fatal condition below carries its own exit code on the error object
// itself, and main()'s only process.exit() call is the single one at the
// very bottom of this file. That is deliberate: process.exit() does not
// synchronously halt execution the way `throw`/`return` do (subsequent
// synchronous statements in the same function can still run before the
// process actually terminates), so scattering process.exit() calls through
// main() risks exactly the class of bug where a "such-and-such is
// unreachable" sidecar failure falls through into code that assumes success.
// Centralizing on thrown, typed errors makes that class of bug structurally
// impossible instead of relying on remembering an early `return` every time.
export abstract class QualificationError extends Error {
  abstract readonly exitCode: number;
}
export class UsageError extends QualificationError {
  readonly exitCode = 2;
}
export class SourceIdentityError extends QualificationError {
  readonly exitCode = 3;
}
export class SidecarUnavailableError extends QualificationError {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}
export class MigrationError extends QualificationError {
  readonly exitCode = 6;
}
export class SeedError extends QualificationError {
  readonly exitCode = 7;
}
export class HandoffError extends QualificationError {
  readonly exitCode = 8;
}

function marker(tag: string, obj: unknown): void {
  console.log(`${tag} ${JSON.stringify(obj)}`);
}

// Prisma rows carry real Date objects (and occasionally BigInt); JSON.stringify
// throws on BigInt and silently ISO-stringifies Date with no declared rule.
// Make the rule explicit before dumping any DB row.
export function jsonSafe(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafe(val);
    return out;
  }
  return v;
}

export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort())
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** @deprecated Compatibility helper for callers pinned to the pre-v1 normalizer. */
export function stripRunIdentity(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripRunIdentity);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'executionId' || k === 'parserRunId' || k === 'artifactId') continue;
      out[k] = stripRunIdentity(val);
    }
    return out;
  }
  return v;
}

/**
 * Stable projection contract for comparing substantive qualification output.
 * Bump this version whenever the allowlist changes. This is deliberately
 * separate from artifactSha256, which always binds the exact persisted bytes.
 */
export const QUALIFICATION_ARTIFACT_PROJECTION_VERSION_V1 =
  'qualification_artifact_projection_v1' as const;

const ASSERTION_SEMANTIC_FIELDS_V1 = [
  'assertionKind',
  'confidence',
  'identity',
  'title',
  'component',
  'serviceCode',
  'appropriation',
  'appropriationType',
  'budgetActivity',
  'budgetActivityName',
  'lineNumber',
  'firstSeenFy',
  'fiscalYear',
  'field',
  'money',
  'narrativeType',
  'text',
  'parentPeCode',
  'projectCode',
  'mission',
  'performerName',
  'performerNormalized',
  'performerRole',
  'location',
  'contractMethod',
  'costCategory',
  'totalCost',
  'parentIdentity',
  'description',
  'quantity',
  'dollars',
  'unitCostDollars',
  'unitLabel',
  'omLine',
  'activityGroup',
  'subActivityGroup',
  'scope',
  'authorizationAmount',
  'appropriationAmount',
  'milestoneType',
  'plannedDate',
  'actualDate',
  'status',
  'notes',
  'from',
  'to',
  'relationshipType',
  'explicitInSource',
  'fieldName',
  'value',
  'metadata',
] as const;

const RUN_DERIVED_KEY_V1 = /(?:Id|ID)$|(?:Sha256|Hash)$/i;
const RUN_DERIVED_NAMES_V1 = new Set([
  'executionid',
  'jobid',
  'providerrunid',
  'parserunid',
  'artifactid',
  'evidenceid',
  'sourcefactid',
  'sourcedocumentid',
  'manifestdocumentkey',
  'createdat',
  'updatedat',
  'generatedat',
  'timestamp',
  'sourceurl',
  'sourcelocator',
  'locator',
  'url',
  'uri',
  'outputartifactsha256',
  'contentsha256',
]);

function stableProjectionValueV1(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Nested arrays may be semantic tuples (for example a bounding box), so
    // their order is preserved. Only explicitly set-like collections are
    // normalized with stableProjectionSetV1 below.
    return value.map(stableProjectionValueV1);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase().replace(/[_-]/g, '');
      const stableDigest =
        normalizedKey === 'sourcepdfsha256' || normalizedKey === 'parserconfigsha256';
      if (
        (!stableDigest && RUN_DERIVED_KEY_V1.test(key)) ||
        RUN_DERIVED_NAMES_V1.has(normalizedKey)
      )
        continue;
      out[key] = stableProjectionValueV1(nested);
    }
    return out;
  }
  return value;
}

function stableProjectionSetV1(values: readonly unknown[]): unknown[] {
  return values.map(stableProjectionValueV1).sort((a, b) => {
    const left = JSON.stringify(canonicalize(a));
    const right = JSON.stringify(canonicalize(b));
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function pickStableFieldsV1(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(record, field))
      picked[field] = stableProjectionValueV1(record[field]);
  }
  return picked;
}

/** Project the allowlisted, run-independent substance of an extraction artifact. */
export function projectQualificationArtifactV1(value: unknown): unknown {
  const artifact = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const assertions = Array.isArray(artifact.assertions) ? artifact.assertions : [];
  const warnings = Array.isArray(artifact.warnings) ? artifact.warnings : [];
  const omissions = Array.isArray(artifact.omissions) ? artifact.omissions : [];
  const parserRuns = Array.isArray(artifact.parserRuns) ? artifact.parserRuns : [];
  const evidence = Array.isArray(artifact.evidence) ? artifact.evidence : [];
  const sourceFacts = Array.isArray(artifact.sourceFacts) ? artifact.sourceFacts : [];
  return canonicalize({
    projectionVersion: QUALIFICATION_ARTIFACT_PROJECTION_VERSION_V1,
    schemaVersion: artifact.schemaVersion,
    source: pickStableFieldsV1(artifact.source, [
      'sourcePdfSha256',
      'fiscalYear',
      'family',
      'exhibit',
      'authority',
      'component',
      'budgetCycle',
      'documentType',
      'pageCount',
      'title',
    ]),
    parserRuns: stableProjectionSetV1(
      parserRuns.map((run) =>
        pickStableFieldsV1(run, [
          'method',
          'parserVersion',
          'parserConfigSha256',
          'pageRanges',
          'requestedPages',
          'succeededPages',
          'failedPages',
        ]),
      ),
    ),
    evidence: stableProjectionSetV1(
      evidence.map((item) =>
        pickStableFieldsV1(item, [
          'granularity',
          'page',
          'printedPage',
          'boundingBox',
          'textSpan',
          'tableLabel',
          'rowLabel',
          'columnLabel',
          'excerpt',
        ]),
      ),
    ),
    sourceFacts: stableProjectionSetV1(
      sourceFacts.map((fact) =>
        pickStableFieldsV1(fact, ['sourcePath', 'category', 'requiredForCompleteness', 'rawValue']),
      ),
    ),
    assertions: stableProjectionSetV1(
      assertions.map((assertion) => pickStableFieldsV1(assertion, ASSERTION_SEMANTIC_FIELDS_V1)),
    ),
    warnings: stableProjectionSetV1(
      warnings.map((warning) => pickStableFieldsV1(warning, ['code', 'severity', 'message'])),
    ),
    omissions: stableProjectionSetV1(
      omissions.map((omission) => pickStableFieldsV1(omission, ['reason', 'severity', 'message'])),
    ),
    summary: stableProjectionValueV1(artifact.summary ?? null),
  });
}

export function hashQualificationArtifactProjectionV1(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(projectQualificationArtifactV1(value)))
    .digest('hex');
}

// Large payloads (artifact bytes, discrepancy/proof-snapshot lists) get
// chunked to bounded-length log lines -- CloudWatch itself tolerates much
// longer events, but every downstream tool that has ever read these logs
// (AWS CLI paging, this very reconstruction) is far more reliable against
// many bounded lines than one very long one.
const CHUNK_CHARS = 6000;

export interface ChunkedPayloadV1 {
  readonly bytes: number;
  readonly sha256: string;
  readonly parts: readonly string[];
}

/** Pure encoder used by every CloudWatch chunk contract. */
export function encodeChunkedPayload(buf: Buffer, chunkChars = CHUNK_CHARS): ChunkedPayloadV1 {
  if (!Number.isSafeInteger(chunkChars) || chunkChars <= 0) {
    throw new RangeError('chunkChars must be a positive safe integer');
  }
  const b64 = buf.toString('base64');
  const parts: string[] = [];
  for (let offset = 0; offset < b64.length; offset += chunkChars) {
    parts.push(b64.slice(offset, offset + chunkChars));
  }
  if (parts.length === 0) parts.push('');
  return {
    bytes: buf.length,
    sha256: createHash('sha256').update(buf).digest('hex'),
    parts,
  };
}

function dumpChunked(tag: string, buf: Buffer, runId: string): void {
  const encoded = encodeChunkedPayload(buf);
  marker(`${tag}_META`, {
    run: runId,
    bytes: encoded.bytes,
    sha256: encoded.sha256,
    chunks: encoded.parts.length,
  });
  for (let i = 0; i < encoded.parts.length; i++) {
    marker(tag, { run: runId, i, n: encoded.parts.length, part: encoded.parts[i] });
  }
  marker(`${tag}_END`, { run: runId, chunks: encoded.parts.length, sha256: encoded.sha256 });
}

function dumpJsonChunked(tag: string, obj: unknown, runId: string): void {
  dumpChunked(tag, Buffer.from(JSON.stringify(jsonSafe(obj), null, 1), 'utf8'), runId);
}

// ── Source identity verification ────────────────────────────────────────

export interface FetchedIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

/** Pure comparison -- no I/O -- so it is trivially unit-testable. */
export function checkSourceIdentity(
  actual: FetchedIdentity,
  expected: { readonly bytes: number; readonly sha256: string },
): { ok: true } | { ok: false; reason: string } {
  if (actual.bytes !== expected.bytes) {
    return {
      ok: false,
      reason: `byte size mismatch: expected ${expected.bytes}, got ${actual.bytes}`,
    };
  }
  if (actual.sha256 !== expected.sha256) {
    return {
      ok: false,
      reason: `sha256 mismatch: expected ${expected.sha256}, got ${actual.sha256}`,
    };
  }
  return { ok: true };
}

/** Streams the presigned URL to disk while hashing in one pass, then verifies identity before returning. Throws SourceIdentityError on mismatch. */
export async function fetchAndVerifySource(
  url: string,
  destPath: string,
  expected: { readonly bytes: number; readonly sha256: string },
): Promise<FetchedIdentity> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new SourceIdentityError(`source fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const hash = createHash('sha256');
  let bytes = 0;
  const out = createWriteStream(destPath);
  // Node's global fetch Response.body is a WHATWG ReadableStream; Readable.fromWeb
  // bridges it to an async-iterable Node stream.
  const reader = Readable.fromWeb(
    res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>,
  );
  for await (const chunk of reader) {
    const buf = chunk as Buffer;
    hash.update(buf);
    bytes += buf.length;
    if (!out.write(buf)) await once(out, 'drain');
  }
  await new Promise<void>((resolvePromise, reject) => {
    out.end((err?: Error | null) => (err ? reject(err) : resolvePromise()));
  });
  const actual: FetchedIdentity = { bytes, sha256: hash.digest('hex') };
  const verdict = checkSourceIdentity(actual, expected);
  if (!verdict.ok) throw new SourceIdentityError(verdict.reason);
  return actual;
}

// ── Sidecar readiness ───────────────────────────────────────────────────

/** Throws SidecarUnavailableError(exitCode=4) if the port never opens within the attempt budget. */
async function waitForTcpPort(
  host: string,
  port: number,
  attempts: number,
  delayMs: number,
): Promise<void> {
  const net = await import('node:net');
  for (let i = 0; i < attempts; i++) {
    const reachable = await new Promise<boolean>((resolvePromise) => {
      const socket = net.createConnection({ host, port }, () => {
        socket.end();
        resolvePromise(true);
      });
      socket.on('error', () => resolvePromise(false));
    });
    if (reachable) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new SidecarUnavailableError(
    `isolated Postgres sidecar never became reachable at ${host}:${port}`,
    4,
  );
}

/** Throws SidecarUnavailableError(exitCode=5) if the health endpoint never returns ok within the attempt budget. */
async function waitForHttpHealth(url: string, attempts: number, delayMs: number): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new SidecarUnavailableError(`isolated MinIO sidecar never became healthy at ${url}`, 5);
}

/**
 * Retries on a transient connection failure (found by independent review:
 * a real Docker port-proxy race where the host port starts accepting TCP
 * before Postgres inside the container is actually ready to serve queries
 * -- waitForTcpPort above passing is necessary but not sufficient). The
 * same race is possible on the real Fargate task shape too: `dependsOn:
 * pg START` only waits for the container to start, not for Postgres to be
 * query-ready. A real schema/syntax failure in the migration itself is NOT
 * transient and will fail identically on every retry, so this does not mask
 * a genuine migration defect -- it only absorbs the narrow startup race.
 */
async function runPrismaMigrateDeploy(cwd: string, attempts = 3, delayMs = 3000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = spawnSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
      cwd,
      stdio: 'inherit',
      env: process.env,
    });
    if (result.status === 0) return;
    if (attempt === attempts) {
      throw new MigrationError(
        `prisma migrate deploy exited ${result.status ?? 'null'} (signal ${result.signal ?? 'none'}) after ${attempts} attempts`,
      );
    }
    console.error(
      `[qualify-defense-budget-drain-image-v1] prisma migrate deploy failed (attempt ${attempt}/${attempts}, likely a Postgres startup race) -- retrying in ${delayMs}ms...`,
    );
    await new Promise((r) => setTimeout(r, delayMs));
  }
}

// ── Isolated fixture seeding ────────────────────────────────────────────

export interface SeedResult {
  readonly archiveVersionId: string;
}

/** Seeds the isolated Postgres (DefenseBudgetCycle + SourceDocument) and the isolated, versioned MinIO bucket with the already-verified source bytes, using the SAME S3 client construction path (`createBudgetVerificationS3Client`) production code uses. */
export async function seedIsolatedFixtures(
  prisma: PrismaClientType,
  s3: S3Client,
  config: QualificationConfig,
): Promise<SeedResult> {
  try {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: config.archiveBucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: config.archiveBucket }));
    }
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: config.archiveBucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    const sourceBytes = readFileSync(config.sourcePath);
    const put = await s3.send(
      new PutObjectCommand({
        Bucket: config.archiveBucket,
        Key: config.archiveKey,
        Body: sourceBytes,
      }),
    );
    const archiveVersionId = put.VersionId;
    if (!archiveVersionId) {
      throw new SeedError(
        'isolated MinIO PutObject did not return a VersionId -- bucket versioning did not take effect',
      );
    }

    const cycleDedupKey = createHash('sha256')
      .update(`defense-budget-qualification-fy${config.fiscalYear}-request-cycle`)
      .digest('hex');
    await prisma.defenseBudgetCycle.upsert({
      where: { id: config.cycleId },
      create: {
        id: config.cycleId,
        fiscalYear: config.fiscalYear,
        authorityTrack: 'request',
        status: 'active',
        templateVersion: 'defense-budget-qualification-v1',
        bootstrapOrigin: 'operator',
        dedupKey: cycleDedupKey,
        metadata: { purpose: 'isolated-qualification', runId: config.runId },
      },
      update: {},
    });

    await prisma.sourceDocument.upsert({
      where: { id: config.sourceDocumentId },
      create: {
        id: config.sourceDocumentId,
        sourceKey: config.sourceKey,
        fiscalYear: config.fiscalYear,
        budgetCycle: config.budgetCycle,
        component: config.component,
        documentType: config.documentType,
        title: config.title,
        sourceUrl: config.sourceUrl,
        sha256: config.sourceSha256,
        byteSize: config.sourceBytes,
        extractionMethod: 'deterministic_pdf',
        archiveBucket: config.archiveBucket,
        archiveS3Key: config.archiveKey,
        archiveVersionId,
        archivedAt: new Date(),
        metadata: {
          purpose: 'isolated-qualification',
          runId: config.runId,
          ...(config.account ? { appropriationAccount: config.account } : {}),
        },
      },
      update: {
        sourceKey: config.sourceKey,
        component: config.component,
        archiveBucket: config.archiveBucket,
        archiveS3Key: config.archiveKey,
        archiveVersionId,
        archivedAt: new Date(),
        metadata: {
          purpose: 'isolated-qualification',
          runId: config.runId,
          ...(config.account ? { appropriationAccount: config.account } : {}),
        },
      },
    });

    return { archiveVersionId };
  } catch (error) {
    if (error instanceof SeedError) throw error;
    throw new SeedError(
      `isolated fixture seeding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await s3.destroy();
  }
}

// ── dbverify: read back the REAL persisted rows ─────────────────────────

export interface DbverifyResult {
  readonly candidate: {
    id: string;
    cycleId: string;
    status: string;
    currentRunId: string | null;
  } | null;
  readonly run: {
    id: string;
    decision: string;
    status: string;
    riskScore: number;
    route: string;
    verifierVersion: string;
    policyVersion: string;
  } | null;
  readonly checks: ReadonlyArray<{
    code: string;
    outcome: string;
    required: boolean;
    blocking: boolean;
    riskPoints: number;
    message: string;
  }>;
  readonly discrepancies: readonly unknown[];
  readonly proofSnapshots: readonly unknown[];
}

/** Reads back the REAL rows the handoff persisted, by the candidate's own (cycleId, sourceDocumentId) key -- exactly what a real reader of this candidate would see, not a second bespoke reconstruction of the proof chain. */
export async function dbverifyCandidate(
  prisma: PrismaClientType,
  cycleId: string,
  sourceDocumentId: string,
): Promise<DbverifyResult> {
  const candidate = await prisma.budgetExtractionCandidateV1.findFirst({
    where: { cycleId, sourceDocumentId },
    orderBy: { createdAt: 'desc' },
  });
  if (!candidate || !candidate.currentRunId) {
    return {
      candidate: candidate ?? null,
      run: null,
      checks: [],
      discrepancies: [],
      proofSnapshots: [],
    };
  }
  const run = await prisma.budgetVerificationRunV1.findFirst({
    where: { id: candidate.currentRunId },
  });
  if (!run) {
    return { candidate, run: null, checks: [], discrepancies: [], proofSnapshots: [] };
  }
  const [checks, discrepancies, proofSnapshots] = await Promise.all([
    prisma.budgetVerificationCheckV1.findMany({
      where: { runId: run.id },
      orderBy: { code: 'asc' },
    }),
    prisma.budgetVerificationDiscrepancyV1.findMany({
      where: { runId: run.id },
      orderBy: { code: 'asc' },
    }),
    prisma.budgetVerificationProofV1.findMany({
      where: { runId: run.id },
      orderBy: { proofKind: 'asc' },
    }),
  ]);
  return { candidate, run, checks, discrepancies, proofSnapshots };
}

// ── Structured report assembly (pure) ───────────────────────────────────

export interface QualificationReport {
  readonly runId: string;
  readonly decision: string;
  readonly finalState: string;
  readonly targetPeCode: string;
  readonly fiscalYear: number;
  readonly totalAssertions: number;
  readonly assertionsByKind: Record<string, number>;
  readonly identityCount: number;
  readonly identityPeCodes: readonly string[];
  readonly omissions: number;
  readonly omissionsByKind: Record<string, number>;
  // A canonical decimal STRING (extraction-artifact-v1.ts's
  // canonicalDecimalStringSchema), never a float -- money values are never
  // represented as JS numbers anywhere in this artifact, precisely to avoid
  // floating-point precision loss on real dollar amounts.
  readonly targetPeFiscalYearTotalMillions: string | null;
  /** The FY2024 request-column total for every PE in
   * `KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS`, read from this same artifact
   * (null when a PE's total assertion is absent -- e.g. a REJECT run that
   * never reached that PE's page). Lets a strict release gate check all
   * five identities from one real run instead of only `targetPeCode`. */
  readonly allTargetPeFiscalYearTotalsMillions: Record<string, string | null>;
  readonly artifactSha256: string;
  readonly normalizedArtifactSha256: string;
  readonly manifestCycleId: string;
  readonly dbCandidateId: string | null;
  readonly dbRunDecision: string | null;
  readonly dbverifyOk: boolean;
  readonly targetR3PeCode: string | null;
  readonly targetR3Performers: ReadonlyArray<{
    readonly performerName: string;
    readonly performerNormalized: string | null;
    readonly costCategory: string | null;
    readonly contractMethod: string | null;
    readonly fiscalYear: number | null;
    readonly totalCostMillions: string | null;
    readonly naturalKey: string | null;
    readonly physicalPage: number | null;
  }>;
  readonly r3DuplicateNaturalKeyConflictCount: number;
}

interface ExtractionArtifactLike {
  assertions: ReadonlyArray<{
    assertionKind: string;
    fieldName?: string;
    // document_fact assertions (extraction-artifact-v1.ts's
    // fundingAssertionV1Schema / documentFactAssertionV1Schema family) carry
    // their payload under `value`; program_element_identity assertions carry
    // theirs under `identity` (rdtePeIdentityV1Schema: { lineKind, peCode }).
    // Two structurally different assertion kinds, two different fields --
    // conflating them was a real bug caught by running this against the real
    // fixture (identityPeCodes came back empty despite identityCount: 5).
    // valueMillions is a canonical decimal STRING (canonicalDecimalStringSchema),
    // never a JS number -- money values are never float-represented here.
    value?: { peCode?: string; fiscalYear?: number; rowKind?: string; valueMillions?: string };
    identity?: { peCode?: string };
    parentPeCode?: string;
    performerName?: string;
    performerNormalized?: string;
    costCategory?: string;
    contractMethod?: string;
    fiscalYear?: number;
    totalCost?: { valueMillions?: string };
    metadata?: { exhibit?: string; naturalKey?: string; physicalPage?: number };
  }>;
  omissions: ReadonlyArray<{
    omissionKind?: string;
    kind?: string;
    code?: string;
    reason?: string;
  }>;
  warnings?: ReadonlyArray<{ code?: string; severity?: string }>;
}

/** Pure: assembles the printed report from the real artifact + real dbverify results. No I/O, fully unit-testable. */
export function buildQualificationReport(input: {
  runId: string;
  decision: string;
  finalState: string;
  artifact: ExtractionArtifactLike;
  artifactRawBytes: Buffer;
  manifestCycleId: string;
  targetPeCode: string;
  targetR3PeCode?: string;
  fiscalYear: number;
  dbverify: DbverifyResult;
}): QualificationReport {
  const { artifact } = input;
  const assertionsByKind: Record<string, number> = {};
  for (const a of artifact.assertions)
    assertionsByKind[a.assertionKind] = (assertionsByKind[a.assertionKind] ?? 0) + 1;

  const omissionsByKind: Record<string, number> = {};
  for (const o of artifact.omissions) {
    const k = String(o.omissionKind ?? o.kind ?? o.code ?? o.reason ?? 'unknown');
    omissionsByKind[k] = (omissionsByKind[k] ?? 0) + 1;
  }

  const identities = artifact.assertions.filter(
    (a) => a.assertionKind === 'program_element_identity',
  ) as Array<{
    assertionKind: string;
    identity?: { peCode?: string };
  }>;
  const findPeTotal = (peCode: string): string | null =>
    artifact.assertions.find(
      (a) =>
        a.assertionKind === 'document_fact' &&
        a.fieldName === 'r2_total_component' &&
        a.value?.peCode === peCode &&
        a.value?.fiscalYear === input.fiscalYear &&
        a.value?.rowKind === 'pe_total',
    )?.value?.valueMillions ?? null;

  const allTargetPeFiscalYearTotalsMillions: Record<string, string | null> = {};
  for (const peCode of Object.keys(KNOWN_FY2024_ARMY_R2_PE_TOTALS_MILLIONS)) {
    allTargetPeFiscalYearTotalsMillions[peCode] = findPeTotal(peCode);
  }

  const rawSha256 = createHash('sha256').update(input.artifactRawBytes).digest('hex');
  const normalizedSha256 = hashQualificationArtifactProjectionV1(
    JSON.parse(input.artifactRawBytes.toString('utf8')),
  );

  const targetR3Performers = artifact.assertions
    .filter(
      (assertion) =>
        assertion.assertionKind === 'performer' &&
        input.targetR3PeCode != null &&
        assertion.parentPeCode === input.targetR3PeCode &&
        assertion.performerName != null &&
        assertion.metadata?.exhibit === 'R-3' &&
        typeof assertion.metadata.naturalKey === 'string' &&
        assertion.metadata.naturalKey.length > 0 &&
        Number.isInteger(assertion.metadata.physicalPage),
    )
    .map((assertion) => ({
      performerName: assertion.performerName!,
      performerNormalized: assertion.performerNormalized ?? null,
      costCategory: assertion.costCategory ?? null,
      contractMethod: assertion.contractMethod ?? null,
      fiscalYear: assertion.fiscalYear ?? null,
      totalCostMillions: assertion.totalCost?.valueMillions ?? null,
      naturalKey: assertion.metadata?.naturalKey ?? null,
      physicalPage: assertion.metadata?.physicalPage ?? null,
    }))
    .sort(
      (left, right) =>
        (left.physicalPage ?? Number.MAX_SAFE_INTEGER) -
          (right.physicalPage ?? Number.MAX_SAFE_INTEGER) ||
        (left.naturalKey ?? left.performerName).localeCompare(
          right.naturalKey ?? right.performerName,
        ),
    );

  return {
    runId: input.runId,
    decision: input.decision,
    finalState: input.finalState,
    targetPeCode: input.targetPeCode,
    fiscalYear: input.fiscalYear,
    totalAssertions: artifact.assertions.length,
    assertionsByKind,
    identityCount: identities.length,
    identityPeCodes: identities
      .map((a) => a.identity?.peCode)
      .filter((v): v is string => Boolean(v))
      .sort(),
    omissions: artifact.omissions.length,
    omissionsByKind,
    targetPeFiscalYearTotalMillions: findPeTotal(input.targetPeCode),
    allTargetPeFiscalYearTotalsMillions,
    artifactSha256: rawSha256,
    normalizedArtifactSha256: normalizedSha256,
    manifestCycleId: input.manifestCycleId,
    dbCandidateId: input.dbverify.candidate?.id ?? null,
    dbRunDecision: input.dbverify.run?.decision ?? null,
    dbverifyOk: input.dbverify.run != null,
    targetR3PeCode: input.targetR3PeCode ?? null,
    targetR3Performers,
    r3DuplicateNaturalKeyConflictCount:
      artifact.warnings?.filter((warning) => warning.code === 'r3_duplicate_natural_key_conflict')
        .length ?? 0,
  };
}

// ── Orchestration ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = resolveQualificationConfig(process.env);
  mkdirSync(config.outRoot, { recursive: true });

  // Self-sufficient: set what the real production code paths read from the
  // environment, rather than depending on a shell wrapper to have exported
  // them first.
  process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = config.workDir;
  process.env.UV_CACHE_DIR ||= '/tmp/uv-cache';
  process.env.XDG_CACHE_HOME ||= '/tmp';
  process.env.TMPDIR ||= '/tmp';

  console.error(
    `[qualify-defense-budget-drain-image-v1] waiting for isolated Postgres sidecar (127.0.0.1:5432)...`,
  );
  await waitForTcpPort('127.0.0.1', 5432, 60, 2000);

  console.error(
    `[qualify-defense-budget-drain-image-v1] waiting for isolated MinIO sidecar (127.0.0.1:9000)...`,
  );
  await waitForHttpHealth('http://127.0.0.1:9000/minio/health/live', 60, 2000);

  console.error(
    '[qualify-defense-budget-drain-image-v1] applying isolated qualification DB migrations...',
  );
  await runPrismaMigrateDeploy(config.appsApiDir);

  marker('QUAL_FETCH_START', { run: config.runId, source: 'presigned_get' });
  let identity: FetchedIdentity;
  try {
    identity = await fetchAndVerifySource(config.presignedGetUrl, config.sourcePath, {
      bytes: config.sourceBytes,
      sha256: config.sourceSha256,
    });
  } catch (error) {
    marker('QUAL_FETCH_IDENTITY_FAIL', { run: config.runId, error: (error as Error).message });
    throw error;
  }
  marker('QUAL_SOURCE_VERIFIED', {
    run: config.runId,
    bytes: identity.bytes,
    sha256: identity.sha256,
  });

  const prisma = new PrismaClient();
  const s3 = createBudgetVerificationS3Client(process.env);
  try {
    console.error(
      '[qualify-defense-budget-drain-image-v1] seeding isolated Postgres + MinIO fixtures...',
    );
    let seed: SeedResult;
    try {
      seed = await seedIsolatedFixtures(prisma, s3, config);
    } catch (error) {
      marker('QUAL_SEED_ERROR', { run: config.runId, error: (error as Error).message });
      throw error;
    }
    marker('QUAL_SEED', {
      run: config.runId,
      archiveBucket: config.archiveBucket,
      archiveKey: config.archiveKey,
      archiveVersionId: seed.archiveVersionId,
      cycleId: config.cycleId,
      sourceDocumentId: config.sourceDocumentId,
      sourceKey: config.sourceKey,
    });

    mkdirSync(config.workDir, { recursive: true });

    console.error(
      '[qualify-defense-budget-drain-image-v1] calling the real production parser handoff...',
    );
    let result: Awaited<ReturnType<typeof runParserHandoffForSourceDocument>>;
    try {
      result = await runParserHandoffForSourceDocument({
        executionId: `defense-budget-qualification-${config.runId}`,
        cycleId: config.cycleId,
        sourceDocumentId: config.sourceDocumentId,
        sourcePath: config.sourcePath,
        sourceSha256: config.sourceSha256,
        sourceLocator: config.sourceUrl,
        sourceUrl: config.sourceUrl,
        parserPolicy: config.parserPolicy as Parameters<
          typeof runParserHandoffForSourceDocument
        >[0]['parserPolicy'],
        exhibitType: config.exhibitType as Parameters<
          typeof runParserHandoffForSourceDocument
        >[0]['exhibitType'],
        budgetFamily: config.budgetFamily,
        fiscalYear: config.fiscalYear,
        authority: config.authority as Parameters<
          typeof runParserHandoffForSourceDocument
        >[0]['authority'],
        component: config.component as Parameters<
          typeof runParserHandoffForSourceDocument
        >[0]['component'],
        ...(config.account ? { account: config.account } : {}),
        budgetCycle: config.budgetCycle,
        // Required by SourceDocumentParserHandoffInput: the same value seeded
        // onto the SourceDocument row above, so the synthetic manifest's
        // `expectedSourceKey` agrees with what production-proof verification
        // reads back out of Postgres.
        sourceKey: config.sourceKey,
        documentType: config.documentType,
        title: config.title,
        workDir: config.workDir,
        // Required to route through createProductionParserVerificationContext
        // -> wireProductionProofBoundary -> the real CompositeProofResolver
        // in 'production_proof' mode + the real Prisma repository.
        persistVerificationAudit: true,
        allowPaidParse: false,
        maxPaidPages: 0,
        parserProjectDir: config.parserProjectDir,
      });
    } catch (error) {
      marker('QUAL_HANDOFF_ERROR', {
        run: config.runId,
        error: (error as Error).message,
        stack: (error as Error).stack?.slice(0, 4000),
      });
      throw new HandoffError((error as Error).message);
    }

    const artifactBytes = readFileSync(result.outputPath);
    dumpChunked('QUAL_ARTIFACT', artifactBytes, config.runId);
    const artifact = JSON.parse(artifactBytes.toString('utf8')) as ExtractionArtifactLike;
    const manifestPath = join(dirname(result.outputPath), 'lifecycle-bridge-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { cycleId: string };

    console.error(
      '[qualify-defense-budget-drain-image-v1] reading back the real persisted verification rows...',
    );
    const dbverify = await dbverifyCandidate(prisma, config.cycleId, config.sourceDocumentId);
    marker('QUAL_CANDIDATE_LOOKUP', {
      run: config.runId,
      queriedCycleId: config.cycleId,
      queriedSourceDocumentId: config.sourceDocumentId,
      found: dbverify.candidate != null,
      candidateId: dbverify.candidate?.id ?? null,
      runFound: dbverify.run != null,
    });

    if (!dbverify.run) {
      marker('QUAL_DBVERIFY_ERROR', {
        run: config.runId,
        error:
          'no persisted budget_verification_run_v1 row found for this candidate -- persist-audit did not write through',
      });
    } else {
      dumpJsonChunked(
        'QUAL_CHECKS',
        {
          run: config.runId,
          decision: dbverify.run.decision,
          status: dbverify.run.status,
          riskScore: dbverify.run.riskScore,
          route: dbverify.run.route,
          checks: dbverify.checks,
        },
        config.runId,
      );
      dumpJsonChunked(
        'QUAL_DISCREPANCIES',
        { run: config.runId, discrepancies: dbverify.discrepancies },
        config.runId,
      );
      const proofFindingsRow = dbverify.proofSnapshots.find(
        (s) => (s as { proofKind?: string }).proofKind === 'proof_findings',
      ) as { evidenceJson?: { findings?: unknown[] } } | undefined;
      dumpJsonChunked(
        'QUAL_PROOFFINDINGS',
        {
          run: config.runId,
          findings: proofFindingsRow?.evidenceJson?.findings ?? [],
          allProofSnapshotKinds: dbverify.proofSnapshots.map((s) => ({
            proofKind: (s as { proofKind?: string }).proofKind,
            status: (s as { status?: string }).status,
          })),
        },
        config.runId,
      );
    }

    const report = buildQualificationReport({
      runId: config.runId,
      decision: result.decision,
      finalState: result.finalState,
      artifact,
      artifactRawBytes: artifactBytes,
      manifestCycleId: manifest.cycleId,
      targetPeCode: config.targetPeCode,
      targetR3PeCode: config.targetR3PeCode,
      fiscalYear: config.fiscalYear,
      dbverify,
    });

    console.log('QUALIFICATION_REPORT ' + JSON.stringify(report, null, 2));

    if (!dbverify.run) {
      // Deliberately NOT thrown: the report above is still real, useful
      // evidence (the artifact itself proves the parser ran) even though
      // persist-audit failed to write through -- exactly the failure mode
      // Phase 10B-32 built the v8 driver to catch. Print it, then fail via
      // process.exitCode (lets pending I/O -- including the report's own
      // console.log -- flush naturally) rather than an abrupt process.exit().
      process.exitCode = 9;
      return;
    }
    console.log('QUAL_FINISH');
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('QUAL_ERROR', (error as Error)?.message ?? error);
    process.exitCode = error instanceof QualificationError ? error.exitCode : 1;
  });
}
