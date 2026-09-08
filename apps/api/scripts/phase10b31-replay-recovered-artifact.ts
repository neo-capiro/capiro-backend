/**
 * Phase 10B-31 -- replay a RECOVERED production extraction artifact through
 * the REAL production verification path, in isolation, WITHOUT re-running
 * the parser.
 *
 * What this drives (all production code, unmodified):
 *   - `routingForSourceFamily('pb_r2')` + `toBudgetComponentOrThrow` --
 *     the exact routing/component translation `DefaultParserHandoffAdapter`
 *     applies;
 *   - `buildLifecycleBridgeSyntheticManifestV1` -- the exact manifest
 *     builder `runParserHandoffForSourceDocument` calls (same key order,
 *     same serialization, so the manifest's content hash is what production
 *     would compute for these inputs);
 *   - `createProductionParserVerificationContext` -- the exact persist-mode
 *     wiring the adapter uses: `wireProductionProofBoundary` ->
 *     `CompositeProofResolver` in `production_proof` mode over the real
 *     Prisma SourceDocument client, the real `SdkS3ProofClient`
 *     (`@aws-sdk/client-s3`), the real `FilesystemParserOutputProofAdapter`,
 *     the real `PrismaBudgetVerificationRepositoryV1`;
 *   - `BudgetVerificationV1Service.verify` with the IDENTICAL
 *     `VerificationRequestV1` shape `ParserRouterV1Service.runVerification`
 *     builds (`mode: 'persist_audit'`, governed raw lifecycle `cycleId`,
 *     `expectedSourcePdfSha256`, `expectedExtractionArtifactSha256` = artifact
 *     BYTE sha) -> real rules -> real `computeDecisionV1` -> real Postgres
 *     persistence (candidate, run, checks, discrepancies, proof snapshots,
 *     and the Phase 10B-31 `proof_findings` row).
 *
 * What it deliberately does NOT do: run the Python parser. The artifact fed
 * in is the byte-exact recovered production artifact (its byte SHA-256 is
 * asserted before use), so this is a replay of PRODUCTION parser output
 * through the REPAIRED verifier -- not a fresh local parse.
 *
 * Isolation (nothing here can reach AWS or a production database):
 *   - DATABASE_URL must name a LOCAL disposable Postgres (refused otherwise);
 *   - BUDGET_VERIFICATION_S3_ENDPOINT must be set and must name a LOCAL
 *     S3-compatible endpoint (a disposable versioned MinIO container). This
 *     is the pre-existing, documented verifier-scoped test hook in
 *     `s3-proof-adapters.ts` (`createBudgetVerificationS3Client`), not a new
 *     switch, and it is the ONLY S3 client construction path production
 *     uses -- so the real `SdkS3ProofClient` HeadObject/GetObject code, the
 *     real `S3ByteLocatorReader`, and the real `ArchiveProofResolver` all
 *     run against the isolated store exactly as they would against S3.
 *     The archive object is uploaded to the isolated store under the REAL
 *     production bucket name and REAL production key with the REAL bytes
 *     (SHA-256 asserted); the ONE value that necessarily differs from the
 *     production row is `archiveVersionId`, because a local S3-compatible
 *     store mints its own version ids -- the SourceDocument row is seeded
 *     with the version id the isolated store actually returned, so the
 *     archive check is a genuine head+bytes+SHA check, never a short-circuit.
 *     The archive check is NOT weakened or bypassed: tamper the bytes or the
 *     version id and it produces its normal blocking `archive_sha_mismatch`.
 *
 * Expected shape of the result and the one known, documented limitation:
 * every SourceDocument / manifest / archive / artifact proof should resolve
 * `verified` with ZERO `source_metadata_mismatch` findings (the bug this
 * phase fixed). Parser-run proof, however, CANNOT be re-established from
 * the recovered artifact alone: `production_proof` requires the
 * independently persisted parser OUTPUT BYTES (R8.2 Workstream C), and in
 * the production drain those live under the container's ephemeral
 * `BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT` (`/tmp/defense-budget-parser-
 * scratch` on task definition `capiro-dev-defense-budget-ingestion-drain:17`)
 * and were never recovered. This script therefore reports whatever the real
 * resolver and decision engine produce -- it does not inject, fabricate, or
 * skip parser-output proof. Read the `proofFindings` and `checks` in the
 * output rather than the headline decision alone.
 *
 * Usage (see docs/defense-budget/PHASE-10B31-PRODUCTION-PROOF-REPAIR-PACKET.md
 * for the exact recorded invocation):
 *   DATABASE_URL=postgresql://...@localhost:PORT/capiro \
 *   BUDGET_VERIFICATION_S3_ENDPOINT=http://localhost:MINIO_PORT \
 *   AWS_ACCESS_KEY_ID=<minio user> AWS_SECRET_ACCESS_KEY=<minio password> AWS_REGION=us-east-1 \
 *   P10B31_RECOVERED_ARTIFACT_PATH=<path> P10B31_SOURCE_PDF_PATH=<path> \
 *   npx tsx scripts/phase10b31-replay-recovered-artifact.ts
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { buildLifecycleBridgeSyntheticManifestV1 } from '../src/defense-budget/parser-router/source-document-parser-handoff.js';
import { routingForSourceFamily } from '../src/defense-budget/parser-router/source-family-routing.js';
import { toBudgetComponentOrThrow } from '../src/defense-budget/default-parser-handoff.adapter.js';
import { createProductionParserVerificationContext } from '../src/defense-budget/parser-router/production-parser-verification-context.js';
import {
  BUDGET_VERIFICATION_S3_ENDPOINT_ENV,
  SdkS3ProofClient,
  createBudgetVerificationS3Client,
} from '../src/defense-budget/verification/trusted-proof/s3-proof-adapters.js';
import { TrustedProofResolutionError } from '../src/defense-budget/verification/trusted-proof/trusted-proof-types.js';
import type { VerificationRequestV1 } from '../src/defense-budget/verification/verification-contract-v1.js';

/* The real production identities of the row under investigation (read-only
 * facts recovered by the prior stage's SELECT-only inspection; re-verify
 * against that evidence before trusting them). */
