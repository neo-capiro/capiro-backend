/**
 * Tests for trusted proof types and resolvers (Workstreams B + C).
 *
 * Tests:
 * - blocking/review finding constructors
 * - PROOF_FINDING_V1_VALUES completeness
 * - SourceDocument not found
 * - SourceDocument SHA mismatch
 * - archive missing/mismatch
 * - manual parser proof + mandatory review trigger
 * - deterministic parser artifact mismatch
 * - reference artifact proof failure
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  blockingFinding,
  reviewFinding,
  PROOF_FINDING_V1_VALUES,
  type ProofFindingCodeV1,
} from './trusted-proof-types.js';
import { SourceDocumentProofResolver } from './source-document-proof-resolver.js';
import { ArchiveProofResolver, type S3ObjectReader } from './archive-proof-resolver.js';
import { ParserRunProofResolver } from './parser-run-proof-resolver.js';
import type { DefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.js';
import type {
  SourceDocumentClient,
  SourceDocumentRow,
} from '../../../program-element/source-document/source-document-registry.js';

const VALID_SHA = 'a'.repeat(64);
const DIFFERENT_SHA = 'b'.repeat(64);

describe('trusted-proof-types — finding constructors', () => {
  it('blockingFinding creates a blocking finding', () => {
    const f = blockingFinding('source_sha_mismatch', 'SHA mismatch');
    expect(f.severity).toBe('blocking');
    expect(f.code).toBe('source_sha_mismatch');
    expect(f.message).toBe('SHA mismatch');
  });

  it('reviewFinding creates a review finding', () => {
    const f = reviewFinding('archive_version_missing', 'archive missing');
    expect(f.severity).toBe('review');
    expect(f.code).toBe('archive_version_missing');
  });

  it('PROOF_FINDING_V1_VALUES includes all required codes', () => {
    const required: ProofFindingCodeV1[] = [
      'source_document_not_found',
      'source_sha_mismatch',
      'manifest_sha_mismatch',
      'artifact_byte_sha_mismatch',
      'artifact_content_sha_mismatch',
      'artifact_source_sha_mismatch',
      'archive_version_missing',
      'archive_sha_mismatch',
      'parse_job_missing',
      'parse_input_sha_mismatch',
      'parse_output_sha_mismatch',
      'parser_method_mismatch',
      'reference_artifact_proof_failed',
    ];
    for (const code of required) {
      expect(PROOF_FINDING_V1_VALUES).toContain(code);
    }
  });
});

describe('SourceDocumentProofResolver', () => {
  function makeFakeClient(row: SourceDocumentRow | null): SourceDocumentClient {
    return {
      sourceDocument: {
        findFirst: jest.fn(
          async () => row,
        ) as unknown as SourceDocumentClient['sourceDocument']['findFirst'],
        create: jest.fn() as unknown as SourceDocumentClient['sourceDocument']['create'],
        update: jest.fn() as unknown as SourceDocumentClient['sourceDocument']['update'],
      },
    };
  }

  it('returns source_document_not_found when row is null', async () => {
    const resolver = new SourceDocumentProofResolver(makeFakeClient(null));
    const result = await resolver.resolve({
      sourceDocumentId: 'missing-id',
      actualSourcePdfSha256: VALID_SHA,
      artifactSourcePdfSha256: VALID_SHA,
    });
    expect(result.findings.some((f) => f.code === 'source_document_not_found')).toBe(true);
    expect(result.findings.every((f) => f.severity === 'blocking')).toBe(true);
  });

  it('returns source_sha_mismatch when stored SHA differs from actual', async () => {
    const row: SourceDocumentRow = {
      id: 'src-1',
      sourceKey: 'key',
      sha256: DIFFERENT_SHA,
      supersededByDocumentId: null,
    };
    const resolver = new SourceDocumentProofResolver(makeFakeClient(row));
    const result = await resolver.resolve({
      sourceDocumentId: 'src-1',
      actualSourcePdfSha256: VALID_SHA,
      artifactSourcePdfSha256: VALID_SHA,
    });
    expect(result.findings.some((f) => f.code === 'source_sha_mismatch')).toBe(true);
  });

  it('returns artifact_source_sha_mismatch when artifact SHA differs from actual', async () => {
    const row: SourceDocumentRow = {
      id: 'src-1',
      sourceKey: 'key',
      sha256: VALID_SHA,
      supersededByDocumentId: null,
    };
    const resolver = new SourceDocumentProofResolver(makeFakeClient(row));
    const result = await resolver.resolve({
      sourceDocumentId: 'src-1',
      actualSourcePdfSha256: VALID_SHA,
      artifactSourcePdfSha256: DIFFERENT_SHA,
    });
    expect(result.findings.some((f) => f.code === 'artifact_source_sha_mismatch')).toBe(true);
  });

  it('returns no findings when all SHAs match', async () => {
    const row: SourceDocumentRow = {
      id: 'src-1',
      sourceKey: 'key',
      sha256: VALID_SHA,
      supersededByDocumentId: null,
    };
    const resolver = new SourceDocumentProofResolver(makeFakeClient(row));
    const result = await resolver.resolve({
      sourceDocumentId: 'src-1',
      actualSourcePdfSha256: VALID_SHA,
      artifactSourcePdfSha256: VALID_SHA,
    });
    expect(result.findings).toEqual([]);
  });
});

describe('ArchiveProofResolver', () => {
  const fakeS3Reader: S3ObjectReader = {
    getObjectBytes: jest.fn(async () => null) as unknown as S3ObjectReader['getObjectBytes'],
    headObject: jest.fn(async () => null) as unknown as S3ObjectReader['headObject'],
  };

  it('returns missing when no archive metadata', async () => {
    const resolver = new ArchiveProofResolver(fakeS3Reader);
    const result = await resolver.resolve({
      expectedSourceSha256: VALID_SHA,
    });
    expect(result.archive.status).toBe('missing');
    expect(result.findings.some((f) => f.code === 'archive_version_missing')).toBe(true);
  });

  it('returns missing when VersionId absent (bucket/key present)', async () => {
    const resolver = new ArchiveProofResolver(fakeS3Reader);
    const result = await resolver.resolve({
      archiveBucket: 'bucket',
      archiveS3Key: 'key',
      expectedSourceSha256: VALID_SHA,
    });
    // Absent VersionId is a missing archive, not a byte mismatch.
    expect(result.archive.status).toBe('missing');
    expect(result.findings.some((f) => f.code === 'archive_version_missing')).toBe(true);
    expect(result.findings.every((f) => f.severity === 'blocking')).toBe(true);
  });

  it('required archive: absent metadata is a blocking finding, not review', async () => {
    const resolver = new ArchiveProofResolver(fakeS3Reader);
    const result = await resolver.resolve({
      expectedSourceSha256: VALID_SHA,
      requireImmutableArchive: true,
    });
    expect(result.archive.status).toBe('missing');
    expect(result.findings.every((f) => f.severity === 'blocking')).toBe(true);
  });

  it('not-required archive: absent metadata is a review finding', async () => {
    const resolver = new ArchiveProofResolver(fakeS3Reader);
    const result = await resolver.resolve({
      expectedSourceSha256: VALID_SHA,
      requireImmutableArchive: false,
    });
    expect(result.archive.status).toBe('missing');
    expect(result.findings.every((f) => f.severity === 'review')).toBe(true);
  });

  it('returns missing when S3 object not found', async () => {
    const reader: S3ObjectReader = {
      getObjectBytes: jest.fn(async () => null) as unknown as S3ObjectReader['getObjectBytes'],
      headObject: jest.fn(async () => null) as unknown as S3ObjectReader['headObject'],
    };
    const resolver = new ArchiveProofResolver(reader);
    const result = await resolver.resolve({
      archiveBucket: 'bucket',
      archiveS3Key: 'key',
      archiveVersionId: 'v1',
      expectedSourceSha256: VALID_SHA,
    });
    expect(result.archive.status).toBe('missing');
    expect(result.findings.some((f) => f.code === 'archive_sha_mismatch')).toBe(true);
  });

  it('returns verified when SHA matches via checksum metadata', async () => {
    const reader: S3ObjectReader = {
      getObjectBytes: jest.fn(async () => null) as unknown as S3ObjectReader['getObjectBytes'],
      headObject: jest.fn(async () => ({
        sha256Checksum: VALID_SHA,
        contentLength: 1000,
      })) as unknown as S3ObjectReader['headObject'],
    };
    const resolver = new ArchiveProofResolver(reader);
    const result = await resolver.resolve({
      archiveBucket: 'bucket',
      archiveS3Key: 'key',
      archiveVersionId: 'v1',
      expectedSourceSha256: VALID_SHA,
    });
    expect(result.archive.status).toBe('verified');
    expect(result.archive.objectSha256).toBe(VALID_SHA);
    expect(result.findings).toEqual([]);
  });

  it('returns mismatch when SHA differs', async () => {
    const reader: S3ObjectReader = {
      getObjectBytes: jest.fn(async () => null) as unknown as S3ObjectReader['getObjectBytes'],
      headObject: jest.fn(async () => ({
        sha256Checksum: DIFFERENT_SHA,
      })) as unknown as S3ObjectReader['headObject'],
    };
    const resolver = new ArchiveProofResolver(reader);
    const result = await resolver.resolve({
      archiveBucket: 'bucket',
      archiveS3Key: 'key',
      archiveVersionId: 'v1',
      expectedSourceSha256: VALID_SHA,
    });
    expect(result.archive.status).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'archive_sha_mismatch')).toBe(true);
  });
});

describe('ParserRunProofResolver — manual parser', () => {
  function makeMinimalArtifact(contentSha: string): DefenseBudgetExtractionArtifactV1 {
    return {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: `dbx1_${contentSha}`,
      contentSha256: contentSha,
      source: {
        manifestDocumentKey: 'test',
        sourcePdfSha256: VALID_SHA,
        sourceLocator: '/test.pdf',
        fiscalYear: 2027,
        family: 'rdte',
        exhibit: 'R-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r1',
      },
      parserRuns: [
        {
          parserRunId: 'run-1',
          method: 'manual',
          parserVersion: '1.0',
          parserConfigSha256: VALID_SHA,
          inputSourceSha256: VALID_SHA,
          outputArtifactSha256: contentSha,
          pageRanges: [{ startPage: 1, endPage: 10 }],
        },
      ],
      evidence: [],
      sourceFacts: [],
      assertions: [],
      warnings: [],
      omissions: [],
      summary: {
        sourceFactCount: 0,
        requiredSourceFactCount: 0,
        coveredRequiredSourceFactCount: 0,
        omittedRequiredSourceFactCount: 0,
        uncoveredRequiredSourceFactCount: 0,
        assertionCount: 0,
        warningCount: 0,
        omissionCount: 0,
        countsByAssertionKind: {},
        countsByOmissionReason: {},
        completenessStatus: 'complete',
      },
    } as unknown as DefenseBudgetExtractionArtifactV1;
  }

  it('manual parser triggers mandatory review', async () => {
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.manualReviewTriggered).toBe(true);
    expect(result.parserRuns).toHaveLength(1);
    expect(result.parserRuns[0]!.method).toBe('manual');
    expect(result.parserRuns[0]!.proofStatus).toBe('verified');
    // Manual parser must carry a review finding
    expect(result.findings.some((f) => f.severity === 'review')).toBe(true);
  });

  it('detects parse_input_sha_mismatch when source SHA differs', async () => {
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: DIFFERENT_SHA,
    });
    expect(result.findings.some((f) => f.code === 'parse_input_sha_mismatch')).toBe(true);
  });

  it('detects parse_output_sha_mismatch when output SHA differs', async () => {
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    // Make the parserRun output SHA different from artifact content SHA
    artifact.parserRuns[0]!.outputArtifactSha256 = DIFFERENT_SHA;
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.findings.some((f) => f.code === 'parse_output_sha_mismatch')).toBe(true);
  });

  it('LlamaParse without parse-job client returns missing', async () => {
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    artifact.parserRuns[0]!.method = 'llamaparse';
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('missing');
    expect(result.findings.some((f) => f.code === 'parse_job_missing')).toBe(true);
  });

  it('deterministic parser WITHOUT a proof source is missing, never verified', async () => {
    // R8.2-C: fields inside the artifact are not independent proof. Without
    // an injected ParserOutputProofSource the persisted output bytes cannot
    // be loaded, so the run must be reported missing.
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    artifact.parserRuns[0]!.method = 'deterministic_pdfplumber';
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('missing');
    expect(result.findings.some((f) => f.code === 'parse_output_missing')).toBe(true);
    expect(result.manualReviewTriggered).toBe(false);
  });

  it('deterministic parser WITH matching persisted output is verified', async () => {
    const { sha256Hex } = require('../../contracts/canonical-json.js');
    const outputBytes = Buffer.from('{"pages":[1]}');
    const outputProofSource = {
      resolveParserOutput: jest.fn(async () => ({
        persistedRunId: 'run-1',
        outputLocator: '/store/run-1/result.json',
        outputBytes,
        inputSourceSha256: VALID_SHA,
        parserVersion: '1.0',
        parserConfigSha256: VALID_SHA,
        status: 'succeeded',
        outputContentSha256: sha256Hex('x'),
        outputByteSha256: sha256Hex(outputBytes.toString('utf8')),
        succeededPages: [1],
      })),
    };
    const resolver = new ParserRunProofResolver(undefined, outputProofSource);
    const artifact = makeMinimalArtifact(VALID_SHA);
    artifact.parserRuns[0]!.method = 'deterministic_pdfplumber';
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('verified');
    expect(outputProofSource.resolveParserOutput).toHaveBeenCalledTimes(1);
    expect(result.manualReviewTriggered).toBe(false);
  });
});

describe('evaluateArchiveProofForPolicy — R8.1 §2.5 archive policy table', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { evaluateArchiveProofForPolicy } = require('./archive-proof-resolver.js');

  it('required + verified -> PASS (no findings)', () => {
    expect(
      evaluateArchiveProofForPolicy({ status: 'verified' }, { requireImmutableArchive: true }),
    ).toEqual([]);
  });
  it('required + missing -> blocking FAIL', () => {
    const f = evaluateArchiveProofForPolicy(
      { status: 'missing' },
      { requireImmutableArchive: true },
    );
    expect(f.every((x: { severity: string }) => x.severity === 'blocking')).toBe(true);
  });
  it('required + mismatch -> blocking FAIL', () => {
    const f = evaluateArchiveProofForPolicy(
      { status: 'mismatch' },
      { requireImmutableArchive: true },
    );
    expect(f.every((x: { severity: string }) => x.severity === 'blocking')).toBe(true);
  });
  it('required + not_applicable -> blocking FAIL', () => {
    const f = evaluateArchiveProofForPolicy(
      { status: 'not_applicable' },
      { requireImmutableArchive: true },
    );
    expect(f.every((x: { severity: string }) => x.severity === 'blocking')).toBe(true);
  });
  it('not required + verified -> PASS', () => {
    expect(
      evaluateArchiveProofForPolicy({ status: 'verified' }, { requireImmutableArchive: false }),
    ).toEqual([]);
  });
  it('not required + not_applicable -> SKIPPED (no findings)', () => {
    expect(
      evaluateArchiveProofForPolicy(
        { status: 'not_applicable' },
        { requireImmutableArchive: false },
      ),
    ).toEqual([]);
  });
  it('not required + missing -> review', () => {
    const f = evaluateArchiveProofForPolicy(
      { status: 'missing' },
      { requireImmutableArchive: false },
    );
    expect(f.every((x: { severity: string }) => x.severity === 'review')).toBe(true);
  });
  it('not required + mismatch -> blocking FAIL', () => {
    const f = evaluateArchiveProofForPolicy(
      { status: 'mismatch' },
      { requireImmutableArchive: false },
    );
    expect(f.every((x: { severity: string }) => x.severity === 'blocking')).toBe(true);
  });
});

describe('R1 — sha256Bytes binary hashing tests', () => {
  it('PDF with non-ASCII bytes hashes correctly (not via string conversion)', () => {
    const { sha256Bytes, sha256Hex } = require('../../contracts/canonical-json.js');
    const pdfBytes = Buffer.from([
      0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0xff, 0xfe, 0x00,
    ]);
    const hash = sha256Bytes(pdfBytes);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // The hash must NOT equal the hash of the binary string representation
    expect(hash).not.toBe(sha256Hex(pdfBytes.toString('binary')));
  });

  it('one-byte PDF mutation changes the SHA', () => {
    const { sha256Bytes } = require('../../contracts/canonical-json.js');
    const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    const mutated = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x35]);
    expect(sha256Bytes(original)).not.toBe(sha256Bytes(mutated));
  });
});

describe('CompositeProofResolver — R8.1 fail-closed production proof', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { CompositeProofResolver } = require('./composite-proof-resolver.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TrustedProofResolutionError } = require('./trusted-proof-types.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {
    computeArtifactContentSha256,
  } = require('../../contracts/extraction-artifact-v1.semantic.js');

  const SRC_BYTES = Buffer.from('%PDF-1.4 source bytes');

  function buildManifest(sourceLocator: string) {
    return {
      schemaVersion: 'defense_budget_cycle_manifest_v1',
      cycleId: 'fy2027-pb',
      fiscalYear: 2027,
      domain: 'defense',
      documents: [
        {
          documentKey: 'r1_army_fy2027',
          family: 'rdte',
          exhibit: 'R-1',
          required: true,
          title: 'R-1 Army FY2027',
          sourceLocator,
          sourceUrl: 'https://example.test/r1.pdf',
          authority: 'dod-comptroller',
          component: 'ARMY',
          budgetCycle: 'pb',
          documentType: 'exhibit',
          parserPolicy: 'deterministic_table',
          requiredDataCategories: ['identity', 'funding'],
          requiredFundingFields: ['request'],
          expectedLineKinds: ['RDTE_PE'],
          allowEmpty: false,
        },
      ],
    };
  }

  function buildArtifact(sourceSha: string) {
    const artifact: Record<string, unknown> = {
      schemaVersion: 'defense_budget_extraction_v1',
      artifactId: 'dbx1_test',
      contentSha256: '0'.repeat(64), // recomputed below
      source: {
        manifestDocumentKey: 'r1_army_fy2027',
        sourceDocumentId: 'sd-1',
        sourcePdfSha256: sourceSha,
        sourceLocator: '/r1.pdf',
        fiscalYear: 2027,
        family: 'rdte',
        exhibit: 'R-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'r1',
      },
      parserRuns: [
        {
          parserRunId: 'run-1',
          method: 'deterministic_pdfplumber',
          parserVersion: '1.0',
          parserConfigSha256: VALID_SHA,
          inputSourceSha256: sourceSha,
          outputArtifactSha256: '0'.repeat(64),
          pageRanges: [{ startPage: 1, endPage: 1 }],
        },
      ],
      evidence: [],
      sourceFacts: [],
      assertions: [],
      warnings: [],
      omissions: [],
      summary: {
        sourceFactCount: 0,
        requiredSourceFactCount: 0,
        coveredRequiredSourceFactCount: 0,
        omittedRequiredSourceFactCount: 0,
        uncoveredRequiredSourceFactCount: 0,
        assertionCount: 0,
        warningCount: 0,
        omissionCount: 0,
        countsByAssertionKind: {},
        countsByOmissionReason: {},
        completenessStatus: 'complete',
      },
    };
    const contentSha = computeArtifactContentSha256(artifact);
    artifact.contentSha256 = contentSha;
    (artifact.parserRuns as Array<Record<string, unknown>>)[0]!.outputArtifactSha256 = contentSha;
    return artifact;
  }

  const SOURCE_SHA = require('node:crypto').createHash('sha256').update(SRC_BYTES).digest('hex');

  function makeReader(map: Record<string, Buffer>) {
    return {
      async read(locator: string) {
        const bytes = map[locator];
        if (!bytes) throw new Error(`not found: ${locator}`);
        return {
          locator,
          bytes,
          kind: 'filesystem' as const,
          contentLength: bytes.length,
          checksumSha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
        };
      },
    };
  }

  function makeSourceDocClient(row: Record<string, unknown> | null) {
    return {
      sourceDocument: {
        findFirst: jest.fn(async () => row),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
  }

  function makeInput() {
    return {
      manifestLocator: '/manifest.json',
      manifestDocumentKey: 'r1_army_fy2027',
      extractionArtifactLocator: '/artifact.json',
      sourceDocumentId: 'sd-1',
    };
  }

  function makeDeps(overrides: Record<string, unknown> = {}) {
    const artifact = buildArtifact(SOURCE_SHA);
    const manifest = buildManifest('/r1.pdf');
    const reader = makeReader({
      '/manifest.json': Buffer.from(JSON.stringify(manifest)),
      '/artifact.json': Buffer.from(JSON.stringify(artifact)),
      '/r1.pdf': SRC_BYTES,
      's3://b/k?versionId=v1': SRC_BYTES,
    });
    const sourceDocumentClient = makeSourceDocClient({
      id: 'sd-1',
      sourceKey: '/r1.pdf',
      sha256: SOURCE_SHA,
      fiscalYear: 2027,
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
      archiveBucket: 'b',
      archiveS3Key: 'k',
      archiveVersionId: 'v1',
    });
    const s3Reader = {
      getObjectBytes: jest.fn(async () => SRC_BYTES),
      headObject: jest.fn(async () => ({ contentLength: SRC_BYTES.length })),
    };
    // R8.2-C: production parser-run proof requires an injected proof source
    // that returns matching persisted output bytes.
    const parserOutputProofSource = {
      resolveParserOutput: jest.fn(async (req: { declaredOutputSha256: string }) => ({
        persistedRunId: 'run-1',
        outputLocator: '/store/run-1/result.json',
        outputBytes: Buffer.from('{"pages":[1]}'),
        inputSourceSha256: SOURCE_SHA,
        parserVersion: '1.0',
        parserConfigSha256: VALID_SHA,
        status: 'succeeded',
        outputContentSha256: req.declaredOutputSha256,
        outputByteSha256: VALID_SHA,
        succeededPages: [1],
      })),
    };
    return {
      mode: 'production_proof' as const,
      byteLocatorReader: reader,
      sourceDocumentClient,
      parseJobClient: { documentParseJob: { findFirst: jest.fn(async () => null) } },
      s3Reader,
      parserOutputProofSource,
      ...overrides,
    };
  }

  it('production_proof without sourceDocumentClient fails', async () => {
    const deps = makeDeps();
    delete (deps as Record<string, unknown>).sourceDocumentClient;
    const resolver = new CompositeProofResolver(deps);
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof without byteLocatorReader fails', async () => {
    const deps = makeDeps();
    delete (deps as Record<string, unknown>).byteLocatorReader;
    const resolver = new CompositeProofResolver(deps);
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof without s3Reader fails when policy requires archive', async () => {
    const deps = makeDeps();
    delete (deps as Record<string, unknown>).s3Reader;
    const resolver = new CompositeProofResolver(deps);
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof without parseJobClient fails when policy requires parser proof', async () => {
    const deps = makeDeps();
    delete (deps as Record<string, unknown>).parseJobClient;
    const resolver = new CompositeProofResolver(deps);
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof without parserOutputProofSource fails when policy requires parser proof', async () => {
    const deps = makeDeps();
    delete (deps as Record<string, unknown>).parserOutputProofSource;
    const resolver = new CompositeProofResolver(deps);
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof never falls back to artifact-asserted SHA when bytes unresolvable', async () => {
    const artifact = buildArtifact(SOURCE_SHA);
    const manifest = buildManifest('/r1.pdf');
    // Reader has manifest + artifact but NO source bytes and no archive row.
    const reader = makeReader({
      '/manifest.json': Buffer.from(JSON.stringify(manifest)),
      '/artifact.json': Buffer.from(JSON.stringify(artifact)),
    });
    const resolver = new CompositeProofResolver({
      mode: 'production_proof',
      byteLocatorReader: reader,
      sourceDocumentClient: makeSourceDocClient({
        id: 'sd-1',
        sourceKey: '/r1.pdf',
        sha256: SOURCE_SHA,
      }),
      parseJobClient: { documentParseJob: { findFirst: jest.fn(async () => null) } },
      s3Reader: {
        getObjectBytes: jest.fn(async () => null),
        headObject: jest.fn(async () => null),
      },
    });
    await expect(resolver.resolve(makeInput())).rejects.toThrow(TrustedProofResolutionError);
  });

  it('production_proof flags SourceDocument metadata mismatch', async () => {
    const deps = makeDeps();
    deps.sourceDocumentClient = makeSourceDocClient({
      id: 'sd-1',
      sourceKey: '/r1.pdf',
      sha256: SOURCE_SHA,
      fiscalYear: 2099, // WRONG fiscal year
      component: 'ARMY',
      budgetCycle: 'pb',
      documentType: 'r1',
      archiveBucket: 'b',
      archiveS3Key: 'k',
      archiveVersionId: 'v1',
    });
    const resolver = new CompositeProofResolver(deps);
    const result = await resolver.resolve(makeInput());
    expect(
      result.proofFindings.some(
        (f: { code: string; severity: string }) =>
          f.code === 'source_metadata_mismatch' && f.severity === 'blocking',
      ),
    ).toBe(true);
  });

  it('production_proof resolves cleanly with full trusted dependencies', async () => {
    const resolver = new CompositeProofResolver(makeDeps());
    const result = await resolver.resolve(makeInput());
    expect(result.proofBundle.sourceDocument.sourceSha256).toBe(SOURCE_SHA);
    expect(result.proofBundle.archive.status).toBe('verified');
  });
});
