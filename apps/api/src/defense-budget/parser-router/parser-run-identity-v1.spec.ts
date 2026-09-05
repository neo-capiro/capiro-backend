/**
 * Phase 10B-25 Defect 2 — parser-run-proof identity mismatch. 10 required
 * regression scenarios, mixing pure unit tests against
 * `parser-run-identity-v1.ts` (identity construction + coverage validation)
 * with resolver-level integration tests against
 * `FilesystemParserArtifactProofResolver`, which is the real production
 * consumer of this module.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { ArtifactBuilderV1 } from '../contracts/artifact-builders.js';
import type { ExtractionSourceV1, ParserRunV1 } from '../contracts/extraction-artifact-v1.js';
import {
  computeParserRunCacheKey,
  computeParserRunId,
  sealParserRuntimeResult,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
} from './parser-runtime-contract-v1.js';
import type { ParserArtifactStoreV1 } from './parser-artifact-store.js';
import {
  buildParserRunIdentityV1,
  resolveContributingRunIdentityV1,
  validateParserRunCoverageV1,
} from './parser-run-identity-v1.js';
import { FilesystemParserArtifactProofResolver } from '../verification/trusted-proof/filesystem-parser-artifact-proof-resolver.js';
import type {
  TrustedProofResolutionV1,
  TrustedVerificationProofResolverV1,
} from '../verification/trusted-proof/trusted-proof-types.js';

const SOURCE_SHA = 'a'.repeat(64);
const OTHER_SOURCE_SHA = 'f'.repeat(64);
const CONFIG_SHA = 'b'.repeat(64);
const OTHER_CONFIG_SHA = '9'.repeat(64);
const BYTE_SHA = 'c'.repeat(64);

/**
 * Build a full resolver fixture (parserRun + descriptor + result + a
 * resolution bundle for the base delegate) parameterized so each test can
 * independently vary the REGISTRATION-time identity (what the descriptor
 * was stored under) vs. the LOOKUP-time identity (what the persisted
 * artifact's `run` fields declare) -- this is what actually exercises
 * "mismatch between registration and lookup" rather than merely asserting
 * on the pure identity builder in isolation.
 */
