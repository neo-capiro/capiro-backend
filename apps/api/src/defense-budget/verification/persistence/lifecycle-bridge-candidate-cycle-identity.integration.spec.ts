/**
 * Phase 10B-28R -- lifecycle-bridge candidate cycle identity, proven against a
 * REAL Postgres through the REAL verifier, the REAL Prisma persistence
 * repository, and the REAL cycle-keyed readers the readiness / promotion
 * layers use in production. No table-routed fakes, no in-memory maps.
 *
 * Why this exists. On the ingestion-bridge path the router receives the raw
 * lifecycle cycle id (`DefenseBudgetCycle.id`, a UUID) while the proof-facing
 * synthetic manifest carries `fy{year}:{uuid}` (Phase 10B-27, so the manifest
 * validator's "cycleId contains the fiscal year" rule holds). Every
 * cycle-keyed reader downstream -- readiness materialization
 * (`PrismaMaterializationArtifactSourceV1.loadCandidateRefs`), promotion
 * eligibility (`PrismaPromotionEligibilityReadRepositoryV1.loadCandidates`),
 * the manifest registry -- queries `budget_extraction_candidate_v1.cycle_id`
 * with the RAW lifecycle id (readiness resolves it from `defense_budget_cycle`
 * by fiscal year + authority track). The verifier must therefore persist the
 * candidate under the raw lifecycle id, with the fy-tagged label recoverable
 * from the manifest proof snapshot. Before 10B-28R it persisted the manifest
 * label instead, so a bridge candidate could never be found by any of those
 * readers once the readiness path is exercised.
 *
 * Gate: runs only when DATABASE_URL names a LOCAL disposable database (see
 * docs: pgvector/pgvector:pg16, database `capiro`, `prisma migrate deploy`).
 * It is skipped -- never pointed at a shared/production database -- otherwise.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { BudgetVerificationV1Service } from '../services/budget-verification-v1.service.js';
import { PrismaBudgetVerificationRepositoryV1 } from './prisma-budget-verification.repository.js';
import { FilesystemProofResolver } from '../trusted-proof/filesystem-proof-resolver.js';
import { FilesystemParserArtifactProofResolver } from '../trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import { FilesystemParserArtifactStore } from '../../parser-router/parser-artifact-store.js';
import {
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserRunIdentityV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { buildLifecycleBridgeSyntheticManifestV1 } from '../../parser-router/source-document-parser-handoff.js';
import { ArtifactBuilderV1 } from '../../contracts/artifact-builders.js';
import type { ExtractionMethodV1, ParserRunV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseBudgetCycleManifestV1 } from '../../contracts/budget-cycle-manifest-v1.js';
import { sha256Bytes, sha256Hex } from '../../contracts/canonical-json.js';
import type { VerificationRequestV1 } from '../verification-contract-v1.js';
import { PrismaMaterializationArtifactSourceV1 } from '../../promotion/readiness/prisma-materialization-artifact-source-v1.js';
import { PrismaPromotionEligibilityReadRepositoryV1 } from '../../promotion/promotion-eligibility-read-repository-prisma-v1.js';
import { PrismaCycleManifestRegistryV1 } from '../../promotion/readiness/prisma-cycle-manifest-registry-v1.js';
import { PrismaReadinessCorpusLoaderV1 } from '../../promotion/readiness/prisma-readiness-corpus-loader-v1.js';
import { PrismaProjectionPlanRepositoryV1 } from '../../projection-plan/projection-plan-repository-prisma-v1.js';
import { materializeRdteFamilyCertificationV1 } from '../../promotion/readiness/family-certification-materialization-rdte-v1.js';
import type { MaterializationManifestInputV1 } from '../../promotion/readiness/family-certification-materialization-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from '../../promotion/readiness/cycle-family-readiness-v1.js';

const DATABASE_URL = process.env.DATABASE_URL?.trim();

function isLocalDatabaseUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

const describeDb = isLocalDatabaseUrl(DATABASE_URL) ? describe : describe.skip;

const FISCAL_YEAR = 2024;
const PE_CODE = '0601102A';
const CONFIG_SHA = 'c'.repeat(64);
const LIFECYCLE_MARKER = 'phase10b28r-integration-spec';
const SOURCE_URL =
  'https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2024/Base%20Budget/rdte/RDTE-Vol%201-Budget%20Activity%201.pdf';

interface BridgeFixture {
  readonly cycleId: string;
  readonly fiscalYear: number;
  readonly sourceDocumentId: string;
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly manifestPath: string;
  readonly manifestObject: ReturnType<typeof buildLifecycleBridgeSyntheticManifestV1>;
  readonly manifestFileSha256: string;
  readonly artifactPath: string;
  readonly artifactContentSha256: string;
  readonly artifactId: string;
  readonly store: FilesystemParserArtifactStore;
}

/**
 * Builds exactly what the production handoff leaves on disk for one bridge
 * document, minus the parser execution itself: the synthetic manifest (through
 * the SAME builder the handoff uses, serialized the SAME way), a sealed parser
 * result registered in a REAL FilesystemParserArtifactStore so the REAL
 * parser-run proof resolves `verified`, and an R-2 extraction artifact whose
 * parser run is OCR (policy `ocrMoneyAlwaysReview` => REVIEW), matching the
 * FY2024 Army canary's REVIEW disposition.
 */
