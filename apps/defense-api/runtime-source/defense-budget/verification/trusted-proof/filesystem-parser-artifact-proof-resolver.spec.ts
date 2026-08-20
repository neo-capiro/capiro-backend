import { describe, expect, it } from '@jest/globals';
import { ArtifactBuilderV1 } from '../../contracts/artifact-builders.js';
import type { ExtractionSourceV1, ParserRunV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  computeParserRunCacheKey,
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { ParserArtifactStoreV1 } from '../../parser-router/parser-artifact-store.js';
import { FilesystemParserArtifactProofResolver } from './filesystem-parser-artifact-proof-resolver.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from './trusted-proof-types.js';

const SOURCE_SHA = 'a'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);
const BYTE_SHA = 'c'.repeat(64);

function fixture() {
  const result = sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'parser-proof-job',
    engine: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: CONFIG_SHA,
    inputSourceSha256: SOURCE_SHA,
    requestedPages: [1],
    succeededPages: [1],
    failedPages: [],
    pages: [
      {
        page: 1,
        text: 'PE 0600000A',
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
      engineVersion: 'pdfplumber-test',
    },
  });
  const identity: ParserRunIdentityV1 = {
    sourceSha256: SOURCE_SHA,
    method: 'deterministic_pdfplumber',
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: CONFIG_SHA,
    pages: [1],
    runtimeContractVersion: 'defense_budget_parser_job_v1',
  };
  const parserRun: ParserRunV1 = {
    parserRunId: computeParserRunId(identity),
    method: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    inputSourceSha256: identity.sourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: [{ startPage: 1, endPage: 1 }],
  };
  const source: ExtractionSourceV1 = {
    manifestDocumentKey: 'r1-proof',
    sourceDocumentId: 'source-proof',
    sourcePdfSha256: SOURCE_SHA,
    sourceLocator: '/tmp/source.pdf',
    fiscalYear: 2027,
    family: 'rdte',
    exhibit: 'R-1',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'R-1',
  };
  const builder = new ArtifactBuilderV1(source);
  builder.addParserRun(parserRun);
  builder.addEvidence({
    evidenceId: 'evidence-proof',
    sourcePdfSha256: SOURCE_SHA,
    parserRunId: parserRun.parserRunId,
    granularity: 'page_only',
    page: 1,
  });
  builder.addSourceFact({
    factId: 'fact-proof',
    sourcePath: 'page:1',
    category: 'metadata',
    requiredForCompleteness: true,
    rawValue: 'proof',
    evidenceIds: ['evidence-proof'],
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: 'assertion-proof',
    sourceFactIds: ['fact-proof'],
    evidenceIds: ['evidence-proof'],
    confidence: 1,
    fieldName: 'proof',
    value: true,
  });
  const artifact = builder.finalize();
  const descriptor: ParserArtifactDescriptorV1 = {
    descriptorVersion: 'parser_artifact_descriptor_v1',
    cacheKey: computeParserRunCacheKey(identity),
    parserRunId: parserRun.parserRunId,
    sourceSha256: SOURCE_SHA,
    method: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: CONFIG_SHA,
    requestedPages: [1],
    runtimeContractVersion: identity.runtimeContractVersion,
    contentSha256: result.contentSha256,
    byteSha256: BYTE_SHA,
    resultLocator: '/tmp/parser-result.json',
    createdAt: '2026-08-05T00:00:00Z',
  };
  const resolution = {
    manifest: { cycleId: 'fy2027', fiscalYear: 2027 },
    manifestContentSha256: 'd'.repeat(64),
    manifestDocument: {
      documentKey: 'r1-proof',
      family: 'rdte',
      exhibit: 'R-1',
      authority: 'dod-comptroller',
    },
    artifact,
    extractionArtifactContentSha256: artifact.contentSha256,
    proofBundle: {
      manifest: {
        locator: '/tmp/manifest.json',
        contentSha256: 'd'.repeat(64),
        cycleId: 'fy2027',
        fiscalYear: 2027,
        documentKey: 'r1-proof',
      },
      extractionArtifact: {
        locator: '/tmp/artifact.json',
        artifactId: artifact.artifactId,
        contentSha256: artifact.contentSha256,
        byteSha256: 'e'.repeat(64),
        schemaVersion: 'defense_budget_extraction_v1',
      },
      sourceDocument: {
        id: 'source-proof',
        sourceKey: '/tmp/source.pdf',
        sourceSha256: SOURCE_SHA,
      },
      archive: { status: 'not_applicable' },
      parserRuns: [],
      resolvedReferenceArtifacts: [],
    },
    proofFindings: [],
    referenceArtifacts: [],
    referenceArtifactsProofBundles: [],
    referenceArtifactsFindings: [],
  } as unknown as TrustedProofResolutionV1;
  return { result, descriptor, resolution };
}

function delegate(resolution: TrustedProofResolutionV1): TrustedVerificationProofResolverV1 {
  return { resolve: async () => resolution };
}

describe('FilesystemParserArtifactProofResolver', () => {
  it('marks a local parser run verified only after exact artifact replay', async () => {
    const { result, descriptor, resolution } = fixture();
    const store = {
      findExact: async () => descriptor,
      readVerified: async () => result,
    } as unknown as ParserArtifactStoreV1;
    const resolved = await new FilesystemParserArtifactProofResolver(
      delegate(resolution),
      store,
    ).resolve({
      manifestLocator: '/tmp/manifest.json',
      manifestDocumentKey: 'r1-proof',
      extractionArtifactLocator: '/tmp/artifact.json',
      sourceDocumentId: 'source-proof',
      referenceArtifacts: [],
    });

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('verified');
    expect(resolved.proofFindings).toEqual([]);
  });

  it('fails closed when the exact parser result is missing', async () => {
    const { resolution } = fixture();
    const store = {
      findExact: async () => null,
    } as unknown as ParserArtifactStoreV1;
    const resolved = await new FilesystemParserArtifactProofResolver(
      delegate(resolution),
      store,
    ).resolve({
      manifestLocator: '/tmp/manifest.json',
      manifestDocumentKey: 'r1-proof',
      extractionArtifactLocator: '/tmp/artifact.json',
      sourceDocumentId: 'source-proof',
      referenceArtifacts: [],
    });

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('missing');
    expect(resolved.proofFindings.some((finding) => finding.code === 'parse_output_missing')).toBe(
      true,
    );
  });

  it('fails closed when verified replay detects tampering', async () => {
    const { descriptor, resolution } = fixture();
    const store = {
      findExact: async () => descriptor,
      readVerified: async () => {
        throw new Error('parser artifact byte SHA mismatch');
      },
    } as unknown as ParserArtifactStoreV1;
    const resolved = await new FilesystemParserArtifactProofResolver(
      delegate(resolution),
      store,
    ).resolve({
      manifestLocator: '/tmp/manifest.json',
      manifestDocumentKey: 'r1-proof',
      extractionArtifactLocator: '/tmp/artifact.json',
      sourceDocumentId: 'source-proof',
      referenceArtifacts: [],
    });

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('mismatch');
    expect(
      resolved.proofFindings.some((finding) => finding.code === 'parse_output_sha_mismatch'),
    ).toBe(true);
  });
});
