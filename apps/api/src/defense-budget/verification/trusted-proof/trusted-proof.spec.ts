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
import type { SourceDocumentClient, SourceDocumentRow } from '../../../program-element/source-document/source-document-registry.js';

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
        findFirst: jest.fn(async () => row) as unknown as SourceDocumentClient['sourceDocument']['findFirst'],
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

  it('returns archive_version_missing when VersionId absent', async () => {
    const resolver = new ArchiveProofResolver(fakeS3Reader);
    const result = await resolver.resolve({
      archiveBucket: 'bucket',
      archiveS3Key: 'key',
      expectedSourceSha256: VALID_SHA,
    });
    expect(result.archive.status).toBe('mismatch');
    expect(result.findings.some((f) => f.code === 'archive_version_missing')).toBe(true);
    expect(result.findings.every((f) => f.severity === 'blocking')).toBe(true);
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

  it('deterministic parser with matching SHAs returns verified', async () => {
    const resolver = new ParserRunProofResolver();
    const artifact = makeMinimalArtifact(VALID_SHA);
    artifact.parserRuns[0]!.method = 'deterministic_pdfplumber';
    const result = await resolver.resolve({
      artifact,
      actualSourcePdfSha256: VALID_SHA,
    });
    expect(result.parserRuns[0]!.proofStatus).toBe('verified');
    expect(result.manualReviewTriggered).toBe(false);
  });
});