async function buildBridgeFixture(input: {
  workDir: string;
  cycleId: string;
  fiscalYear: number;
  sourceDocumentId: string;
  sourceBytes: Buffer;
  requestMillions?: string;
  method?: ExtractionMethodV1;
  /** When set, the manifest's cycleId is overwritten with this raw label (pre-10B-27 shape). */
  manifestCycleIdOverride?: string;
}): Promise<BridgeFixture> {
  const dir = join(input.workDir, `${input.cycleId}-${input.sourceDocumentId}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  const sourcePath = join(dir, 'source.pdf');
  writeFileSync(sourcePath, input.sourceBytes);
  const sourceSha256 = sha256Bytes(input.sourceBytes);
  const method = input.method ?? 'paddleocr';
  const parserVersion = method === 'paddleocr' ? 'paddleocr-det-rec-row-reconstruction-v1' : 'pdfplumber-0.11.0';

  const manifestObject = buildLifecycleBridgeSyntheticManifestV1({
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    sourceDocumentId: input.sourceDocumentId,
    title: 'FY2024 ARMY RDT&E R-2 exhibits',
    sourcePath,
    sourceUrl: SOURCE_URL,
    sourceSha256,
    // Phase 10B-31: this fixture's proof resolver is FilesystemProofResolver
    // (not CompositeProofResolver), which never consults expectedSourceKey --
    // this test exercises candidate cycle-identity persistence, not the
    // metadata-agreement check, so any valid non-blank value satisfies the
    // now-required field without affecting this file's assertions.
    sourceKey: `defense-budget-observation-${input.sourceDocumentId}`,
    budgetFamily: 'rdte',
    exhibitType: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r2',
    parserPolicy: 'deterministic_table',
  });
  if (input.manifestCycleIdOverride != null) {
    (manifestObject as { cycleId: string }).cycleId = input.manifestCycleIdOverride;
  }
  const manifestPath = join(dir, 'lifecycle-bridge-manifest.json');
  // Exactly how source-document-parser-handoff.ts serializes it.
  const manifestText = `${JSON.stringify(manifestObject, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText, 'utf8');

  const identity: ParserRunIdentityV1 = {
    sourceSha256,
    method,
    parserVersion,
    parserConfigSha256: CONFIG_SHA,
    pages: [1],
    runtimeContractVersion: DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
  };
  const result = sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: `phase10b28r-${input.cycleId}`,
    engine: method,
    parserVersion,
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: sourceSha256,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text: `PE ${PE_CODE} In-House Laboratory Independent Research FY${input.fiscalYear} ${input.requestMillions ?? '296.67'}`,
        blocks: [],
        tables: [],
        images: [],
        evidencePrecision: 'page_only',
        warnings: [],
      },
    ],
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: 1,
      pagesSucceeded: 1,
      pagesFailed: 0,
      engineVersion: parserVersion,
    },
  });
  const store = new FilesystemParserArtifactStore(join(dir, 'parser-artifacts'));
  await store.putVerified({ identity, result, resultJson: JSON.stringify(result) });

  const parserRun: ParserRunV1 = {
    parserRunId: computeParserRunId(identity),
    method,
    parserVersion,
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: sourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: [{ startPage: 1, endPage: 1 }],
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
  };
  const builder = new ArtifactBuilderV1({
    manifestDocumentKey: input.sourceDocumentId,
    sourceDocumentId: input.sourceDocumentId,
    sourcePdfSha256: sourceSha256,
    sourceLocator: SOURCE_URL,
    sourceUrl: SOURCE_URL,
    fiscalYear: input.fiscalYear,
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb',
    documentType: 'r2',
    title: 'FY2024 ARMY RDT&E R-2 exhibits',
  });
  builder.addParserRun(parserRun);
  builder.addEvidence({
    evidenceId: 'ev-pe',
    sourcePdfSha256: sourceSha256,
    parserRunId: parserRun.parserRunId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addEvidence({
    evidenceId: 'ev-money',
    sourcePdfSha256: sourceSha256,
    parserRunId: parserRun.parserRunId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addSourceFact({
    factId: 'fact-pe',
    sourcePath: 'page:1',
    category: 'identity',
    requiredForCompleteness: true,
    rawValue: PE_CODE,
    evidenceIds: ['ev-pe'],
  });
  builder.addSourceFact({
    factId: 'fact-money',
    sourcePath: 'page:1',
    category: 'money',
    requiredForCompleteness: true,
    rawValue: input.requestMillions ?? '296.67',
    evidenceIds: ['ev-money'],
  });
  builder.addAssertion({
    assertionKind: 'program_element_identity',
    assertionId: 'a-pe',
    sourceFactIds: ['fact-pe'],
    evidenceIds: ['ev-pe'],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE_CODE },
    title: 'In-House Laboratory Independent Research',
    component: 'ARMY',
  });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: 'a-money',
    sourceFactIds: ['fact-money'],
    evidenceIds: ['ev-money'],
    confidence: 1,
    identity: { lineKind: 'RDTE_PE', peCode: PE_CODE },
    fiscalYear: input.fiscalYear,
    field: 'request',
    money: {
      originalValue: input.requestMillions ?? '296.67',
      originalUnit: 'millions',
      valueMillions: input.requestMillions ?? '296.67',
    },
  });
  const artifact = builder.finalize();
  const artifactPath = join(dir, `${input.sourceDocumentId}.extraction-v1.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact), 'utf8');

  return {
    cycleId: input.cycleId,
    fiscalYear: input.fiscalYear,
    sourceDocumentId: input.sourceDocumentId,
    sourcePath,
    sourceSha256,
    manifestPath,
    manifestObject,
    manifestFileSha256: sha256Hex(manifestText),
    artifactPath,
    artifactContentSha256: artifact.contentSha256,
    artifactId: artifact.artifactId,
    store,
  };
}

function realVerifier(prisma: PrismaClient, fixture: BridgeFixture) {
  const repository = new PrismaBudgetVerificationRepositoryV1(prisma);
  const resolver = new FilesystemParserArtifactProofResolver(
    new FilesystemProofResolver({ sourcePdfPath: fixture.sourcePath }),
    fixture.store,
  );
  return { service: new BudgetVerificationV1Service(resolver, repository), repository };
}

/** Exactly the request shape ParserRouterV1Service.runVerification builds on the bridge path. */
function bridgeRequest(fixture: BridgeFixture, mode: 'persist_audit' | 'inspect' = 'persist_audit'): VerificationRequestV1 {
  return {
    manifestLocator: fixture.manifestPath,
    manifestDocumentKey: fixture.sourceDocumentId,
    extractionArtifactLocator: fixture.artifactPath,
    sourceDocumentId: fixture.sourceDocumentId,
    mode,
    expectedSourcePdfSha256: fixture.sourceSha256,
    cycleId: fixture.cycleId,
  };
}

function manifestInputFor(fixture: BridgeFixture): MaterializationManifestInputV1 {
  const parsed = parseBudgetCycleManifestV1(fixture.manifestObject);
  return {
    manifestContentSha256: fixture.manifestFileSha256,
    documents: parsed.documents,
    requiredIdentityKeys: [],
    requiredNarrativeSections: [],
  };
}

/**
 * The verification audit tables (`budget_extraction_candidate_v1`,
 * `budget_verification_run_v1`, checks, discrepancies, proofs, review
 * decisions) are append-only by design -- `*_no_delete` / `*_no_update`
 * triggers refuse any DELETE, and the SourceDocument rows they reference are
 * pinned by RESTRICT foreign keys. This spec therefore never tries to delete
 * them: every run uses fresh random UUIDs for cycle ids, SourceDocument ids
 * and source bytes, so rows from earlier runs cannot collide with or be
 * mistaken for this run's rows, and they simply accumulate in the disposable
 * database. Only the lifecycle rows the corpus-loader test creates
 * (`defense_budget_cycle` / expected source / observation) are removed,
 * because `defense_budget_cycle` is unique per (fiscal year, authority track)
 * and a leftover cycle from a crashed run would otherwise block the next run.
 * Consequently this spec must not run concurrently against one database.
 */
async function cleanupLifecycleRows(prisma: PrismaClient): Promise<void> {
  // `defense_budget_cycle` has exactly four ON DELETE RESTRICT children:
  // expected_source, source_observation, ingestion_outbox and lifecycle_signal.
  // This spec only ever writes the first two, but all four are cleared before
  // the cycle itself: a row left behind by a crashed or future variant of this
  // spec would otherwise make the cycle undeletable, and since these statements
  // deliberately do NOT swallow errors, that would throw in both beforeAll and
  // afterAll and wedge the spec permanently against that database.
  const statements = [
    `DELETE FROM "defense_budget_lifecycle_signal" WHERE "cycle_id" IN (SELECT "id" FROM "defense_budget_cycle" WHERE "template_version" = $1)`,
    `DELETE FROM "defense_budget_ingestion_outbox" WHERE "cycle_id" IN (SELECT "id" FROM "defense_budget_cycle" WHERE "template_version" = $1)`,
    `DELETE FROM "defense_budget_source_observation" WHERE "cycle_id" IN (SELECT "id" FROM "defense_budget_cycle" WHERE "template_version" = $1)`,
    `DELETE FROM "defense_budget_expected_source" WHERE "cycle_id" IN (SELECT "id" FROM "defense_budget_cycle" WHERE "template_version" = $1)`,
    `DELETE FROM "defense_budget_cycle" WHERE "template_version" = $1`,
  ];
  for (const sql of statements) {
    await prisma.$executeRawUnsafe(sql, LIFECYCLE_MARKER);
  }
}

describeDb('Phase 10B-28R -- lifecycle-bridge candidate cycle identity against a real database', () => {
  jest.setTimeout(180_000);

  let prisma: PrismaClient;
  let workDir: string;

  // Production-shaped identities: the lifecycle cycle row id is a UUID, the
  // SourceDocument id is a UUID. Fresh per run so repeated runs on one
  // disposable database never collide on deterministic candidate ids.
  const RAW_CYCLE_ID = randomUUID();
  const SOURCE_DOCUMENT_ID = randomUUID();
  const SOURCE_BYTES = Buffer.from(`%PDF-1.4 phase10b28r bridge source ${RAW_CYCLE_ID}\n`, 'utf8');
  const identity: CycleFamilyReadinessIdentityV1 = {
    fiscalYear: FISCAL_YEAR,
    authorityTrack: 'request',
    familyGroup: 'rdte',
  };

  let fixtureA: BridgeFixture;
  let resultA: Awaited<ReturnType<BudgetVerificationV1Service['verify']>>;

  /**
   * `budget_extraction_candidate_v1.source_document_id` is a real foreign key
   * to `source_document` (the bridge always verifies a REGISTERED
   * SourceDocument), so every candidate this spec persists needs its
   * SourceDocument row first -- exactly as production does.
   */
  async function registerSourceDocument(id: string, bytes: Buffer): Promise<void> {
    await prisma.sourceDocument.create({
      data: {
        id,
        sourceKey: `phase10b28r-spec-${id}`,
        fiscalYear: FISCAL_YEAR,
        budgetCycle: 'pb',
        component: 'ARMY',
        documentType: 'r2',
        title: 'FY2024 ARMY RDT&E R-2 exhibits',
        sourceUrl: SOURCE_URL,
        sha256: sha256Bytes(bytes),
        byteSize: bytes.length,
        extractionMethod: 'deterministic_pdf',
      },
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    await prisma.$connect();
    await cleanupLifecycleRows(prisma);
    workDir = mkdtempSync(join(tmpdir(), 'phase10b28r-cycle-identity-'));
    await registerSourceDocument(SOURCE_DOCUMENT_ID, SOURCE_BYTES);
    fixtureA = await buildBridgeFixture({
      workDir,
      cycleId: RAW_CYCLE_ID,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
    });
    resultA = await realVerifier(prisma, fixtureA).service.verify(bridgeRequest(fixtureA));
  });

  afterAll(async () => {
    // Audit rows are immutable and stay (see cleanupLifecycleRows); the
    // lifecycle rows created for the corpus-loader test are removed so the
    // unique (fiscal year, authority track) cycle can be recreated next run.
    await cleanupLifecycleRows(prisma);
    await prisma.$disconnect();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('the real verifier persists a REVIEW candidate under the RAW lifecycle cycle id, with the fy-tagged manifest label recoverable from the proof snapshot', async () => {
    expect(fixtureA.manifestObject.cycleId).toBe(`fy${FISCAL_YEAR}:${RAW_CYCLE_ID}`);
    expect(resultA.decision).toBe('REVIEW');
    expect(resultA.status).toBe('NEEDS_REVIEW');
    expect(resultA.cycleId).toBe(RAW_CYCLE_ID);
    expect(resultA.manifestContentSha256).toBe(fixtureA.manifestFileSha256);
    // No blocking proof finding survives the fy-tag translation.
    const proofs = await prisma.budgetVerificationProofV1.findMany({ where: { runId: resultA.verificationRunId } });
    const manifestProof = proofs.find((proof) => proof.proofKind === 'manifest');
    expect(manifestProof?.status).toBe('verified');
    const evidence = manifestProof?.evidenceJson as Record<string, unknown>;
    expect(evidence.cycleId).toBe(`fy${FISCAL_YEAR}:${RAW_CYCLE_ID}`);
    expect(evidence.candidateCycleId).toBe(RAW_CYCLE_ID);
    expect(evidence.contentSha256).toBe(fixtureA.manifestFileSha256);

    const rows = await prisma.$queryRawUnsafe<Array<{ cycleId: string; status: string; manifestSha: string; family: string | null; extractionMethod: string | null }>>(
      `SELECT "cycle_id" AS "cycleId", "status", "manifest_content_sha256" AS "manifestSha", "family", "extraction_method" AS "extractionMethod"
         FROM "budget_extraction_candidate_v1" WHERE "id" = $1::uuid`,
      resultA.candidateId,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cycleId).toBe(RAW_CYCLE_ID);
    expect(rows[0]!.status).toBe('NEEDS_REVIEW');
    expect(rows[0]!.manifestSha).toBe(fixtureA.manifestFileSha256);
    expect(rows[0]!.family).toBe('rdte');
    expect(rows[0]!.extractionMethod).toBe('paddleocr');
  });

  it('readiness materialization and promotion eligibility readers find the candidate by the RAW lifecycle cycle id, and NOT by the manifest label', async () => {
    const artifactSource = new PrismaMaterializationArtifactSourceV1(prisma);
    const byRaw = await artifactSource.loadCandidateRefs({
      cycleId: RAW_CYCLE_ID,
      manifestDocumentKeys: [SOURCE_DOCUMENT_ID],
    });
    const ref = byRaw.get(SOURCE_DOCUMENT_ID);
    expect(ref).toBeDefined();
    expect(ref!.candidateId).toBe(resultA.candidateId);
    expect(ref!.verificationRunId).toBe(resultA.verificationRunId);
    expect(ref!.decision).toBe('REVIEW');
    expect(ref!.status).toBe('NEEDS_REVIEW');
    expect(ref!.manifestContentSha256).toBe(fixtureA.manifestFileSha256);
    expect(ref!.sourceSha256).toBe(fixtureA.sourceSha256);

    const byLabel = await artifactSource.loadCandidateRefs({
      cycleId: `fy${FISCAL_YEAR}:${RAW_CYCLE_ID}`,
      manifestDocumentKeys: [SOURCE_DOCUMENT_ID],
    });
    expect(byLabel.size).toBe(0);

    const eligibility = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    const candidates = await eligibility.loadCandidates(RAW_CYCLE_ID, ['rdte']);
    expect(candidates.map((candidate) => candidate.candidateId)).toEqual([resultA.candidateId]);
    expect(candidates[0]!.status).toBe('NEEDS_REVIEW');
    expect(candidates[0]!.family).toBe('rdte');
    expect(candidates[0]!.extractionMethod).toBe('paddleocr');
    expect(await eligibility.loadCandidates(`fy${FISCAL_YEAR}:${RAW_CYCLE_ID}`, ['rdte'])).toEqual([]);
  });

  it('a separately initialized reader (fresh Prisma client, no shared state) finds the same candidate', async () => {
    const fresh = new PrismaClient({ datasources: { db: { url: DATABASE_URL! } } });
    try {
      const refs = await new PrismaMaterializationArtifactSourceV1(fresh).loadCandidateRefs({
        cycleId: RAW_CYCLE_ID,
        manifestDocumentKeys: [SOURCE_DOCUMENT_ID],
      });
      expect(refs.get(SOURCE_DOCUMENT_ID)?.candidateId).toBe(resultA.candidateId);
    } finally {
      await fresh.$disconnect();
    }
  });

  it('repeating the identical verification is an exact idempotent replay (same candidate, same run, no duplicate rows)', async () => {
    const again = await realVerifier(prisma, fixtureA).service.verify(bridgeRequest(fixtureA));
    expect(again.candidateId).toBe(resultA.candidateId);
    expect(again.verificationRunId).toBe(resultA.verificationRunId);
    expect(again.cycleId).toBe(RAW_CYCLE_ID);
    expect(again.decision).toBe('REVIEW');
    const counts = await prisma.$queryRawUnsafe<Array<{ candidates: number; runs: number }>>(
      `SELECT (SELECT COUNT(*) FROM "budget_extraction_candidate_v1" WHERE "cycle_id" = $1 AND "manifest_document_key" = $2)::int AS "candidates",
              (SELECT COUNT(*) FROM "budget_verification_run_v1" r JOIN "budget_extraction_candidate_v1" c ON c."id" = r."candidate_id"
                WHERE c."cycle_id" = $1 AND c."manifest_document_key" = $2)::int AS "runs"`,
      RAW_CYCLE_ID,
      SOURCE_DOCUMENT_ID,
    );
    expect(counts[0]).toEqual({ candidates: 1, runs: 1 });
  });

  it('the readiness corpus loader reconstructs the bridge document as ingested_review from durable rows keyed by the lifecycle cycle', async () => {
    const now = new Date();
    // SourceDocument row already registered in beforeAll (FK for candidates).
    await prisma.documentParseJob.create({
      data: {
        sourceDocumentId: SOURCE_DOCUMENT_ID,
        provider: 'paddleocr',
        mode: 'pdf_ocr',
        resultType: 'json',
        inputSha256: fixtureA.sourceSha256,
        status: 'succeeded',
        completedAt: now,
      },
    });
    await prisma.defenseBudgetCycle.create({
      data: {
        id: RAW_CYCLE_ID,
        fiscalYear: FISCAL_YEAR,
        authorityTrack: 'request',
        templateVersion: LIFECYCLE_MARKER,
        // defense_budget_cycle_origin_chk allows discovery | template | operator.
        bootstrapOrigin: 'template',
        dedupKey: sha256Hex(`${LIFECYCLE_MARKER}:cycle:${RAW_CYCLE_ID}`),
      },
    });
    const expected = await prisma.defenseBudgetExpectedSource.create({
      data: {
        cycleId: RAW_CYCLE_ID,
        fiscalYear: FISCAL_YEAR,
        authorityTrack: 'request',
        stage: 'president_budget_request',
        sourceFamily: 'pb_r2',
        component: 'ARMY',
        adapterId: 'army-budget',
        label: 'FY2024 Army RDT&E R-2 (Vol 1, BA 1)',
        templateVersion: LIFECYCLE_MARKER,
        expectedFrom: now,
        expectedTo: now,
        dedupKey: sha256Hex(`${LIFECYCLE_MARKER}:expected:${RAW_CYCLE_ID}`),
      },
    });
    await prisma.defenseBudgetSourceObservation.create({
      data: {
        expectedSourceId: expected.id,
        cycleId: RAW_CYCLE_ID,
        adapterId: 'army-budget',
        discoveredUrl: SOURCE_URL,
        contentSha256: fixtureA.sourceSha256,
        byteSize: SOURCE_BYTES.length,
        observationState: 'ingested',
        revisionKind: 'first_discovery',
        classifiedFiscalYear: FISCAL_YEAR,
        classifiedAuthorityTrack: 'request',
        classifiedStage: 'president_budget_request',
        classifiedSourceFamily: 'pb_r2',
        sourceDocumentId: SOURCE_DOCUMENT_ID,
        dedupKey: sha256Hex(`${LIFECYCLE_MARKER}:observation:${RAW_CYCLE_ID}`),
      },
    });

    const corpus = await new PrismaReadinessCorpusLoaderV1(prisma, () => undefined).loadCorpus(identity);
    expect(corpus.cycleId).toBe(RAW_CYCLE_ID);
    expect(corpus.expectedSources).toHaveLength(1);
    expect(corpus.expectedSources[0]!.latestIngestion).toBe('ingested_review');
  });

  it('the manifest registry, keyed by the RAW lifecycle cycle id, resolves for the matching readiness identity only', async () => {
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    await registry.register(RAW_CYCLE_ID, parseBudgetCycleManifestV1(fixtureA.manifestObject));
    const loaded = await registry.loadManifestForIdentity(identity, RAW_CYCLE_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.documents.map((document) => document.documentKey)).toEqual([SOURCE_DOCUMENT_ID]);
    expect(await registry.loadManifestForIdentity({ ...identity, fiscalYear: FISCAL_YEAR + 1 }, RAW_CYCLE_ID)).toBeNull();
    expect(await registry.loadManifestForIdentity(identity, `fy${FISCAL_YEAR}:${RAW_CYCLE_ID}`)).toBeNull();
  });

  it('REVIEW is discovered but never treated as usable: materialization by the RAW cycle id reports candidate_incomplete until an explicit review decision, and bundle gates still govern afterwards', async () => {
    const artifactSource = new PrismaMaterializationArtifactSourceV1(prisma);
    const projectionPlans = new PrismaProjectionPlanRepositoryV1(prisma);
    const request = { identity, cycleId: RAW_CYCLE_ID, manifest: manifestInputFor(fixtureA) };
    const ports = { artifactSource, projectionPlans, producerVersion: 'phase10b28r-integration-spec@1' };

    const beforeAcceptance = await materializeRdteFamilyCertificationV1(request, ports);
    expect(beforeAcceptance.outcome).toBe('candidate_incomplete');
    expect(beforeAcceptance.detail).toContain(resultA.candidateId);
    expect(beforeAcceptance.detail).toContain('status is NEEDS_REVIEW');
    expect(beforeAcceptance.record).toBeNull();

    // An explicit, hash-bound review decision through the REAL repository is
    // the only thing that moves the candidate forward.
    const { repository } = realVerifier(prisma, fixtureA);
    const decision = await repository.persistReviewDecision({
      candidateId: resultA.candidateId,
      verificationRunId: resultA.verificationRunId,
      reviewerId: 'phase10b28r-integration-spec',
      decision: 'accept',
      notes: 'isolated integration test: exercising the acceptance boundary only',
      evidenceIds: [],
      expectedSourceSha256: resultA.sourcePdfSha256,
      expectedExtractionArtifactSha256: resultA.extractionArtifactSha256,
      expectedManifestContentSha256: resultA.manifestContentSha256,
    });
    expect(decision.candidateId).toBe(resultA.candidateId);
    const accepted = await artifactSource.loadCandidateRefs({ cycleId: RAW_CYCLE_ID, manifestDocumentKeys: [SOURCE_DOCUMENT_ID] });
    expect(accepted.get(SOURCE_DOCUMENT_ID)?.status).toBe('REVIEW_ACCEPTED');
    expect(accepted.get(SOURCE_DOCUMENT_ID)?.decision).toBe('REVIEW');

    // After acceptance the materializer proceeds past the status gate and
    // reloads the artifact. Nothing here may produce a projection plan: a
    // single accepted R-2 member is not a complete RDT&E bundle. Today the
    // reload itself is refused, because `loadVerifiedArtifact` compares the
    // FILE byte SHA against `budget_extraction_candidate_v1.
    // extraction_artifact_sha256`, which the verifier populates with the
    // artifact CONTENT SHA (`resolution.extractionArtifactContentSha256`) --
    // the same content-vs-byte disagreement the real FY2024 Army canary shows
    // (artifactContentSha256 95433cc2... vs artifactByteSha256 9a088be0...).
    // That is a pre-existing contract mismatch in the post-acceptance
    // materialization path, documented (not changed) by Phase 10B-28R; it is
    // fail-closed, so it is asserted here exactly as observed.
    let afterAcceptance: Awaited<ReturnType<typeof materializeRdteFamilyCertificationV1>> | null = null;
    let thrown: unknown = null;
    try {
      afterAcceptance = await materializeRdteFamilyCertificationV1(request, ports);
    } catch (error) {
      thrown = error;
    }
    if (afterAcceptance) {
      expect(afterAcceptance.outcome).not.toBe('materialized');
      expect(afterAcceptance.record).toBeNull();
    } else {
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toMatch(/artifact byte SHA mismatch .* refusing to materialize/);
    }
    const plans = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS "n" FROM "defense_budget_projection_plan" WHERE "cycle_id" = $1`,
      RAW_CYCLE_ID,
    );
    expect(plans[0]!.n).toBe(0);
  });

  it('a tampered wrong-year manifest still fails closed through the real resolver (blocking manifest_sha_mismatch => REJECT), without persisting', async () => {
    const tampered = await buildBridgeFixture({
      workDir,
      cycleId: RAW_CYCLE_ID,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
    });
    (tampered.manifestObject as { fiscalYear: number }).fiscalYear = FISCAL_YEAR - 1;
    writeFileSync(tampered.manifestPath, `${JSON.stringify(tampered.manifestObject, null, 2)}\n`, 'utf8');
    const result = await realVerifier(prisma, tampered).service.verify(bridgeRequest(tampered, 'inspect'));
    expect(result.decision).toBe('REJECT');
    expect(result.cycleId).toBe(RAW_CYCLE_ID);
    const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS "n" FROM "budget_extraction_candidate_v1" WHERE "cycle_id" = $1`,
      RAW_CYCLE_ID,
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('other cycles, fiscal years, and document identities remain distinct and isolated from the RAW cycle', async () => {
    const otherCycle = randomUUID();
    const otherFyCycle = randomUUID();
    const otherDocument = randomUUID();

    const sameDocumentOtherCycle = await buildBridgeFixture({
      workDir,
      cycleId: otherCycle,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
    });
    const otherFiscalYear = await buildBridgeFixture({
      workDir,
      cycleId: otherFyCycle,
      fiscalYear: FISCAL_YEAR + 1,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
    });
    const otherDocumentBytes = Buffer.from(`%PDF-1.4 phase10b28r other document ${otherDocument}\n`, 'utf8');
    await registerSourceDocument(otherDocument, otherDocumentBytes);
    const otherDocumentSameCycle = await buildBridgeFixture({
      workDir,
      cycleId: RAW_CYCLE_ID,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: otherDocument,
      sourceBytes: otherDocumentBytes,
    });

    const resultB = await realVerifier(prisma, sameDocumentOtherCycle).service.verify(bridgeRequest(sameDocumentOtherCycle));
    const resultC = await realVerifier(prisma, otherFiscalYear).service.verify(bridgeRequest(otherFiscalYear));
    const resultD = await realVerifier(prisma, otherDocumentSameCycle).service.verify(bridgeRequest(otherDocumentSameCycle));

    expect(new Set([resultA.candidateId, resultB.candidateId, resultC.candidateId, resultD.candidateId]).size).toBe(4);
    expect(resultB.cycleId).toBe(otherCycle);
    expect(resultC.cycleId).toBe(otherFyCycle);
    expect(resultD.cycleId).toBe(RAW_CYCLE_ID);

    const artifactSource = new PrismaMaterializationArtifactSourceV1(prisma);
    const rawRefs = await artifactSource.loadCandidateRefs({
      cycleId: RAW_CYCLE_ID,
      manifestDocumentKeys: [SOURCE_DOCUMENT_ID, otherDocument],
    });
    expect(rawRefs.get(SOURCE_DOCUMENT_ID)?.candidateId).toBe(resultA.candidateId);
    expect(rawRefs.get(otherDocument)?.candidateId).toBe(resultD.candidateId);
    const otherRefs = await artifactSource.loadCandidateRefs({ cycleId: otherCycle, manifestDocumentKeys: [SOURCE_DOCUMENT_ID] });
    expect(otherRefs.get(SOURCE_DOCUMENT_ID)?.candidateId).toBe(resultB.candidateId);
    const otherFyRefs = await artifactSource.loadCandidateRefs({ cycleId: otherFyCycle, manifestDocumentKeys: [SOURCE_DOCUMENT_ID] });
    expect(otherFyRefs.get(SOURCE_DOCUMENT_ID)?.candidateId).toBe(resultC.candidateId);

    const eligibility = new PrismaPromotionEligibilityReadRepositoryV1(prisma);
    expect((await eligibility.loadCandidates(otherCycle, ['rdte'])).map((c) => c.candidateId)).toEqual([resultB.candidateId]);
    expect((await eligibility.loadCandidates(otherFyCycle, ['rdte'])).map((c) => c.candidateId)).toEqual([resultC.candidateId]);
  });

  it('coexists with pre-fix REJECT rows: a raw-UUID manifest (pre-10B-27 shape) still persists as REJECT under the same lifecycle cycle, and readiness sees the newest terminal candidate', async () => {
    const legacyCycle = randomUUID();
    const preFix = await buildBridgeFixture({
      workDir,
      cycleId: legacyCycle,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
      manifestCycleIdOverride: legacyCycle,
    });
    const rejected = await realVerifier(prisma, preFix).service.verify(bridgeRequest(preFix));
    expect(rejected.decision).toBe('REJECT');
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.cycleId).toBe(legacyCycle);

    const postFix = await buildBridgeFixture({
      workDir,
      cycleId: legacyCycle,
      fiscalYear: FISCAL_YEAR,
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      sourceBytes: SOURCE_BYTES,
    });
    const reviewed = await realVerifier(prisma, postFix).service.verify(bridgeRequest(postFix));
    expect(reviewed.decision).toBe('REVIEW');
    expect(reviewed.cycleId).toBe(legacyCycle);
    expect(reviewed.candidateId).not.toBe(rejected.candidateId);

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; cycleId: string; status: string }>>(
      `SELECT "id", "cycle_id" AS "cycleId", "status" FROM "budget_extraction_candidate_v1" WHERE "cycle_id" = $1 ORDER BY "created_at"`,
      legacyCycle,
    );
    expect(rows.map((row) => row.status)).toEqual(['REJECTED', 'NEEDS_REVIEW']);
    expect(rows.every((row) => row.cycleId === legacyCycle)).toBe(true);

    const refs = await new PrismaMaterializationArtifactSourceV1(prisma).loadCandidateRefs({
      cycleId: legacyCycle,
      manifestDocumentKeys: [SOURCE_DOCUMENT_ID],
    });
    expect(refs.get(SOURCE_DOCUMENT_ID)?.candidateId).toBe(reviewed.candidateId);
    expect(refs.get(SOURCE_DOCUMENT_ID)?.status).toBe('NEEDS_REVIEW');
  });
});