function buildFixture(input: {
  registered: {
    sourceSha256: string;
    requestedPages: number[];
    parserConfigSha256: string;
    method?: ParserRunV1['method'];
  };
  lookup: {
    sourceSha256: string;
    requestedPages: number[];
    parserConfigSha256: string;
    method?: ParserRunV1['method'];
  };
  /** If set, the persisted result's contentSha256 is forced to this value
   * instead of the naturally sealed hash -- used to simulate output-artifact
   * tampering independent of identity. */
  forceResultContentSha256?: string;
}) {
  const method = input.registered.method ?? 'deterministic_pdfplumber';
  const lookupMethod = input.lookup.method ?? method;

  const registeredIdentity: ParserRunIdentityV1 = {
    sourceSha256: input.registered.sourceSha256,
    method,
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: input.registered.parserConfigSha256,
    pages: [...input.registered.requestedPages].sort((a, b) => a - b),
    runtimeContractVersion: 'defense_budget_parser_job_v1',
  };

  const result = sealParserRuntimeResult({
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: 'parser-proof-job',
    engine: method,
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: input.registered.parserConfigSha256,
    inputSourceSha256: input.registered.sourceSha256,
    requestedPages: [...registeredIdentity.pages],
    succeededPages: [...registeredIdentity.pages],
    failedPages: [],
    pages: registeredIdentity.pages.map((page) => ({
      page,
      text: `PE 0600000A page ${page}`,
      blocks: [],
      tables: [],
      images: [],
      evidencePrecision: 'page_only' as const,
      warnings: [],
    })),
    warnings: [],
    metrics: {
      durationMillis: 1,
      pagesProcessed: registeredIdentity.pages.length,
      pagesSucceeded: registeredIdentity.pages.length,
      pagesFailed: 0,
      engineVersion: 'pdfplumber-test',
    },
  });
  const storedContentSha256 = input.forceResultContentSha256 ?? result.contentSha256;
  const storedResult = { ...result, contentSha256: storedContentSha256 };

  const descriptor: ParserArtifactDescriptorV1 = {
    descriptorVersion: 'parser_artifact_descriptor_v1',
    cacheKey: computeParserRunCacheKey(registeredIdentity),
    parserRunId: computeParserRunId(registeredIdentity),
    sourceSha256: registeredIdentity.sourceSha256,
    method: registeredIdentity.method,
    parserVersion: registeredIdentity.parserVersion,
    parserConfigSha256: registeredIdentity.parserConfigSha256,
    requestedPages: [...registeredIdentity.pages],
    runtimeContractVersion: registeredIdentity.runtimeContractVersion,
    contentSha256: storedContentSha256,
    byteSha256: BYTE_SHA,
    resultLocator: '/tmp/parser-result.json',
    createdAt: '2026-08-05T00:00:00Z',
  };

  const lookupIdentity: ParserRunIdentityV1 = {
    sourceSha256: input.lookup.sourceSha256,
    method: lookupMethod,
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: input.lookup.parserConfigSha256,
    pages: [...input.lookup.requestedPages].sort((a, b) => a - b),
    runtimeContractVersion: 'defense_budget_parser_job_v1',
  };

  const parserRun: ParserRunV1 = {
    parserRunId: computeParserRunId(registeredIdentity),
    method: lookupMethod,
    parserVersion: 'pdfplumber-test',
    parserConfigSha256: lookupIdentity.parserConfigSha256,
    inputSourceSha256: lookupIdentity.sourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: [
      {
        startPage: Math.min(...lookupIdentity.pages),
        endPage: Math.max(...lookupIdentity.pages),
      },
    ],
    requestedPages: [...lookupIdentity.pages],
    succeededPages: [...lookupIdentity.pages],
    failedPages: [],
  };

  const source: ExtractionSourceV1 = {
    manifestDocumentKey: 'r1-proof',
    sourceDocumentId: 'source-proof',
    sourcePdfSha256: lookupIdentity.sourceSha256,
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
    sourcePdfSha256: lookupIdentity.sourceSha256,
    parserRunId: parserRun.parserRunId,
    granularity: 'page_only',
    page: lookupIdentity.pages[0],
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
        sourceSha256: lookupIdentity.sourceSha256,
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

  return { registeredIdentity, lookupIdentity, descriptor, storedResult, resolution, parserRun };
}

function delegate(resolution: TrustedProofResolutionV1): TrustedVerificationProofResolverV1 {
  return { resolve: async () => resolution };
}

/** A registration-aware fake store: `findExact` only returns the descriptor
 * when the passed-in identity's cache key exactly matches the identity the
 * descriptor was actually registered under -- this is what makes tests 2-4
 * genuinely exercise a registration/lookup MISMATCH rather than a
 * not-yet-populated cache. */
function registrationAwareStore(
  registeredIdentity: ParserRunIdentityV1,
  descriptor: ParserArtifactDescriptorV1,
  storedResult: Awaited<ReturnType<typeof sealParserRuntimeResult>>,
): { store: ParserArtifactStoreV1; findExactSpy: jest.Mock<(...args: unknown[]) => unknown> } {
  const registeredKey = computeParserRunCacheKey(registeredIdentity);
  const findExactSpy: jest.Mock<(...args: unknown[]) => unknown> = jest.fn(
    async (identity: ParserRunIdentityV1) => {
      return computeParserRunCacheKey(identity) === registeredKey ? descriptor : null;
    },
  ) as unknown as jest.Mock<(...args: unknown[]) => unknown>;
  const store = {
    findExact: findExactSpy,
    readVerified: async () => storedResult,
  } as unknown as ParserArtifactStoreV1;
  return { store, findExactSpy };
}

async function resolveWith(
  resolution: TrustedProofResolutionV1,
  store: ParserArtifactStoreV1,
) {
  return new FilesystemParserArtifactProofResolver(delegate(resolution), store).resolve({
    manifestLocator: '/tmp/manifest.json',
    manifestDocumentKey: 'r1-proof',
    extractionArtifactLocator: '/tmp/artifact.json',
    sourceDocumentId: 'source-proof',
    referenceArtifacts: [],
  });
}

describe('Phase 10B-25 Defect 2 — parser-run identity + coverage proof', () => {
  it('1. requested pages 1-10 with legitimately blank pages 2,4,10 PASSES parser-run proof when failures are correctly typed', async () => {
    const requestedPages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const succeededPages = [1, 3, 5, 6, 7, 8, 9];
    const failedPages = [
      { page: 2, code: 'no_embedded_text', message: 'blank page' },
      { page: 4, code: 'no_embedded_text', message: 'blank page' },
      { page: 10, code: 'no_embedded_text', message: 'blank page' },
    ];
    const pure = validateParserRunCoverageV1({ requestedPages, succeededPages, failedPages });
    expect(pure.ok).toBe(true);
    expect(pure.findings).toEqual([]);

    const { registeredIdentity, descriptor, storedResult, resolution, parserRun } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages, parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: SOURCE_SHA, requestedPages, parserConfigSha256: CONFIG_SHA },
    });
    parserRun.succeededPages = succeededPages;
    parserRun.failedPages = failedPages;
    const { store } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('verified');
    expect(resolved.proofFindings).toEqual([]);
  });

  it('2. requested-page mismatch between registration and lookup FAILS', async () => {
    const { registeredIdentity, descriptor, storedResult, resolution } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 4], parserConfigSha256: CONFIG_SHA },
    });
    const { store } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('missing');
    expect(resolved.proofFindings.some((f) => f.code === 'parse_output_missing')).toBe(true);
  });

  it('3. source-SHA mismatch between registration and lookup FAILS', async () => {
    const { registeredIdentity, descriptor, storedResult, resolution } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: OTHER_SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
    });
    const { store } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('missing');
    expect(resolved.proofFindings.some((f) => f.code === 'parse_output_missing')).toBe(true);
  });

  it('4. engine/config mismatch between registration and lookup FAILS', async () => {
    const { registeredIdentity, descriptor, storedResult, resolution } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: OTHER_CONFIG_SHA },
    });
    const { store } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('missing');
    expect(resolved.proofFindings.some((f) => f.code === 'parse_output_missing')).toBe(true);
  });

  it('5. artifact-hash tampering FAILS (identity matches, persisted bytes do not)', async () => {
    const { registeredIdentity, descriptor, storedResult, resolution } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      forceResultContentSha256: '7'.repeat(64),
    });
    const { store } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('mismatch');
    expect(resolved.proofFindings.some((f) => f.code === 'parse_output_sha_mismatch')).toBe(true);
  });

  it('6. missing failed-page evidence (a page absent from both succeeded and failed) FAILS the coverage-union check', () => {
    const pure = validateParserRunCoverageV1({
      requestedPages: [1, 2, 3],
      succeededPages: [1, 3],
      failedPages: [],
    });
    expect(pure.ok).toBe(false);
    expect(pure.findings.some((f) => f.includes('no succeeded/failed disposition'))).toBe(true);
  });

  it('7. overlapping succeeded/failed page sets FAIL', () => {
    const pure = validateParserRunCoverageV1({
      requestedPages: [1, 2],
      succeededPages: [1, 2],
      failedPages: [{ page: 2, code: 'no_embedded_text', message: 'blank' }],
    });
    expect(pure.ok).toBe(false);
    expect(pure.findings.some((f) => f.includes('present in both succeeded and failed'))).toBe(true);
  });

  it('8. an unaccounted requested page (present in neither succeeded nor failed) FAILS', () => {
    const pure = validateParserRunCoverageV1({
      requestedPages: [1, 2, 3, 4],
      succeededPages: [1, 2],
      failedPages: [{ page: 3, code: 'no_embedded_text', message: 'blank' }],
    });
    expect(pure.ok).toBe(false);
    expect(pure.findings.some((f) => f.includes('requested page(s) with no succeeded/failed disposition: 4'))).toBe(
      true,
    );
  });

  it('9. reordered but equivalent page ranges produce a DETERMINISTIC identical identity hash', () => {
    const base = {
      sourceSha256: SOURCE_SHA,
      method: 'deterministic_pdfplumber' as const,
      parserVersion: 'pdfplumber-test',
      parserConfigSha256: CONFIG_SHA,
    };
    const identityOrdered = buildParserRunIdentityV1({ ...base, requestedPages: [1, 2, 3] });
    const identityReordered = buildParserRunIdentityV1({ ...base, requestedPages: [3, 1, 2] });
    const identityWithDupes = buildParserRunIdentityV1({ ...base, requestedPages: [2, 3, 1, 2, 3] });

    expect(identityOrdered.pages).toEqual([1, 2, 3]);
    expect(identityReordered.pages).toEqual([1, 2, 3]);
    expect(identityWithDupes.pages).toEqual([1, 2, 3]);
    expect(computeParserRunCacheKey(identityOrdered)).toBe(computeParserRunCacheKey(identityReordered));
    expect(computeParserRunCacheKey(identityOrdered)).toBe(computeParserRunCacheKey(identityWithDupes));
    expect(computeParserRunId(identityOrdered)).toBe(computeParserRunId(identityReordered));
  });

  it('10. a legacy artifact (no requestedPages field at all) FAILS CLOSED and never fuzzy-matches a differently-shaped artifact', async () => {
    const legacyRun: ParserRunV1 = {
      parserRunId: 'legacy-run-1',
      method: 'deterministic_pdfplumber',
      parserVersion: 'pdfplumber-test',
      parserConfigSha256: CONFIG_SHA,
      inputSourceSha256: SOURCE_SHA,
      outputArtifactSha256: 'e'.repeat(64),
      pageRanges: [{ startPage: 1, endPage: 3 }],
      // requestedPages deliberately omitted -- legacy pre-Phase-10B-25 shape.
    };
    const pureResolved = resolveContributingRunIdentityV1(legacyRun);
    expect(pureResolved.status).toBe('legacy_missing_requested_pages');

    const { registeredIdentity, descriptor, storedResult, resolution } = buildFixture({
      registered: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
      lookup: { sourceSha256: SOURCE_SHA, requestedPages: [1, 2, 3], parserConfigSha256: CONFIG_SHA },
    });
    resolution.artifact.parserRuns[0]!.requestedPages = undefined;
    resolution.artifact.parserRuns[0]!.succeededPages = undefined;
    resolution.artifact.parserRuns[0]!.failedPages = undefined;
    const { store, findExactSpy } = registrationAwareStore(registeredIdentity, descriptor, storedResult);
    const resolved = await resolveWith(resolution, store);

    expect(resolved.proofBundle.parserRuns[0]?.proofStatus).toBe('missing');
    expect(
      resolved.proofFindings.some((f) => f.code === 'parser_run_identity_legacy_unsupported'),
    ).toBe(true);
    // Never falls through to a lookup at all -- a legacy artifact must not
    // silently pass or fuzzy-match against a differently-shaped descriptor.
    expect(findExactSpy).not.toHaveBeenCalled();
  });
});