const REAL = Object.freeze({
  cycleId: 'cff02efd-45e7-4ae4-8f7f-dacd12bdb84c',
  sourceDocumentId: 'a99fbf5b-5eb4-45f3-87e4-96c40c2c0bb0',
  sourceKey: 'defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4',
  sourceSha256: '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6',
  sourceUrl:
    'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf',
  title: 'FY2024 ARMY RDT&E R-2 exhibits',
  fiscalYear: 2024,
  budgetCycle: 'pb',
  component: 'ARMY',
  documentType: 'r2',
  extractionMethod: 'llamaparse',
  byteSize: 7227604,
  archiveBucket: 'capiro-defense-budget-raw-dev-967807252336',
  archiveS3Key:
    'raw/public/dod-budget/fiscal_year=2024/source_authority=dod-comptroller/family=rdte/document_id=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4/sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6/original.bin',
  archiveVersionIdInProduction: 'QN5S2.UB7ez8f6E4xrZxYoBrtW7Nf14s',
  archiveKmsKeyArn: 'arn:aws:kms:us-east-1:967807252336:key/29f4399d-4a5c-449e-b28d-29a7e71b8970',
  retainUntil: '2033-09-01T10:32:56.859Z',
  archivedAt: '2026-09-01T10:32:57.416Z',
  metadata: {
    manifestKey:
      'raw/public/dod-budget/fiscal_year=2024/source_authority=dod-comptroller/family=rdte/document_id=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4/sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6/manifest.json',
    retrievalKey:
      'raw/public/dod-budget/fiscal_year=2024/source_authority=dod-comptroller/family=rdte/document_id=defense-budget-observation-cf5b34c86b34b7e75d9c5be7d18f4dc5a8bbea08aec23611bc2020efce6f74c4/sha256=1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6/retrieval.json',
  },
  /** Byte SHA-256 of the recovered production artifact object (S3 key name == byte sha). */
  recoveredArtifactByteSha256: '739557f6d7df9101694633ecd39a45d0c1d1a75048b7408e24b54616253fce64',
  /** Semantic content SHA the production candidate row carries. */
  recoveredArtifactContentSha256: 'c51eead5f280029f31d8602e42c94b04b7d1882a069fdcb3fe150740c0d8fc60',
  productionCandidateId: 'f967d4fe-0420-5d6e-843e-7dcb84935252',
  productionRunId: '1ea40d2d-22c5-55de-a31a-136501b374f9',
  productionManifestContentSha256: '94a716334f89c75e73d26439fc9b8315fe56a88f1ab3bdf725e8288d48aace13',
});

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireLocalUrl(name: string, raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is required and must name a LOCAL endpoint`);
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${name} "${value}" is not a valid URL`);
  }
  if (!LOCAL_HOSTS.has(hostname)) {
    throw new Error(`${name} host "${hostname}" is not local; refusing to run this isolated replay against it`);
  }
  return value;
}

function requireEnvPath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!existsSync(value)) throw new Error(`${name} does not exist: ${value}`);
  return value;
}

