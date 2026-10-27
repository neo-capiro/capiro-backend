import type { DefenseEvidenceRefDto } from '@capiro/shared';
import { DefenseBudgetEvidenceLocatorService } from './defense-budget-evidence-locator.service.js';
import { buildMinimalArtifact } from '../defense-budget/contracts/testing-helpers.js';
import { computeArtifactContentSha256 } from '../defense-budget/contracts/extraction-artifact-v1.semantic.js';
import { S3ExtractionArtifactStore } from '../defense-budget/parser-router/extraction-artifact-store.js';
import { sha256Bytes } from '../defense-budget/contracts/canonical-json.js';

const docId = '00000000-0000-4000-8000-000000000001';
const bucket = 'synthetic-evidence-fixture';
const prefix = 'phase10/parser-artifacts';
const originalEnv = {
  APP_ENV: process.env.APP_ENV,
  BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET:
    process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET,
  BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX:
    process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX,
};

function fixture() {
  const artifact = buildMinimalArtifact();
  artifact.source.sourceDocumentId = docId;
  Object.assign(artifact.evidence[0]!, {
    granularity: 'cell_bbox',
    tableLabel: 'R-1',
    rowLabel: 'Program',
    columnLabel: 'FY 2099',
    boundingBox: {
      x0: 10,
      y0: 20,
      x1: 30,
      y1: 40,
      coordinateSystem: 'pdf_points',
      pageWidth: 612,
      pageHeight: 792,
    },
  });
  artifact.contentSha256 = computeArtifactContentSha256(artifact);
  artifact.artifactId = `dbx1_${artifact.contentSha256}`;
  const bytes = Buffer.from(JSON.stringify(artifact));
  const candidate = {
    extractionArtifactId: artifact.artifactId,
    extractionArtifactSha256: sha256Bytes(bytes),
    extractionArtifactLocator: `s3://${bucket}/${prefix}/fixture?versionId=immutable-fixture`,
    sourceDocumentId: docId,
    sourceSha256: artifact.source.sourcePdfSha256,
    runs: [{ decision: 'PASS' }],
    reviewDecisions: [{ decision: 'accept' }],
  };
  const objects = {
    getObject: jest.fn().mockResolvedValue({ bytes, versionId: 'immutable-fixture' }),
    putObject: jest.fn().mockRejectedValue(new Error('read-only fixture')),
  };
  const prisma = {
    defenseBudgetActiveSnapshot: { findUnique: jest.fn().mockResolvedValue({ snapshotId: docId }) },
    defenseBudgetCanonicalRow: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ verificationCandidateId: docId, verificationRunId: docId }),
    },
    budgetExtractionCandidateV1: { findUnique: jest.fn().mockResolvedValue(candidate) },
  };
  const service = new DefenseBudgetEvidenceLocatorService(prisma as never);
  Object.defineProperty(service, 'store', {
    value: new S3ExtractionArtifactStore(bucket, prefix, objects),
  });
  const ref: DefenseEvidenceRefDto = {
    evidenceRefId: `procurement-source:${docId}`,
    sourceDocumentId: docId,
    sourceRevisionId: null,
    sourceFamily: 'procurement_jbook',
    publisher: null,
    sourceUrl: 'https://example.invalid/source.pdf',
    contentHash: artifact.source.sourcePdfSha256,
    nativeLocator: { page: 3, section: null, occurrenceId: null },
    edition: null,
    observedAt: null,
  };
  const metadata = {
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    assertionId: artifact.assertions[0]!.assertionId,
    evidenceId: artifact.evidence[0]!.evidenceId,
  };
  return { service, ref, metadata, candidate, objects, prisma, artifact, bytes };
}

describe('qualified published budget native coordinates', () => {
  beforeEach(() => {
    process.env.APP_ENV = 'synthetic';
    process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET = bucket;
    process.env.BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_PREFIX = prefix;
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  it('uses the actual readVerified hash path and returns only bounded exact source coordinates', async () => {
    const f = fixture();
    const result = await f.service.read(f.ref, f.metadata);
    expect(result).toMatchObject({
      availability: 'available',
      tableLabel: 'R-1',
      rowLabel: 'Program',
      columnLabel: 'FY 2099',
      boundingBox: { x0: 10, coordinateSystem: 'pdf_points' },
    });
    expect(f.objects.getObject).toHaveBeenCalledWith({
      bucket,
      key: `${prefix}/fixture`,
      versionId: 'immutable-fixture',
    });
    expect(f.objects.putObject).not.toHaveBeenCalled();
    expect(f.prisma.defenseBudgetCanonicalRow.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          snapshotId: docId,
          sourceDocumentId: docId,
          sourcePdfSha256: f.ref.contentHash,
          sourceAssertionId: f.metadata.assertionId,
          evidenceIds: { array_contains: [f.metadata.evidenceId] },
        }),
      }),
    );
    expect(JSON.stringify(result)).not.toContain('s3:');
  });
  it.each([
    'missing version',
    'foreign bucket',
    'foreign prefix',
    'unqualified',
    'wrong source',
    'unpublished',
  ])('refuses %s before artifact access', async (kind) => {
    const f = fixture();
    if (kind === 'missing version')
      f.candidate.extractionArtifactLocator = `s3://${bucket}/${prefix}/fixture`;
    if (kind === 'foreign bucket')
      f.candidate.extractionArtifactLocator = `s3://foreign/${prefix}/fixture?versionId=x`;
    if (kind === 'foreign prefix')
      f.candidate.extractionArtifactLocator = `s3://${bucket}/foreign/fixture?versionId=x`;
    if (kind === 'unqualified') f.candidate.reviewDecisions[0]!.decision = 'reject';
    if (kind === 'wrong source') f.candidate.sourceSha256 = 'f'.repeat(64);
    if (kind === 'unpublished')
      f.prisma.defenseBudgetCanonicalRow.findFirst.mockResolvedValue(null);
    expect(await f.service.read(f.ref, f.metadata)).toMatchObject({
      availability: 'unavailable',
      boundingBox: null,
    });
    expect(f.objects.getObject).not.toHaveBeenCalled();
  });
  it('rejects bytes that do not match the immutable candidate hash', async () => {
    const f = fixture();
    f.objects.getObject.mockResolvedValue({
      bytes: Buffer.from('{}'),
      versionId: 'immutable-fixture',
    });
    expect(await f.service.read(f.ref, f.metadata)).toMatchObject({
      availability: 'unavailable',
      tableLabel: null,
    });
  });
  it('rejects a page identity mismatch instead of assigning coordinates to another evidence ref', async () => {
    const f = fixture();
    f.ref.nativeLocator.page = 4;
    expect(await f.service.read(f.ref, f.metadata)).toMatchObject({
      availability: 'unavailable',
      boundingBox: null,
    });
  });
});