async function main(): Promise<void> {
  const databaseUrl = requireLocalUrl('DATABASE_URL', process.env.DATABASE_URL);
  const s3Endpoint = requireLocalUrl(BUDGET_VERIFICATION_S3_ENDPOINT_ENV, process.env[BUDGET_VERIFICATION_S3_ENDPOINT_ENV]);
  if (process.env.AWS_PROFILE) {
    throw new Error('AWS_PROFILE must be unset for this isolated replay (credentials must be the local store\'s, never a real AWS profile)');
  }
  if (process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET) {
    throw new Error('BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET must be unset (the artifact is served from the local parser-artifact root)');
  }
  const artifactPath = requireEnvPath('P10B31_RECOVERED_ARTIFACT_PATH');
  const sourcePdfPath = requireEnvPath('P10B31_SOURCE_PDF_PATH');
  const keepScratch = process.env.P10B31_KEEP_SCRATCH === '1';

  // 1. Byte-exact inputs.
  const artifactBytes = readFileSync(artifactPath);
  const artifactByteSha256 = sha256Hex(artifactBytes);
  if (artifactByteSha256 !== REAL.recoveredArtifactByteSha256) {
    throw new Error(`recovered artifact byte SHA drifted: expected ${REAL.recoveredArtifactByteSha256}, got ${artifactByteSha256}`);
  }
  const artifactHeader = JSON.parse(artifactBytes.toString('utf8')) as {
    contentSha256: string;
    artifactId: string;
    source: { component: string; sourcePdfSha256: string };
    parserRuns: Array<{ method: string; parserVersion: string; requestedPages: number[] }>;
    assertions: unknown[];
    omissions: Array<{ severity: string; reason: string }>;
  };
  if (artifactHeader.contentSha256 !== REAL.recoveredArtifactContentSha256) {
    throw new Error(`recovered artifact contentSha256 drifted: expected ${REAL.recoveredArtifactContentSha256}, got ${artifactHeader.contentSha256}`);
  }
  const pdfBytes = readFileSync(sourcePdfPath);
  const pdfSha256 = sha256Hex(pdfBytes);
  if (pdfSha256 !== REAL.sourceSha256) {
    throw new Error(`source PDF SHA drifted: expected ${REAL.sourceSha256}, got ${pdfSha256}`);
  }
  if (pdfBytes.length !== REAL.byteSize) {
    throw new Error(`source PDF byte size drifted: expected ${REAL.byteSize}, got ${pdfBytes.length}`);
  }

  // 2. Scratch layout mirroring the production drain's parser-artifact root.
  const outerDir = mkdtempSync(join(tmpdir(), 'phase10b31-replay-recovered-'));
  const parserArtifactRoot = join(outerDir, 'parser-artifact-root');
  const documentWorkDir = join(parserArtifactRoot, 'work', REAL.sourceDocumentId);
  const extractionDir = join(parserArtifactRoot, 'extraction-artifacts');
  mkdirSync(documentWorkDir, { recursive: true });
  mkdirSync(extractionDir, { recursive: true });
  process.env.BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT = parserArtifactRoot;
  const sourcePath = join(documentWorkDir, 'source.pdf');
  writeFileSync(sourcePath, pdfBytes);
  const artifactLocator = join(extractionDir, `${artifactByteSha256}.json`);
  copyFileSync(artifactPath, artifactLocator);
  if (sha256Hex(readFileSync(artifactLocator)) !== artifactByteSha256) {
    throw new Error('artifact copy is not byte-identical');
  }

  // 3. Isolated versioned archive store, reached through the SAME factory
  //    production uses (`createBudgetVerificationS3Client`).
  const s3 = createBudgetVerificationS3Client(process.env);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: REAL.archiveBucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: REAL.archiveBucket }));
  }
  await s3.send(
    new PutBucketVersioningCommand({
      Bucket: REAL.archiveBucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
  );
  const put = await s3.send(
    new PutObjectCommand({
      Bucket: REAL.archiveBucket,
      Key: REAL.archiveS3Key,
      Body: pdfBytes,
      ContentType: 'application/pdf',
      ChecksumAlgorithm: 'SHA256',
    }),
  );
  const isolatedVersionId = put.VersionId;
  if (!isolatedVersionId) {
    throw new Error('isolated archive store did not return a VersionId -- bucket versioning is not effective; refusing to seed an unversioned archive');
  }
  // What the real resolver will see on HeadObject (checksum metadata present
  // or not decides whether ArchiveProofResolver takes the trusted-checksum
  // path or the read-bytes-and-hash path -- both are real production code).
  const probe = new SdkS3ProofClient({ client: s3 });
  const head = await probe.headObject(REAL.archiveBucket, REAL.archiveS3Key, isolatedVersionId);

  // 4. Seed the REAL SourceDocument row (real identities; the isolated
  //    store's version id is the single documented deviation).
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  await prisma.$connect();
  let context: Awaited<ReturnType<typeof createProductionParserVerificationContext>> | undefined;
  try {
    const existing = await prisma.sourceDocument.findUnique({ where: { id: REAL.sourceDocumentId } });
    if (existing) {
      if (existing.archiveVersionId !== isolatedVersionId) {
        throw new Error(
          `SourceDocument ${REAL.sourceDocumentId} already exists with archiveVersionId ${existing.archiveVersionId}; ` +
            'use a fresh disposable database for each replay',
        );
      }
    } else {
      await prisma.sourceDocument.create({
        data: {
          id: REAL.sourceDocumentId,
          sourceKey: REAL.sourceKey,
          fiscalYear: REAL.fiscalYear,
          budgetCycle: REAL.budgetCycle,
          component: REAL.component,
          documentType: REAL.documentType,
          title: REAL.title,
          sourceUrl: REAL.sourceUrl,
          sha256: REAL.sourceSha256,
          byteSize: REAL.byteSize,
          extractionMethod: REAL.extractionMethod,
          metadata: REAL.metadata,
          archiveBucket: REAL.archiveBucket,
          archiveS3Key: REAL.archiveS3Key,
          archiveVersionId: isolatedVersionId,
          archiveKmsKeyArn: REAL.archiveKmsKeyArn,
          retainUntil: new Date(REAL.retainUntil),
          archivedAt: new Date(REAL.archivedAt),
        },
      });
    }

    // 5. The exact production manifest for these inputs, via the exact
    //    production builder with the exact adapter-side translations.
    const routing = routingForSourceFamily('pb_r2');
    const manifest = buildLifecycleBridgeSyntheticManifestV1({
      cycleId: REAL.cycleId,
      fiscalYear: REAL.fiscalYear,
      sourceDocumentId: REAL.sourceDocumentId,
      title: 'r2',
      sourcePath,
      sourceUrl: REAL.sourceUrl,
      sourceSha256: REAL.sourceSha256,
      sourceKey: REAL.sourceKey,
      budgetFamily: routing.family,
      exhibitType: routing.exhibit,
      authority: routing.authority,
      component: toBudgetComponentOrThrow(REAL.component),
      budgetCycle: routing.budgetCycle,
      documentType: routing.documentType,
      parserPolicy: routing.parserPolicy,
    });
    const manifestPath = join(documentWorkDir, 'lifecycle-bridge-manifest.json');
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    writeFileSync(manifestPath, manifestBytes);

    // 6. The exact production persist-mode wiring and the exact router request.
    context = await createProductionParserVerificationContext({ parserArtifactRoot, allowPaidParse: false });
    const request: VerificationRequestV1 = {
      manifestLocator: manifestPath,
      manifestDocumentKey: REAL.sourceDocumentId,
      extractionArtifactLocator: artifactLocator,
      sourceDocumentId: REAL.sourceDocumentId,
      mode: 'persist_audit',
      expectedSourcePdfSha256: REAL.sourceSha256,
      expectedExtractionArtifactSha256: artifactByteSha256,
      cycleId: REAL.cycleId,
    };

    let result: Awaited<ReturnType<typeof context.verificationService.verify>> | null = null;
    let resolutionError: string | null = null;
    try {
      result = await context.verificationService.verify(request);
    } catch (err) {
      if (err instanceof TrustedProofResolutionError) {
        resolutionError = `${err.name}: ${err.message}`;
      } else {
        throw err;
      }
    }

    // 7. Read everything back out of the real database.
    const candidates = await prisma.$queryRawUnsafe<
      Array<{ id: string; cycle_id: string; status: string; manifest_content_sha256: string; extraction_artifact_sha256: string; extraction_artifact_id: string; source_sha256: string; policy_sha256: string; current_run_id: string | null; family: string | null; extraction_method: string | null }>
    >(
      `SELECT id, cycle_id, status, manifest_content_sha256, extraction_artifact_sha256, extraction_artifact_id, source_sha256, policy_sha256, current_run_id, family, extraction_method
         FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid ORDER BY created_at ASC`,
      REAL.sourceDocumentId,
    );
    const runs = await prisma.$queryRawUnsafe<
      Array<{ id: string; candidate_id: string; decision: string; status: string; route: string; risk_score: number }>
    >(
      `SELECT id, candidate_id, decision, status, route, risk_score FROM budget_verification_run_v1
         WHERE candidate_id IN (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid)
         ORDER BY created_at ASC`,
      REAL.sourceDocumentId,
    );
    const proofRows = await prisma.$queryRawUnsafe<
      Array<{ run_id: string; proof_kind: string; status: string; evidence_jsonb: unknown }>
    >(
      `SELECT run_id, proof_kind, status, evidence_jsonb FROM budget_verification_proof
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         ORDER BY created_at ASC, proof_kind ASC`,
      REAL.sourceDocumentId,
    );
    const discrepancyCounts = await prisma.$queryRawUnsafe<
      Array<{ code: string; severity: string; n: bigint }>
    >(
      `SELECT code, severity, COUNT(*)::bigint AS n FROM budget_verification_discrepancy_v1
         WHERE run_id IN (SELECT id FROM budget_verification_run_v1 WHERE candidate_id IN
           (SELECT id FROM budget_extraction_candidate_v1 WHERE source_document_id = $1::uuid))
         GROUP BY code, severity ORDER BY code, severity`,
      REAL.sourceDocumentId,
    );

    const omissionsBySeverity: Record<string, number> = {};
    for (const o of artifactHeader.omissions) {
      const key = `${o.reason}|${o.severity}`;
      omissionsBySeverity[key] = (omissionsBySeverity[key] ?? 0) + 1;
    }

    const report = {
      inputs: {
        recoveredArtifact: {
          path: artifactPath,
          byteSha256: artifactByteSha256,
          contentSha256: artifactHeader.contentSha256,
          artifactId: artifactHeader.artifactId,
          assertions: artifactHeader.assertions.length,
          omissionsByReasonSeverity: omissionsBySeverity,
          sourceComponentInArtifact: artifactHeader.source.component,
          parserRuns: artifactHeader.parserRuns.map((r) => ({
            method: r.method,
            parserVersion: r.parserVersion,
            requestedPageCount: r.requestedPages.length,
          })),
        },
        sourcePdf: { path: sourcePdfPath, sha256: pdfSha256, byteSize: pdfBytes.length },
        isolatedArchiveStore: {
          endpoint: s3Endpoint,
          bucket: REAL.archiveBucket,
          key: REAL.archiveS3Key,
          versionIdUsed: isolatedVersionId,
          productionVersionId: REAL.archiveVersionIdInProduction,
          headObjectSeenByResolver: head,
        },
        manifest: {
          path: manifestPath,
          contentSha256: sha256Hex(manifestBytes),
          productionManifestContentSha256: REAL.productionManifestContentSha256,
          document: {
            component: manifest.documents[0]!.component,
            expectedSourceKey: manifest.documents[0]!.expectedSourceKey,
            expectedSourceSha256: manifest.documents[0]!.expectedSourceSha256,
            sourceLocator: manifest.documents[0]!.sourceLocator,
            cycleId: manifest.cycleId,
          },
        },
        request,
        parserArtifactRoot,
      },
      resolutionError,
      result: result
        ? {
            decision: result.decision,
            status: result.status,
            route: result.route,
            riskScore: result.riskScore,
            candidateId: result.candidateId,
            verificationRunId: result.verificationRunId,
            cycleId: result.cycleId,
            manifestContentSha256: result.manifestContentSha256,
            extractionArtifactSha256: result.extractionArtifactSha256,
            policySha256: result.policySha256,
            checks: result.checks.map((c) => ({
              code: c.code,
              outcome: c.outcome,
              required: c.required,
              blocking: c.blocking,
              riskPoints: c.riskPoints,
              message: c.message,
            })),
            acceptedAssertionCount: result.acceptedAssertionIds.length,
            rejectedAssertionCount: result.rejectedAssertionIds.length,
          }
        : null,
      persisted: {
        candidates,
        runs,
        proofRows,
        discrepancyCounts: discrepancyCounts.map((d) => ({ code: d.code, severity: d.severity, n: Number(d.n) })),
      },
      productionReference: {
        candidateId: REAL.productionCandidateId,
        runId: REAL.productionRunId,
        manifestContentSha256: REAL.productionManifestContentSha256,
      },
    };
    const json = JSON.stringify(report, null, 2);
    console.log(json);
    const out = process.env.P10B31_REPORT_OUT?.trim();
    if (out) writeFileSync(out, `${json}\n`, 'utf8');
  } finally {
    await context?.dispose();
    s3.destroy();
    await prisma.$disconnect();
    if (!keepScratch) rmSync(outerDir, { recursive: true, force: true });
    else console.error(`scratch kept at ${outerDir}`);
  }
}

main().catch((err) => {
  console.error('FAILED', err);
  process.exitCode = 1;
});
